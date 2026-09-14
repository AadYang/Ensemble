# Subagent 与原生 CLI 的对齐方案（W23 提案）

> 状态：已实施（2026-09-11）
> - ✅ §4.1 primer 补 Task 引导（`help/primer.ts` + 单测）
> - ✅ §4.2 前端 ToolCard 加 `[subagent]` 标识与 description
> - ✅ §4.5 codex 侧 MCP 工具 `Task` → `spawn_ensemble_agent` 改名（消同名竞争）
> - ✅ §4.3/§4.4 codex 原生 subagent 采集 + 转译（codex 0.154 实测 item type = `collab_tool_call`，见 §3.3 spike 注记）
>
> 背景：用户新增了 subagent 支持后，观察到 Ensemble 里「很少看到开 subagent」，且质疑该支持是否与直接使用 Claude Code CLI / Codex CLI 等价。
> 结论先行：**不等价。** 三套 runtime 把同一个 `Task` 名字解释成了三条不同实现，只有 Claude 侧是「真原生」，而原生那条恰恰在 Ensemble UI 里不可见。本文给出把「subagent 体验」向原生 CLI 收敛的分层方案。

---

## 1. 目标 / 非目标

### 目标

1. 让模型**更愿意、且更恰当地**使用 subagent（补回被替换掉的行为引导）。
2. 让原生 subagent（Claude SDK 内部、Codex CLI 内部）在 Ensemble 里**至少可感知**（工具卡片可见、最终结果可见）。
3. 消除 Codex 侧「原生 subagent」与「Ensemble 注入的 MCP Task」同名竞争、语义打架的问题。
4. 保持 OpenAI 侧 Scheme B（DB 子 agent）的既有语义，不倒退。

### 非目标

- 不重写 Claude 侧为 Scheme B（原生透明嵌套是正确的 task 语义）。
- 不做「自动把用户任务拆成 N 个子任务」的编排器。
- 不做 subagent 独立 model / provider 选择的 UI（留 v1.1）。
- 不改三套 runtime 的底层执行模型，只补「引导 + 可见性 + 收编」。
- 不动上下文窗口显示（W22）、peer / team / skills 等既有能力。

---

## 2. 现状盘点（为什么不等价）

`SessionManager.ts:1256` 对**所有 runtime** 传同一份：

```ts
tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Task", "ExitPlanMode"],
```

但 `"Task"` 这个字符串在三套 runtime 里被解释成三种东西：

| Runtime | `"Task"` 落到哪 | 子 agent 是 DB 实体？ | Ensemble UI 可见？ | 关键代码 |
|---|---|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` **内部** spawn（方案 A 透明嵌套） | ❌ | ❌（最多父 turn 内一个 tool_use 块） | `runtimes/claude.ts`；`SessionManager.ts:1926-1927`「never reaches this callback」 |
| OpenAI | 与 `tools` 数组无关，由 `opts.spawnTask` 注入 `makeTaskTool`（方案 B） | ✅ | ✅（`agent_created` 广播） | `runtimes/openai.ts:79`；`SessionManager.ts:967` |
| Codex | **双轨**：① codex CLI 原生 subagent（Ensemble 未关）② Ensemble 注入的 MCP `Task` | ① ❌ ② ✅ | ① ❌（中间步骤被丢弃）② ✅ | `runtimes/codex.ts` `translateItem`；`mcp-bridge.ts:191` |

### 三个核心 gap

**Gap 1 — 行为引导被替换掉。**
Claude runtime 传了 `systemPrompt` 字符串后，SDK 从 preset 模式整体退出（`runtimes/claude.ts:37-53` + `settingSources: []`）：没有 Claude Code 内置的操作规程、没有 CLAUDE.md walk-up、没有 auto-memory。而 `help/primer.ts` 里的 Ensemble primer 只教了 peer / skills，**通篇没提 Task**。工具 schema 还在，但「什么时候该并行开 subagent」这条 proactive 策略没了。

**Gap 2 — 原生 subagent 不可见。**
- Claude 侧：子会话由 SDK 内部跑，不进 DB、不广播 `agent_created`、`makeCanUseTool` 拦不到，只能 abort 整轮。
- Codex 侧：`translateItem` 只 surface `agent_message / command_execution / file_change / mcp_tool_call / web_search / reasoning`，注释明确 `todo_list and other items: not surfacing in v1`——codex 原生 subagent 的中间过程被丢。

**Gap 3 — Codex 侧两个「Task」并存。**
codex 原生 subagent 机制没被禁用，同时 Ensemble 又往 codex 的 MCP 里塞了一个同名 `Task`（`mcp-bridge.ts:191` → `spawnTaskSubagent`）。模型面对两个语义不同的 subagent 通道：一个是轻量原生、一个是完整 Ensemble DB agent（重跑 primer+skills+sendMessage）。这与「直接跑 codex CLI」是两种体验。

---

## 3. 方案

### 3.1（必做 · 低成本高杠杆）primer 补 Task 引导

**改 `core/src/help/primer.ts`**，在 peer / skills 之后加一段 ~100 tokens 的 Task 段落。目标是把「proactive 策略」补回来，同时防滥用：

```ts
// 插入 PRIMER 字符串（示意，最终措辞以实现为准）：
//
// Subagents (Task tool):
//   - Prefer Task when work is genuinely independent and parallelizable
//     (reading several files, separate research threads) or when a clean
//     isolated context helps. Do NOT spawn a subagent for a trivial one-file
//     lookup — read it directly.
//   - The subagent runs to completion in its own context and returns its final
//     result. It does NOT see your in-progress edits unless you describe them
//     in the prompt.
//   - Runtime note: on Claude, Task is the SDK's native subagent; on
//     OpenAI/Codex, Task creates a real Ensemble child agent that inherits
//     your model + provider. Depth is capped at 3.
```

要点：

- primer 是**三 runtime 共用**的字符串（`primer.ts` 头注释已确认），所以措辞保持 runtime-neutral，runtime 差异只写一行 note（既有 primer 已有「On Codex CLI agents…」的先例）。
- 明确加「不要为琐碎单文件查找开 subagent」，避免从「不开」矫枉过正到「乱开」。
- 单测：`buildEnsemblePrimer()` 断言包含 `"Task"` 关键词，防止将来重构把这段删掉。

### 3.2（Claude 侧）保持原生，补前端可见性，不改执行

**决策：不把 Claude 的 Task 改成 Scheme B。** 理由：

- 原生透明嵌套就是正确的 task 语义（同 SDK、同上下文隔离、并行），重写会丢语义、破坏 resume、且 `canUseTool` 目前收不到 Task 的代价是「失去 gate」，而不是「需要重写」。
- 想拿到原生子会话的中间事件，SDK 不 surface，Ensemble 只能 abort 整轮——这是 SDK 边界，不是 Ensemble 缺陷。

**做法（前端为主）：**

1. 验证 Claude SDK 对 Task 的渲染链路：`tool_use(Task) → tool_result(<final text>)` 是否已在 ToolCard 完整展示；确认子 agent 名 / 最终结果可读。
2. 给 `toolName === "Task"` 的 ToolCard 加一个「subagent」标识（复用 `subagent-catalog.ts` 的 `spawnedAsTaskFor` 概念，Claude 侧前端按 toolName 判断）。
3. 可选：在 ToolCard 折叠态下显示 Task 的 `description`（模型传入的 3-5 字摘要），让用户知道「这里开了一个子代理」。

### 3.3（Codex 侧）推荐「原生优先 + 转译可见 + 收编 MCP Task」

**推荐方案 C1：原生优先。**

1. **spike（已完成）**：codex 0.154 实测，原生 subagent 在**父线程**的 `codex exec --json` 流里只以 `item.type === "collab_tool_call"` 出现。
2. **`translateItem` 补 subagent 转译（已完成）**：把 `collab_tool_call`（`isCompleted` 时）转成 `assistant tool_use("Subagent", { tool, status, receiver_thread_ids?, prompt? })`，让「原生 subagent 活动发生过」在 Ensemble 可见。注意：codex **不会**把子 agent 的中间消息 inline 进父流，子 agent 的内容最终合并进父的 `agent_message`，所以可见粒度止于 marker，不是逐条子步骤。
3. **收编 Ensemble MCP Task（已完成）**：MCP 工具改名 `spawn_ensemble_agent`（`mcp-bridge.ts`），与 codex 原生 subagent 语义区分，消同名竞争。

#### spike 注记（codex-cli 0.154.0，2026-09-11）

`codex exec --json` 实测父线程事件序列（read-only sandbox，要求模型并行开 3 个 subagent）：

```text
thread.started
turn.started
item.completed  agent_message      # 父的「我并行开 3 个 subagent」
item.started    collab_tool_call    # tool="wait", status="in_progress"
item.completed  collab_tool_call    # tool="wait", status="completed"
…（每个 subagent 一对 start/complete）
item.completed  agent_message      # 合并后的最终报告
turn.completed
```

`collab_tool_call` 字段形状：

```json
{
  "id": "item_1",
  "type": "collab_tool_call",
  "tool": "wait",
  "sender_thread_id": "<parent-thread-id>",
  "receiver_thread_ids": [],
  "prompt": null,
  "agents_states": {},
  "status": "in_progress" | "completed"
}
```

实测 `tool` 只见到 `"wait"`，`receiver_thread_ids` / `agents_states` 为空、`prompt` 为 null —— 子 agent 的派发与中间内容在父流里不可见，只有最终 `agent_message` 有合并结果。`translateItem` 因此按「可缺省字段」处理，不假设字段一定存在。

**备选方案 C2：Ensemble 优先（不推荐作为默认）。**

- 明确禁用 codex 原生 subagent（若当前 CLI 版本提供开关），只留 MCP `Task` → DB 子 agent。
- 优点：subagent 全是可见 DB 实体、可 gate/cancel。
- 缺点：丢掉 codex 原生的并行/沙箱语义，且「和直接 codex CLI 等价」的诉求会更远。
- 仅当用户明确表示「我就要 DB 可见、不要原生」时再选。

### 3.4（OpenAI 侧）保持 Scheme B，只补引导与描述

OpenAI 没有可比的原生 CLI subagent，Scheme B（`makeTaskTool` → `spawnTaskSubagent` → 真 DB agent）已是 `docs/plans/openai-task-handoff.md` 决议过的正确设计，**不动执行**。只做两件轻量事：

1. 让 `makeTaskTool` 的 description 与 primer 3.1 的措辞对齐（保持「何时用 / 何时不用」一致）。
2. primer 生效后，OpenAI 侧自动获得同样的 proactive 引导。

---

## 4. 实施切片

| 阶段 | 内容 | 产出 |
|---|---|---|
| 4.1 primer 补 Task | `primer.ts` 加段落 + 单测；三 runtime typecheck | 模型行为引导回归，~100 tokens |
| 4.2 Claude 前端可见性 | 验证 Task tool_use/tool_result 渲染；加 subagent 标识 | 原生 subagent 至少「可见」 |
| 4.3 Codex spike | 抓真实 subagent JSONL，定 item shape | spike 笔记，转译依据 |
| 4.4 Codex 转译 | `translateItem` 补 subagent item + 单测 | 原生 subagent 中间过程可见 |
| 4.5 Codex 收编 | MCP `Task` 改名/默认关闭决策 + 实现 | 消除双 Task 竞争 |
| 4.6 文档收尾 | 更新 `openai-task-handoff.md` / `subagent-suggestions.md` 的现状注记 | 文档与实现一致 |

**总约 2–3 个工作日**（4.1 + 4.2 半天可交付，4.3–4.5 是主要工作）。

---

## 5. 风险与开放问题

| 风险 / 问题 | 缓解 |
|---|---|
| codex 原生 subagent 的触发方式与 JSONL shape 会随版本变 | 已 pin 到 0.154：`collab_tool_call`（见 §3.3 spike 注记）；转译函数对未知 item type 保持 no-op 不 crash（现有 `translateItem` 已如此） |
| primer 加 Task 后矫枉过正（乱开 subagent） | 措辞含「不要为琐碎查找开」；token 预算控制 ~100；真模型 smoke 后微调 |
| primer 是三 runtime 共用，措辞不能绑定单一 runtime | runtime 差异只放一行 note（与既有「On Codex CLI agents…」同款） |
| codex native resume 路径不重建 prompt，primer 变更要新 thread 才生效 | 现有 `systemPromptHash` 漂移检测可复用到 codex（若开启 resume）；风险接受 |
| C2（禁用 codex 原生 subagent）可能没有 CLI 开关 | spike 时确认；无开关则 C2 不可行，回到 C1 |
| 前端 ToolCard 对嵌套 tool_use/tool_result 的现有实现未知 | 4.2 先读 `desktop-ui` ToolCard 再决定改动量 |

---

## 6. 验收标准

- [ ] `buildEnsemblePrimer()` 输出包含 Task 引导段落，且单测断言不回归
- [ ] Claude runtime 下模型仍可通过 `tools:["Task"]` 开原生 subagent，前端 ToolCard 能识别并展示
- [ ] Codex runtime 下原生 subagent 活动以 `Subagent` tool_use marker 可见；子 agent 中间文本 codex 不 inline，最终合并结果经父 `agent_message` 回到父 turn
- [ ] Codex 侧不再出现两个同名 `Task`（或已明确区分为 `spawn_ensemble_agent`）
- [ ] OpenAI Scheme B 行为不变：Task → 真 DB 子 agent、`agent_created` 广播、深度 cap 3、父 cancel 级联
- [ ] 三 runtime typecheck + 单测全绿；primer 变更后真模型 smoke 一轮，定性观察 Task 调用率

---

## 7. 显式不做

- 不给 Claude 侧默认启用 Scheme B（保持原生透明嵌套）
- 不做自动任务分解编排器
- 不做 subagent 独立 model / provider 选择 UI
- 不改 W22 上下文窗口、peer / team / skills 能力
