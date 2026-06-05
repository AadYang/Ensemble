# `codex-cli-runtime.md` 审阅意见

> 审阅对象：[`codex-cli-runtime.md`](./codex-cli-runtime.md)（W20 提案）
> 审阅日期：2026-05-11
> 审阅方法：先调研 codex CLI / SDK 当前公开能力，再对照设计稿判断方向与细节
>
> **结论**：方向正确（用 codex 拿 ChatGPT OAuth 这条路对），但设计稿的核心实施路径需修正：
> 1. **改用 `@openai/codex-sdk`**（OpenAI 官方 TS SDK），而非手写 spawn + 行解析
> 2. **§5.4 permission 桥不成立**——codex 没有 per-call approval callback，安全模型是 sandbox-tier
> 3. **codex turn cost 应 null**（ChatGPT 订阅计费），不参与 totalCost
>
> §0 spike 内容大幅缩小：原稿前提"是否有 headless"已被官方文档预先解决，剩余 spike 只需确认 permission / usage / MCP 三个字段映射。

---

## 0. 方向性事实清单（设计稿写作时未掌握的）

1. **codex 有官方 TS SDK：`@openai/codex-sdk`**（OpenAI 维护，npm 包，Node.js 18+）
   - API：`Codex` / `Thread` 类，`startThread / resumeThread / run / runStreamed`
   - 实现机制：SDK 内部 spawn `codex` CLI 子进程 + JSONL stdin/stdout 通信
   - 与 `@anthropic-ai/claude-agent-sdk` 架构**完全对称**

2. **codex 有稳定 headless 模式 `codex exec --json`**：
   - JSONL 事件流，schema 公开
   - 事件类型：`thread.started / turn.started / turn.completed / turn.failed / item.started / item.completed / error`
   - Item 涵盖：agent messages / reasoning / command executions / file modifications / MCP tool invocations / web searches / plan updates

3. **认证**：
   - 默认从 `~/.codex/auth.json` 读 ChatGPT OAuth cached token
   - 或 `CODEX_API_KEY` env 走 API key
   - device-code flow (`codex login --device-auth`) 支持 headless 登录

4. **Sandbox / Approval 模型**：
   - 启动期声明 sandbox 等级：`--sandbox read-only`（默认）/ `workspace-write` / `danger-full-access`
   - **没有逐 tool call 的 callback 模型**，没有 `canUseTool` 等价物

→ 设计稿 §0 "必须先 spike codex 是否有 headless"的前提**大部分已被官方文档预先解决**。spike 只剩 permission/usage/MCP 三个细节字段映射。

---

## A. 方向性修正

| # | 问题 | 建议 |
|---|---|---|
| A1 | §0 spike 前提过时 | "codex 是否有 headless / JSON stream" 已有官方答案：是。**§0 改写为"spike 已部分回答，剩余唯一未知 = permission/usage/MCP 字段映射"**，避免误导读者以为整个方案存在性未确认 |
| A2 | **最重要的方向修正：改用 `@openai/codex-sdk` 而非手写 spawn + 行解析** | §1 表第 2 行 / §2 架构表 / §5.1 全部改：用 `@openai/codex-sdk` 嵌入，与 Claude side 用 `@anthropic-ai/claude-agent-sdk` 的架构完全对称。优势：① 行解析器零代码，事件 schema 由 OpenAI 维护；② SDK 升级跟随 codex 协议变更；③ 与"Agent 内核走库方式嵌入"项目级技术决策（CLAUDE.md §1）一致。SDK 内部仍是 spawn CLI——"依赖用户本机装 codex"的前提不变，只是把行解析责任交给 OpenAI |
| A3 | §1 表第 6 行 "codex CLI 版本管理：依赖用户本机已装 codex" | 改用 SDK 后仍要本机 codex CLI（SDK spawn 它）。**新增检测点**：`@openai/codex-sdk` 与本机 codex CLI 版本兼容矩阵；启动期 `codex --version` 校验 |
| A4 | §1 表第 9 行 "流式合成：Claude-shaped SdkMessage" | 改用 SDK 后，事件源是 `runStreamed` 的 `thread.started / turn.started / item.completed(agent_message) / turn.completed / error` 等。映射目标依然是 Claude-shaped SdkMessage（与 OpenAIAgentRuntime W16 Slice 2 同款）。§5.3 切片要重写映射表 |

---

## B. Permission 模型是真 blocker

| # | 问题 | 建议 |
|---|---|---|
| B1 | codex 没有 per-call approval callback。**§1 表第 8 行 / §5.4 「permission 桥」整段都不成立** | 二选一（须用户决议）：① **接受 codex 的 sandbox-tier 模型**——v1 在创建 openai-codex provider 时让用户选默认 sandbox 等级（read-only / workspace-write / danger-full-access），SessionManager 在 codex runtime 下**不再走 canUseTool 弹审批**。**用户视角：codex agent 没有逐工具审批 UI，与 Claude agent 行为不一致**——这是平台差异；② 自维护逐 call 拦截层（用 SDK 拦截 `item.command_execution` 事件后人工 hold）——但 codex 不支持"暂停执行等待确认再继续"的协议，做不到真正的 gate，只能"事后展示"。**推荐 ①**，写明 codex agent 安全模型与 Claude 不同 |
| B2 | UI 影响 | ProviderPanel 选 codex entry 时多出一个 "default sandbox" 单选（默认 `workspace-write`）；ChatPane 顶部 banner 提示 "codex runtime 不支持逐工具审批，由 sandbox 等级控制"。验收清单加这条 |
| B3 | 现有验收 §8 第 7 行 "调用 permission-gated 工具时弹 PermissionDialog；allow / deny 都正确转回 codex" | 与 B1 决议矛盾。按 B1 ① 删除此条；改为 "danger-full-access 模式下 codex 不弹审批；read-only / workspace-write 下违反 sandbox 等级的写入由 codex 自身拒绝，前端展示拒绝原因" |

---

## C. ProviderKind / 认证细节

| # | 问题 | 建议 |
|---|---|---|
| C1 | §3 字段约束 "`apiKey`: 必须为 `null`（用 OAuth）" | codex 实际支持两种认证：`~/.codex/auth.json`（OAuth）**或** `CODEX_API_KEY` env。v1 只走 OAuth 路径是合理的（W19 已有 sk-key 的 openai-local），但应**明确**：openai-codex provider 创建时如果检测到 `~/.codex/auth.json` 不存在，banner 提示 "请先在终端跑 `codex login`"，而不是默默用 env var |
| C2 | §3 "只能存在一个 openai-codex provider" | 合理，但理由要写清：codex CLI 在本机一份 auth，多个 provider 行没意义。同步加 unique index 在 Provider 表 `kind='openai-codex'` 时 |
| C3 | §3 "启动期检测：codex 不在 PATH 时标 disabled" | 增加：codex 在 PATH 但 `~/.codex/auth.json` 缺失 → 不 disable provider，metadata 写 `auth_missing`，UI 显示 "需登录" 按钮（点击跑 `codex login`，类似 W15 anthropic-local 体验） |

---

## D. 工具集 / Usage / 范围

| # | 问题 | 建议 |
|---|---|---|
| D1 | §1 表第 7 行 "复用 codex CLI 内置工具集" | OK，但要写清：codex 的内置工具是 Read / Edit / Bash / web_search / plan / MCP-tools。**v1 不让 codex agent 注册 Ensemble 自有的 ask-user MCP / peer-send MCP**——因为 codex 自己有 plan / web_search，工具栈对齐不强求 v1 完成。**或者**确认 codex SDK 支持外部 MCP server 注入（其事件流有 `item.mcp_tool_call`）；如支持，把 Ensemble 现有 MCP 服务挂上去也行——这点 spike 里确认 |
| D2 | §1 表第 10 行 "Usage / cost：写 UsageEvent 表 + 走 pricing.json" | codex SDK 的 `turn.completed` 携带 `usage` 字段（OpenAI 2026 changelog 提到 "exec --json reports reasoning-token usage"）。**实施前 spike 要确认字段映射**：`inputTokens / outputTokens / reasoningTokens / cachedTokens` 对应 W17 Schema 哪些字段；reasoning tokens 单独算还是合并 output |
| D3 | §1 表第 10 行 cost 计算 | codex 走 ChatGPT 订阅，**逐 turn 无现金成本**——与 sk-key 模型本质不同。W17 价格表为 codex turn 算"折合 USD"会误导（用户已付 $20/月，逐次无边际成本）。**推荐**：codex turn 在 UsageEvent 表里 `cost` 字段强制为 `null`，UI 单独标 "subscription"；不与其他 provider 的 cost 累加进 totalCost |

---

## E. 实施切片调整

基于 A2（改用 SDK）和 B1（去掉 permission 桥）：

| 阶段 | 原工作量 | 调整后 | 备注 |
|---|---|---|---|
| 5.0 spike | 0.5d | **0.5d** | 内容缩小为：permission 模型 + usage 字段 + MCP 注入能力 |
| 5.1 CodexCliRuntime 骨架 | 1d | **0.5d** | 用 SDK 后行解析归零，主要工作是事件映射 |
| 5.2 chooseRuntime + Kind | 0.5d | 0.5d | 不变 |
| 5.3 流式合成 | 0.5d | 0.5d | 不变 |
| 5.4 ~~permission 桥~~ | ~~0.5d~~ | **0.5d** | 改为 sandbox-tier 选择 UI + provider 字段加 `defaultSandbox` |
| 5.5 W17 usage 接入 | 0.5d | 0.5d | 加 D3 的 cost=null 处理 |
| 5.6 前端 UI 第 5 entry | 0.5d | 0.5d | 加 sandbox 单选 |
| 5.7 单测 + E2E | 0.5d | 0.5d | 不变 |
| 5.8 文档 | 0.5h | 0.5h | 不变 |

**总：原 4–4.5d → 调整后 3.5–4d**（用 SDK 省的工作量被 sandbox UI / cost 特殊处理抵消一部分）

---

## F. 风险表补充

§6 风险表加：

- **codex SDK 与本机 codex CLI 版本不兼容**：SDK 内部 spawn CLI 时通信协议错位 → 启动期 `codex --version` 校验 + 不匹配时 banner
- **ChatGPT 订阅到期 / 限速**：codex SDK 报 quota 错 → 透传错误信息；不重试

---

## G. 「待用户决议」补充

§9 现 5 项，建议追加：

6. **permission 模型选择**：B1 ① 接受 sandbox-tier（推荐）vs ② 自实现"事后展示" → 倾向 ①
7. **codex turn 的 cost 表达**：D3 `cost=null` 标 "subscription" vs 按 GPT-5.x 等价价折算 → 倾向 null
8. **是否允许 codex agent 用 Ensemble 自有 MCP 服务**（ask-user / peer-send）→ 看 spike 结果，倾向 v1 不挂，v1.1 再说

---

## H. 与 CLAUDE.md 既有约束的潜在冲突

| 项 | 状态 |
|---|---|
| CLAUDE.md §1 "Agent 内核：库方式嵌入 SDK，不走 CLI 子进程包装" | A2 改用 `@openai/codex-sdk` 后**符合**（虽然 SDK 内部 spawn CLI，但对 Ensemble 代码而言是库调用）。**原稿的"手写 spawn + 行解析"路线违反这条**——这是 A2 修正后的额外收益 |
| CLAUDE.md §3.5 "CLI 模型白名单卡死非 Claude 名字"备注 "真正的解是 W16 双 SDK" | W20 把 OpenAI 体系拓展为 3 选 1（local / codex / compat），与该备注精神一致 |

---

## 调研来源

- [Codex SDK – OpenAI Developers](https://developers.openai.com/codex/sdk)
- [@openai/codex-sdk – npm](https://www.npmjs.com/package/@openai/codex-sdk)
- [codex/sdk/typescript/README.md – GitHub](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Non-interactive mode – Codex | OpenAI Developers](https://developers.openai.com/codex/noninteractive)
- [Authentication – Codex | OpenAI Developers](https://developers.openai.com/codex/auth)
- [Command line options – Codex CLI | OpenAI Developers](https://developers.openai.com/codex/cli/reference)
- [Headless Execution Mode – DeepWiki](https://deepwiki.com/openai/codex/4.2-headless-execution-mode-(codex-exec))

---

## 总结

> **优先级**：A2（改用 SDK）→ B1（permission 模型）→ D3（cost 表达）→ 其余细节
>
> 三项核心修正都基于"调研出 codex 已有官方 SDK + 公开 sandbox 模型"这一事实，原设计稿在写作时该信息缺失。
>
> 文档结构（决策矩阵 / 风险表 / spike 前置）本身很好；以上意见为信息补正 + 方向校准，非推翻方案。

---

## 设计稿作者答复（2026-05-11）

按 review 顺序逐条标 ✓ 接受 / ⚠ 部分接受 + 微调 / ✗ 反驳。未标的 = 全盘接受。

**先认错**：原稿写作时**未调研 `@openai/codex-sdk` 的存在**——按用户原话「先不做，先出个方案」我跳过了 spike subagent，靠 W19 时段的 codex repo 阅读记忆写设计，结果路径选了「手写 spawn + 行解析」。这条路 review 指出**直接违反 CLAUDE.md §1「Agent 内核：库方式嵌入 SDK」这条锁定决策**（review §H）。SDK 改用 review 推荐的路线后，这个锁定决策保持不变。**这是 review 给我堵上的最大漏洞，价值高于本身的技术细节修正**。

### A. 方向性修正

| # | 处理 | 备注 |
|---|---|---|
| A1 | ✓ 接受 | §0 改写为「spike 范围 = permission/usage/MCP 三个字段映射」；不再说"codex 是否有 headless"未知 |
| A2 | ✓ **关键接受** | 改用 `@openai/codex-sdk`。Slice 5.1 直接消费 SDK 的 `Codex` / `Thread` / `runStreamed`，不再写行解析器。架构表整段重写 |
| A3 | ✓ 接受 | 启动期 `codex --version` 校验 + SDK 兼容矩阵在 README 写明 |
| A4 | ✓ 接受 | 事件源换为 SDK 的 `turn.started / item.completed(agent_message) / turn.completed / error`；目标仍是 Claude-shaped SdkMessage（前端零改） |

### B. Permission 模型

| # | 处理 | 备注 |
|---|---|---|
| B1 | ✓ 接受方案 ① | sandbox-tier 模型不可绕。v1 接受 codex agent **没有逐工具审批 UI**——这是平台行为差异，写进 HANDBOOK。SessionManager 在 codex runtime 下短路 canUseTool（直接 allow）。把"为什么 codex 不弹审批"作为 codex 体系**预期行为**而非 bug |
| B2 | ✓ 接受 | ProviderPanel codex entry 加 `default sandbox` 单选（默认 `workspace-write`）。ChatPane 顶部 banner 仅对 codex agent 显示「sandbox=<level>，无逐工具审批」。验收清单加该条 |
| B3 | ✓ 接受 | 删 §8 第 7 行原 permission gate 验收条；改为 sandbox 违规由 codex 自身拒绝、前端展示拒绝原因 |

### C. ProviderKind / 认证

全盘接受 C1 / C2 / C3。C3 的"auth missing 不 disable 而是显示登录引导"特别好——是借鉴 W15 anthropic-local OAuth 缺失时的体验。

### D. 工具集 / Usage / cost

| # | 处理 | 备注 |
|---|---|---|
| D1 | ✓ 接受 | v1 不让 codex agent 用 Ensemble 自有 MCP；spike 同时确认 codex SDK 的外部 MCP 注入能力，v1.1 看情况接入 |
| D2 | ✓ 接受 | spike 必查 `inputTokens / outputTokens / reasoningTokens / cachedTokens` 字段映射 |
| D3 | ⚠ **接受 + 数据模型微调** | 同意 codex turn cost 不应混进 totalCost——ChatGPT 订阅经济学是真的。**但 W17 现有 schema 用 `costKnown=false` 标"未知 model"** 已经把那个 boolean 占了。建议：UsageEvent 加 **`billingModel TEXT CHECK IN ('metered','subscription')` 列**，默认 `metered`；codex turn 写 `billingModel='subscription'` + `costUSD=0` + `costKnown=true`（**costKnown 改语义为「价格信息完整」，subscription turn 是已知 = 0，不污染 unknownModels**）。前端 byAgent/byModel/byProvider/daily 表渲染时跳过 subscription 的 cost 显示为 `—`，totals.costUSD 求和时排除 `billingModel='subscription'`。需要 W17 现有 `UsageEvent` 表加列 + 聚合层多过滤——~0.5d 增量。这条不在 review §E 切片调整里，要额外加 |

### E. 实施切片

✓ 接受 review §E 的工作量调整。**追加 D3 的 schema 列 + 聚合过滤 = 总 ~4d**（review 的 3.5-4d 偏紧）。

### F. 风险表

全盘接受 §F 两条追加。

### G. 待用户决议

✓ 全盘接受 §G 三条新增。最终 §9 = 原 5 项 + review 新增 3 项 = 8 项。

### H. CLAUDE.md 既有约束

✓ 接受。原稿"手写 spawn + 行解析"路线违反 CLAUDE.md §1 这点最让我警觉——这条决策表（包括 §1 全表）应该在写新设计稿前**重读一次**而不是凭记忆写。**已存入 memory** 作为后续设计稿写作前置流程。

---

### v1 → v2 修订总账

| 项 | v1（原稿） | v2（吸收 review） |
|---|---|---|
| codex 接入方式 | 手写 spawn + JSONL 行解析 | **`@openai/codex-sdk` 库嵌入**（A2 / H） |
| permission 模型 | per-call canUseTool 桥 | **sandbox-tier 静态等级**（B1 / B2） |
| codex turn cost | 进 pricing.json + UsageEvent.costUSD | **`billingModel='subscription'` + 0 cost + 不计入 totals**（D3 + 作者微调） |
| spike 范围 | "codex 是否有 headless" 是 load-bearing 未知 | **缩到 permission / usage / MCP 三字段确认**（A1） |
| auth missing UX | 标 disabled | **显示"需登录"按钮 + 引导 `codex login`**（C3） |
| codex CLI 版本管理 | README 写明 | + **启动期版本校验 + 兼容矩阵 banner**（A3） |
| 工作量估时 | 4-4.5d | **~4d**（A2 省的工作量被 D3 schema 增量抵消） |
| 与 CLAUDE.md §1 关系 | ❌ 违反 | ✅ 符合 |

### 待你下决议（review §G 新增 3 项 + 原稿 §9 5 项）

实施前需要确认的 8 项，重新汇总放原稿 §9。最关键 3 项：

1. **B1 permission 模型**：接受 sandbox-tier ①（推荐）vs 自实现事后展示 ② — 我会按 ① 实施除非你反对
2. **D3 cost 表达**：新增 `billingModel` 列 + subscription turn 不进 totals（推荐）vs 按 gpt-5.x 等价价折算（误导）— 我会按推荐实施
3. **D1 codex agent 用 Ensemble MCP（ask-user / peer-send）**：v1 不接 vs v1 接 — 我会按 v1 不接，留 v1.1

剩余 5 项（spike 时机、版本 pin、PATH 缺失 UX、跨 runtime peer_send reframing、W16 v2 §2 reject 撤销注脚）原稿已有默认，按推荐走即可。

确认这 3 项 + 5 项默认无异议后我把原稿 v1 → v2 改写，commit，然后跑 spike。
