# OpenAI 侧 Permission 状态机（W16 Slice 4）

> 状态：✅ 已实施（commit `6b1e5f6`，2026-05-11）
> W16 v2 §5 W16-S5a 提到要画状态机图，本稿是该图 + 实现细节。
> 实际实施验证了 §0 的核心判断：**不需要模块级 `Map<runId, InterruptState>`**——await callback 让 state 自然在栈上活到 resolve。

## 0. TL;DR

OpenAI Agents SDK 的 permission 是 **interrupt-resume 模型**，与 Claude SDK 的 **callback 模型** 语义不同。但因为我们已经持有一个 `async canUseTool(toolName, input)` callback（SessionManager 的 UI 桥），实现上**不需要做模块级状态机 Map**：runtime 在同一个 `query()` 调用栈里把 interrupt → await callback → resume 串起来，state 自然存活在闭包里。

W16 v2 §5 原本的 `Map<runId, InterruptState>` 设计是为「state 必须跨 ServerMsg 一来一回保留」准备的。**这是不必要的**——`canUseTool` 这个 Promise 一直没 resolve 时，整个 `for await (const event of runtime.query(...))` 循环就挂在那儿，state 全在 V8 调用栈里。重审审阅意见后的判断：内存级 Map 是过度工程。

## 1. 状态图

```
                       ┌──────────────────────────────────┐
                       │  SessionManager.sendMessage 入口  │
                       └─────────────────┬────────────────┘
                                         │
                                         ▼
                          OpenAIAgentRuntime.query(opts)
                                         │
                                         ▼
                  ┌────── 构造 agent + sdkTools + Runner ──────┐
                  │                                             │
                  │  每个 NormalizedTool 转成 OpenAI FunctionTool │
                  │  → needsApproval 按 permissionMode 决定       │
                  │     (default/plan → 大多 true; bypass → 全 false) │
                  └─────────────────┬───────────────────────────┘
                                    │
                                    ▼
                   ┌── INITIAL ──→ runner.run(agent, inputs, stream)
                   │                       │
                   │                       │ 流式事件 yield 给 SessionManager
                   │                       │ (sdk_message → ServerMsg.message)
                   │                       │
                   │                       ▼
                   │              for await 结束 → result.interruptions ?
                   │                       │
                   │              ┌────────┴────────┐
                   │              │                 │
                   │           empty               非空
                   │              │                 │
                   │              ▼                 ▼
                   │       result/success      ┌─ INTERRUPTED ─┐
                   │              │            │                │
                   │              │            │  for each item │
                   │              │            │       │        │
                   │              │            │       ▼        │
                   │              │            │  await opts.   │
                   │              │            │  canUseTool(   │
                   │              │            │   item.name,   │
                   │              │            │   parsedArgs)  │
                   │              │            │       │        │
                   │              │            │       ▼        │
                   │              │            │  decision?     │
                   │              │            │   allow → state.approve(item)
                   │              │            │   deny  → state.reject(item, msg)
                   │              │            └────────┬───────┘
                   │              │                     │
                   │              │                     ▼
                   │              │            runner.run(agent, state, stream)
                   │              │                     │ (循环回 INITIAL)
                   │              │                     │
                   │              ▼                     │
                   │            DONE  ←─────────────────┘
                   │
                   │  任何阶段：abort.signal aborted
                   │  → break + 终止；state 由 GC 自然回收
                   │  → 不需要显式 cleanup
                   └────────────────────────────────────
```

## 2. 关键不变量

- **不引入模块级 `Map<runId, InterruptState>`**：状态全部在 `OpenAIAgentRuntime.query()` 闭包里。这样 abort、并发 sendMessage、内存泄漏都不需要单独处理。
- **interrupt-resume 循环计数有上限**：单 turn 内 ≤ 32 次 approval round（防止恶意 prompt 让模型疯狂调工具死循环）。超过抛 error。
- **abort 在任何点都安全**：runner.run() 接收 `signal: opts.abortController.signal`；canUseTool 的 SessionManager 端在 abort 时 reject 该 Promise；我们抓 AbortError 后正常 break。
- **state.approve / state.reject 必须严格配对到 result.interruptions 里的 item**：不要复用、不要跨 result 用。每次 result 拿到的 interruptions 只对该 result 的 state 有效。

## 3. PermissionMode → needsApproval 映射

每个 NormalizedTool 注册时根据 mode 决定 `needsApproval`：

| Mode | Read | Grep | Glob | Edit | Write | Bash |
|---|---|---|---|---|---|---|
| `default` | no | no | no | **yes** | **yes** | **yes** |
| `acceptEdits` | no | no | no | no | no | **yes** |
| `bypassPermissions` | no | no | no | no | no | no |
| `dontAsk` | no | no | no | no | no | no |
| `plan` | no | no | no | **yes** | **yes** | **yes** |

`needsApproval=true` 的工具在 SDK 内部触发 interruption。`needsApproval=false` 的工具 SDK 直接执行不暂停。

**plan 模式**：Slice 4 暂时和 default 一样（write/bash 都问）。完整 plan mode（model 不能 call write 工具）依赖 system-prompt 增强 + ask_user 兜底，落到 Slice 5（W16-S0/S5 实施稿）。

## 4. canUseTool 在 SessionManager 端的行为

SessionManager 现有的 `makeCanUseTool(sessionId)` 已经实现了：
- 写 Permission DB row（state = pending）
- 通过 WS 发 `permission_request` ServerMsg → 前端弹框
- 等待 `permission_response` ClientMsg → resolve Promise → 返回给 SDK

OpenAI 侧不需要任何 SessionManager 端的改动——直接复用现有 callback。这是抽象层的好处：runtime 内部 interrupt-resume 与 callback 之间的 impedance mismatch 在 runtime 内部消化掉。

## 5. 取消（abort）路径

- 用户点取消 → `opts.abortController.abort()` → 所有路径：
  1. `runner.run()` 抛 `AbortError`（runner 内部 listening signal）
  2. 如果正卡在 `await opts.canUseTool(...)`，SessionManager 端那边 abort 该 sessionId 的 pending permission → reject Promise → runtime 抓后 break
- runtime 抓 abort：不向 SessionManager 发 error（abort 是用户主动行为，不算错误）；停止 yield 即可

## 6. 上限保护

```ts
const MAX_INTERRUPT_ROUNDS = 32;
let rounds = 0;
while (rounds++ < MAX_INTERRUPT_ROUNDS) {
  result = await runner.run(...);
  for await (const ev of result) yield translate(ev);
  if (!result.interruptions?.length) break;
  for (const item of result.interruptions) await handleApproval(item);
}
if (rounds >= MAX_INTERRUPT_ROUNDS) {
  yield { type: "error", message: "agent stuck in approval loop (>32 rounds), aborted" };
}
```

## 7. 待 Slice 5 补的事

- **plan mode 完整实现**：需要 ExitPlanMode 工具映射 + system-prompt 增强
- **跨 runtime ask_user**：Claude side ask_user MCP 已工作；OpenAI side 在 Slice 5.1 / 5.2 实现
- **cross-runtime peer_send**：Slice 5.4

## 8. 不在本设计范围

- 跨 ServerMsg 持久化 state（不需要——单 turn 内同步处理；turn 结束就丢弃）
- 多 runtime 联合 permission 决策（暂时各 runtime 独立处理，由 SessionManager 调度）
- approval audit log（Permission 表已经存了；Slice 4 不动）

---

附：W16 v2 §5 W16-S5a 原文要求「持久化 interruption state (在哪一步、call_id、context)」+「load saved state + run resume」。
**本设计采纳更简的方案**：因为我们持有 `canUseTool` 这个 await-able callback，state 自然在 V8 栈上活到 callback resolve 为止；不需要 toString/fromString 序列化，也不需要模块级 Map。
如果未来需要支持「sidecar 重启后恢复未决 approval」，再切到 RunState 序列化方案。
