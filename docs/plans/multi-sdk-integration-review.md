# multi-sdk-integration.md 审阅意见

> **审阅对象**：`docs/plans/multi-sdk-integration.md`
> **审阅依据**：审阅时核对了 `core/src/sessions/SessionManager.ts:sendMessage`、`core/src/llm-gateway.ts`、`shared/src/protocol.ts:ServerMsg`、`core/src/index.ts:231`(Provider.kind 枚举)、`core/src/peer-mcp.ts` / `ask-user-mcp.ts`、`core/package.json`。
> **结论**：方向正确、stage 切分合理；存在若干**事实性错误**和**设计盲点**，按严重程度分级，建议设计 agent 据此修订原文档。

---

## 0. 范围澄清（用户事后追加，已纳入本审阅）

- 删除 `bedrock` / `vertex` 两种 kind。
- 只保留两条路径：**Claude Code** 与 **OpenAI**。
- 每条路径各有两种入口：**官方授权登录** 与 **第三方兼容（baseUrl + key）**。
- DeepSeek / GLM / MiniMax 等第三方上游统一通过 anthropic-compat 或 openai-compat 接入，不再单独建模。

下文所有结论已对齐这个简化方针。

---

## 1. 待回答的设计问题（修订前必须先决断）

### A. "OpenAI 官方授权登录"具体形态是什么？

Claude side 的"官方授权登录"是 `claude login` 的 OAuth + token 持久化，对应当前的 `anthropic-local` kind，含义清晰。

OpenAI side 没有原生 OAuth-for-API 流程。可能解读：

- **i. 默认 baseUrl + 官方 API key**：实质仍是 API key，与"第三方兼容"只差默认 baseUrl → 不需要新 kind，UI preset 即可
- **ii. ChatGPT 账号 OAuth**（类似 Codex CLI）：但 §2 决策表已"不采纳 Codex CLI"，自相矛盾
- **iii. OpenAI Platform OAuth client**：通常给三方应用用，少见

**这条不先答清楚，§2 决策表 / Provider.kind 枚举 / UI 表单都无法定型。**

---

## 2. 严重问题（事实错误 / 实施会直接卡死）

### 2.1 `NormalizedEvent` 类型与现有 `ServerMsg` 协议两层模型混淆

- 原文 §3.3 草案：`type: "init" | "assistant_text" | "tool_use" | "tool_result" | "permission_request" | "user_question" | "result" | "error"`
- 原文 §247 附注：「NormalizedEvent 在 server 内部，发给 frontend 时已经是这个 ServerMsg 形态」
- **事实**：`shared/src/protocol.ts` 的 `ServerMsg` 顶层是 9 种：`hello / agent_created / agent_updated / agent_deleted / status / message / permission_request / user_question / error`。`init/assistant_text/tool_use/tool_result/result` 是嵌套在 `message.msg` 里的 `SdkMessage` union，**不是顶层 type**。
- 把两层拍平到一个 union 会导致：要么改前端协议（违反 §8 "WS 协议不变"验收），要么 ClaudeAgentRuntime 适配层信息损失。

**修订建议**：明确两层模型——
- `RuntimeEvent`（runtime 内部产物）：`message(SdkMessage 子集) / permission_request / user_question / result / error`
- `ServerMsg`（前端协议，不变）：`hello / agent_created / agent_updated / status / ...` 由 SessionManager 自己产出
- runtime 不发 `hello / agent_created / status`，避免实施者误以为 runtime 也要处理这些元事件

### 2.2 `Provider.kind` schema migration 完全缺失

当前 `core/src/index.ts:231` 是 5 元枚举，DB 列也存这些字符串。澄清方针后要删 `bedrock` / `vertex`，文档完全没提迁移。

**修订建议**：§3.3 新增「Schema 与迁移」段，明确：
1. 新枚举值（两种命名风格，二选一）：
   - **A. 双维度**：`kind ∈ {claude, openai}` + `mode ∈ {official, compatible}`
   - **B. 单维度（沿用现有命名）**：`{anthropic-local, anthropic, openai-local?, openai-compat}`（`openai-local` 是否存在取决于 §1.A）
2. 旧 bedrock / vertex provider 的处理：自动迁移、提示用户重建、还是禁用 + 提供导出
3. 启动时 migration 行为：遇到老 kind 值是 throw 还是 graceful degrade
4. UI 表单 kind 下拉的新选项

### 2.3 "OpenAI Agents SDK 自带 file/shell tools" 是错的

- 原文 §4 表格第 2 行：「OpenAI Agents SDK 自带 file/shell tools ✅」
- **事实**：`@openai/agents` 不内置 Read/Edit/Write/Bash/Grep/Glob。Claude side 的工具是 Claude CLI 提供的，不是 SDK 提供的。
- OpenAI side 这 4 个工具必须自己 `tool({ name, parameters, execute })` 实现，并与 Claude side 的行为对齐（路径校验、权限拦截、错误格式）。

**修订建议**：§4 表格第 2 行改为"v1 在 NormalizedTool 抽象层自实现 4 个工具，跨 runtime 复用"。§6.4 估时由 2 天上调到 **3-4 天**。

### 2.4 permission flow 跨 SDK 是两套不同语义，§6.5 估 1 天严重低估

- Claude SDK：`canUseTool: (name, input) => Promise<{behavior, ...}>` —— **同步回调**
- OpenAI Agents JS：`tool.needsApproval` + `run` 返回 `interruptions` + `run(agent, state, { approvals })` **重启 run** —— **中断/恢复**模型
- 两套语义对接 NormalizedEvent 的 `permission_request` 必须设计：interrupt-state 持久化、跨 WS 消息回路恢复 run、abort 时清理 pending state。
- 原文第 136 行 "approval callback，但 mode 定义不同" 措辞误导，让人以为只是参数差异。

**修订建议**：拆出独立 stage `W16-S5a permission 协议跨 runtime 标准化（含 interrupt-resume 设计）`，估 **3 天**。文档需画清楚 OpenAI side 的状态机：`run → interruption → save state → WS to FE → FE response → load state + run resume`。

---

## 3. 中等问题（设计含糊 / 会延期或返工）

### 3.1 `autoManaged × kind` 路由矩阵不全
原文 §6.6 / §8 反复用"不再勾 autoManaged"，但没画完整路由矩阵。结合简化方针，建议矩阵收敛后**直接禁用 autoManaged 维度**（详见 §3.2）。

### 3.2 musistudio 应从"deprecated 但保留"升级为"只读 + 一键迁移"

简化方针下，DeepSeek/GLM/MiniMax 都直连 compat 端点，**musistudio 唯一价值（协议翻译）完全消失**。

**修订建议**：§2 决策表、§6.6 stage、§7 显式不做、§10.3 决策确认四处口径统一为：
- v1 直接拒绝**新建**任何 autoManaged provider
- 旧 autoManaged provider 可读、可删、可一键迁移到对应 compat kind
- 不再保留 musistudio 进程启动逻辑（除非迁移过渡期需要）
- §6.6 stage 措辞从"标 deprecated"升级为"提供迁移工具 + UI banner"

### 3.3 OpenAI side session resume 砍得过粗
- 原文 §4 / §6.2 / §7：「OpenAI v1 不做 resume，每次 new conversation」
- **事实**：Ensemble 自己有 `messages` 表存历史，OpenAI runtime 完全可以"读 messages 表 → 把历史塞 `input`"实现 resume 假象，**比 Claude side 还容易**（Claude side 反而是 CLI session 文件）。

**修订建议**：v1 就实现"OpenAI runtime 自维护 history"，不依赖 SDK 的 resume 概念。这是 OpenAI side 的优势，不是劣势。

### 3.4 "lastSessionId" 措辞与实现错位
- §6.2 开放问题 2 / §8 验收：「换 provider 时清 lastSessionId」
- `lastSessionId` 是 Claude CLI 概念，OpenAI side 不存在。
- **修订建议**：抽象成 "runtime conversation handle"，每个 runtime 自己定义如何 reset。文档统一术语。

### 3.5 systemPrompt 两侧语义差异未点出
- Claude SDK：`customSystemPrompt` 与 CLI 内部默认 system 拼接，受 `settingSources / CLAUDE.md` 注入影响
- OpenAI Agents：`instructions` 直接当 system message，无二次拼装
- §4 表格 "customSystemPrompt ✅ ✅" 掩盖了行为差异。**修订建议**：§4 加脚注，§6 风险加一条"用户在 Claude side 调好的 prompt 切到 OpenAI side 表现会不同"。

### 3.6 §8 验收 "现有所有功能不退化" 太空泛
Claude side 实际有 20+ feature 必须不动：peer_send / ask_user / Task subagent / ExitPlanMode / 5 种 permission mode / hooks / settingSources / mergedEnv 注入 / abortController / 流式 partial assistant_text / ...

特别提示：`peer-mcp.ts` / `ask-user-mcp.ts` 是 per-call `createSdkMcpServer` 闭包绑定 `fromAgentId`，重构 ClaudeAgentRuntime 时若闭包构造时机挪错位置，会导致 fromAgentId 串号——**强烈建议单测覆盖**。

**修订建议**：§8 展开为可勾选的回归 checklist，stage 6.7 之前加"测试支架 + 回归 baseline 录制"。

### 3.7 UI 表单需"两 runtime × 两入口"四态改造
原文 §6.6 只说"编辑表单的 autoManaged 复选框文案改"远不够。新表单决策树：

```
选择 runtime: [Claude] | [OpenAI]
   ↓
选择接入方式: [官方授权登录] | [第三方兼容(baseUrl+key)]
   ↓
若选官方 → 触发 OAuth / 填官方 key
若选兼容 → 填 baseUrl + apiKey
   ↓
拉取 models 列表 → 用户必选默认 model
```

**修订建议**：新增前置 stage `W16-S0 UI 表单四态改造 + 旧 provider 迁移 banner`，估 1 天。

---

## 4. 轻量问题 / 补充建议

### 4.1 SEA 打包未列入 stage
`make-exe.mjs` / `bundle.mjs` 必须把 `@openai/agents` 及传递依赖打进 sidecar exe。原文 §6.1 风险只说"测一下，估计 ~5MB"，没列入 stage。**建议**新增 `W16-S3.5 sidecar SEA 打包验证`（dev 跑通 ≠ SEA 能跑通）。

### 4.2 Stage 编号与章节编号冲突
第 5 节叫"实施切片"但表里编号 6.1-6.8，与 §6 风险章节同号。`§6.5` 既能指章节又能指 stage。**建议**改 stage 编号为 `W16-S1..S8`。

### 4.3 OpenAI Agents SDK MCP 现状需核实
§2 决策表写"MCP 已支持"，§4 把 MCP 留到 v1.1。需要核实当前 `@openai/agents` 的 MCP API 是否稳定、是否能复用 Claude side 的 in-process MCP 注入方式。**建议**风险表加一条：若 OpenAI Agents SDK 的 MCP 接入方式与 Claude SDK 显著不同，peer_send 跨 runtime 设计会延期。

### 4.4 Stage 6.7 测试矩阵收敛
按澄清方针收敛为 **4 组合**：
- Claude 官方授权登录 + Read/Edit
- Claude 第三方 anthropic-compat（如官方 API key 或反代）+ Read/Edit
- OpenAI 官方（默认 baseUrl + 官方 key）+ Read/Edit
- OpenAI 第三方 openai-compat（DeepSeek 或 GLM 任选一家代表）+ Read/Edit

加一个回归：旧 bedrock/vertex/autoManaged provider 启动时不崩。

### 4.5 OpenAI runtime abort 路径未验收
SDK in-process 跑 agent loop 时，`abortController.abort()` 是否能中断**底层 fetch streaming**？OpenAI Agents SDK 0.0.x 的 abort 行为没在文档验收里。**建议**加：sidecar 强退时 OpenAI runtime 必须 1s 内放掉所有 socket。

### 4.6 W14 × W16 交互未评估
W14 (subagent 推荐) 上线后，OpenAI side 因为没 Task 概念，subagent 推荐对 OpenAI agent 失效。**建议** §10 或 §6 风险加一条：W16 上线后 W14 设计需要 runtime-aware（不同 runtime 显示不同推荐集）。

### 4.7 AgentSettings 0-model fallback 防线缺失
§6.2 开放问题 1 已提到。**建议** §8 验收加具体行为：「openai-compat provider 创建时若 `models` 为空，AgentSettings 显示"刷新模型列表"占位、禁止保存 agent」——避免重蹈 W15 "0 模型 fallback default" 的覆辙（CLAUDE.md §2.3 已记录的坑）。

---

## 5. 推荐路由矩阵（建议附进原文档 §3.3）

| 入口 | provider.kind（待 §1.A 定型） | 路由到 | 备注 |
|---|---|---|---|
| Claude 官方授权登录 | `anthropic-local` | ClaudeAgentRuntime | 现有，保留 |
| Claude 第三方 anthropic-compat | `anthropic` | ClaudeAgentRuntime | 现有，保留 |
| OpenAI 官方 | 取决于 §1.A 答案 | OpenAIAgentRuntime | W16 新增 |
| OpenAI 第三方 openai-compat | `openai-compat` | OpenAIAgentRuntime | W16 新增 |
| ~~Bedrock / Vertex~~ | ~~删除~~ | — | 需 schema migration |
| ~~musistudio autoManaged~~ | （旧数据） | 只读 / 一键迁移 | v1 不允许新建 |

---

## 6. 估时与优先级修订建议

| 项 | 原估 | 调整 | 原因 |
|---|---|---|---|
| W16-S0 UI 表单四态 + 迁移 banner | 未列 | +1d | §3.7 |
| W16-S1 AgentRuntime 抽象 | 0.5d | 不变 | — |
| W16-S2 ClaudeAgentRuntime 包装 + 回归 baseline 录制 | 1d | +1d | §3.6 |
| W16-S3 OpenAIAgentRuntime 最小 chat | 1d | 不变 | — |
| W16-S3.5 SEA 打包验证 | 未列 | +0.5d | §4.1 |
| W16-S4 4 个 file/shell 工具自实现 | 2d | +1-2d | §2.3 |
| W16-S5 permission 适配 | 1d | — | 拆分 |
| W16-S5a permission 协议跨 runtime 标准化 | 未列 | +3d | §2.4 |
| W16-S6 文档 + musistudio 迁移工具 | 0.5d | +0.5d | §3.2 |
| W16-S7 端到端 4 组合测试 | 2-3d | 不变 | §4.4 |
| Schema migration（删 bedrock/vertex） | 未列 | +0.5d | §2.2 |

**v1 总估**：原 **2 周** → 修订后 **约 3 周**（含跨平台测试与 SEA 验证）。

---

## 7. 转发给设计 agent 的执行清单

1. 先回答 §1.A "OpenAI 官方授权登录" 形态，再修订 Provider.kind 枚举与 UI 表单
2. 重写 §3.3 NormalizedEvent，明确两层模型（RuntimeEvent vs ServerMsg）
3. §3.3 新增"Schema 与迁移"段（删 bedrock/vertex + 新枚举命名 + 老数据处理）
4. §4 表格修正 file/shell tools 不内置；customSystemPrompt 加脚注
5. §6.5 拆 permission stage，加 §6.5a interrupt-resume 协议设计
6. §6.6 musistudio "deprecated → 只读 + 迁移工具"
7. §6.0 新增 W16-S0 UI 表单四态改造
8. §6.3.5 新增 SEA 打包验证 stage
9. §8 验收展开为 Claude side 回归 checklist
10. §6.7 测试矩阵收敛为 4 组合 + bedrock/vertex/autoManaged 回归
11. stage 编号统一为 W16-S* 避免与章节冲突
12. 估时按 §6 表格更新
