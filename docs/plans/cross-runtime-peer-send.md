# 跨 runtime peer_send 设计（W16 Slice 5.1 + 5.4）

> 状态：✅ 已实施（commit `9b6bebc`，2026-05-11）
> 关联：W16 v2 §6.2 #3 原列为开放问题；C 方案要求一次做完
> Slice 7 E2E：双向 Claude ⇄ OpenAI peer_send 通过 WS ClientMsg 直接路由全跑通

## 0. TL;DR

经过 Slice 1-4 抽象层就位，**peer_send 跨 runtime "默认就可工作"**——SessionManager 已经把每个 agent 的 sendMessage 调度抽象成 runtime-agnostic：
- `Claude agent → OpenAI agent`：A 的 peer-mcp 调用 `sendPeerMessage(A, B)` → SessionManager 路由 B → B 的 provider.kind 决定走 OpenAIAgentRuntime → 收到消息正常处理
- `OpenAI agent → Claude agent`：对称，A 的 peer_send 工具调用 → SessionManager 路由 B → B 走 Claude runtime

**唯一缺的**：OpenAI agent 当前**没有** peer_send 工具——peer-mcp.ts 只为 Claude side 注册到 SDK 的 mcpServers map 里。

所以 Slice 5.1 + 5.4 实际工作量是：**给 OpenAIAgentRuntime 加 peer_send + ask_user 两个 session-aware 工具**。不是协议设计，是工具注册。

## 1. 现状

```
Claude agent A 调 peer_send
   └─ peer-mcp.ts: makePeerMcpServer(sessions, A.id) 闭包绑定 fromAgentId=A
        └─ tool handler 调 sessions.sendPeerMessage(A, target, msg, mode)
             └─ SessionManager 解析 target → agent B
                  └─ B.sendMessage(formattedMsg, { peerOrigin: {fromA, name, mode} })
                       └─ chooseRuntime(B.provider.kind) → runtime.query(...)
                            └─ runtime 处理（不管 Claude 还是 OpenAI）
```

跨 runtime 的两端都已经在工作。需要把 peer_send 也暴露给 OpenAI side 的 agent。

## 2. 设计：session-aware tools 走 RuntimeOptions 注入

`peer_send` / `ask_user` 不同于 6 个核心文件/shell 工具——它们**需要 SessionManager 实例和 fromAgentId**。`peer-mcp.ts` 用闭包绑定，OpenAI side 平移这个模式。

### 2.1 RuntimeOptions 加两个回调

```ts
interface RuntimeOptions {
  // ... 现有 12 个字段
  /** Per-call closure over SessionManager.sendPeerMessage + this session's id.
   *  Claude side ignores (peer_send arrives via mcpServers map).
   *  OpenAI side registers as a NormalizedTool. */
  peerSend?: (target: string, message: string, mode?: "continue" | "review" | "fork" | "raw") => Promise<string>;
  /** Per-call closure over SessionManager.askUser. Same Claude-ignore /
   *  OpenAI-register pattern. */
  askUser?: (question: string, options: string[]) => Promise<string>;
}
```

### 2.2 SessionManager 端

`sendMessage` 已经创建了 `peerMcp` / `askUserMcp`（在 mcpServers map 里给 Claude 用）。再额外构造两个纯 callback：

```ts
const runtimeOpts: RuntimeOptions = {
  // ...
  peerSend: makePeerSendHandler(this, sessionId),    // Slice 1.7 已暴露
  askUser: makeAskUserHandler(this, sessionId),       // Slice 1.7 已暴露
};
```

闭包 binding 已经在 Slice 1.7 单测里 locked-in，不需要新单测。

### 2.3 OpenAIAgentRuntime 端

在 `query()` 入口判断 opts 是否提供了这两个回调，提供则注册成 NormalizedTool 加进 sdkTools 列表：

```ts
const sessionAwareTools: AnyNormalizedTool[] = [];
if (opts.peerSend) sessionAwareTools.push(makeOpenAIPeerSendTool(opts.peerSend));
if (opts.askUser) sessionAwareTools.push(makeOpenAIAskUserTool(opts.askUser));
const allTools = [...sdkTools, ...sessionAwareTools.map(t => toOpenAITool(t, { permissionMode }))];
```

### 2.4 工具定义（peer_send）

```ts
function makeOpenAIPeerSendTool(send: PeerSendCallback): NormalizedTool {
  const schema = z.object({
    target: z.string().min(1),
    message: z.string().min(1),
    mode: z.enum(["continue", "review", "fork", "raw"]).optional(),
  });
  return {
    name: "peer_send",
    description: "Send a chat message to another agent in this workspace. ...",
    parameters: schema,
    async execute(args) {
      return send(args.target, args.message, args.mode);
    },
  };
}
```

ask_user 类似。

## 3. needsApproval 决策

`peer_send` 和 `ask_user` 是**系统级安全操作**，应当 `needsApproval: false`（Claude side 通过 `allowedTools: [PEER_SEND_TOOL_NAME, ASK_USER_TOOL_NAME]` 实现的同效）。

要在 `shouldRequireApproval` 表里加这两行：

| Tool | 任意 mode |
|---|---|
| peer_send | no |
| ask_user | no |

## 4. mode 字段的处理

peer_send 的 `mode` 影响**接收方收到的消息怎么 reframe**——`formatPeerHandoff` 已经处理。`peer_send` 工具的 `mode` 参数对发送方运行时是透明的，直接转发。

## 5. 实现位置

```
core/src/sessions/runtimes/openai.ts           # query() 拼接 sessionAwareTools
core/src/sessions/tools/session-aware.ts       # 新增：makeOpenAIPeerSendTool + makeOpenAIAskUserTool
core/src/sessions/runtimes/types.ts            # RuntimeOptions 加 peerSend/askUser
core/src/sessions/SessionManager.ts            # runtimeOpts 注入 callback
core/src/sessions/tools/index.ts               # shouldRequireApproval 加 peer_send/ask_user
```

预计代码量 ~120 行 + ~50 行单测。

## 6. 开放问题

1. **同名工具冲突**：Claude side `peer_send` 的 MCP-tool 实际名是 `mcp__agentorch-peer__peer_send`，OpenAI side 我打算直接叫 `peer_send`。前端 ToolCard 渲染要兼容两种名字（或者 normalize 一下）。**建议**：前端 detect `_send$` / `_user$` 后缀做一个映射；或者 OpenAI side 也用 `mcp__agentorch-peer__peer_send` 这个长名让前端零改动。
2. **跨 runtime mode 语义对等性**：`continue / review / fork / raw` 4 个 mode 在 OpenAI side 是否表现一致？目前接收方处理 mode 只是改 prompt 前缀（`formatPeerHandoff`），与 runtime 无关。**应该一致**。
3. **错误传播**：peer_send 给一个不存在的 target，错误怎么回到调用方？现有 sendPeerMessage 已 throws → tool execute 异常 → adapter 捕获 → 返回 `Error: ...` 字符串给模型。**已工作**。

## 7. 验收

- [ ] OpenAI agent 调 peer_send 给一个 Claude agent，后者收到消息
- [ ] OpenAI agent 调 peer_send 给另一个 OpenAI agent，对方收到
- [ ] Claude agent 调 peer_send 给 OpenAI agent（已有路径，回归不破）
- [ ] peer_send 给不存在的 target → 返回错误字符串给模型，agent 不崩
- [ ] 闭包 binding 不串号：两个 OpenAI agent 同时 peer_send 各回各
- [ ] needsApproval=false 生效：调用 peer_send 没有弹权限框
