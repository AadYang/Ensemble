# 上下文窗口显示（W22 提案 · v1 设计稿）

> **状态**：✅ 已决议，7.1–7.7 已落地（含 i18n 字符串）；7.8 待 Windows/macOS 实机跑一遍确认 glyph 渲染。
> **目标**：在每个 agent pane 顶部显示一行「上下文占用」状态条（`▕████░░ 64% 82k/128k`），覆盖三套 runtime（Claude SDK / OpenAI in-process / Codex CLI），并对 openai-compat（DeepSeek / GLM 等）保证数值准确。
> **触发动机**：Ensemble 已支持 Claude / OpenAI(-compat) / Codex 三路，但用户看不到每个 agent 的上下文还差多少就要 compact；且 W17 token 统计只算历史账单，不做「当前窗口占用」。
> **核心取舍**：展示是皮，**准确性**是命门。OpenAI 兼容协议不返回窗口大小，误差几乎全在「分母」这张表上。

---

## 1. 关键设计决策

| 维度 | 否决方案 | 采纳方案 | 理由 |
|---|---|---|---|
| 分母来源 | 三 runtime 各显神通 | **Claude 读 SDK `contextWindow`（权威）；OpenAI / Codex / compat 查 `context-windows.json` + 用户覆盖** | Claude SDK 直接给窗口大小，最准；OpenAI-compat 只能查表（见下） |
| 分母表形态 | ① 全量 LiteLLM 2.3MB 打包 ② 仅官方小表（DeepSeek/GLM 落 unknown） | **过滤快照**：脚本从 LiteLLM `model_prices_and_context_window.json` 抽官方 Claude/OpenAI + deepseek/glm/qwen/kimi/moonshot/minimax/zhipu 等 compat 条目，生成 ~几十 KB 的 `context-windows.json`，随 SEA 打包，脚本可刷新 | 兼顾「DeepSeek/GLM 准确性」与包体；方案②直接违背用户「关键是准确」的要求 |
| 分子来源 | 本地 tokenizer 估算 | **只信 SDK/API 的 usage**；`local-tokenizer` 继续只做 billing 审计（已有） | 本地 tokenizer 对 DeepSeek/GLM 的分词器是近似值，不能当上下文占用 |
| 缓存 token | 从已用里减掉 | **计入已用**（缓存一样占窗口） | Codex/OpenAI 的 `input_tokens` 已含缓存（缓存是子集）；Claude 的 `inputTokens` 不含缓存，需加回 cacheRead/cacheCreation |
| 推理 token | 单独另算 | **并入 output**（Codex 已做；DeepSeek-R1/GLM-Z1 的 reasoning 在 `completion_tokens` 内，实施时 spike 验证） | 统一公式，不做特判 |
| 有效窗口 | 名义 context × 95% | **分母 = `maxInputTokens`**，`used = 总输入(含缓存) + 总输出(含推理)` | 输入/输出分开统计，不必再打折；语义清晰 |
| 未知模型 | 给一个假百分比 | **`known=false` → UI 显示「unknown」** | 准确性的一部分是「不造假」 |
| model id 匹配 | 模糊匹配（"deepseek"） | **精确 id**；`response.model` 优先，fallback `opts.model` | 同是 deepseek，v3=128K、v3.2=163840、GLM-5.2=1M，模糊必错 |
| 传输 | 复用 `status` / 塞进 result | **新增 `ServerMsg` 类型 `context`**，每轮结束发一次 | status 语义是「idle/running/...」，不混；result 是历史消息，不合适做实时状态 |
| 显示位置 | 独立面板 / 弹窗 | **agent pane 头部一行 compact bar**（Unicode glyph 风格） | 与 `/clear /compact` 的心智在同一视线；不破坏布局 |

---

## 2. 数据现状盘点

### 2.1 已有但没被用上的字段

- `runtimes/claude.ts`：透传 SDK `result`，其中 `modelUsage[model].contextWindow` 就是**权威分母**，但 `usage-extract.ts` 目前只读 input/output/cache/local，**丢弃了 contextWindow**。
- `runtimes/openai.ts` 与 `runtimes/codex.ts`：合成 result 时 `contextWindow: 0`（注释「SDK 不 surface」）——**分母缺失**，这是本次要补的洞。

### 2.2 三个 runtime 的分子现状

| runtime | 上游 usage 字段 | 已用公式 | 分母 |
|---|---|---|---|
| Claude | `inputTokens`(不含缓存) / `outputTokens` / `cacheReadInputTokens` / `cacheCreationInputTokens` / `contextWindow` | `input + cacheRead + cacheCreation + output` | SDK `contextWindow`（权威） |
| OpenAI(-compat) | `response.usage`：`inputTokens`(含缓存，=prompt_tokens) / `outputTokens` / `prompt_tokens_details.cached_tokens` | `inputTokens + outputTokens` | 查表 / 覆盖 |
| Codex | `turn.completed.usage`：`input_tokens`(含缓存) / `cached_input_tokens`(子集) / `output_tokens` / `reasoning_output_tokens` | `input_tokens + output_tokens + reasoning_output_tokens` | 查表 / 覆盖 |

**关键精度点（OpenAI runtime）**：现有 `accumulateUsage` 会把 tool 回路的多个 response **累加**（为 billing 用）。上下文占用必须取**最后一个 response 的 usage**——每个 response 都重发全量历史，累加会重复计数。需要单独记 `lastUsage`（Codex 的 `lastUsage` 已是「最后一轮」，天然正确）。

### 2.3 与现有结构的兼容点

- `UsageEvent` 表**不加列**：上下文占用是「当前实时状态」，不是历史账单；不落库、随 turn 推送，`/clear /compact` 时前端归零。
- `/clear /compact` 已存在（`SessionManager` → `agent_history_reset` WS 消息）。上下文条在收到 `reason: "clear" | "compact"` 时归零。
- 不动 `pricing.json` / `pricing.ts`：价格是价格，窗口是窗口，两张表各自独立、各自有 override 文件（对齐 pricing 的「双轨」模式）。

---

## 3. 分母数据：`context-windows.json`

### 3.1 位置与形态

- **内置**：`core/src/context-windows.json`（esbuild inline 进 SEA bundle）
- **用户覆盖**：`${appDataDir}/context-window-overrides.json`（浅合并，同 `pricing-overrides.json` 模式）

```json
{
  "version": "2026-06-01",
  "note": "maxInputTokens per model. Source: LiteLLM model_prices_and_context_window.json snapshot, quarterly refresh.",
  "models": {
    "claude-opus-4-7":     { "maxInputTokens": 200000, "maxOutputTokens": 32000 },
    "gpt-5.2":             { "maxInputTokens": 400000, "maxOutputTokens": 128000 },
    "deepseek-chat":       { "maxInputTokens": 131072, "maxOutputTokens": 8192 },
    "deepseek-reasoner":   { "maxInputTokens": 131072, "maxOutputTokens": 65536 },
    "glm-4.5":             { "maxInputTokens": 131072, "maxOutputTokens": 16384 },
    "glm-4.6":             { "maxInputTokens": 200000, "maxOutputTokens": 131072 },
    "qwen-max":            { "maxInputTokens": 131072, "maxOutputTokens": 8192 },
    "kimi-k2":             { "maxInputTokens": 131072, "maxOutputTokens": 16384 }
  }
}
```

> 注：以上数值为**示意**，实施时由 `scripts/update-context-windows.mjs` 从 LiteLLM 抓取当前真实值落表。

### 3.2 生成脚本

`scripts/update-context-windows.mjs`：
1. 拉 `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
2. 过滤 provider 前缀白名单（deepseek / glm / zhipu / z.ai / qwen / kimi / moonshot / minimax + 官方 anthropic / openai）
3. **key 归一化**：去掉 `provider/` 前缀 → 裸 model id（如 `deepseek/deepseek-chat` → `deepseek-chat`）；同名冲突时保留一条并 log 警告
4. 写 `core/src/context-windows.json` + 更新 `version`

### 3.3 解析函数 `resolveContextWindow(model)`（`core/src/context-window.ts`）

```ts
resolveContextWindow(model): {
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  known: boolean;
}
```

- 精确 key 命中 → `known=true`
- 未命中 → `known=false`（不猜、不模糊）
- 内置表 + override 浅合并后查找；override 可新增第三方条目

---

## 4. 分子捕获：三 runtime 改动

### 4.1 Claude

- `usage-extract.ts` 的 `SdkResultPayload.modelUsage` 增加 `contextWindow?: number` 读取（供分母）。
- 新增纯函数 `computeContextSnapshot(model, source, message)`：输入当前 model + 来源 + result 消息，输出 `{ model, usedTokens, contextWindowTokens, percent, known, source }`。
  - `used = inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens`
  - `contextWindowTokens = modelUsage[model].contextWindow`（SDK 给，`> 0` 即权威）；**为 0/缺失时回退 `resolveContextWindow(model)` 查表**——覆盖 anthropic-compat 上游（GLM/MiniMax 走 Claude 协议时 SDK 不 surface 窗口）。

### 4.2 OpenAI

- `openai.ts` 里在 `response_done` 处理中，**另存 `lastUsage`**（最后一个 response 的 usage，不累加）。
- 合成 result 时把 `lastUsage` 挂到 modelUsage 的入口上（字段对齐 Claude，但 `contextWindow` 仍为 0，分母走 `resolveContextWindow`）。
- `resolveContextWindow(response.model ?? opts.model)` 查表；`known=false` 时上下文条显示 unknown。

### 4.3 Codex

- 已有 `lastUsage`（`turn.completed` 最后一轮），合成 result 时已并入 modelUsage。
- 分母走 `resolveContextWindow(opts.model)`（Codex 模型是官方 gpt-5.x，内置表覆盖）。

### 4.4 统一收敛点：`SessionManager`

在「收到 result → 写 UsageEvent」的同一位置（`SessionManager` 约 1396 行），额外算一次 context snapshot，通过 `hub.sendToSession(sessionId, { type: "context", ... })` 推送前端。**纯读路径，不落库**。

---

## 5. 协议改动（`shared/src/protocol.ts`）

`ServerMsg` 新增：

```ts
| {
    type: "context";
    sessionId: string;
    context: {
      model: string;
      usedTokens: number;
      contextWindowTokens: number | null; // null = unknown
      percent: number | null;             // null = unknown
      known: boolean;
      source: "claude-sdk" | "openai" | "codex";
    };
  }
```

- 每轮结束发一次；`/clear` `/compact` 时由前端在收到 `agent_history_reset` 后自行归零（不加新的后端 reset 消息）。
- `percent = known ? round(usedTokens / contextWindowTokens * 100) : null`，clamp 到 `[0, 100]`。

---

## 6. 前端显示（`desktop-ui`）

### 6.1 位置与格式

agent pane 头部（model 名旁）一行 compact bar，沿用项目 Unicode glyph 风格：

```
[model]  ▕████████░░ 82% 84k/128k
[model]  context: unknown      ← known=false
```

### 6.2 颜色阈值（质量退化语义 · 已决议）

| 阈值 | 颜色 | 含义 |
|---|---|---|
| ≤20% | 绿 | 无退化 |
| 20–40% | 黄 | 退化开始 |
| >40% | 红 | 明显退化 |

> **用户决议**：采用 context-rot 研究的「质量退化」阈值 0–20 / 20–40 / 40+，而非「窗口充盈度」的 70/90。语义是「上下文占用越高，回答质量越可能退化」——**40% 即进入红区**，提醒尽早 `/compact`。

### 6.3 状态机

- turn 中：保持上一轮数值（不闪烁）
- 收到 `context` 消息：更新该 sessionId 的 bar
- 收到 `agent_history_reset`（clear/compact）：归零显示
- `known=false`：显示 `context: unknown`，tooltip 提示「未知模型，可在 context-window-overrides.json 补充窗口大小」

---

## 7. 实施切片

| 阶段 | 工作量 | 产出 |
|---|---|---|
| 7.1 `context-window.ts` + `context-windows.json` | 0.5d | `resolveContextWindow` 纯函数 + 内置表 + override 合并；单测覆盖命中/未命中/override |
| 7.2 `scripts/update-context-windows.mjs` | 0.5d | 从 LiteLLM 抽快照 + key 归一化；跑一次生成真实 `context-windows.json` |
| 7.3 Claude 侧 `extractContextSnapshot` | 0.5d | `usage-extract.ts` 增读 `contextWindow`；纯函数单测 |
| 7.4 OpenAI 侧 `lastUsage` | 0.5d | `openai.ts` 存最后一个 response 的 usage；spike 验证 `response.usage` 字段名（camelCase vs snake_case） |
| 7.5 Codex 侧分母接线 | 0.5h | result 合成后走 `resolveContextWindow`（分子已就绪） |
| 7.6 `SessionManager` 推 `context` 消息 | 0.5d | result 处理处算 snapshot + `sendToSession`；集成测试覆盖三 runtime 各一条 |
| 7.7 协议 + 前端 bar | 0.5d | `protocol.ts` 加 `context` 类型 + pane 头部组件 + 颜色阈值 + unknown 态 + 归零 |
| 7.8 i18n + 三平台 review | 0.5d | en/zh strings；Windows/macOS 各跑一遍看 glyph 渲染 |

**总约 3.5–4 个工作日**。

---

## 8. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| LiteLLM 表里 model id 与 Ensemble 用户填的不一致 | 生成脚本 key 归一化 + `resolveContextWindow` 精确匹配 + 未命中落 unknown；用户 override 兜底 |
| `@openai/agents` 的 `response.usage` 字段命名变动 | 7.4 spike 先行，读不到就落 `known=false`（宁缺毋假） |
| DeepSeek/GLM 流式 response 不带 `usage`（若 SDK 未开 `include_usage`） | 7.4 spike 确认 SDK 是否默认带 usage；不带则在请求层补 `stream_options.include_usage` |
| 推理 token 占窗口但 provider 未单列 | Codex 已并入 output；DeepSeek/GLM 的 reasoning 在 `completion_tokens` 内，天然覆盖 |
| Codex `input_tokens` 是否含缓存的口径变化 | 7.4/7.5 用一条真实 Codex turn 核对 `input_tokens` vs `cached_input_tokens` 关系，公式按「input 已含缓存」写死并注释 |
| 新增 `context` 消息对旧前端/旧 core 的兼容 | 协议是 union 增量，旧端忽略未知 type 即可；不 bump 版本 |

---

## 9. 显式不做（避免范围蔓延）

- 不做 turn 过程中的实时刷新（v1 仅每轮结束）
- 不做「还剩几个 prompt / 几轮」的预测
- 不做自动 compact 触发（`/compact` 仍是手动）
- 不做上下文历史趋势图（那是 W17 stats 的活，且 W17 不存窗口）
- 不做 context-window-overrides 的 UI 编辑器（同 pricing，v1.1）
- 不做全量 LiteLLM 打包（用过滤快照）

---

## 10. 验收标准

- [ ] Claude / OpenAI / Codex 三 runtime 各跑一轮，pane 头部出现上下文 bar，数值非 0
- [ ] Claude 侧分母 = SDK `contextWindow`；OpenAI/Codex 侧分母 = `context-windows.json` 查表值
- [ ] DeepSeek / GLM（openai-compat）配置了 override 后显示正确百分比；未配置时显示 `context: unknown`，不给假百分比
- [ ] 缓存 token 计入已用：Claude 的 cacheRead/cacheCreation 加回；Codex/OpenAI 的 input 已含缓存、不重复计
- [ ] OpenAI tool 回路多 response 时，上下文 = **最后一个** response 的 usage（不累加）
- [ ] `/clear` `/compact` 后上下文条归零
- [ ] 未知 model id（表内无、无 override）→ `known=false` → unknown 态 + tooltip
- [ ] `resolveContextWindow` 单测：精确命中 / 未命中 / override 覆盖 / 同 model 多 provider 前缀归一化
- [ ] `context` 消息走 `shared/src/protocol.ts` 类型，`ServerMsg` union 编译通过
- [ ] Windows + macOS 各跑一遍，glyph 渲染正常（沿用项目现有 bar 字符）

---

## 11. 用户决议（已确认，2026-09-11）

1. **分母覆盖策略**：✅ 采纳推荐「LiteLLM 过滤快照」方案（§3.2）——DeepSeek/GLM 开箱即准，附 `scripts/update-context-windows.mjs` 刷新脚本。
2. **颜色阈值**：✅ 采纳 context-rot「质量退化」阈值 **20/40**（§6.2），语义从「窗口充盈度」切换为「质量退化」——≤20% 绿 / 20–40% 黄 / >40% 红。
