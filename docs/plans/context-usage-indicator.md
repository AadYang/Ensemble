# 会话上下文占比显示 + 关停自动 compact（提案 · 决议版）

> **⚠️ v2 修订（2026-09-15）——§2.2 的单一窗口表 + `resolveContextWindow` 已被取代。**
> 本文档其余部分（关停自动 compact、占比位置、数据通道）仍然有效；但「分母」的取法改了：
> 厂商标称容量、runtime 实际有效窗口、压缩阈值是**三个不同的事实**，分别由
> `advertisedWindow` / `effectiveWindow` / `compactionThreshold` 解析（见
> `docs/plans/context-window-display.md` 文首的 v2 修订表），`resolveContextWindow` **已删除**。
> 进度条的分母只取 `effectiveWindow`（本会话实测 > 版本匹配的 runtime profile > null），
> **不得回退到厂商标称值**；标称值只在旁边/tooltip 展示。前端显示规则在
> `shared/src/context-bar-view.ts`（纯函数 + 单测）。

> **状态**：✅ 已实施；2026-09-14 修订分子算法（本地 tokenizer 数真实 transcript，见 §2.1）
> **目标**：关掉「turn 前自动 compact」，改为在 ChatPane 头部实时显示当前会话的上下文占用百分比，≥70% 红色闪烁提醒；compact 只保留手动 `/compact`。
> **触发动机**：自动 compact 基于「条数 + 字符数」拍脑袋触发，可能正好打断正在处理的代码细节；官方客户端与社区项目已普遍用「上下文占比」替代隐性压缩，用户要求对齐该体验。

---

## 0. 用户决议（定稿）

| # | 议题 | 决议 |
|---|---|---|
| 1 | 自动 compact | **直接关掉，只留手动 `/compact`** |
| 2 | 占比显示位置 | **只在 ChatPane 头部**（不放侧栏 AgentTree） |
| 3 | OpenAI/Codex 的 contextWindow | **接受静态 model→窗口表兜底**（随新模型维护） |
| 4 | 阈值与样式 | **≥70% 红色闪烁**，不做黄色分档；**同意先落盘再开发** |

> **后续修订（2026-09-15）**：议题 3 / 4 已被 `context-window-display.md` 的后续决议取代 ——
> ①分母不再是静态表（见文首 v2 修订）；②阈值改为 context-rot 的 **20/40 三档**
> （≤20% 绿 / 20–40% 黄 / >40% 红，实现见 `shared/src/context-bar-view.ts` 的 `contextTone`），
> 不再是「≥70% 红色闪烁」。本文档下文出现的 `70` / 闪烁相关描述均按此理解。

---

## 1. 现状盘点

### 1.1 当前自动 compact（本次要关）

核心在 `core/src/sessions/SessionManager.ts`：

| 位置 | 内容 |
|---|---|
| `L95-98` | 常量 `AUTO_COMPACT_MIN_MESSAGES=40` / `AUTO_COMPACT_TRIGGER_CHARS=28_000` / `AUTO_COMPACT_KEEP_MESSAGES=16` / `AUTO_COMPACT_SUMMARY_MAX_CHARS=40_000` |
| `L1781-1836` | `maybeAutoCompactBeforeTurn`：条数≥40 且字符≥28k 时，把「除最近 16 条」外的历史压缩成摘要，`DELETE` 全部 Message → 写 `seq=0` 的 system compact 行 → 清 resume 元数据 |
| `L1838-1858` | `replaceMessageHistory`：SQLite 事务里删旧行 + 写摘要行 + 重插保留行 |
| `L770-787` | `truncateTranscript` / `compactPromptFromTranscript`（仅自动 compact 用） |
| `L2686-2711` | `sendMessage` 里每个 turn 前调用 `maybeAutoCompactBeforeTurn` 的调用点 |

问题：触发只看条数 + 字符数，不感知是否在改代码细节；字符数 ≠ 真实上下文占用（代码行字符多、中文消息字符少，偏差大）。

**手动 `/compact` 不动**：`compactAgent`（`L1663`）→ `compactAgentHistory`（`L1720`）整段保留。

**受影响的测试**（`core/src/sessions/__tests__/reasoning-effort-flow.test.ts`）：
- `L153-207`「auto-compacts oversized local history …」→ 删除
- `L207-266`「broadcasts visible running state before auto-compact work starts」→ 删除
- `L729-810` 手动 `compactAgent` 相关 → 保留（如与自动逻辑有交叉则调整）
- `cancel-recovery.test.ts:2903-2937` 是 `trimRuntimeHistory` 保留 compact 摘要的测试，**与自动 compact 无关，保留**。

### 1.2 上下文占比的数据可用性

占比 = `usedTokens / contextWindow`，两个数现状：

**分母 `contextWindow`**
- Claude：SDK `result.modelUsage[model].contextWindow` 已自带、实时准确。
- OpenAI：`runtimes/openai.ts:304` 写死 `contextWindow: 0`（SDK 不统一暴露）。
- Codex：`runtimes/codex.ts:880` 写死 `contextWindow: 0`。
- 当前 `usage-extract.ts` 的 `SdkResultPayload` 直接**丢弃** `contextWindow`（没进 UsageEvent）。

**分子 `usedTokens`（当前上下文已用 token）**
- 每轮 `result` 的 `modelUsage` 已含 `inputTokens / outputTokens / cacheReadInputTokens / cacheCreationInputTokens`，且已落进 `UsageEvent` 各列。
- **归一化口径（重要）**：本项目约定 `inputTokens` 是**不含 cache 的普通输入**，cache 部分单独在 `cacheReadTokens / cacheCreationTokens` 列。依据：
  - `pricing.ts:160-162` 注释明确「inputTokens already excludes the cached portion」；
  - `runtimes/openai.ts:413` 显式 `inputTokens = reportedInputTokens - cacheReadInputTokens`。
- 因此 **`usedTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens`**（当前窗口内实际占用的总 token：普通输入 + cache 命中/写入 + 本轮输出）。

### 1.3 展示位置与数据通道

- 头部：`desktop-ui/components/ChatPane.tsx:779-783`，现有 `status dot + name + model + status`，可直接在 `model` 后加 `ctx {percent}%`。
- 状态报告：`GET /api/agents/:id/status`（`core/src/index.ts:1490`）→ `SessionManager.getStatusReport`（`SessionManager.ts:1860`）→ 前端 `AgentStatusReport`（`desktop-ui/lib/agent-api.ts:84`）。
- WS 协议：`shared/src/protocol.ts:122` `ServerMsg` union（`agent_updated` / `status` / `message` / …），可新增 `context_usage`。
- 前端 store：`desktop-ui/store/agents.ts:44` `AgentState = { summary, turns }`；WS 分发与 `setStatus`（`L476`）都在此文件。

---

## 2. 设计

### 2.1 类型与归一化

```ts
// shared/src/protocol.ts
export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  percent: number; // Math.min(100, Math.round(usedTokens / contextWindow * 100))，封顶 100
}
```

- `usedTokens` = 本地 tokenizer 数真实 transcript（merged systemPrompt + 各 message 可见文本），见 context-usage.ts 头注（2026-09-14 修订：不再用 provider usage 相加 —— DeepSeek anthropic-compat 会上报 `cache_read_input_tokens` 2.83M 超过自身 1M 窗口）
- ~~`contextWindow`：curated 表优先（第三方/OpenAI 官方窗口）> SDK 上报（Claude 实时值）> 静态表兜底。~~
  **v2（2026-09-15）**：这个优先级是反的——运行时上报的**本会话实测值**必须最优先，静态表只能做
  版本匹配的兜底，且两者都拿不到时有值就显示「有效上限未知」而不是拿标称值顶上。
  另外「厂商标称容量」与「运行中有效窗口」是两个字段，不能挤进同一个 `contextWindow`。

### 2.2 上下文窗口事实层（v2：`core/src/context-window.ts`）

~~`resolveContextWindow`~~ 已删除。现在是分层 resolver，每层有各自的可信度与作用域：

| 层 | 内容 | key | 可否做分母 / 写配置 |
|---|---|---|---|
| catalog | 厂商标称上下文窗口 + 最大输出 | `vendor/model` | 否 / 仅在 `confirmed` 且 runtime 键语义已验证时 |
| runtime profile | 实测有效窗口 + 压缩阈值 | `runtime/vendor/model`（+ 版本匹配） | 是（兜底） / 仅阈值已实测时 |
| session 实测 | 本会话 runtime 上报的窗口 | 会话级 | 是（最优先） / 否 |
| override | 用户覆盖 | 同上两层的 key | 按字段 / 需显式 `confidence: "confirmed"` |

```ts
advertisedWindow(model, vendor?): number | null    // 厂商标称，仅显示
effectiveWindow(model, ctx): EffectiveWindow | null // 分母；无可靠值 → null
compactionThreshold(model, scope): number | null    // 未实测 → null → 不设 env
requestedRuntimeWindow(model, scope): number | null  // 唯一可写配置的入口
```

> 具体数值以官方文档 / 实测为准，本文档只定机制。未知模型 → `effectiveWindow` 返回 `null`：
> UI 显示占用 token + 「有效上限未知」（若标称值已知则一并显示），**不给假百分比**。
> 旧的 `models.*.maxInputTokens` override 仍可读，迁移为 `legacy` 条目（仅显示）。

### 2.3 后端：内存态 + 纯函数

新文件 `core/src/context-usage.ts`（纯函数，可单测）：

```ts
export function reportedContextWindowFromResult(msg: unknown, model: string): number | undefined;
export function contextUsageFromTranscript(
  model: string,
  ctx: EffectiveWindowContext,   // { runtime, vendor, runtimeVersion?, sessionObserved?, requested? }
  transcriptTexts: readonly string[],
): ContextUsage | null;
```

逻辑：result 钩子处用 `contextTranscriptTexts` 收集 mergedSystemPrompt + 各 message 可见文本；`contextUsageFromTranscript` 用本地 tokenizer 数 token，分母走 `effectiveWindow(model, ctx)`（`ctx.sessionObserved` 即 `reportedContextWindowFromResult` 的返回值，优先级最高），percent 封顶 100；计数为 0 返回 `null`；**有计数但无有效分母时返回只有 `usedTokens`（+ `advertisedContextWindow`）的对象，`percent` 缺失**。

`SessionManager` 增加：

```ts
private contextUsageByAgent = new Map<string, ContextUsage>();
```

- **写入**：在 `SessionManager.ts:3185`（`msg.type === "result"` 分支、`extractUsageEvents` 同一位置）计算 `contextUsageFromResult(msg, agent.model)`，set 进 map，并 `hub.broadcast`/`sendToSession` 一条 `{ type: "context_usage", sessionId, usage }`。
  - 该分支只处理主会话 result；quickQuery 的 `source='meta'` 走独立路径，不会污染会话占比。
- **重置**：`clearAgentContext`（`/clear`）和 `compactAgentHistory`（`/compact`）成功后 `map.delete(id)` 并广播 `{ type: "context_usage", sessionId, usage: null }`。
- **读取**：`getStatusReport` 返回值加 `contextUsage: this.contextUsageByAgent.get(id) ?? null`（`SessionManager.ts:1916` 的 return 里）。

> 为什么不用 `UsageEvent` 表反查：UsageEvent 是**账单数据**（v3 决议已与 Message 生命周期解耦），`/compact`/`/clear` 后历史 usage 仍在，反查会得到错误的「旧高占比」。内存态随会话重置，语义正确；v1 不做跨重启持久化（重启后下一次 turn 才有值，见「显式不做」）。

WS 协议新增（`shared/src/protocol.ts` `ServerMsg`）：

```ts
| { type: "context_usage"; sessionId: string; usage: ContextUsage | null }
```

### 2.4 前端

**store（`desktop-ui/store/agents.ts`）**
- `AgentState` 加 `contextUsage: ContextUsage | null`。
- 新增 `setContextUsage(id, usage)` action。
- WS 分发处处理 `context_usage` → `setContextUsage`。
- `upsertAgent` 新建 agent 时 `contextUsage: null`。

**ChatPane 头部（`desktop-ui/components/ChatPane.tsx:779-783`）**
- 在 `summary.model` 后、`· {summary.status}` 前渲染：`ctx {percent}%`。
- 无值（`null`）不渲染。
- `percent >= 70` 时加红色闪烁类 `ctx-flash`（颜色 `var(--err)`），并带 `title` tooltip：`{usedTokens.toLocaleString()} / {contextWindow.toLocaleString()} tokens`。
- 全局样式加：

```css
@keyframes ctx-flash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.ctx-flash { color: var(--err); animation: ctx-flash 1s step-end infinite; }
```

**API 类型（`desktop-ui/lib/agent-api.ts`）**
- `AgentStatusReport` 加 `contextUsage: ContextUsage | null`（`import type { ContextUsage } from "@agentorch/shared"`）。

---

## 3. 实施切片

| 阶段 | 内容 | 产出 |
|---|---|---|
| 3.1 关自动 compact | 删 `sendMessage` 调用点（`L2686-2711` 的 auto-compact try 块）、`maybeAutoCompactBeforeTurn`、`replaceMessageHistory`、`truncateTranscript`、`compactPromptFromTranscript`、`AUTO_COMPACT_*` 常量；删/改 `reasoning-effort-flow.test.ts` 两条自动测试；手动 `/compact` 不动 | typecheck + 相关测试绿 |
| 3.2 静态表 + 纯函数 | `core/src/context-window.ts` + `core/src/context-usage.ts` + 单测（公式、cache 计入、Claude 实时值优先、未知窗口返回 null） | 纯函数单测绿 |
| 3.3 后端内存态 + WS | `SessionManager` map + result 钩子写入 + clear/compact 重置 + `getStatusReport.contextUsage`；`protocol.ts` 加 `ContextUsage` + `context_usage` 消息；广播落点 | 后端单测：turn 后广播、clear/compact 后 null |
| 3.4 前端 store + API | `agent-api.ts` 类型、`agents.ts` `AgentState.contextUsage` + `setContextUsage` + WS 处理 | typecheck |
| 3.5 ChatPane 头部 + 闪烁样式 | 头部渲染 `ctx %`、`>=70` 红色闪烁、tooltip、全局 keyframes；i18n（en/zh 的 `title` 文案，值本身无需翻译） | 手动三端 dev 模式人眼 review |
| 3.6 收尾 | 全仓 typecheck + 受影响测试 + 本文档验收打勾 | CI 等价验证 |

总约 1-1.5 个工作日。

---

## 4. 验收标准

- [ ] 每个 turn 结束后，ChatPane 头部出现 `ctx {percent}%`（首次 turn 前 / 重启后不显示，直到下一次 result）
- [ ] `percent >= 70` 时头部该指示器红色闪烁；`<70` 不闪烁
- [ ] tooltip 显示 `usedTokens / contextWindow`（千分位）
- [ ] Claude（anthropic-local / anthropic）走 SDK 实时 `contextWindow`
- [ ] OpenAI-compat / Codex 走静态表；未知模型不显示占比
- [ ] `/compact` 与 `/clear` 后占比立即消失（`context_usage: null`），下一次 turn 重新出现
- [ ] 自动 compact 彻底移除：turn 前不再有任何 `maybeAutoCompactBeforeTurn` / `AUTO_COMPACT_*` 调用；`/compact` 手动仍可用且测试绿
- [ ] 全仓 `pnpm typecheck` 通过，受影响测试通过

---

## 5. 显式不做（避免范围蔓延）

- 不做侧栏 AgentTree 的上下文徽章（决议：仅 ChatPane 头部）
- 不做黄色预警分档（决议：仅 ≥70% 红色闪烁）
- 不做自动 compact 的开关/设置项（决议：直接关）
- ~~不做基于真实 Message 文本的本地 tokenizer 重算~~ **2026-09-14 已改**：DeepSeek anthropic-compat 上报的 `cache_read_input_tokens`（2.83M）超过自身 1M 窗口，provider usage 相加不可信；改为本地 tokenizer 数真实 transcript（对齐 LiteLLM / OpenHands / aider）
- 不把 `contextUsage` 持久化到 DB / 跨重启保留（v1 内存态，重启后下一次 turn 才有值）
- 不把 `contextWindow` 补进 `UsageEvent` 历史表（与 W17 账单统计的「上下文峰值」未来需求解耦，暂不动 schema）
- 不做紧凑阈值提醒按钮（`/compact` 已存在；头部闪烁本身即提醒）

---

## 6. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 静态表数值过时 / 缺新模型 | `effectiveWindow` 返回 null → UI 显示「有效上限未知」（标称值已知则照常展示），**不回退标称值**；随新模型发布更新 `MODEL_CATALOG`（同 `pricing.json` 校准节奏） |
| 厂商标称值与 runtime 实际有效值不一致（Codex clamp、Claude Code 对无表模型回退 ≈200K） | 两者是不同字段：分母只取 `effectiveWindow`，标称值只在旁边/tooltip；runtime profile 必须带版本 + 实测条件（`measuredUnder`），不同配置条件下的数字不得拼进同一条记录 |
| Claude SDK 的 `inputTokens` 口径若与「不含 cache」不符 | 已按 `pricing.ts`/`openai.ts` 现有约定统一；单测覆盖 cache 计入公式，若 SDK 行为变化由 3.2 单测暴露 |
| 多模型 turn 选错 model 条目 | `contextUsageFromResult` 优先 `currentModel`，缺则选最大 usage 条目；单测覆盖 |
| `percent` 封顶 | 本地计数可能略超窗口，percent 封顶 100（对齐 OpenHands `min(100,…)`）；`usedTokens` 不 clamp，tooltip 仍显示真实 used/window |
| 红色闪烁对个别低对比主题可读性 | 用 `var(--err)` 现有错误色，`step-end` 1s 闪烁；三端人眼 review |
| 关自动 compact 后长会话可能直接触达模型上下文上限 | 这是本次决策的有意取舍；头部占比 ≥70% 闪烁即人工触发 `/compact` 的信号 |
