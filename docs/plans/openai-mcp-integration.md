# OpenAI 侧 MCP / ask_user / ExitPlanMode 接入（W16 Slice 5.1 + 5.2）

> 状态：✅ 已实施（commit `9b6bebc`，2026-05-11）
> 关联：W16 v2 §4 表里 OpenAI side "in-process MCP" 标 ❌；C 方案要求一次到位
> 选择确认：走轻型路径（NormalizedTool / 不接 SDK MCP）；前端 markdown 渲染算 Slice 5 验收
> Slice 7 E2E：timicc gpt-5.2 触发 ExitPlanMode → permission_request → PermissionDialog markdown 渲染分支命中

## 0. TL;DR

经过对 `@openai/agents-core` MCP API 的调研，**两条路**：
1. **重型路径**：用 `MCPServer` 接入。但 SDK 的 MCP API 是「作为 client 连外部 MCP server」——stdio/sse/http transport，没有「in-process server」一类。要把我们的 peer_send / ask_user 暴露成 MCP，得起一个 in-process MCP server（依赖 `@modelcontextprotocol/sdk`，需要 streamable-http transport bridge）。
2. **轻型路径**：peer_send / ask_user / Task / ExitPlanMode **不走 MCP**，全部注册成 SDK 原生 FunctionTool（即 NormalizedTool）。功能等价，省掉 MCP server 进程 + 协议帧。

**推荐轻型路径**——v1 没用户跨进程访问 ask_user/peer_send 的需求；MCP-as-service 是为外部生态准备的，自家工具进自家 SDK 是浪费。

W16 v2 §4 「in-process MCP (peer_send / ask_user)」打 ❌ 的原因之一就是 SDK 的 MCP API 不顺。本设计是把这个 ❌ 变成 ✅ 的最小代价方案。

## 1. SDK MCP API 现状

`@openai/agents-core` 导出：
- `MCPServerStdio` / `MCPServerStreamableHttp` / `MCPServerSSE` — **三种 client transport**，连外部 MCP server
- `mcpToFunctionTool` — 把 MCP server 上的工具拉下来转 FunctionTool
- `MCPServers` / `connectMcpServers` — 批量管理多个 client connection

**没有** SDK-side 的 MCP server 工厂（Claude SDK 是有的：`createSdkMcpServer`）。

如果我们要把 peer_send 暴露成 MCP 让 OpenAI 侧用：
1. 起一个 in-process MCP server（用 `@modelcontextprotocol/sdk` 的 `Server` 类）
2. 注册 peer_send 工具到这个 server
3. OpenAI 侧用 `MCPServerStreamableHttp` 通过 localhost 连
4. 工具被发现 → 调用 → 走回我们的 handler

这是 4 跳的桥。**而 NormalizedTool 路径是 0 跳**：peer_send 已经是个 closure，注册成 FunctionTool 立刻可用。

## 2. 推荐方案：全部走 NormalizedTool / SDK FunctionTool

### 2.1 工具清单

OpenAI side 注册的"自家"工具集：

| Tool | 来源 | needsApproval | 备注 |
|---|---|---|---|
| peer_send | cross-runtime-peer-send.md §2 | no | session-aware closure |
| ask_user | 本设计 §3 | no | session-aware closure |
| Task | openai-task-handoff.md §3 | no | session-aware closure |
| ExitPlanMode | 本设计 §4 | no | 静态工具，无 closure |

加上 Slice 3 的 6 个核心工具（Read/Edit/Write/Bash/Grep/Glob），OpenAI side v1 完整工具集 = **10 个**。

### 2.2 实现位置

```
core/src/sessions/tools/session-aware.ts       # peer_send / ask_user / Task（这 3 个需要 closure）
core/src/sessions/tools/exit-plan-mode.ts      # ExitPlanMode（静态工具）
core/src/sessions/tools/index.ts               # 集成到 sdkTools 拼接逻辑
core/src/sessions/runtimes/types.ts            # RuntimeOptions 加 peerSend / askUser / spawnTask 回调
core/src/sessions/runtimes/openai.ts           # query() 入口拼接 session-aware tools
core/src/sessions/SessionManager.ts            # 给 runtimeOpts 注入 callbacks
```

## 3. ask_user 实现

工具签名（mirror Claude side ask-user-mcp.ts）：

```ts
function makeOpenAIAskUserTool(ask: AskUserCallback): NormalizedTool {
  return {
    name: "ask_user",
    description: "Ask the human user a question and wait for their answer. ...",
    parameters: z.object({
      question: z.string().min(1),
      options: z.array(z.string().min(1)).min(1),
    }),
    async execute({ question, options }) {
      return ask(question, options);
    },
  };
}
```

`AskUserCallback` = `(question, options) => Promise<string>`。SessionManager 已经有 `makeAskUserHandler(this, sessionId)`（Slice 1.7 暴露），直接复用。

## 4. ExitPlanMode 实现

工具签名（mirror Claude side 内置）：

```ts
const exitPlanModeTool: NormalizedTool = {
  name: "ExitPlanMode",
  description: "Exit plan mode after presenting your plan. The user will be asked to approve the plan " +
    "before any code is written.",
  parameters: z.object({
    plan: z.string().min(1).describe("Markdown-formatted plan to present to the user."),
  }),
  async execute({ plan }) {
    // 此工具的 execute 不实际做事——SDK 会用 needsApproval 暂停，
    // 我们在 canUseTool 路径里把 plan 文本传给前端弹框
    // (前端识别 toolName==="ExitPlanMode" 时渲染 plan + Approve/Deny 按钮)
    return plan; // 用户 approve 后此返回值就是父 agent 看到的内容
  },
};
```

**特殊**：ExitPlanMode 是唯一一个 `needsApproval = true` 的 session-aware 工具——它的语义就是"提议→等用户审批"。前端 permission_request UI 已经存在；只需识别 toolName 渲染 plan markdown + Approve/Deny 按钮。前端识别由 ServerMsg.permission_request 的 toolName 字段做。

shouldRequireApproval 表加：

| Tool | mode=plan | 其他 mode |
|---|---|---|
| ExitPlanMode | yes | no |

只在 plan mode 下 gate；其他 mode 直接执行返回 plan 文本（行为退化为「让模型输出一段 plan」）。

## 5. Plan mode 完整闭环

Slice 4 时 plan mode 走 default 的 gating 表（写工具都问）。Slice 5 让它「正确」：

- system prompt 加一段 "You are in plan mode. Do NOT use Edit/Write/Bash directly. Present a plan via ExitPlanMode and let the user approve."（SessionManager 端在 systemPrompt 注入）
- ExitPlanMode 工具暴露
- canUseTool 在 plan mode 下对 Edit/Write/Bash 直接 deny（SessionManager 端逻辑，不在 runtime）

这样 plan mode 的工具集事实上变成 Read/Grep/Glob/peer_send/ask_user/Task/ExitPlanMode（7 个）。

## 6. 实现位置 + 估时

```
core/src/sessions/tools/session-aware.ts        # peer_send / ask_user / Task   ~120 行
core/src/sessions/tools/exit-plan-mode.ts       # ExitPlanMode                  ~30 行
core/src/sessions/tools/index.ts                # 拼接逻辑 + needsApproval     ~30 行
core/src/sessions/runtimes/types.ts             # RuntimeOptions 加 callback     ~10 行
core/src/sessions/runtimes/openai.ts            # query() 拼接               ~20 行
core/src/sessions/SessionManager.ts             # 注入 callback + plan-mode    ~40 行
core/src/sessions/tools/__tests__/             # 4 个新 session-aware 工具      ~80 行
```

**总：~330 行**。

## 7. 开放问题

1. **MCP 外部 server 支持**（Slice 5 不做）：用户配置 stdio MCP server 后，OpenAI side 怎么接？走 `MCPServers.connect` + `mcpToFunctionTool` 注入到 agent。**Slice 5 不实施**，v1.1 加。
2. **ExitPlanMode 前端 UI**：当前 permission_request 弹框可能不渲染 markdown。**Slice 5 设计稿不动前端**；Slice 5 验收要求前端能至少显示 plan 文本（即使无 markdown）。markdown 渲染优化 v1.1。
3. **plan mode 的 systemPrompt 注入位置**：SessionManager 还是 runtime？**建议 SessionManager**——保持 runtime 对 permissionMode 无感，统一在 SessionManager 端注入。

## 8. 验收

- [ ] OpenAI agent ask_user 弹 user_question ServerMsg，用户响应后 agent 收到选项字符串
- [ ] OpenAI agent ExitPlanMode 在 plan mode 下触发 permission_request，approve 后 plan 文本传回模型
- [ ] OpenAI agent ExitPlanMode 在非 plan mode 下直接返回 plan 文本（不弹框）
- [ ] OpenAI agent 在 plan mode 下尝试 Edit/Write/Bash → canUseTool 返回 deny → 模型收到 "denied"
- [ ] 4 个 session-aware 工具 needsApproval=false 生效（除 ExitPlanMode plan-mode 例外）
