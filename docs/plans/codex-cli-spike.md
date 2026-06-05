# Codex SDK Spike 报告（W20 §5.0）

> 日期：2026-05-11
> SDK 版本：`@openai/codex-sdk@0.130.0`
> 类型源：`core/node_modules/@openai/codex-sdk/dist/index.d.ts`（已读完）

## 结论先行

| Spike Q | 结果 |
|---|---|
| Q1 sandbox 配置 API | ✅ `ThreadOptions.sandboxMode: "read-only" \| "workspace-write" \| "danger-full-access"` — per-thread |
| Q2 usage 字段映射 | ✅ snake_case；map 进 W17 UsageEvent 简单（见 §2） |
| Q3 MCP 注入 API | ⚠ **没有 mcpServers 直接参数**——走 `CodexOptions.config` TOML 覆盖；**也没有 user-defined FunctionTool/Tool 参数**——意味着原稿的 Path A（FunctionTool）走不通；Path B 的实施细节有重要分叉（见 §3） |
| Q4 (bonus) OAuth 接入 | ✅ 不传 `apiKey` 时 SDK 内部 spawn 的 codex CLI 自动用 `~/.codex/auth.json`；Ensemble 不动 auth |

## 1. SDK 类型核心摘录

```ts
class Codex {
  constructor(options?: CodexOptions);
  startThread(options?: ThreadOptions): Thread;
  resumeThread(id: string, options?: ThreadOptions): Thread;
}

type CodexOptions = {
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  config?: CodexConfigObject;  // 任意 TOML key/value 覆盖
  env?: Record<string, string>;
};

type ThreadOptions = {
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  networkAccessEnabled?: boolean;
  webSearchMode?: "disabled" | "cached" | "live";
  webSearchEnabled?: boolean;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  additionalDirectories?: string[];
};

class Thread {
  get id(): string | null;
  runStreamed(input, turnOptions?): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
  run(input, turnOptions?): Promise<Turn>;
}

type ThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: Usage }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "item.started" | "item.updated" | "item.completed"; item: ThreadItem }
  | { type: "error"; message: string };

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

type ThreadItem =
  | AgentMessageItem    // 助手文本
  | ReasoningItem       // 推理摘要
  | CommandExecutionItem // shell 执行
  | FileChangeItem      // 文件改动 (add/delete/update)
  | McpToolCallItem     // MCP 工具调用
  | WebSearchItem
  | TodoListItem
  | ErrorItem;
```

## 2. usage → W17 UsageEvent 字段映射

```
codex Usage                    →  UsageEvent 列
─────────────────────────────────────────────
input_tokens                   →  inputTokens
output_tokens + reasoning_output_tokens (合并)  →  outputTokens
cached_input_tokens            →  cacheReadTokens
                               →  cacheCreationTokens = 0（codex 不报）
billingModel                   =  'subscription'（W20 §3.2）
costUSD                        =  0
costKnown                      =  true
```

**为什么 reasoning_output_tokens 合并进 outputTokens**：用户付钱看的是 "output 总量"，区分推理 vs 回应 token 是 codex 内部 cognitive cost 分摊，对账单意义不大；W17 stats panel 不分 output 子项。**v1 合并不显示**；v1.1 如果用户反馈需要可加一列。

## 3. MCP 注入的 ⚠ 实际情况

SDK **没有** `mcpServers` 参数（既不在 CodexOptions 也不在 ThreadOptions）。`McpToolCallItem` 事件类型存在意味着 codex 支持 MCP，**但配置入口是 codex CLI 自己的 `~/.codex/config.toml` 的 `[mcp_servers.foo]` 段**——通过 `CodexOptions.config` 传 `{ mcp_servers: { foo: {...} } }` 让 SDK 序列化成 `--config` CLI flag。

### codex config.toml 的 mcp_servers schema

从 codex repo 已知形态（基于 codex 命令行工具文档 + 用户社区配置示例）：

```toml
[mcp_servers.github]
command = "npx"
args = ["@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "ghp_..." }

# 或 HTTP transport（如支持）：
[mcp_servers.weather]
url = "https://api.example.com/mcp"
```

**关键事实**：codex 通过 **child process / external server** 形式消费 MCP，**不接受 in-process JavaScript MCP server instances**。我们的 `peer-mcp.ts` / `ask-user-mcp.ts` 当前是 `McpSdkServerConfigWithInstance`（in-process），**不能直接灌**。

### Path 重审

| Path | 可行性 | 工作量 |
|---|---|---|
| ~~A. FunctionTool / NormalizedTool~~ | ❌ codex SDK 没有 user-defined tool 参数 | n/a |
| ~~B (原稿). 在 Codex 构造里直接传 MCP server 实例~~ | ❌ SDK 只接 TOML 配置，不接对象实例 | n/a |
| **C. Ensemble core 起 HTTP MCP 端点 + codex 通过 URL 连**（**采纳**） | ✅ 现 Fastify 已就位，加一个 MCP route 即可；codex config 写 `[mcp_servers.agentorch-internal] url = "http://127.0.0.1:<corePort>/api/mcp/internal"` | ~1d（原 0.75d → +0.25d）|
| D. 起 standalone stdio MCP 子进程（与 core 不同进程） | ✅ 可行，但多一个 process / IPC 跳转 / 部署单元 | ~1.5d |

**Slice 5.5 实际方案 = Path C**：

1. 装 `@modelcontextprotocol/sdk`（codex SDK 已经依赖 → 应该已经在 node_modules 里）
2. `core/src/mcp-bridge.ts`：用 `@modelcontextprotocol/sdk` 的 `Server` 类暴露 peer_send / ask_user / Task 三个工具的 HTTP MCP endpoint
3. 在 Fastify 注册 `/api/mcp/internal` 路由（streamable HTTP transport）
4. 鉴权：URL 里塞一次性 token（启动时生成 `crypto.randomUUID()`），写到 codex `config.mcp_servers.agentorch-internal.url` 的 query string；Fastify 端校验
5. 用户外部 MCP 通过 `loadEnabledMcpServers()` → 转 codex TOML 形态注入 `config.mcp_servers`

### 5.5b OpenAI side 外部 MCP 也要调整

`@openai/agents` 的 `MCPServerStdio` / `MCPServerStreamableHttp` 是 client-side（连外部 MCP），不是 server-side。所以 OpenAI side 接外部 MCP 是 client 形态，与 codex 不冲突。**5.5b 仍按原计划**。

OpenAI side 的内部 peer/ask/Task 已经是 NormalizedTool（W16 Slice 5）——**不动**。

## 4. Approval / Permission 模型

`ThreadOptions.approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted"`

- `never`：codex 永不弹审批（与 sandbox 配合用 read-only 是安全的）
- `on-request`：codex 在 SDK 客户端层尝试 emit approval 事件——**但 SDK 类型里没有 approval 事件**，意味着这种模式可能只在交互式 TUI 下有效
- `on-failure`：sandbox 拦截后才弹审批——同样没有事件入口
- `untrusted`：怀疑模式

**v1 策略**：固定 `approvalPolicy: "never"` 配合 `sandboxMode`（用户选择）。codex agent 不弹任何 approval；sandbox 等级是唯一安全 gate。这符合 W20 v2.1 §1 的「sandbox-tier 模型 + canUseTool 短路」决议。

## 5. Plan 调整

基于本 spike 修订 W20 v2.1 中受影响的部分：

| W20 §位置 | v2.1 原稿 | spike 后修订 |
|---|---|---|
| §5.5 codex MCP 注入 | 0.75d | **1d**（HTTP MCP bridge + token 鉴权）|
| §5.5 内容 | Path A vs B by spike | **Path C 确定**：HTTP MCP 端点 |
| §3 schema | UsageEvent 加 billingModel | **不变** |
| §5.6 usage 映射 | turn.completed → modelUsage | **微调**：reasoning_output_tokens 合并进 outputTokens |
| §1 表第 11 行 approval policy | sandbox-tier + canUseTool 短路 | **加**：approvalPolicy 固定 "never" |
| 总工作量 | ~6d | **~6.25d**（+0.25d MCP HTTP bridge）|

## 6. 启动 5.1 之前的清单 ✅

- [x] SDK 装好（`@openai/codex-sdk@0.130.0`）
- [x] 类型已读
- [x] sandbox API 形态确认
- [x] usage 字段映射定稿
- [x] MCP 注入路径定稿（Path C）
- [x] OAuth 路径确认（不传 apiKey 自动走 auth.json）
- [x] approvalPolicy 决定（固定 "never"）

可以开 5.1。
