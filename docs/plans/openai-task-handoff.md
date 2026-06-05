# OpenAI 侧 Task subagent 实现（W16 Slice 5.3）

> 状态：✅ 已实施（commit `9b6bebc`，2026-05-11）
> 关联：W16 v2 §4 表里写「设计映射」未细化；C 方案要求一次做完
> 用户决议：3 层 cap + 允许跨 runtime；实现按方案 B (`SessionManager.spawnTaskSubagent`)
> 真模型 E2E 验证留给 W14 实施期顺带覆盖

## 0. TL;DR

Claude side 的 Task tool 走「方案 A 透明嵌套」：claude CLI 内部 spawn 子会话，父 agent 的视图把整个子会话渲染为 ToolCard。OpenAI SDK 没有等价的内置概念——`handoff()` 是「转交控制」语义（A 说完话让 B 接手回应用户），不是「派子任务并等结果」语义。

OpenAI SDK 的正确映射是 **`Agent.asTool()`**：把一个 Agent 包装成 FunctionTool，父 agent 调它就跑子 agent，子 agent 的 final output 作为 tool 结果回到父。这才是 "task" 语义。

但这有一个**关键现实约束**：Ensemble 的 Agent 是 DB 实体，不是 SDK in-process Agent。要把"Task" 实现得跟 Claude side 一致（子 agent 也有 DB row、消息持久化、permission gating），需要走 SessionManager 路径而不是 SDK 路径。

**推荐方案**：Task tool 在 OpenAI runtime 里调 `SessionManager.spawnTaskSubagent(parentId, description, prompt)` —— 这个 helper 创建一个临时子 agent（parentId 指向父）、用 parent 的 provider/model、执行一次 sendMessage、收集 final output、返回给父。

## 1. 现状

### Claude side Scheme A（已工作）

- claude CLI 收到 Task tool call
- CLI 内部 spawn 子 conversation（相同 model + tools，独立 context）
- 子 conversation 的 messages 走 SDK 流（assistant / stream_event / result）
- 父 agent 看到 `tool_use(Task) → tool_result(<final text>)` 块
- 前端把整段嵌套渲染为 ToolCard

ToolCard 渲染逻辑在 `desktop-ui/`，不在本设计范围。

### OpenAI side（缺失）

- 没有 Task 工具
- SDK 的 `Agent.asTool()` 存在但需要 in-process Agent 实例
- 直接用 `Agent.asTool()`：父调子时 SDK 起一个新 Runner 跑子 → 子的输出回父。但子 agent 的 messages 不会进我们的 DB，前端看不到 subagent 的中间步骤。

## 2. 设计方案对比

| 方案 | 优 | 劣 | 推荐? |
|---|---|---|---|
| A. `Agent.asTool()` 直接用 SDK 内置 | 一行代码 | 子 agent 不进 DB，前端看不到中间步骤、不能 permission gate、不能 cancel | ❌ |
| B. Task tool 调 SessionManager.spawnTaskSubagent() | 子 agent 是真 DB 实体，所有现有路径复用 | 需写 helper；嵌套 sendMessage 注意死循环 | ✅ |
| C. 自己写 Runner loop 调 OpenAI SDK | 完全控制 | 重复造轮子；和 Slice 2 的 runtime 平面冲突 | ❌ |

## 3. 设计方案 B（推荐）

### 3.1 SessionManager.spawnTaskSubagent

```ts
async spawnTaskSubagent(
  parentId: string,
  description: string,
  prompt: string,
): Promise<{ finalText: string; subagentId: string }> {
  const parent = await prisma.agent.findUnique({ where: { id: parentId } });
  if (!parent) throw new Error("parent not found");

  // 子 agent：复用 parent 的 model + provider + systemPrompt，加 description 注释
  const child = await prisma.agent.create({
    data: {
      parentId,
      name: `task:${description.slice(0, 32)}`,
      model: parent.model,
      providerId: parent.providerId,
      systemPrompt: parent.systemPrompt,
      workspace: parent.workspace,
      status: "IDLE",
      metadata: { spawnedAsTaskFor: parentId },
    },
  });

  // 广播 child 创建（前端可选择渲染独立 pane，或隐藏 / 嵌套渲染）
  this.hub.broadcast({ type: "agent_created", agent: toSummary(child) });

  // 跑 child 一轮 sendMessage（这是嵌套调用，但有 parentId 链 + 32 次 round cap 防爆）
  const result = await this.sendMessage(child.id, prompt);
  return { finalText: result?.finalText ?? "", subagentId: child.id };
}
```

### 3.2 OpenAI Task tool 注册

参考 cross-runtime-peer-send.md §2.4 的 session-aware tool 模式：

```ts
// core/src/sessions/tools/session-aware.ts
function makeOpenAITaskTool(spawn: TaskCallback): NormalizedTool {
  return {
    name: "Task",
    description: "Delegate a subtask to a subagent. The subagent inherits this agent's model + " +
      "provider but runs in an isolated context. Returns the subagent's final response.",
    parameters: z.object({
      description: z.string().min(1).describe("Short task summary (3-5 words)."),
      prompt: z.string().min(1).describe("Full task description for the subagent."),
    }),
    async execute({ description, prompt }) {
      const { finalText } = await spawn(description, prompt);
      return finalText;
    },
  };
}
```

`TaskCallback` 由 SessionManager 注入：`(desc, prompt) => spawnTaskSubagent(sessionId, desc, prompt)`。

### 3.3 RuntimeOptions 加 spawnTask 回调

```ts
interface RuntimeOptions {
  // ...
  spawnTask?: (description: string, prompt: string) => Promise<{ finalText: string; subagentId: string }>;
}
```

### 3.4 需要操心的事

1. **嵌套深度限制**：子 agent 又调 Task → 孙 agent → 链下去。加 `taskDepth` 字段在 metadata 里，>3 时拒绝。
2. **取消传播**：父被 cancel 时子也要 cancel。SessionManager.cancel 已支持级联 by parentId，复用即可。
3. **错误传播**：子 throws → tool execute throws → adapter 包装成字符串 → 返回给父模型。父可以选择重试 / 失败。
4. **前端渲染**：W14 设计已经讨论过这个；前端可以根据 `metadata.spawnedAsTaskFor` 判断是嵌套 subagent，决定是渲染独立 pane（adaptive layout）还是 ToolCard 嵌套。**Slice 5 不动前端**，留 v1.1 UI 优化。

## 4. 实现位置

```
core/src/sessions/SessionManager.ts            # 加 spawnTaskSubagent + RuntimeOptions.spawnTask 注入
core/src/sessions/tools/session-aware.ts       # makeOpenAITaskTool
core/src/sessions/tools/index.ts               # shouldRequireApproval Task=no（subagent 内的 tools 各自再 gate）
core/src/sessions/runtimes/openai.ts           # query() 注册 Task 工具
core/src/sessions/runtimes/types.ts            # RuntimeOptions 加 spawnTask
```

预计代码 ~150 行 + ~60 行单测（含嵌套深度边界）。

## 5. 开放问题

1. **subagent 用什么 model？**：方案默认沿用父 model。但用户可能想让 subagent 跑更便宜模型（例如 gpt-4o-mini 跑搜索 task）。**建议 v1 写死继承 parent；v1.1 加 optional `model` 参数**。
2. **subagent 的工具集**：方案默认全部继承 parent 工具集。但 Task 内禁用 Task 工具防止无限嵌套？**建议加 `taskDepth` cap 而非禁用**——cap 简单，深度 ≤ 3 够用。
3. **跨 runtime subagent**：Claude agent 能 Task → OpenAI subagent 吗？技术上能（继承 providerId 即继承 runtime）。但**这是不同模型行为不一致风险**。**v1 不限制**，让用户自己玩；如果反馈差再加 same-runtime constraint。
4. **streaming subagent 输出**：父等子的同时，子的 stream events 要不要广播给前端？现有 sendMessage 会广播 child sessionId 的 message 事件，前端订阅 child 即可看到。**默认行为已经 ok**。

## 6. 验收

- [ ] OpenAI agent 调 Task 创建 subagent，subagent 跑完返回结果
- [ ] subagent 的 messages 进 DB（with `parentId` = 父 sessionId）
- [ ] subagent 的 messages 通过 WS 广播给订阅了 subagent.id 的客户端
- [ ] 父被 cancel 时 subagent 也 cancel（已有级联机制复用）
- [ ] taskDepth > 3 时 Task tool execute 抛错（拒绝继续嵌套）
- [ ] 错误传播：subagent 失败时父收到 Error: ... 字符串
