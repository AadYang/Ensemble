# Codex CLI Runtime + OpenAI 外部 MCP 接入（W20 提案 · v2.1 合并版）

> **状态**：📝 设计落盘，**8 项决议齐全，待 spike + 实施**（v2.1 2026-05-11：W21「OpenAI 外部 MCP」按用户决议合并进 W20）
> **目标**：
> - 在 Ensemble 加入第三个 runtime `CodexCliRuntime`，让用户用本机 `codex login` 已就位的 ChatGPT-account OAuth 凭证驱动 OpenAI Responses API，不需要 sk- API key
> - **并修补 OpenAI side（openai-local / openai-compat）当前漏掉的用户外部 MCP 接入**——v2.1 把原 W21 backlog 合并进来，避免「Claude / codex 有外部 MCP，OpenAI sk-key 没有」的尴尬不对称
>
> **v2.1 合并改动**：W21 backlog（OpenAI side 接外部 MCP）整段并入。Slice 5.5「codex MCP 注入」与新增 Slice 5.5b「OpenAI runtime 接外部 MCP」共用 `mcp-adapter` 助手（把 Ensemble 现有 McpServer 表的 stdio/http/sse 配置转成对应 SDK 的 MCP client 实例）。总工作量从 v2 的 ~5d 升到 ~6d。
>
> **v2 核心改动 vs v1**（来自 [`codex-cli-runtime-review.md`](./codex-cli-runtime-review.md)）：
> - **改用 `@openai/codex-sdk` 库嵌入**（不再手写 spawn + 行解析）——与 Claude side 用 `@anthropic-ai/claude-agent-sdk` 完全对称，且符合 CLAUDE.md §1「Agent 内核：库方式嵌入 SDK」锁定决策。SDK 内部仍 spawn codex CLI，但行解析 / 协议帧 / refresh / 等责任全部归 OpenAI 维护
> - **Permission 模型：sandbox-tier 静态等级**（read-only / workspace-write / danger-full-access）——codex 无 per-call callback；codex agent **没有逐工具审批 UI**，由 sandbox 等级控制——这是**预期行为**，写进 HANDBOOK
> - **Cost 表达**：codex turn 走 ChatGPT 订阅，逐 turn 无现金成本；UsageEvent 表加 `billingModel ∈ {metered, subscription}` 列；subscription turn `costUSD=0` + `costKnown=true` + `billingModel='subscription'`；聚合 totals 过滤 subscription 行——**不与其他 provider cost 混算**
> - **MCP 接入：完整体验（内部 peer/ask/Task + 用户外部 MCP）**——与 Claude side 工具栈对齐
> - **Spike 范围大幅缩窄**：原稿假设的「codex 是否有 headless」未知已被官方文档解决；spike 只需确认 permission flow / usage 字段 / MCP 注入 API 三个字段映射
>
> **W16 v2 §2 决议撤销**：W16 v2 当时 reject 了「codex CLI as sidecar」方案。本稿审批通过后该决议撤销——情况变了（codex 官方 TS SDK + 用户本机 OAuth 已就位 + 用户明确诉求）。撤销注脚写进 `multi-sdk-integration.md`。

---

## 0. Spike（实施前置，~0.5d）

**剩余未知**（review 缩窄后）：

1. **codex SDK 的 sandbox 配置 API**：是 `Codex({ sandbox: 'workspace-write' })` 还是 per-`runStreamed` 参数？sandbox 等级能否中途切换？
2. **codex SDK 的 usage 字段映射**：`turn.completed` 事件载荷里 `inputTokens / outputTokens / reasoningTokens / cachedTokens` 字段名 + 类型；reasoning tokens 单独算还是合入 output
3. **codex SDK 的 MCP 注入 API**：通过 `Codex` 构造参数还是 `Thread.run` 选项？支持几种 transport（stdio / http / sse）？事件流里 `item.mcp_tool_call` 的载荷结构？

spike 输出 → `docs/plans/codex-cli-spike.md`，给 5.1 实施提供具体字段名 + 调用方式。

---

## 1. 关键设计决策（v2 决议后）

| 维度 | 否决方案 | 采纳方案 | 理由 |
|---|---|---|---|
| 接入方式 | 手写 spawn + JSONL 行解析 | **`@openai/codex-sdk` 库嵌入** | 与 Claude SDK 嵌入对称；CLAUDE.md §1 锁定决策；行解析责任归 OpenAI |
| Runtime 抽象 | 复用 OpenAIAgentRuntime + 加 mode 分支 | **新加 `CodexCliRuntime`（第三 runtime）** | `@openai/agents` 与 `@openai/codex-sdk` 是不同 SDK；强糅会让 OpenAIAgentRuntime 变 if-else 大坑 |
| Provider kind | 复用 openai-local 加 sub-mode | **新加 `openai-codex` kind** | W19 `openai-local` 定义为「`api.openai.com` + sk-key」；codex 是另一个协议栈 |
| Permission 模型 | per-call canUseTool 桥 | **sandbox-tier 静态等级**（read-only / workspace-write / danger-full-access）| codex 无 per-call callback；用户在创建 openai-codex provider 时选默认 sandbox；codex agent 不弹审批是预期 |
| Cost 表达 | 进 pricing.json + UsageEvent.costUSD 折算 | **`billingModel='subscription'` + `costUSD=0` + 不计入 totals** | ChatGPT 订阅经济学：用户已付月费，逐 turn 无边际成本；折算成 gpt-5.x 等价价会误导 |
| Schema 增量 | 复用现有列 | **UsageEvent 加 `billingModel TEXT CHECK IN ('metered','subscription')` 列**，默认 `metered` | `costKnown=false` 已被 W17 占用（语义：未知 model）；用 billingModel 表达「订阅 vs 计量」语义分明 |
| MCP 接入 | v1 不接 / 只接内部 | **完整接：内部 peer/ask/Task + 用户外部 McpServer 表** | 与 Claude side 对齐；codex agent 不当 island；用户的 GitHub/Notion MCP 在 codex 也能用 |
| UI 入口 | 单独菜单 | **现有四态表单加第 5 entry**：(OpenAI, codex) | 与 Claude/OpenAI × 官方/兼容 决策树平行；用户一眼能选 |
| 鉴权处理 | 我们读 `~/.codex/auth.json` 抽 token | **完全由 codex SDK + CLI 处理** | 不碰 auth.json；不实现 JWT refresh；不背 ToS 风险 |
| auth missing UX | 标 disabled | **显示「需登录」引导**（点击跑 `codex login`）| 比 disable 友好；类比 anthropic-local 缺凭证情况 |
| codex CLI 管理 | bundle 进 SEA | **依赖用户本机装**，启动期 `codex --version` 检测 + SDK 兼容矩阵校验 | bundle codex 让 SEA 涨 100+ MB；让用户更新 codex 我们只探测 |
| 工具集 | 自己注入 NormalizedTool | **复用 codex SDK 内置工具集**（Read/Edit/Bash/web_search/plan）| 套自己工具会破坏 codex hooks，类比 W16 Claude side 不替换内置工具的决策 |
| 流式合成 | OpenAI 风格独立形态 | **合成 Claude-shaped SdkMessage**（system/init → stream_event → assistant → result）| 与 OpenAIAgentRuntime W16 Slice 2 同款；前端零改动 |
| 版本 pin | 最新 codex CLI / SDK | **测一个版本 + README 写明，超出范围 warn banner 但允许跑** | 避免追协议变更兔子洞 |

---

## 2. 架构

```
                          ┌─ ClaudeAgentRuntime  → @anthropic-ai/claude-agent-sdk (SDK 内部 spawn claude CLI)
chooseRuntime(kind) ───── ┼─ OpenAIAgentRuntime  → @openai/agents                  (api.openai.com，sk-key)
                          └─ CodexCliRuntime     → @openai/codex-sdk               (SDK 内部 spawn codex CLI)  ← W20 新
```

三 runtime 都实现 `AgentRuntime` 接口（W16 Slice 1.5）。**与原稿差异**：原稿 §2 写「CodexCliRuntime 与 ClaudeAgentRuntime 高度对称（spawn 子进程 + 行解析）」。v2 改为**与所有库嵌入 runtime 对称**：runtime 只调 SDK 方法，不亲自 spawn / 解析。SDK 内部仍 spawn codex CLI，但对 runtime 代码而言是库调用。

CodexCliRuntime 与现有 runtime 字段映射：

| 行为 | ClaudeAgentRuntime | OpenAIAgentRuntime | CodexCliRuntime（新） |
|---|---|---|---|
| SDK 库 | `@anthropic-ai/claude-agent-sdk` | `@openai/agents` | `@openai/codex-sdk` |
| 入口 API | `query({ prompt, options })` | `Runner.run(agent, input, {stream})` | `Codex().startThread().runStreamed(prompt)` |
| 鉴权 | 父进程 env (`ANTHROPIC_API_KEY` / ` claude login`) | `OpenAIProvider({ apiKey })` | codex CLI 自己读 `~/.codex/auth.json` |
| sandbox / permission | `canUseTool` callback | interrupt-resume → `canUseTool` callback | **sandbox 等级** 启动时声明，无 callback |
| 工具集 | SDK 给 + mcpServers map | NormalizedTool + session-aware 注入 | codex 内置 + 注入 MCP（含内部 + 外部） |
| usage 来源 | result.modelUsage[model] | StreamEventResponseCompleted | `turn.completed` event payload |
| abort | `AbortController.signal` | 同 | 同 |
| cwd | `homedir()` | n/a（in-process）| `homedir()`（codex CLI 行为相关）|

---

## 3. Schema 变化

### 3.1 Provider 表（不动结构，加新 kind）

新 kind `openai-codex`。`kind` 列已是 TEXT。约束：
- `baseUrl`: 必须 null
- `apiKey`: 必须 null
- 单例约束：只允许一个 `openai-codex` provider（类比 `anthropic-local`）
- 启动期检测：
  - `codex` 不在 PATH → metadata 标 `codex_cli_missing` + UI 灰显第 5 entry + 链接 install 指引
  - codex 在 PATH 但 `~/.codex/auth.json` 缺失 → **不 disable**，metadata 标 `auth_missing` + UI 显示「需登录」按钮（点击跑 `codex login`）
- 新字段 `defaultSandbox TEXT DEFAULT 'workspace-write'`（per-provider sandbox 等级）

### 3.2 UsageEvent 表（加列）

W17 引入的 UsageEvent 加一列：

```sql
ALTER TABLE UsageEvent ADD COLUMN billingModel TEXT NOT NULL DEFAULT 'metered'
  CHECK (billingModel IN ('metered', 'subscription'));
```

**写入语义**：
- Claude / OpenAI (sk-key / compat) turn → `billingModel='metered'`（默认）
- codex turn → `billingModel='subscription'` + `costUSD=0` + `costKnown=true`（含义：价格信息完整，就是 0；不是「未知 model」）

**聚合层**（W17 §5 `/api/usage/summary`）改动：
- `totals.costUSD` 累计时过滤 `billingModel='metered'` only
- `daily / byAgent / byModel / byProvider` 各 bucket 的 `costUSD` 同上过滤
- 但 **token 字段全部入账**（subscription turn 也消耗真实 tokens，统计有价值）
- 新增 totals 字段 `subscriptionTurns: number` 让 UI 标注「N 个 subscription turn 不计入总成本」
- UI（W17 §3.2 stat cards / detail table）：cost 列 `subscription` 行显示 `—`（不是 `$0.00` 也不是 `?`，避免混淆 unknown）

### 3.3 启动期 idempotent 迁移

`db.ts:ensureColumn` 模式扩展到 UsageEvent。

---

## 4. UI 决策树（四态 → 五态）

```
runtime: [Claude] [OpenAI]
  ↓
entry (Claude):   [官方 OAuth] [兼容 + key]
entry (OpenAI):   [官方 sk-key] [Codex login] [兼容 + key]   ← Codex 是新
                       ↓                ↓                ↓
                  baseUrl 锁         全空            baseUrl + key
                  + apiKey 必填   + sandbox 单选       都自填
                  kind=openai-local  kind=openai-codex    kind=openai-compat
```

### 4.1 codex entry 形态

- **codex 在 PATH 上 + auth.json 存在**：entry 正常可点；表单仅显示 sandbox 单选（`read-only` / `workspace-write` 默认 / `danger-full-access`）
- **codex 在 PATH 上 + auth.json 缺失**：entry 可点；表单显示「需登录」按钮 + 指引「在终端跑 `codex login`」 + sandbox 单选灰显
- **codex 不在 PATH**：entry 灰显 + tooltip「Install codex from https://github.com/openai/codex#install」

### 4.2 ChatPane 顶部 banner（仅 openai-codex agent）

```
sandbox=workspace-write · codex runtime 不支持逐工具审批
```

让用户在 chat 流程里明白「写文件不会弹框」——这是 codex 体系差异，不是 bug。

### 4.3 sandbox 在 AgentSettings 可改

类比 `permissionMode`：每个 agent 可单独覆盖 provider 的默认 sandbox。

---

## 5. 实施切片

| 阶段 | 工作量 | 产出 |
|---|---|---|
| **5.0 spike** | **0.5d** | `docs/plans/codex-cli-spike.md`：sandbox 配置 API + usage 字段映射 + MCP 注入 API 三个具体确认 |
| 5.1 装 SDK + CodexCliRuntime 骨架 | 0.5d | `pnpm add @openai/codex-sdk`；`core/src/sessions/runtimes/codex.ts`：构造 Codex / Thread；runStreamed 事件 → AgentRuntime 接口产出 sdk_message 事件；最小 chat 跑通 |
| 5.2 chooseRuntime + Kind 扩展 | 0.5d | `runtimes/index.ts` 路由 `openai-codex` → CodexCliRuntime；`core/src/index.ts` PROVIDER_KINDS 加 + POST /providers 验证（baseUrl/apiKey null + 单例 + path/auth 检测）+ defaultSandbox 字段 |
| 5.3 流式合成 + 事件映射 | 0.5d | 把 codex SDK 事件转 Claude-shaped SdkMessage（`thread.started` → system/init；`item.completed(agent_message)` 文本拼 stream_event/text_delta；`turn.completed` → result；`error` → error） |
| 5.4 sandbox UI + canUseTool 短路 | 0.5d | ProviderPanel 第 5 entry + sandbox 单选；AgentSettings 加 sandbox 切换；SessionManager 在 kind=openai-codex 时 canUseTool 自动 allow（codex 不弹审批） |
| 5.5 codex MCP 注入（内部 + 外部） | 0.75d | codex SDK 接受 mcpServers 配置（spike 确认形态后实施）：注入 peer-mcp/ask-user-mcp/Task + loadEnabledMcpServers() 的用户外部 MCP；`item.mcp_tool_call` 事件映射成 SdkMessage tool_use 块 |
| **5.5b OpenAI runtime 接外部 MCP**（W21 合并） | **1d** | 新建 `mcp-adapter.ts` 把 Ensemble McpServer 表的 stdio/http/sse 配置转成 `@openai/agents-core` 的 `MCPServerStdio` / `MCPServerStreamableHttp` / `MCPServerSSE` 实例；OpenAIAgentRuntime 在 query() 入口消费 `opts.mcpServers` 中的外部条目（type=stdio/http/sse 的，不动 SDK-instance 类型的内部 MCP）；codex Slice 5.5 复用同一 adapter |
| 5.6 W17 usage 接入 + billingModel 列 | 0.75d | UsageEvent 加 billingModel 列 + idempotent migration；codex `turn.completed` 字段映射；W17 聚合层加 subscription 过滤 + `subscriptionTurns` 字段；UI cost 列 subscription 行显示 `—` |
| 5.7 auth-missing UX | 0.25d | 启动期 `~/.codex/auth.json` 检测 + ProviderPanel 「需登录」按钮（点击 Tauri shell 启动一个 cmd 弹出跑 `codex login`，或直接复制命令）|
| 5.8 ChatPane banner | 0.25d | codex agent 顶部显示 sandbox 等级 + 「无逐工具审批」提示 |
| 5.9 W18 NSIS hook 扩展 | 0.1d | `installer-hooks.nsh` 的 taskkill 加 `codex.exe` |
| 5.10 单测 + 端到端 | 0.5d | runtime mock test + 真机端到端 prompt（含 MCP 工具调用）|
| 5.11 文档 | 0.5h | architecture.md / HANDBOOK / multi-sdk-integration.md 加注脚（W16 §2 reject 撤销）/ development-log |

**总约 6d**（v2.1 加 5.5b 后从 v2 的 5d 升）。

---

## 6. 与现有架构的兼容点

- **AgentRuntime 接口不变**（W16 Slice 1.5 + Slice 5.1 拓展）：codex runtime 实现同一接口；SessionManager 调度逻辑不变
- **WS / ServerMsg 协议不变**：合成 Claude-shaped SdkMessage 让前端零改
- **W17 UsageEvent 表**：加一列 + 写入分支；查询接口加一个过滤
- **W18 NSIS hook**：扩 taskkill 列表
- **W19 openai-local kind**：保留；与 openai-codex 平行存在，**用户在 OpenAI 体系里 3 选 1**（local / codex / compat）

---

## 7. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| codex SDK 与本机 codex CLI 版本不兼容 | 启动期 `codex --version` 校验 + 不匹配时 warn banner（不阻止运行）|
| codex SDK API 还年轻可能变 | pin 版本；隔离在 `runtimes/codex.ts` 单文件，类比 W16 OpenAIAgentRuntime 隔离策略 |
| codex agent 没有逐工具审批是用户视角的「行为不一致」 | HANDBOOK 显式说明；ChatPane banner 明示；不是 bug 是 feature |
| ChatGPT 订阅到期 / 限速 | codex SDK 报 quota 错 → 透传错误消息；不重试 |
| 用户本机没装 codex 但 DB 残留 openai-codex provider | 启动期检测 + metadata 标 missing + UI 灰显 entry + 提供 disable 按钮 |
| 用户 `codex logout` 后 token 失效 | codex SDK 抛 auth 错 → SessionManager 透传 error 给前端 + 提示重 login |
| codex SDK 不支持外部 stdio MCP 注入（spike 决议）| 退化方案：v1 仅注入内部 peer/ask/Task；外部 MCP 推 v1.1 + W21 一并解决 |
| `~/.codex/auth.json` 路径在不同平台不同 | codex SDK 内部处理；我们仅作存在性检测——用 `os.homedir()` 拼平台-aware 路径 |

### 7.1 v2.1 合并的范围

- **OpenAI side 外部 MCP 接入**（原 W21）：本次一并修。`OpenAIAgentRuntime.query()` 之前 0 处 `mcpServers`，用户配的 McpServer 在 OpenAI agent 上看不到——v2.1 通过 5.5b 修补。**内部 MCP**（peer-mcp / ask-user-mcp / Task）已经在 W16 Slice 5.x 通过 NormalizedTool 接入 OpenAI side 不动；本次只补外部 stdio/http/sse 这条路径

---

## 8. 显式不做（避免范围蔓延）

- 不 bundle codex 二进制进 SEA（依赖用户本机装）
- 不自动 install codex（README 指引）
- 不读 `~/.codex/auth.json`（codex SDK 全权处理）
- 不实现 JWT refresh / OAuth flow
- ~~**不修 OpenAI side 外部 MCP 缺失**——立 W21~~（v2.1 合并进 W20，见 §5.5b）
- 不支持 codex CLI 的 plugin / hook / 自定义 model 设置（v1 默认行为）
- 不对 codex turn 折算 USD（subscription 经济学）

---

## 9. 验收标准

- [ ] **spike 完成**（5.0），结果写入 `docs/plans/codex-cli-spike.md`
- [ ] codex 在 PATH + auth.json 存在 → ProviderPanel 第 5 entry 可点；sandbox 单选默认 `workspace-write`
- [ ] codex 在 PATH + auth.json 缺失 → entry 可点；表单显示「需登录」+ codex login 指引
- [ ] codex 不在 PATH → entry 灰显 + tooltip install 链接
- [ ] 创建 openai-codex provider：baseUrl / apiKey 必须 null；单例约束生效
- [ ] 简单 prompt（"what is 1+1"）能收到流式响应 + 最终 assistant 文本
- [ ] codex agent 用 Read/Edit/Bash 跑文件读取 task，前端 ToolCard 渲染正确
- [ ] codex agent **不弹 PermissionDialog**（canUseTool 被短路）；sandbox=read-only 时写入操作由 codex 自身拒绝、前端展示拒绝原因
- [ ] codex agent 能调用内部 MCP：`peer_send` 给 Claude/OpenAI agent，对方收到
- [ ] codex agent 能调用 `ask_user`，前端弹 user_question
- [ ] codex agent 能调用 `Task` 创建 subagent（与 OpenAI side W16 Slice 5.3 一致）
- [ ] codex agent 能调用用户外部 MCP server（McpServer 表 stdio/http/sse）
- [ ] **OpenAI agent（openai-local / openai-compat）也能调用用户外部 MCP server**（5.5b 合并 W21 验收）
- [ ] 同一 McpServer 表行（一份用户配置）能同时被 Claude / OpenAI / codex 三个 runtime 消费——`mcp-adapter` 单元测试覆盖三个 SDK 形态转换
- [ ] turn 完成后写 UsageEvent：`billingModel='subscription'`，`costUSD=0`，`costKnown=true`
- [ ] 统计面板 totals.costUSD **不包含** codex turn 的 0 cost（subscription 过滤）；但 totals.turns / token 字段包含
- [ ] 统计面板 detail table cost 列：subscription 行显示 `—`；新 stat 字段 `subscriptionTurns` 让用户知道有几次 codex turn 在订阅范围内
- [ ] AgentSettings 能切换 agent 的 sandbox 等级（不需要重建 provider）
- [ ] ChatPane codex agent 顶部显示 sandbox banner
- [ ] W18 NSIS hook 也杀 `codex.exe`
- [ ] 跨 runtime peer_send：Claude agent ↔ Codex agent ↔ OpenAI agent 三方双向通

---

## 附 1：v1 → v2 修订总账

| v1 决策 | v2 决策 | 来源 |
|---|---|---|
| 手写 spawn + 行解析 | `@openai/codex-sdk` 库嵌入 | review A2 |
| codex 是否有 headless = load-bearing 未知 | spike 范围缩窄到 permission/usage/MCP 字段映射 | review A1 |
| per-call canUseTool 桥 | sandbox-tier 静态等级 + canUseTool 短路 | review B1 + 接受 ① |
| codex turn cost 入 pricing.json + totalCost | UsageEvent 加 `billingModel` 列；subscription 不入 totals | review D3 + 作者数据模型微调 |
| codex agent 不接 Ensemble MCP（v1 不接） | **接内部 + 外部 MCP 完整体验** | 用户决议 Option 3 |
| auth missing → disable | 显示「需登录」引导 | review C3 |
| codex CLI 版本管理 = README 注 | + 启动期 `codex --version` 校验 + 兼容矩阵 banner | review A3 |
| 流式合成事件源 = stdout 行解析 | 事件源 = SDK 类型化事件（`turn.started` / `item.completed` / `turn.completed` / `error`）| review A4 |
| 工作量 4-4.5d | ~5d（MCP option 3 + billingModel schema 增量）| 综合 |
| W21（OpenAI 外部 MCP）独立立项 | **合并进 W20 (v2.1)**，+1d → 总 ~6d | 用户决议（避免「codex 有外部 MCP，OpenAI sk-key 没有」的不对称） |

## 附 2：W21 合并说明（v2.1）

**原 W21「OpenAI side 接用户外部 MCP」并入 W20**。理由：codex 接外部 MCP 会让「Claude / codex 有 / OpenAI sk-key 没有」的不对称非常显眼，分两个工单做反而对用户体验有更差的中间状态。

技术上两件事高度重叠：
- 共用 `core/src/sessions/runtimes/mcp-adapter.ts` 助手：把 Ensemble McpServer 表里的 stdio/http/sse 配置分别转成 `@openai/agents-core` 的 `MCPServerStdio` / `MCPServerStreamableHttp` / `MCPServerSSE` 实例（Ensemble 现有 McpServer 字段 `transport: 'stdio' | 'http' | 'sse'` + `config: {command/args/env | url/headers}` 完美对齐 OpenAI SDK API）
- OpenAIAgentRuntime 与 CodexCliRuntime 都在 query() 入口调 `adaptExternalMcpServers(opts.mcpServers)` 后注入到各自 SDK 的 Agent / Codex 构造参数

内部 MCP（peer-mcp.ts / ask-user-mcp.ts）形态是 `McpSdkServerConfigWithInstance` —— **不走 adapter**：
- OpenAI side 维持 W16 Slice 5 的现状（NormalizedTool 注册成 FunctionTool）
- codex side 是否走 NormalizedTool 还是 SDK MCP 注入，由 5.0 spike 决定

不动的是 Claude side——Claude SDK 已经天然消费 stdio/http/sse + SDK-instance 两种 MCP 配置，路径已就位。

## 附 3：W16 v2 §2 决议撤销注脚

W20 实施时需要给 [`multi-sdk-integration.md`](./multi-sdk-integration.md) 加一行：

> §2 当时 reject「codex CLI as sidecar」基于「codex 用户群小/文档少」。2026-05-11 W20 撤销：codex 已发布官方 TS SDK（`@openai/codex-sdk`），用户群增长，且 spawn 由 SDK 内部处理，对 Ensemble 代码而言是库嵌入而非 CLI 包装。新建 `CodexCliRuntime` 作为第三 runtime；详见 [`codex-cli-runtime.md`](./codex-cli-runtime.md)。

---

## 附 4：Memory 关联

- W17 [FK CASCADE 不该吞业务/审计数据](../../C:/Users/Aad_y/.claude/projects/D--WorkSpace-AgentUI/memory/feedback_fk_cascade_data_loss.md)：codex turn 写入 UsageEvent 同样适用——agent 删除不影响 codex 历史 cost（subscription 表达 ≠ unknown）
- W20 [写新设计稿前重读 CLAUDE.md §1](../../C:/Users/Aad_y/.claude/projects/D--WorkSpace-AgentUI/memory/feedback_reread_claude_md_before_design.md)：本稿 v1 违反 §1 锁定决策的教训；v2 改用 SDK 后符合
