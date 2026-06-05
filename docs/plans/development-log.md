# Ensemble 开发日志

> 按时间倒序记录每次修改的**意图**与**留下的教训**。设计动机不在这里，去看 plan 文档（[`ensemble-spinoff.md`](ensemble-spinoff.md) / [`agent-orchestrator-plan.md`](agent-orchestrator-plan.md)）。架构现状去看 [`../architecture.md`](../architecture.md)。

---

## 2026-05-11 · W20 Codex CLI 第三 runtime（10 个 Slice）

**目标**：让 Ensemble 通过本地 `codex login` 的 ChatGPT-account OAuth 跑 codex turn，作为继 Claude / OpenAI 之后的第三个 runtime。设计稿：[`codex-cli-runtime.md`](codex-cli-runtime.md) v2.1（C 方案 · 含完整 MCP），[`codex-cli-spike.md`](codex-cli-spike.md) 落实 SDK 形态。

| Slice | 落点 |
|---|---|
| 5.0 spike | `@openai/codex-sdk@0.130.0` 类型读完、sandbox 是 per-thread、approvalPolicy 必须固定 `never`（其他模式 SDK 无事件通道、会静默挂）、MCP 走 TOML overrides（无 in-process JS instance 入口）、`reasoning_output_tokens` 合并进 outputTokens |
| 5.1 Runtime 骨架 | `core/src/sessions/runtimes/codex.ts` 新建 CodexCliRuntime，library-embed @openai/codex-sdk（保 CLAUDE.md §1 lock-up） |
| 5.2 注册 | `chooseRuntime` 加 `openai-codex` 分支；POST /providers 验证 codex provider（不收 baseUrl/apiKey、单例约束）；`PROVIDER_KINDS` 加 `openai-codex` |
| 5.3 事件映射 | translateEvent / translateItem：agent_message / command_execution / file_change / mcp_tool_call / web_search / reasoning → Claude-shaped SdkMessage（system/init → stream_event → assistant → result），usage 包含 reasoning_output_tokens 合并 |
| 5.4 sandbox UI + canUseTool 短路 | ProviderPanel codex 表单（无 baseUrl/apiKey、sandbox 三选）；ProviderDTO 暴露 `defaultSandbox` / `codexCliMissing` / `authMissing`；`refreshCodexHealth()` 检测 `where.exe codex` + `~/.codex/auth.json`；SessionManager codex 分支跳过 canUseTool（sandbox 是唯一安全 gate） |
| 5.5 MCP 双向 | `core/src/mcp-bridge.ts` 起 Streamable HTTP MCP 端点（`@modelcontextprotocol/sdk` Server + Fastify all('/api/mcp/internal')）、boot-time BRIDGE_TOKEN、`registerHandlers(agentId, ...)` 在 codex 跑前注册闭包、turn 结束 unregister；codex config.mcp_servers 注入 `{agentorch-internal: {url}}` + 用户外部 MCP TOML 翻译 |
| 5.5b OpenAI 接外部 MCP（W21 合并） | `core/src/sessions/runtimes/mcp-adapter.ts` 翻译 Claude 形 mcpServers → `@openai/agents` MCPServerStdio/StreamableHttp/SSE；Agent 构造前 connectAll、finally closeAll |
| 5.6 billingModel 列 | `UsageEvent.billingModel`（'usage' / 'subscription'）、extractUsageEvents 在 providerKind='openai-codex' 时写 subscription + costUSD=0；aggregator 不改（codex 行通过 cost=0 自然不计费） |
| 5.7 auth-missing UX | ProviderPanel 行内显示 codex CLI missing / auth missing 横幅 + 一键复制 `codex login` 到剪贴板 |
| 5.8 ChatPane sandbox 横幅 | ChatPane 在 codex agent 顶部显示「sandbox=X · no per-tool approval」 |
| 5.9 NSIS hook | `installer-hooks.nsh` PRE-INSTALL/UNINSTALL 加 `taskkill /F /IM codex.exe /T`（codex 子进程不一定走 ensemble-core 进程树） |
| 5.10 测试 + 文档 | extractUsageEvents 加 subscription 用例（3 个）；mcp-bridge.test.ts 覆盖 mcpServersToCodexConfig 7 个分支；dev-log 此条 |

**踩的坑**：
- codex SDK `CodexConfigObject` 是递归 primitive union（`string | number | boolean | CodexConfigValue[] | CodexConfigObject`），没有 `unknown`，传 `Record<string, Record<string, unknown>>` 直接撞类型墙。解法：`as unknown as CodexOptions['config']` 双重 cast。
- codex SDK 不暴露 `mcpServers` 直参 / 不收 user-defined Tool，**所有** MCP 都要走 codex CLI 的 TOML（child process + URL）。我们的内部 peer/ask/Task 必须通过 HTTP bridge 暴露，不能像 Claude side 那样直接传 in-process instance。
- codex 的 4 种 approvalPolicy 里只有 `never` 在 SDK 类型表里有完整事件覆盖；其他三种在 SDK 现版本下没有 approval 事件 surface，会静默挂。v1 必须固定 `never` + sandboxMode。

**留下的规则**：
- **每加一个新 runtime 都要先 spike 类型再写代码**（W20.5.0 救了一周——发现 Path A/B 全死、Path C 是唯一可行；如果按 v1 原稿写完才发现就要回退）。
- **codex 行的 cost 必须显式 0**：subscription billing 必须 costUSD=0 + billingModel='subscription'，否则 W17 aggregator 会按 token × price 计费、双重收钱。
- **新 sidecar 进程要进 NSIS hook 杀名单**：codex.exe 不走 ensemble-core 进程树（spawn 时机/进程组分离），需要单独 taskkill。未来加新 sidecar 同样要更新 `installer-hooks.nsh`。
- **MCP bridge 闭包绑定改 per-request 注册表**：Claude side 是 per-turn 构造 sdkMcpServer（闭包绑死 fromAgentId）；codex side 是 HTTP 跨进程，必须 `registerHandlers(agentId)` + finally `unregisterHandlers`，否则后续 agent 调 MCP 会拿到上一个 agent 的闭包。

---

## 2026-05-11 · W18 NSIS hook 杀 sidecar

### `d7046e0` fix(installer): NSIS preinstall hook kills ensemble-core sidecar

**触发**：用户报装新版时如果 Ensemble 还在运行，安装失败。确认根因是 Tauri NSIS 默认模板的 `CheckIfAppIsRunning` 只杀 main binary（`ensemble.exe`），不知道 sidecar `ensemble-core.exe` 存在，导致 sidecar 孤儿锁住自身 EXE 文件、覆盖步骤失败。

**根因细节**：W15 stage 5.9 落地的 Rust 端 cleanup（`WindowEvent::CloseRequested` / `RunEvent::Exit` 调 `child.kill()`）只在干净 close 路径里走。NSIS 用 TerminateProcess 硬杀 main binary 时 Rust 收不到信号，cleanup hooks 跳过，sidecar 留下。

**改动**：`src-tauri/installer-hooks.nsh` 加 `NSIS_HOOK_PREINSTALL` + `NSIS_HOOK_PREUNINSTALL` 两个宏，跑 `taskkill /F /IM ensemble-core.exe /T` 然后 sleep 500ms 让 Windows 释放文件句柄。`tauri.conf.json` 加 `bundle.windows.nsis.installerHooks` 指向该文件。验证：生成的 `installer.nsi:28` 出 `!include "...installer-hooks.nsh"`；端到端 smoke 装 setup.exe /S 后原 sidecar PID 被杀、新 `$INSTDIR\ensemble-core.exe` 93.38 MB 写入成功。

**留下的规则**：
- **Tauri NSIS 默认模板只管 main binary，sidecar/externalBin 全部要自己 hook 杀**。未来加新的 sidecar（不只是 ensemble-core）也要进 `installer-hooks.nsh` 的 taskkill 列表。
- 不要依赖 Rust 侧 cleanup handlers 在升级安装场景生效——NSIS TerminateProcess 跳过它们。安装期进程清理必须在 NSIS 层做。
- 用 `taskkill /T`（树形）不只是 `/F`，因为 sidecar 可能 spawn claude CLI / spawn 别的子进程。

---

## 2026-05-11 · W17 Token 消耗统计 v3 实施

### `d76e240` feat(usage): token usage stats dialog with UsageEvent table

**触发**：W16 多 provider × 多 runtime × 多 agent 落地后，单天累计消耗无法心算。用户提议参考 stormzhang/token-tracker（实测 URL 404，参考缺失），让我基于同领域调研 + Ensemble 自身数据形态做设计。

**关键决策（v3 vs v2）**：用户回怼 v2「删 agent 接受 cost 丢失 + 警告」方案，给出根本性框架：「历史 cost 是数据，为何会和 agent 强绑定」。推翻 v2，新建 `UsageEvent` 表归一化账单数据：
- agentId / providerId nullable FK + ON DELETE SET NULL
- snapshot 字段（agentName / providerName / providerKind / parentId / model）写入时冻结
- 聚合层 `aggregateUsage()` 直接读这张表，不再扫 Message.payload
- Message 表保持 CASCADE（chat history 该跟 agent 一起死），UsageEvent 独立留存

**改动**（10 个 slice，~3.5d）：
- 后端：`UsageEvent` 表 + 3 索引 + repo；`pricing.json`（Claude/OpenAI 官方全 SKU）+ `pricing.ts` 双轨（内嵌 + `appDataDir()/pricing-overrides.json` 浅合并）；`SessionManager.persistResultMessage` 双写钩子；`OpenAIAgentRuntime` 监听 `StreamEventResponseCompleted` 合成 `modelUsage` 与 Claude 对齐；`SessionManager.quickQuery` 也写 source='meta' row；`GET /api/usage/summary` endpoint 含 4 维度聚合 + topAgent + includeDescendants 子树滚动。
- 前端：`UsageStatsDialog` 模态弹窗（recharts stacked AreaChart 按 provider 色块 + line toggle、4 stat cards 含可点 topAgent、4 维度 groupBy 切换、include-descendants tree toggle、CSV 跟随当前 groupBy）；顶部条加 `◔` 按钮（保持项目 Unicode glyph 风格不引入 lucide）；i18n en+zh 各 20+ 键。

**测试**：62 → 90，新增 pricing/usage-extract/usage-aggregate 三套套件（unknown model 落 bucket、cache 折扣、descendants 不重复累计等不变量）。

**E2E 验收**：fresh sidecar + 4 注入 UsageEvent rows → 聚合 endpoint 返完整结构 + unknownModels + topAgent；删 agent main 后 byAgent 显示「(deleted)main: $0.1575」，totals 不掉钱——用户提出的根本诉求达成。

**留下的规则**：
- **FK CASCADE 不该吞业务/审计数据**。会话/UI 状态可 CASCADE 跟主体死，账单/audit/metric 必须存活——独立表 snapshot 是首选模式（已固化到 memory：`feedback_fk_cascade_data_loss.md`）。
- 价格统一走自维护表。SDK 给的 costUSD 对第三方虚高（按官方价算），不能信。
- 不依赖外部 reference 项目时，公开同领域调研 + 自身数据形态足够支撑设计；显式标注「参考链接 404」让后人 cross-check。

---

## 2026-05-11 · W14 Subagent 推荐 v2 实施

### `43a8542` feat(suggest): subagent recommendation dialog (v2 设计)

**触发**：W16 落地后 backlog 唯一剩项；用户拍板 v2 设计去掉切 Haiku、用 prompt 瘦身换速度。

**改动**：
- 后端：`subagent-catalog.ts`（8 角色目录） + `subagent-suggest.ts`（parser + prompt builder） + `POST /agents/:id/suggest-children` 端点（history take 10 + head 200，30s TTL 缓存，1 次 JSON retry，全失败回 static fallback）。`SessionManager.quickQuery()` 新增 side-channel 接口走父 agent 自己的 runtime（不持久化、不广播）。
- 前端：`SuggestSubagentDialog` 4 卡布局（3 推荐 + 1 永驻自创）；AgentSettings 加「★ 推荐子 agent」按钮；客户端 15s timeout 与服务端对齐；失败静默 fallback 不弹 toast。
- 测试：62/62（catalog 9 + parser 9 新增），smoke 验证 empty-history → static fallback 路径返回 reviewer/tester/debugger。

**留下的规则**：
- 跨第三方 provider 的功能不要假设有"更快档"模型——v1 假设 Haiku 存在被 W16 多 provider 现实推翻。**优化生成速度优先用 prompt 瘦身**（input + output 都瘦），切 model 是最后一招且要 runtime-aware。
- 模型输出 schema 复杂度直接影响 wall-clock——让模型输出 `{key, hint<=80}` 而不是整段 systemPrompt，server 端拼模板把输出 token 从 ~500/项降到 ~30/项。
- "失败兜底"应该是默认行为而不是错误流程——推荐这种 meta-UI 功能挂掉时给用户 "create from scratch" 永驻按钮就够了，不需要 error toast。

---

## 2026-05-11 · W16 多 SDK 原生集成实施 (8 个 Slice)

### `d6e7225` fix(provider): default provider creation must ignore disabled rows (Slice 7)

**触发**：Slice 7 E2E 回归注入 bedrock + autoManaged 旧 row 启动后，发现 `anthropic-default` 没被创建——`ensureDefaultProvider` 把 disabled rows 也算进 count。

**改动**：count 改为 `where: { disabled: false }`；disabled rows 仍然保留给迁移 UI，但不再阻塞 default 种子。

**E2E 验收**：本地 claude OAuth + MiniMax 第三方 anthropic + timicc OpenAI-compat（gpt-5.2，gpt-4o-mini 被 timicc 拒）三套都跑通；双向 cross-runtime peer_send 通过 WS ClientMsg 直接路由也跑通；ExitPlanMode 在 plan mode 下正确 hit permission_request；bedrock + autoManaged legacy row 启动后被正确 disable 并打 deprecatedReason tag。

**留下的规则**：第三方 openai-compat 上游的模型白名单各家不同，preset 列表能列的不一定能 call；E2E 时遇到 502 先试 `/v1/models` 看上游接哪些。

### `5f3810d` refactor(gateway): remove musistudio gateway end to end (Slice 6)

**触发**：Slice 5 落地后 OpenAI provider 已有原生 runtime，musistudio 翻译层无用户使用。

**改动**：删 `core/src/llm-gateway.ts` 整文件 + `/litellm/*` 路由 + `litellm.bootstrap()` + `SessionManager` autoManaged env 分支 + `@musistudio/llms` 依赖。前端删 LiteLLM service bar + Litellm API + 20 个死 i18n keys。Schema 上 `autoManaged` 列保留只读，给 migrate-from-deprecated 端点使用。

**包体积**：SEA 94.96 → 93.35 MB（Δ -1.61 MB）。W16 净 Δ vs 起步 baseline = +0.35 MB（@openai/agents 加进来抵掉了 musistudio）。

**留下的规则**：删功能时先看是否有数据依赖；DB 列就算源码再没人写也保留只读，给未来 migration 留空间。代码层删尽，schema 层留余。

### `9b6bebc` feat(runtime): session-aware tools + plan-mode closure (Slice 5)

**触发**：W16 v2 §4 列出的 OpenAI side feature 对齐缺口——peer_send / ask_user / Task / ExitPlanMode 都没接。

**改动**：`tools/session-aware.ts` 三个工厂（peer_send / ask_user / Task）通过 RuntimeOptions callback 注入；`tools/exit-plan-mode.ts` 静态工具，`needsApproval` 只在 plan mode 下 true。SessionManager.spawnTaskSubagent 创建 child DB row（继承 model + provider + systemPrompt），taskDepth ≥ 3 拒绝。plan-mode systemPrompt 在 SessionManager 端拼装；canUseTool 在 plan mode 自动 deny Edit/Write/Bash 不走 UI。前端 PermissionDialog 接 react-markdown 渲染 ExitPlanMode 的 plan field；`displayToolName` 统一 strip `mcp__<server>__` 前缀让 Claude 长名和 OpenAI 短名同样渲染。

**留下的规则**：跨 runtime 共用的 NormalizedTool 抽象有效；只要 SessionManager 抽象出 callbacks，runtime 就不需要知道 SessionManager。permission 状态机不一定要序列化——同步 await canUseTool 让 state 在 V8 栈上活到 resolve（见 `openai-permission-state-machine.md` §0）。

### `aa7bfea` docs(plan): three Slice 5 design docs

**触发**：W16 v2 §6.2 把 cross-runtime peer_send 列为开放问题；Slice 5 实施前必须先选定方向。

**产出**：[`cross-runtime-peer-send.md`](cross-runtime-peer-send.md) / [`openai-task-handoff.md`](openai-task-handoff.md) / [`openai-mcp-integration.md`](openai-mcp-integration.md)。三个用户拍板项：peer_send OpenAI 端用短名 `peer_send`（前端 normalize）+ Task depth 3 层 cap + cross-runtime 允许 + plan markdown 渲染算 Slice 5 验收 + plan-mode systemPrompt 注入放 SessionManager。

### `6b1e5f6` feat(runtime): OpenAI interrupt-resume permission flow (Slice 4)

**触发**：OpenAIAgentRuntime 在 Slice 2 只做 chat，permission 没接；Slice 4 让 5 种 permissionMode 全部生效。

**改动**：tools/index.ts `shouldRequireApproval(mode, name)` 表化 per-tool gating；OpenAIAgentRuntime.query 改为循环 `run → 检查 interruptions → await canUseTool 每个 item → approve/reject → re-run with state`。32 round cap 防死循环。设计稿 `openai-permission-state-machine.md` 把不需要持久化 state 这一关键判断落了下来。

**留下的规则**：interrupt-resume 不一定要 toString/fromString — 只要外层有 await callback，state 自然在栈上活够久。

### `33715e5` feat(tools): NormalizedTool + 6 built-in tools (Slice 3)

**触发**：OpenAI runtime 需要工具集；Claude SDK 的工具走 CLI 不能复用。

**改动**：`NormalizedTool` 接口（zod object schema + execute）；Read / Edit / Write / Bash（Win 走 PowerShell，POSIX 走 sh）/ Grep（ripgrep 优先，无则纯 Node fallback）/ Glob 六个工具；`toOpenAITool` 适配器接 SDK 的 `tool()` 工厂。Claude side 工具不动（CLI 内置带 hooks / settingSources，替换会破坏链路）。

**留下的规则**：抽象层只为 OpenAI side 服务时省力；强行让 Claude side 也走自己的工具实现就是为对齐而对齐，破坏 hooks 不值。

### `992a218` feat(runtime): OpenAIAgentRuntime minimal chat (Slice 2)

**触发**：Slice 1 抽象层就位，先用最小可工作的 OpenAI chat 验证整条路径。

**改动**：`@openai/agents` 装上（要带 zod ^4，与 `@anthropic-ai/claude-agent-sdk` `^3.25 || ^4` 兼容，但 musistudio 的 openai dep 留下个 zod 3 peer 警告——musistudio Slice 6 删了就消了）；`OpenAIAgentRuntime` 把 SDK 的 RunStreamEvent 合成成 Claude-shaped SDK message（system/init → stream_event/text_delta → assistant → result/success）让前端零改动；history 从 messages 表读出来通过 `user()` / `assistant()` helpers 拼成 AgentInputItem。

**留下的规则**：跨 SDK 的合成型 sdk_message 把"协议适配"压到 runtime 内一处；前端 / SessionManager / DB Schema 都不知道这是 OpenAI 合成的。

### `16780e8` feat(runtime): AgentRuntime abstraction + deprecated provider migration (Slice 1)

**触发**：W16 v2 W16-S0..S2 — 让 Claude side 完全零退化的前提下抽出 runtime 接口，留好 OpenAI side 落地的位置。

**改动**：`AgentRuntime` 接口 + `ClaudeAgentRuntime` 包装现有 query() 调用 + `chooseRuntime(kind)` 工厂；SessionManager 改为通过 runtime 派发，peer-mcp / ask-user-mcp 闭包构造留在 SessionManager 端（Slice 1.7 单测钉死 fromAgentId 不串号）。Provider 表加 `disabled` + `metadata` 列，启动时 `migrateDeprecatedProviders()` 自动 disable bedrock/vertex/autoManaged 旧 row；POST /providers 拒绝 deprecated kind / autoManaged；新加 `/providers/:id/migrate-from-deprecated` 端点把旧 row 的 baseUrl+apiKey 转换成 openai-compat 新 row。前端 ProviderPanel 重构成 runtime+entry 四态决策树，顶部加 deprecation banner + per-row migrate 按钮。

**留下的规则**：删除性变更对 DB 列要保留只读（autoManaged column 不删），让 migration 工具能读老数据；新功能层级抽象，老数据兼容看 metadata。

---

## 2026-05-11 · 设计落盘

### docs(plan): W16 多 SDK 原生集成提案

**触发**：用户接入 timicc OpenAI-compat → model `gpt-5.4` 被 claude CLI 本地白名单拒绝。深挖发现 musistudio gateway 也救不了——transformer 把 model 名原样塞上游请求体，伪装成 `claude-opus-4-7` 同样在上游侧 404。

**根因**：claude CLI 是为 Anthropic 体系设计的 agent 运行时，不只 chat，连 tool_use/tool_result 块结构、permission flow、MCP 协议、模型名校验都是 Anthropic-shaped。要原生支持 OpenAI 体系必须用 OpenAI 自己的 agent SDK。

**产出**：[`docs/plans/multi-sdk-integration.md`](multi-sdk-integration.md) ——抽 `AgentRuntime` 接口；按 provider.kind 路由到 `@anthropic-ai/claude-agent-sdk` 或 `@openai/agents`；废弃 musistudio。v1 估约 2 周。索引：AgentUI 主 plan §11 (g) 添加，本仓库 CLAUDE.md §6 backlog 添加。

**留下的规则**：未来引入新生态（Bedrock / Vertex / Ollama 各家 agent SDK）按同一 `AgentRuntime` 接口实现，**不要**继续套 claude CLI；翻译路径在第三方生态上是死胡同。

## 2026-05-10 · v1 起步周

### `120641c` fix(provider): tolerant model-list parser + verbose diagnostics

**触发**：测 MiniMax `https://api.minimaxi.com/anthropic/v1/models` 时上游返回 200 但解析出 0 模型——之前的 `extractModelIds` 只认 `{data:[{id}]}` 严格 OpenAI/Anthropic 标准。

**改动**：
- 新加 `extractModelIds`，支持 envelope `data` / `models` / `results` / 裸数组，id 字段 `id` / `name` / `model` / `model_id` / `model_name`
- 失败诊断现在带上响应体前 200 字节（之前只说 "0 models in `data` array" 信息量为零）

**留下的规则**：上游响应形状千差万别，扩展支持时改 `extractModelIds` 一处；不要在 `probeModels` 里堆 if-else。

### `dd8c09b` fix(build): prep-sidecar must always rebuild ensemble-core

**触发**：用户报「装新版后 ↻ 显示 `0 models · default`」。这个组合只在**新前端 + 旧 server** 下出现：新前端 fallback `r.discovered?.count ?? r.models.length` 拿到 0，source 走默认字符串 `"default"`。检查时间戳发现 sidecar 还是 14:17 旧的，shell 是新的——installer 是混的。

**根因**：`scripts/prep-sidecar.mjs` 用 `existsSync(SRC_EXE)` 跳过重建，只要文件还在磁盘上就不重打。改了 `core/src/*` 后 sidecar 不会自动跟上。

**改动**：删 existsSync 短路，每次 prep 都强制 `pnpm -F @ensemble/core package`。

**留下的规则**：build 链里不要用「文件存在就跳过」做 idempotency——源文件依赖关系工程脚本不该自己揣测，要么真做依赖图，要么就每次都做。

### `bd85eab` fix(provider): smart Anthropic-compat models discovery

**触发**：用户配 `kind=openai-compat, baseUrl=https://api.minimaxi.com/v1`，刷模型一直只看到 hardcoded opus/sonnet。

**根因（多重）**：
1. 旧 refresh-models 只试一个 URL，且只发 OpenAI auth header
2. AgentSettings 在 `provider.models = []` 时 fallback 到 hardcoded list，让用户误以为「列表对了」
3. openai-compat 不走 musistudio 翻译就直接灌给 SDK 是死路——SDK 是 Anthropic 协议，发 `/v1/messages` 给 OpenAI endpoint 必失败

**改动**：
- 新加 `probeModels(baseUrl, apiKey)`：候选 URL 多个、Anthropic + OpenAI 双套 header 同时发、`anthropic-version: 2023-06-01` 必带
- 返回 `{discovered: {count, sourceUrl}}` 让前端显示具体哪个 URL 工作了
- 失败返回 502 + `tried[]` 数组，每项含 url/status/bodyHead
- 前端 `ProviderPanel` onRefreshModels 显示 `✓ 12 models · <url>` 或 `✗ <message>` 行内
- `AgentSettings` 取消第三方 provider 的假回落，显示「无模型，去刷新」黄色提示
- baseUrl 占位符改成示意 Anthropic-compat URL（智谱、DeepSeek）

**留下的规则**：
- 第三方 provider 列表为空时，**绝不**显示假模型——错得远比直接报错隐蔽
- 任何"自动尝试 N 个 URL"的逻辑，失败时必须返回**所有尝试过的 URL + 上游响应片段**，不然用户看不到才是真正的 bug
- OpenAI-compat 直连的 path 在 v1 不打开，强迫走 musistudio gateway

**用户验证态**：MiniMax 的正确 baseUrl 是 `https://api.minimaxi.com/anthropic`（不是 `/v1`，那是 OpenAI 路径）。智谱、DeepSeek 同理 `xxx/anthropic`。

### `599d7bc` feat: complete Phase A + Phase B (W15 stages 5.2–5.11)

**触发**：用户授权全程实施。

**完成内容（按 stage 罗列）**：

| Stage | 产出 |
|---|---|
| 5.2 fork core | `core/` 从 AgentUI/server 拷 + 改名 `@ensemble/core`、SEA exe 重命名 `ensemble-core.exe`、PACKAGED 检测加 `ENSEMBLE_PACKAGED` 别名、数据目录默认 `~/.ensemble`、保留 `AGENTORCH_*` env 兼容 |
| 5.3 fork desktop-ui | `desktop-ui/` 从 AgentUI/web 拷 + 改名 `@ensemble/desktop-ui`、删除 `next dev` 模式、删除 `allowedDevOrigins` / rewrites、distDir 改 `static-out`、品牌字符串 + localStorage key 前缀全替 |
| 5.4 Tauri init | `src-tauri/` 通过 `tauri-cli init --ci` 生成、identifier `dev.ensemble.app`、productName `Ensemble`、默认窗口 1280x800 + minWidth/Height 800/600、`visible: false` |
| 5.5 sidecar 集成 | `Cargo.toml` 加 `tauri-plugin-shell` + `tokio`、`bundle.externalBin: ["binaries/ensemble-core"]`、capabilities 加 `shell:allow-execute` for sidecar、`scripts/prep-sidecar.mjs` 把 SEA exe 拷成 target-triple 后缀 |
| 5.6 端口动态分配 | core 加 `ENSEMBLE_AUTO_PORT=1` 走 `port: 0`、stdout 第一行打 `ENSEMBLE_LISTENING <port>`、pino 强制走 stderr；Rust 侧 `BufReader` 解析 |
| 5.7 主窗口加载 | `on_sidecar_ready(port)` 在 sidecar 报告端口后 `window.navigate` + `show()` + `set_focus()` |
| 5.8 数据目录 | Rust spawn sidecar 时注入 `AGENTORCH_DATA_DIR = app.path().app_data_dir()`、`AGENTORCH_WEB_ROOT` 同上（dev 用 CARGO_MANIFEST_DIR/../desktop-ui/static-out，prod 用 resource_dir/web） |
| 5.9 生命周期 | `on_window_event` 拦 `CloseRequested` + `RunEvent::Exit` 兜底 → `child.kill()`，验证主进程死 sidecar 同步死 |
| 5.10 系统托盘 | `tauri = features=["tray-icon"]`、`TrayIconBuilder` Show / Quit 菜单、Quit 主动 kill sidecar 再 `app.exit(0)` |
| 5.11 打包链路 | `pnpm desktop:build` 跑 prep + `tauri build` → MSI (38 MB) + NSIS (26 MB) |

**踩的坑（已固化在 CLAUDE.md §2.3）**：
- Tauri 5.4 init 不接受 `--identifier` flag（CLI 版本差异），改 conf.json 手填
- `tauri::tray` feature-gated，`Cargo.toml` 必须显式开
- Tauri sidecar 把 binary 拷到 `target/debug/`，不带相邻 `web/` —— 必须通过 env 注入 web root
- Windows MSVC linker 不在 PATH 时 `cargo build` 报 `link.exe not found` —— 装 VS 2022 Build Tools + VCTools workload
- crates.io 在国内偶发性 HTTP/2 download failure，重试一次通常就好

### `afcbe87` chore: scaffold Ensemble desktop project (W15 stage 5.1)

初始脚手架。pnpm workspace（shared / core / desktop-ui，src-tauri 不在 workspace），CLAUDE.md / README.md 起手稿。AgentUI 仓库零改动验证通过。

---

## 后续 backlog（暂未排期）

- stage 5.12 原生文件对话框替换现有 portal modal（`@tauri-apps/api/dialog`）
- icon 替换默认占位（v1 用 Tauri 默认）
- 跨平台 v1 范围决策（macOS / Linux build）
- 签名证书（v1 接受 SmartScreen 警告）
- 自动更新（`tauri-plugin-updater`）
- 项目库（多 sqlite 切换）
- W14 subagent 推荐功能（设计在 AgentUI 仓库 `docs/plans/subagent-suggestions.md`，到 Ensemble 实施时再迁过来）

---

## 模板（写新条目时照抄）

```
### `<commit-hash>` <commit subject>

**触发**：<什么场景促使这次改动；用户报错 / 自己发现 / 路线图>

**根因**：<如果是 fix，分析根因；feat 跳过>

**改动**：<高层做了什么；不要复述 diff>

**留下的规则**：<这次改动后可固化的判断准则；如果不需要新规则就写「无」>
```
