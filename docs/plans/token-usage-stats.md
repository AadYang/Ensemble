# Token 消耗统计（W17 提案 · v3 决议版）

> **状态**：📝 设计落盘，**8 项决议齐全，待实施**（v3 2026-05-11：用户决议后定稿；v2 → v3 主要变化是 cost 数据解耦改走 `UsageEvent` 独立表）
> **目标**：在顶部工具栏加「◔ 统计」按钮，打开统计面板展示 token / 成本消耗，含趋势图 + 详细列表。
> **触发动机**：W16 后 Ensemble 支持多 provider × 多 runtime × 多 agent，单天的累计消耗用户没法心算；需要直观看到「钱花在哪个 agent / 哪天 / 哪个 model」。
>
> **关于参考项目**：用户最初指向 `https://github.com/stormzhang/token-tracker`。**实测该 URL 404**——可能仓库已删除/改名/私有。设计基于同领域公开项目（ccusage / claude-usage / TokenTracker mm7894215）+ Ensemble 自身数据形态。
>
> **v3 用户决议总览**：
> - 价格表 v1 仅 Claude + OpenAI 官方（v2 的 timicc/DeepSeek/GLM/MiniMax 缩窄到仅官方 + 用户用 `pricing-overrides.json` 自补）
> - 删 agent 历史 cost **不丢**：新建 `UsageEvent` 独立表归一化账单数据，agent/provider 表删除不影响
> - subagent v1 **直接上 tree toggle**（v2 的"平级 + indentation"升级为可展开折叠）
> - stat card #4 = 最贵 agent（可点跳转）
> - range 默认 30d / 趋势图统一 day / v1 含 CSV / 图标保持 Unicode `◔`
>
> **v2 → v3 重要变化**：用户提出"历史 cost 是数据，为何与 agent 强绑定" → 推翻 v2 的「删 agent 接受丢失」方案，重新做 schema 设计 → 新建 `UsageEvent` 表（agent/provider 信息 snapshot），与 `Message` 表的会话生命周期完全解耦。**memory 记录原则**：FK CASCADE 不该吞业务/审计数据（详见 `~/.claude/.../memory/feedback_fk_cascade_data_loss.md`）。

---

## 1. 关键设计决策

| 维度 | 否决方案 | 采纳方案 | 理由 |
|---|---|---|---|
| 数据存放 | 从 `Message.payload` JSON 聚合 | **独立 `UsageEvent` 表**，写 Message 时同步双写 | 历史 cost 是业务数据，不应被 `Message ON DELETE CASCADE` 吞掉；独立表 + agentId/providerId snapshot + nullable FK 让删除 agent / provider 不影响账单 |
| 成本计算 | Claude 读 SDK `costUSD` / OpenAI 自维护 | **所有 provider 统一走 `pricing.json` 价格表** | SDK 的 `costUSD` 按官方 Anthropic 价算，对第三方 anthropic-compat（MiniMax/GLM 走 Claude 协议）虚高错值。统一计算路径 |
| 价格表覆盖 | + 第三方测过几家 | **v1 仅 Claude 官方 + OpenAI 官方**，第三方进 `unknownModels` 桶或用户 `pricing-overrides.json` 自补 | 用户决议：缩窄维护面，保留扩展机制 |
| 价格表形态 | TS hardcoded | **`core/src/pricing.json`（打包随 SEA）+ `appDataDir()/pricing-overrides.json`（用户可改，浅合并覆盖）** | 双轨兼顾打包友好和用户可改 |
| 聚合查询 | scan Message + JSON parse | **直接 `SELECT FROM UsageEvent`**，列字段就是聚合需要的 | UsageEvent schema 就为统计设计；无 JSON 反序列化；自然支持索引 |
| 索引 | partial index on Message | **常规 index on `UsageEvent.createdAt`** | UsageEvent 表本身就只装统计行，不需要 partial |
| 聚合缓存 | 30s TTL Map | **不加缓存** | SQLite + indexed 查询足够快；缓存是预防性过度工程 |
| UI 形态 | 整页路由 `/stats` | **顶部工具栏 ◔ 按钮 → 模态对话框** | 不破坏 workspace 布局；ProviderPanel 同模式 |
| 图标 | lucide / shadcn 风格 | **保持 Unicode `◔` glyph** | 项目所有工具按钮都用 Unicode glyph（`↻ ✎ × ⇪ ⚡ ⌬ ★`）；lucide 是 50KB icon font 风格漂移 |
| 图表库 | chart.js / victory | **recharts** | React 原生、bundle 小、声明式 |
| 时间范围 | 日期输入 | **预设按钮 7d / 30d / 90d / All + custom，默认 30d** | 账单周期最常见 |
| 趋势图形态 | 单 line | **stacked area（按 provider 色块）+ line toggle，统一 day 单位** | 多 provider 时单 line 看不出占比；day 单位让 recharts 自动 tick |
| 货币 | 多币种 | **USD（pricing.json 原始单位）** | 加汇率 = 加缓存 + 加配置 |
| 时区 | server-side 切桶 | **UTC 拉数据，前端按浏览器 IANA tz 切 day-bucket** | 规避 SQL 时区噩梦 |
| 删 agent 历史 cost | CASCADE / soft-delete / payload snapshot | **UsageEvent 表 agentId nullable + ON DELETE SET NULL** | 用户决议：cost 是数据不和 agent 绑定。删 agent → Message CASCADE 走（chat 干净抹除）；UsageEvent 留存且 agentId=NULL，stats 走 snapshot 字段显示 |
| subagent 形态 | 平级 + indentation | **v1 直接上 tree toggle**（include descendants 开关 + 展开折叠） | 用户决议：v1 UX 一步到位，不留 polish 缺口 |
| stat card #4 | 总 turns / 上下文峰值 | **最贵 agent（可点跳转）** | 运营价值最高 |
| W14 quickQuery token | 不入账 | **写 UsageEvent 行入账**（source='meta'） | 实际 ~500-700 token/次（catalog 150 + history 10×50 + output 100） |
| CSV | 仅 daily | **跟随当前 groupBy 视图导出** | 零额外 UI 工作 |
| 隐私 | 上传聚合 | **完全本机** | 同 DB 存放路径 |

---

## 2. 数据现状盘点

### 2.1 source-of-truth 选择：双写 Message + UsageEvent

**理由**：Message 是会话生命周期数据（chat history，删 agent 应 CASCADE）；UsageEvent 是账单数据（项目级别审计，删 agent 不应丢）。两者语义不同，应该是两张表。

**写路径**（SessionManager.persistResultMessage 后增钩子）：

```ts
// 已有：写 Message
await prisma.message.create({ data: { agentId, type: 'result', payload, ... } });

// 新增（W17 Slice 5.3）：从 payload.modelUsage + pricing.json 算 cost，写 UsageEvent
const events = extractUsageEvents(agentSnapshot, providerSnapshot, payload);
for (const e of events) await prisma.usageEvent.create({ data: e });
```

`agentSnapshot` 和 `providerSnapshot` 在 sendMessage 开头从 DB 读出（已有逻辑），写 UsageEvent 时 inline snapshot 进字段。

### 2.2 Claude side（result message 已就绪）

SDK 的 `result` SDKMessage（`@anthropic-ai/claude-agent-sdk/.../coreTypes.d.ts:8-16`）携带：

```ts
type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;        // ← v2+ 完全无视，统一走 pricing.json 算
  contextWindow: number;
};
```

每个 `modelUsage[modelName]` 拆成一条 UsageEvent。多模型在一个 turn（实际很少见）则一 result → 多 UsageEvent。

### 2.3 OpenAI side（需要补合成 + 统一 schema）

`OpenAIAgentRuntime.query()`（W16 Slice 2）当前合成的 `result` SDK message 只填 `{type:"result", subtype:"success", session_id}`，缺 usage 字段。

**修复**（Slice 5.1）：
- 监听 `@openai/agents` 的 `StreamEventResponseCompleted` 事件（`response.completed` 时 final usage 才稳定）。一次 query 可能多 response（tool 回路），逐 response 累加到 turn-level
- 合成的 result message **结构对齐 Claude**：`modelUsage: {[modelName]: ModelUsage}` 形态，让 `extractUsageEvents` 走同一份代码
- 实施前先 spike `@openai/agents` SDK 上 `response.usage` 的字段命名（snake_case vs camelCase；nullable 与否）

**cache 字段映射**：
- Claude SDK: `cacheReadInputTokens` / `cacheCreationInputTokens`
- OpenAI SDK: `prompt_tokens_details.cached_tokens`（OpenAI prompt-caching，仅 cache_read 无 creation）
- 缺字段 `?? 0` 兜底

### 2.4 价格表（统一 pricing.json）

**位置**：`core/src/pricing.json`（esbuild 把 JSON inline 进 SEA bundle）

**结构**：

```json
{
  "version": "2026-05-11",
  "note": "USD per 1M tokens. Source: provider official pricing pages, recalibrated quarterly.",
  "models": {
    "claude-opus-4-7":  { "input": 15.00, "output": 75.00, "cacheRead": 1.50,  "cacheWrite": 18.75, "_source": "anthropic.com/pricing" },
    "claude-sonnet-4-6":{ "input":  3.00, "output": 15.00, "cacheRead": 0.30,  "cacheWrite":  3.75, "_source": "anthropic.com/pricing" },
    "claude-haiku-4-5-20251001": { "input": 1.00, "output": 5.00, "cacheRead": 0.08, "cacheWrite": 1.25, "_source": "anthropic.com/pricing" },
    "gpt-5.2":          { "input":  1.25, "output": 10.00, "cacheRead": 0.125, "_source": "openai.com/api/pricing" },
    "gpt-4o":           { "input":  2.50, "output": 10.00, "cacheRead": 1.25,  "_source": "openai.com/api/pricing" },
    "gpt-4o-mini":      { "input":  0.15, "output":  0.60, "cacheRead": 0.075, "_source": "openai.com/api/pricing" }
  }
}
```

**覆盖范围（v1 决议）**：仅 Claude 官方 + OpenAI 官方。第三方（MiniMax / GLM / DeepSeek / timicc / Moonshot 等）落 `unknownModels` 桶，用户可通过 `pricing-overrides.json` 自补。

**用户覆盖**：启动时检测 `${appDataDir}/pricing-overrides.json`（Windows `%APPDATA%\dev.ensemble.app\` / macOS `~/Library/Application Support/dev.ensemble.app/` / Linux `~/.config/dev.ensemble.app/`）。存在则浅合并到 `models` 字段。**v1 不做 UI 编辑器**（v1.1）。

**校准协议**：每季度 review，更新 `pricing.json` 的 `version` 字段。

### 2.5 quickQuery（W14 推荐）token 入账

`SessionManager.quickQuery` 在调完 runtime 后，把 final usage 写一条 `UsageEvent` row：

```ts
await prisma.usageEvent.create({
  data: {
    agentId,          // 调用源 agent
    agentName,        // snapshot
    providerId,
    providerName,
    providerKind,
    parentId: null,
    model,
    source: 'meta',   // 区别于 'result'
    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    costUSD,
    createdAt: now(),
  },
});
```

ChatPane 不读 UsageEvent（仍按 Message.type !== 'meta' 过滤逻辑），所以 quickQuery 完全不污染 chat 渲染但完整入账。

---

## 3. UsageEvent Schema

```sql
CREATE TABLE IF NOT EXISTS UsageEvent (
  id TEXT PRIMARY KEY,
  -- soft references: nullable FK + SET NULL on delete, snapshot fields cover the gap
  agentId TEXT REFERENCES Agent(id) ON DELETE SET NULL,
  agentName TEXT NOT NULL,
  parentId TEXT,                            -- agent's parentId at write time (for subagent tree)
  providerId TEXT REFERENCES Provider(id) ON DELETE SET NULL,
  providerName TEXT NOT NULL,
  providerKind TEXT NOT NULL,               -- 'anthropic-local' / 'anthropic' / 'openai-compat'
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('result', 'meta')),
  inputTokens INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
  cacheCreationTokens INTEGER NOT NULL DEFAULT 0,
  costUSD REAL NOT NULL DEFAULT 0,          -- 0 when model unknown to pricing.json
  costKnown INTEGER NOT NULL DEFAULT 0,     -- 0 = unknown model (uncounted in totals)
  createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS usage_time_idx ON UsageEvent(createdAt);
CREATE INDEX IF NOT EXISTS usage_agent_idx ON UsageEvent(agentId);
CREATE INDEX IF NOT EXISTS usage_provider_idx ON UsageEvent(providerId);
```

**snapshot 字段**（`agentName / providerName / providerKind / parentId`）：写入时定格，避免后续重命名 / 删除影响历史。

**`costKnown` 字段**：区分两类 costUSD=0：
- `costKnown=1` 且 `costUSD=0`：真的不花钱（如 cache_read 全打中）
- `costKnown=0`：model 不在 pricing.json 也不在 overrides → 进 `unknownModels` 桶，不计 total

---

## 4. UI 设计

### 4.1 顶部工具栏按钮

在 ws 状态点旁加 `◔` 图标按钮，title="usage stats"。点击 → 打开模态对话框。

### 4.2 模态对话框布局

```
┌─ usage stats ─────────────────────────────────────── ✕ ┐
│                                                          │
│  range:  [7d] [30d] [90d] [All] [custom...]   tz=local   │
│                                                          │
│  ┌── 4 stat cards ──────────────────────────────────┐    │
│  │ TOTAL COST    │  AGENTS  │  TURNS  │  TOP AGENT  │    │
│  │ $12.34        │  8       │  142    │  main →     │    │
│  │                                     │  $4.20     │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌── daily cost trend ──── [area|line]──────────┐        │
│  │       │                                       │       │
│  │   $   │   .████.                              │       │
│  │       │.████████████.                         │       │
│  │       └──────────────────                     │       │
│  │        5/1   5/5   5/10                       │       │
│  └─────────────────────────────────────────────────┘     │
│  legend: ■ Claude  ■ OpenAI                              │
│                                                          │
│  group by:  [day] [agent] [model] [provider]             │
│  □ include descendants (only for byAgent)                │
│                                                          │
│  ┌── detail table ──────────────────────────────────┐    │
│  │ date    │ cost   │ in tokens │ out │ cache_r/w  │     │
│  │ 5/11    │ $2.10  │ 142.3k    │ 8k  │ 1.2M/300k  │     │
│  │ 5/10    │ $1.85  │ ...       │ ... │ ...        │     │
│  │ (byAgent 视图)                                   │     │
│  │ ▾ main           │ $4.20 │ ...                  │     │
│  │   ↳ task:review  │ $0.50 │ ...                  │     │
│  │ ▸ explorer       │ $1.30 │ ...                  │     │
│  │ (deleted agents) │ $0.50 │ ...                  │     │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│                              [export CSV]  [close]       │
└──────────────────────────────────────────────────────────┘
```

**详细说明**：

- **Range 切换**：7d / 30d / 90d / All / custom；默认 **30d**；All tooltip 标"全部历史"
- **趋势图**：默认 stacked area（按 provider 色块），toggle 切到 line。recharts `<AreaChart>` + `<Area stackId='cost' dataKey='claude' />` `<Area stackId='cost' dataKey='openai' />`
- **stat card #4「最贵 agent」**：显示 agent 名 + cost；agent 名是可点的，点击关闭 dialog 并切到该 agent 的 ChatPane（如果还存在）；若已删则禁用点击，显示 `(deleted)` 后缀
- **detail table**：列固定 `cost / in / out / cache_read / cache_creation / turns`
- **byAgent 视图的 tree toggle**：
  - `☐ include descendants` 复选框（仅 byAgent 视图启用）
  - 关闭时：每个 agent 行只统计直接产生的 token / cost
  - 开启时：每个 agent 行包含其子树（按 parentId 递归）的累计；展开图标 `▾/▸` 切换显示子行
  - 已删 agent 进 `(deleted agents)` 聚合行（agentId=NULL 的 UsageEvent）
- **空数据态**：4 stat card 全 `—`；图区显示 centered "no data in this range"；table 行空 caption "no rows match these filters"
- **数字格式**（`Intl.NumberFormat`）：
  - tokens ≥ 10000 用 `k`（`142.3k`），≥ 10M 用 `M`（`1.2M`）
  - cost 永远 2 位小数，千分位按 locale（`$1,234.56`）

### 4.3 删 agent 行为（v3 已解耦）

无需警告。Message CASCADE 走干净抹除 chat history；UsageEvent 保留，agentId=NULL，agentName snapshot 还在。Stats panel 走 snapshot 显示 `(deleted)` 后缀。

### 4.4 CSV export（跟随当前 groupBy）

按钮在右下角。点击时根据当前 groupBy + include-descendants 状态决定列：

| groupBy | 文件 | 列 |
|---|---|---|
| day | `usage-daily-...csv` | `date, costUSD, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns` |
| agent | `usage-by-agent-...csv` | `agentId, agentName, parentId, costUSD, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns, includesDescendants` |
| model | `usage-by-model-...csv` | `model, costUSD, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns` |
| provider | `usage-by-provider-...csv` | `providerId, providerName, kind, costUSD, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns` |

前端 `Blob` + `a.download`，无需服务端协助。

---

## 5. 后端聚合 API

```
GET /api/usage/summary?since=<iso>&until=<iso>&tz=<IANA>&includeDescendants=<bool>
  → 200 {
    range: { since, until, tz },
    totals: {
      costUSD: number,
      inputTokens: number,
      outputTokens: number,
      cacheReadTokens: number,
      cacheCreationTokens: number,
      turns: number,
      agents: number,
    },
    daily: [
      { date, costUSD, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns,
        byProvider: { claude: number, openai: number } }
    ],
    byAgent: [
      { agentId: string | null, agentName, parentId: string | null,
        costUSD, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns,
        descendantIds: string[] /* present only when includeDescendants=true */ }
    ],
    byModel: [
      { model, costUSD, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns }
    ],
    byProvider: [
      { providerId: string | null, providerName, kind,
        costUSD, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns }
    ],
    unknownModels: [
      { model, providerId: string | null, turns, inputTokens, outputTokens }
    ],
    topAgent: { agentId: string | null, agentName, costUSD } | null
  }
```

**契约细节**：
- `[since, until)` half-open；缺省 since = 表中最早 `createdAt`（用于 range='All'）
- `tz` IANA 时区名（如 `Asia/Shanghai`）；前端 `Intl.DateTimeFormat().resolvedOptions().timeZone` 取值。SQL 拉 UTC，day-bucket 在 JS 切（Intl.DateTimeFormat）
- `includeDescendants=true` 时 byAgent 行的 token/cost 包括其 parentId 子树聚合；行也带 `descendantIds` 数组
- `byAgent` / `byProvider` 包含 agentId/providerId=NULL 的"deleted"聚合行
- `unknownModels` 按 `(model, providerId)` 聚合
- `topAgent` 是预算 #4 stat card 的数据；按 costUSD 降序取第一名

**实现思路**：`SELECT FROM UsageEvent WHERE createdAt >= ? AND createdAt < ? AND costKnown = 1` 拉全集，JS reduce 算 4 个维度。`unknownModels` 单独 `WHERE costKnown = 0` 拉一遍。`includeDescendants=true` 时按 `parentId` 关系树遍历再聚合。

---

## 6. 实施切片

| 阶段 | 工作量 | 产出 |
|---|---|---|
| 6.1 OpenAI runtime usage 合成 | 半天 | `runtimes/openai.ts` 监听 `StreamEventResponseCompleted` 逐 response 累加；合成 result 用 `modelUsage: {[m]: ModelUsage}` 结构；单测验证 schema 对齐 Claude |
| 6.2 `pricing.json` + `pricing.ts` | 1 天 | JSON 文件含 Claude 官方 + OpenAI 官方全 SKU；`pricing.ts` 启动时合并 `appDataDir()/pricing-overrides.json`；`computeCost(modelUsage, model)` 函数；单测覆盖 unknown model 返回 `costKnown=false` |
| 6.3 `UsageEvent` 表 + 双写钩子 | 1 天 | `db.ts` 加表 + 索引 + repo；`SessionManager.persistResultMessage()` 写完 Message 后调 `recordUsageEvents()`；单测：删 agent 后 UsageEvent 留存且 agentId=NULL |
| 6.4 聚合 endpoint | 半天 | `GET /api/usage/summary` + half-open + tz + includeDescendants 参数；单测覆盖 4 个 group 维度 + tz 边界 + unknownModels + topAgent + descendantIds |
| 6.5 前端 lib + dialog 骨架 | 半天 | `lib/usage-api.ts` + `<UsageStatsDialog>` 4 stat cards + range 按钮 + groupBy 切换 |
| 6.6 趋势图 + recharts | 半天 | 装 recharts；stacked area + line toggle；空态居中占位 |
| 6.7 byAgent tree toggle | 半天 | `☐ include descendants` 复选框；展开/折叠 UI；联动 API includeDescendants 参数 |
| 6.8 工具栏按钮 + i18n + 空态 | 0.5h | 顶部条 `◔` 按钮（保持 Unicode glyph）；en/zh strings；3 块空态 mockup |
| 6.9 CSV export（跟随 groupBy） | 0.5h | 前端 currentGroupBy → 列 schema → Blob + a.download |
| 6.10 quickQuery 入账 | 0.5h | `SessionManager.quickQuery` 调完后写 UsageEvent，source='meta' |

**总约 4-4.5 个工作日**（v3 上调 vs v2 的 3.5-4 天：新增 UsageEvent 表 + tree toggle 一上）。

---

## 7. 与现有架构的兼容点

- **不动 WS 协议**：纯 REST endpoint
- **新增 `UsageEvent` 表**：独立 schema，启动期 idempotent CREATE；不影响 Message 表
- **Message 表不变**：保持现有 CASCADE 行为（删 agent → 抹 chat history），UsageEvent 由独立 FK 维护
- **不动 Provider 路由 / Runtime 抽象**：usage 是纯读路径（W17）+ 写钩子（SessionManager 内）
- **W16 cross-runtime 兼容**：双写发生在 SessionManager 内，runtime 无关
- **W14 subagent 兼容**：UsageEvent.parentId snapshot 自动跟随 W14 spawnTaskSubagent 写入的 child agent
- **W14 quickQuery 兼容**：同样写 UsageEvent，source='meta'

---

## 8. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 价格表过时 / 第三方 model | `unknownModels` 单列展示 + cost `?`；用户用 `pricing-overrides.json` 即时补；v1.1 加 UI 编辑器 |
| 大数据量聚合慢（>1M events） | UsageEvent 自带索引；超过阈值时考虑分页 / streaming JSON（v1 不优化） |
| 跨时区 day-bucket 边界 | tz IANA 参数 + 前端 Intl 切桶 |
| Slice 6.1 前的 OpenAI session 没 usage | 旧数据无法回填；进 `unknownModels`；UI tooltip 说明 |
| 双写带来事务一致性 | persistResultMessage + recordUsageEvents 包在一个 transaction 里；任一失败回滚两个 |
| `quickQuery` token 偏差 | v1 入账（6.10） |
| Claude side 第三方 anthropic 端点 SDK `costUSD` 虚高 | 已废弃 SDK costUSD，统一走 pricing.json |
| OpenAI prompt-caching 字段映射 | `prompt_tokens_details.cached_tokens` → `cacheReadTokens`（2.3） |
| Tauri WebView2/WebKit 字体缺失 `◔` 渲染 | Slice 6.8 三平台 dev 模式人眼 review；若崩则该平台条件 swap |

---

## 9. 显式不做（避免范围蔓延）

- 不做按月份的账单导出（CSV 够用）
- 不做预算 / 告警阈值
- 不做团队 / 多用户聚合
- 不做按文件 / cwd / repo 聚合
- 不做实时 push
- 不做汇率换算
- 不做外部账单 API 对账
- **不做 soft-delete on Agent**（UsageEvent 已解耦，不需要）
- **不做 pricing-overrides UI 编辑器**（v1.1）
- **不做价格表第三方覆盖**（v1.1 视用户反馈）
- **不做 UsageEvent 回填工具**（旧 Message.payload 不入账，v1 直接接受 cutoff date）

---

## 10. 验收标准

- [ ] 顶部工具栏出现 `◔` 按钮；title 含 "usage stats"
- [ ] 点击 ≤ 200ms 弹出对话框，4 张 stat 卡 + 趋势 + table 三块齐备
- [ ] 默认 range = 30d；切换 7d / 90d / All 数据 + 图都更新
- [ ] groupBy 切换 day / agent / model / provider 4 种维度，表格列 + CSV 列对应改变
- [ ] **byAgent 视图含 include-descendants toggle**，开关后行 cost / token 数变化 + 子行展开折叠
- [ ] Claude side 和 OpenAI side 的 turn 都计入 cost 总额（用 pricing.json 算）
- [ ] 价格表里没有的 model → 出现在 unknownModels 单独行，cost 显示 `?`，不计入 total
- [ ] `${appDataDir}/pricing-overrides.json` 存在时被浅合并覆盖，不存在不报错
- [ ] export CSV 跟随当前 groupBy 视图导出对应文件名 + 列
- [ ] 完全无消息时 4 stat card / 图 / table 三块各显示独立空态占位
- [ ] **删 agent 后该 agent 的 UsageEvent rows 仍存在**，agentId=NULL，stats panel byAgent 视图显示 "(deleted agents)" 聚合行
- [ ] 删 provider 同上：UsageEvent.providerId=NULL，byProvider 视图显示 "(deleted providers)" 聚合行
- [ ] quickQuery 产生的 token 计入总账（UsageEvent source='meta'）
- [ ] **subagent 在 byAgent 表能 tree 展开/折叠**，include-descendants 工作正确
- [ ] top agent stat card 显示成本最高 agent；点击关闭 dialog 并切到 ChatPane（已删则 disabled）
- [ ] `UsageEvent` 表启动期被创建；索引 `usage_time_idx` / `usage_agent_idx` / `usage_provider_idx` 存在
- [ ] persistResultMessage + recordUsageEvents 在一个 transaction 内（一边失败两边回滚）

---

## 附 1：v1 → v2 → v3 修订差异

| v1 决策 | v2 决策 | v3 决策（最终） |
|---|---|---|
| Claude 直读 SDK costUSD | pricing.json 统一 | 同 v2 |
| pricing 在 TS hardcoded | JSON 双轨 | 同 v2 |
| OpenAI synth result 缺 usage | 合成 + modelUsage shape 对齐 | 同 v2 |
| 30s TTL 缓存 | 删除依赖 partial index | 删 partial index（UsageEvent 自带普通 index 够用） |
| 工具栏 lucide? | 保持 ◔ | 同 v2 |
| 删 agent 接受丢失 + 警告 | 同上 | **新建 UsageEvent 独立表 + agentId nullable** |
| subagent 平级 + indentation | 同 v1 | **v1 直接上 tree toggle** |
| quickQuery 不入账 | 写 Message type='meta' | **写 UsageEvent source='meta'**（不再用 Message 表混存） |
| CSV 字段未定 | 跟随 groupBy | 同 v2 |
| 价格表 v1 覆盖 | + 第三方测过 | **v1 仅 Claude + OpenAI 官方**（缩窄） |
| 工作量 | 2.5-3d → 3.5-4d | **4-4.5d**（新增 UsageEvent 表 + tree toggle） |

## 附 2：与 review 的差异

review 推荐的 D1 三方案（soft-delete / payload snapshot / 接受丢失）全部被否决——用户跳出方案空间提出"为什么 cost 要绑 agent"，给出第四方案（独立表）。这是 v2 → v3 的关键转折。

Memory 已固化原则：[FK CASCADE 不该吞业务/审计数据](C:\Users\Aad_y\.claude\projects\D--WorkSpace-AgentUI\memory\feedback_fk_cascade_data_loss.md)。
