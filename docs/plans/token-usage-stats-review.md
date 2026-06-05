# `token-usage-stats.md` 审阅意见（v2）

> 审阅对象：[`token-usage-stats.md`](./token-usage-stats.md)（W17 提案）
> 审阅日期：2026-05-11
> 审阅前提澄清：
> - 项目仅支持 Claude / OpenAI 两套 runtime；第三方模型（GLM / MiniMax / DeepSeek / timicc 等）通过 baseURL+key 走 `anthropic-compat` 或 `openai-compat`
> - 项目尚未发布，不需考虑历史数据与升级兼容
>
> 结论：方向正确。**价格策略**有一个核心决策需翻案；**UI / API** 有 4 处自相矛盾或描述模糊；**subagent / 删 agent 语义** 两个产品决策未落地。建议优化后再开工。

---

## A. 核心策略翻案：价格表统一覆盖 Claude side

| # | 问题 | 建议 |
|---|---|---|
| A1 | §1 表第 2 行决策"Claude 直读 SDK `costUSD`"对**走 anthropic-compat 的第三方**（MiniMax / GLM 用 Claude 协议）不成立——SDK 按 Anthropic 官方价算，给出的 `costUSD` 是虚高错值。byProvider 表里这些行的数字会严重误导用户 | **改为：所有 provider 统一走 `core/src/pricing.ts` 价格表，不再读 SDK 的 `costUSD`**。一致的计算路径，对第三方也能给出真实价格。代价仅是 Claude 新模型出来要手动更新一次价格表（频率 < 1 次/季度） |
| A2 | §2.3 价格表覆盖范围 | v1 覆盖：Claude 官方现行模型（opus-4-x / sonnet-4-x / haiku-4-x 全套）+ OpenAI 官方现行模型 + 已测过的 3 家第三方（timicc / DeepSeek / GLM）。其余 → `unknownModels` 桶，cost 显示 `?`，不计入 total |
| A3 | §2.3 pricing-overrides 推到 v1.1 太晚 | v1 把 `OPENAI_COMPAT_PRICING` 从 TS hardcoded 改成同目录 JSON 文件（`core/src/pricing.json`），打包随 sidecar，用户可临时编辑覆盖。零额外工作量，价值大 |
| A4 | 价格表数据出处不可追溯 | `pricing.json` 每条 entry 同行注释 `// source: <url>, fetched: 2026-05-11`（或在文件头列校准日期）；约定季度校准一次 |

---

## B. 必须修正的硬错误 / 矛盾

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| B1 | §2.3 第 90 行 | `~/.config/dev.ensemble.app/pricing-overrides.json` 路径错。Windows 是 `%APPDATA%\dev.ensemble.app\`（见 CLAUDE.md §1） | 用 Tauri `appDataDir()`，跨平台。Sidecar 通过现有 `ENSEMBLE_APP_DATA_DIR` 环境变量获取 |
| B2 | §3.2 vs §4 自相矛盾 | §3.2 说"列固定 `cost / in / out / cache_read / cache_creation / turns`"；但 §4 的 `byProvider` schema 里**只有 `costUSD, turns`** | 二选一：① 后端补全 `byProvider` 的 token 字段（推荐，schema 对齐）；② §3.2 改写为"按 groupBy 维度列动态" |
| B3 | §4 `unknownModels` schema | 只有 `model` 字段，但同一 model 名可能在多个 provider 下出现（用户自定义 provider 命名重复） | 加 `providerId`，按 `(model, providerId)` 聚合 |
| B4 | §2.2 描述模糊 | "监听 `output_text_delta` 的同时累加 `response.usage`"——但 `response.usage` 只在 `response.completed` 才有 final 值，不随 delta 增量给 | 改写：「在 `StreamEventResponseCompleted` 事件取 final usage；一个 query 可能多 response（tool 回路），逐 response 累加到 turn-level」。先确认 `@openai/agents` SDK 上 `response.usage` 字段的实际类型 |
| B5 | §3.1 图标 | `◔` 是 Unicode glyph，Tauri WebView2 / WebKit 字体缺失会落 fallback，视觉跳。项目其他地方用 lucide / shadcn 风格 | 换 lucide icon（`<Coins/>` 或 `<BarChart3/>`），与现有顶部条一致 |

---

## C. 双 SDK 适配细节

| # | 问题 | 建议 |
|---|---|---|
| C1 | OpenAI runtime 合成 result 的 schema 与 Claude 不对齐 | 合成的 result 也用 `modelUsage: { [modelName]: ModelUsage }` 结构（而不是顶层单 model 字段），便于聚合层走同一份解析代码 |
| C2 | byModel 聚合的 model 名 normalization | Claude SDK 给 dated 名（`claude-opus-4-5-20251001`），同一逻辑模型不同 snapshot 是否合并？**v1 不合并、按原样聚合**最简单；UI 用 monospace + tooltip 显示完整 id |
| C3 | Cache 字段映射说明 | **不需要按 provider 做字段适配**——compat 架构下 SDK 已统一字段名。Claude side 读 `cache_read_input_tokens` / `cache_creation_input_tokens`，OpenAI side 读 `prompt_tokens_details.cached_tokens`，缺字段 `?? 0` 兜底。在 §2.2 写明这个简单事实，避免读者误以为需要做字段适配表 |

---

## D. 产品决策未落地（必须在开工前敲定）

| # | 问题 | 建议 |
|---|---|---|
| D1 | **删 agent 后历史 cost 怎么办？**`Agent` 表 `ON DELETE CASCADE` 到 Message，删 agent → 历史花费同步消失。用户预期 ≠ "删 agent 抹除历史账单" | 决策三选一：① 改为 soft-delete（推荐，Agent 加 `deletedAt` 字段，列表过滤；最小改动）；② 删 Agent 时把 agentName / providerName snapshot 写进每条 Message.payload；③ 接受花费记录随 agent 一起消失（最简单但反直觉）。**这是 schema 决策，必须先定** |
| D2 | **subagent 累计语义**。subagent 是独立 Agent row，byAgent 表里和父 agent 平级；但用户视角"main agent 真实花费"通常包含其下 subagent 树 | byAgent 行返回 `parentId`，UI 加 tree 展开 / 收起 + 一个"include descendants"toggle。subagent 是 W14 默认功能，v1 不做这块会非常突兀 |
| D3 | **W14 quickQuery（推荐功能）token 不入账**。§7 风险表"典型 < 100 token/次"判断不准——推荐 prompt 实际数百 token，频繁调用累积可观 | v1 给 `SessionManager.quickQuery` 加 `recordUsage` 钩子，写一行 Message `type='meta'`，agentId 关联调用源 agent，model 字段标 `[suggestion]`。+0.5 天工作量但避免"用户怀疑总账不对" |

---

## E. UI / UX

| # | 问题 | 建议 |
|---|---|---|
| E1 | **趋势图信息密度低**。多 provider 用单条 line 看不出 OpenAI 占比 vs Claude 占比 | 默认 stacked area（按 provider 拆色块），保留 line / stacked toggle。recharts `AreaChart` + `stackId` 一行 |
| E2 | **空数据态没分区描述**。验收 §9 只一句"显示暂无数据"，4 张 stat card / 趋势图 / table 三块各自空态应分别设计 | 4 张 card 显示 `—`；图显示居中占位；table 显示空 caption。各自 mockup |
| E3 | **CSV export 字段未明确** | 明确：默认导出 daily detail（单文件），列 = `date, costUSD, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns`。byAgent / byModel 不导出（用户用得少，省时间） |
| E4 | **数字格式策略未定**。`142.3k` / `1.2M` 切换阈值？小数位？千分位分隔符？ | `Intl.NumberFormat`：token ≥10k 用 k、≥10M 用 M；cost 永远 2 位小数；分隔符按 locale |
| E5 | **时区处理**。§7 第 3 行"按 server 本地时区"足够，但 day-bucket 边界（23:30 → 00:30 算同一天还是次日）需明确 | API 接受 `tzOffset` 或 `tz`，前端传 `Intl.DateTimeFormat().resolvedOptions().timeZone`；SQL 用 `datetime(createdAt, 'unixepoch', ?)`。如不接受 tz 参数，则在文档明确"按 sidecar OS 本地时区切分日" |
| E6 | range="All" 在新用户场景显示大量低值 | 默认 30d 是对的；All 按钮 tooltip 标"全部历史" |

---

## F. 后端 API 细节

| # | 问题 | 建议 |
|---|---|---|
| F1 | `since / until` 边界 close/open 还是 close/close？ | `[since, until)` half-open，文档明确 |
| F2 | range="All" 的 API 表达 | `since` 可选；缺省 = 表中最早 `createdAt` |
| F3 | 30s TTL 缓存的收益存疑。§3.2 自己说 "前端切 groupBy 不打 API"，缓存仅在用户反复点同一 range 时命中 | 删除缓存层简化代码。实测慢再加 |
| F4 | endpoint 路径风格未对齐 | 对照 `core/src/index.ts` 既有 API 命名风格确认 `/api/usage/summary` 是否一致 |
| F5 | DB 索引 | 现有 `Message(agentId, createdAt)` 用不上 `WHERE type='result' AND createdAt BETWEEN` 查询。加 partial index：`CREATE INDEX msg_result_time_idx ON Message(createdAt) WHERE type='result'`。§5.3 实施切片加上 schema 迁移 |

---

## G. 验收清单补强

§9 现有清单建议追加：

- [ ] 删 agent 后历史 cost 行为符合 D1 选定方案
- [ ] subagent 累计在 byAgent 表能展开父子（依赖 D2）
- [ ] `byProvider` / `byAgent` / `byModel` 三个数组的 schema 列对齐（依赖 B2）
- [ ] `unknownModels` 数组按 `(model, providerId)` 聚合，同名 model 在不同 provider 下能区分（依赖 B3）
- [ ] quickQuery 产生的 token 计入总账（依赖 D3）

---

## H. 「待决议」补充

§10 已 5 项，建议追加：

6. **删 agent 后历史 cost 处理**（soft-delete / payload snapshot / 接受丢失）—— D1
7. **subagent 在 byAgent 表的形态**（平级 / 树形展开）—— D2
8. **quickQuery 是否计入**（写 meta row / v1 忽略）—— D3
9. **价格表是否覆盖 Claude side**（A1，统一计算 vs 保留 SDK costUSD）

---

## 总结

> **优先级**：A（价格策略翻案）→ B / D（schema 决策和硬错误）→ C / E / F（细节）→ G / H（验收和待决议清单）。
>
> 优化后工作量预计从 2.5–3 天上调到 **3–3.5 天**，主要增量：
> - subagent 树形展开
> - `pricing.json` 外置
> - Claude side 也走价格表
> - quickQuery 入账钩子
>
> 文档写作质量本身很好（决策矩阵 / 风险表 / 显式不做都很清晰）；以上意见为查漏补缺，非推翻方案。

---

## 设计稿作者答复（2026-05-11）

按 review 顺序逐条标 ✓ 接受 / ⚠ 部分接受 / ✗ 反驳。其余未标的 = 全盘接受。

### A. 价格策略翻案

| # | 处理 | 备注 |
|---|---|---|
| A1 | ✓ 接受 | **关键打回**。当 `provider.baseUrl` 非空（即第三方 anthropic-compat 上游）时，SDK 的 `costUSD` 是按官方 Anthropic 价算的虚高数。统一价格表更对。 |
| A2 | ✓ 接受 | 同意覆盖范围；具体 Claude 模型 SKU 列表实施时拉一次官方页定稿。 |
| A3 | ⚠ 部分接受 | **"零额外工作量"低估了**。Ensemble core 是 SEA 单文件（W15 决策），bundle 阶段 esbuild 把 import 的 JSON 内联进二进制——简单 `import "./pricing.json"` 不是 user-editable 的，得通过 Tauri resources 落到 install dir 才能编辑。v1 可两步走：① `pricing.json` 在 core 内 import（便于打包 + 校验），② 启动时检测 `appDataDir()/pricing-overrides.json` 存在则浅合并覆盖。这才是真正"用户可改"且"打包友好"的双轨。复杂度 ~半天，不是零。 |
| A4 | ✓ 接受 | source 注释 + 校准日期写在文件头。 |

### B. 硬错误 / 矛盾

| # | 处理 | 备注 |
|---|---|---|
| B1 | ✓ 接受 | 跨平台路径错。改 `appDataDir()` 解析。 |
| B2 | ✓ 接受 | 选方案 ①：补全 `byProvider` / `byAgent` / `byModel` 的所有 token 字段，schema 对齐 detail table 列。 |
| B3 | ✓ 接受 | `unknownModels` 按 `(model, providerId)` 聚合。 |
| B4 | ✓ 接受 | 改写为「在 `StreamEventResponseCompleted` 事件取 final usage；一次 query 多 response（tool 回路）逐条累加」。实施 Slice 5.1 前先 spike 一下 `@openai/agents` SDK 的真实事件 schema。 |
| B5 | ✗ **反驳** | Ensemble 现有顶部条 / ProviderPanel / ChatPane 工具按钮**全部用 Unicode glyph**（`↻ ✎ × ⇪ ⚡ ⌬ ★`），项目没引入 lucide / shadcn icons 依赖。为单个 stats 按钮引入 lucide 是项目级风格漂移，且增 ~50KB icon font bundle。**坚持 Unicode glyph**：实测 WebView2 (Windows) + WebKit (macOS/Linux) 上 `◔` 都有 fallback，确认在 Slice 5.6 实施时人眼 review 一下；若某平台真渲染崩，再做条件 swap，不为预防做项目级依赖。 |

### C. 双 SDK 适配

全盘接受（C1 / C2 / C3 都对）。Slice 5.1 OpenAI 合成 result 时主动统一成 `modelUsage: { [modelName]: ModelUsage }` 形态，聚合层就只写一份代码。

### D. 产品决策

| # | 处理 | 备注 |
|---|---|---|
| D1 | ⚠ **部分接受，方案换** | 删 agent → 历史 cost 消失这事**是真问题**，但 review 推荐的方案 ①（Agent 加 `deletedAt` soft-delete）成本被低估：当前 `prisma.agent.findUnique` / `findFirst` / `count` / FK 引用全要加 `WHERE deletedAt IS NULL` 过滤，且 `isDefault` 唯一性、`name` 唯一性、parent-child 解析全部要重审。<br/>**反建议方案 ②（snapshot in payload）**：写 Message 时直接把 `agentName` / `providerName` / `providerKind` 三个字段冗余进 `payload.meta` JSON。聚合时优先读 snapshot，缺失 fallback 到 join。新增字段 ≤ 20 行，无需 schema 迁移。删 agent 时 message 仍 CASCADE 走（这点不变），所以**这个方案仍然丢历史**——和方案 ① 等价的正解还是 soft-delete。<br/>**最终选择**：v1 接受方案 ③（删 agent 抹除其历史 cost），delete 对话框加显式警告。soft-delete 推 v1.1 单独立项做完整 schema 改造。理由：W17 是统计功能，把 schema soft-delete 改造硬塞进来违反 CLAUDE.md 准则 3「外科手术」。 |
| D2 | ⚠ 部分接受 | subagent 父子展开是正确的 UX，但 review 称"不做非常突兀"过于强。flat byAgent 列表已包含 subagent 行（W14 spawnTaskSubagent 产生的 child 都是真 Agent row），用户看得见。tree 展开是 polish，不是 correctness。<br/>**最终选择**：v1 byAgent 数组每条返回 `parentId`（schema 调整）；UI v1 显示为平级，但用 indentation 标缩进暗示父子；toggle 展开 / "include descendants" 切换推到 v1.1。这样 schema 不需要再改但 UX 已具雏形。 |
| D3 | ✓ 接受 | `quickQuery` 实际 input ~500-700 token / 次（catalog table ~150 + history 10×50），review 说得对，我 v1 设计的「< 100 token」是错的。`quickQuery` 加 `recordUsage` 钩子写 `Message type='meta'` row（不进 chat 渲染，UI 侧 ChatPane 过滤 `type!=='meta'`）。+0.5d 工作量接受。 |

### E. UI / UX

| # | 处理 | 备注 |
|---|---|---|
| E1 | ✓ 接受 | stacked area + line toggle。 |
| E2 | ✓ 接受 | 三块各画一份空态 mockup 进设计稿。 |
| E3 | ⚠ 部分接受 | **CSV 只导 daily 太刚性**。改为「CSV 跟随当前 groupBy 视图」——用户点 day 导 daily、点 agent 导 byAgent、点 model 导 byModel。前端只生成一个 export handler 接 currentGroupBy，零额外工作。 |
| E4 | ✓ 接受 | `Intl.NumberFormat` 规则按 review 写。 |
| E5 | ✓ 接受 | API 接受 `tz` 参数（IANA name 优先，offset 兜底）；SQL `datetime(..., 'unixepoch', 'localtime')` 不够（locale 是 server-side），改 `datetime(..., 'unixepoch')` 拉 UTC 后前端做 day-bucket。也对：分桶移到前端做避免 SQL 时区噩梦。 |
| E6 | ✓ 接受 | tooltip 标"全部历史"。 |

### F. 后端 API 细节

| # | 处理 | 备注 |
|---|---|---|
| F1 | ✓ 接受 | `[since, until)` half-open。 |
| F2 | ✓ 接受 | All → since 缺省 = earliest createdAt。 |
| F3 | ✓ 接受 | 删 30s 缓存。SQLite + 加了 F5 索引后这量级 ms 级响应，缓存层是过度工程。删。 |
| F4 | ✓ 接受 | 实施时核对 `/api/...` 风格；endpoint 改 `/usage/summary`（在 fastify register 里）。 |
| F5 | ✓ 接受 | 加 partial index `CREATE INDEX msg_result_time_idx ON Message(createdAt) WHERE type='result'`。Slice 5.3 实施时同步在 `db.ts` 的 `ensureColumn`-style 启动期 migration 加上。 |

### G / H. 验收 + 待决议

✓ 全盘接受。G 5 项追加到验收 checklist；H 4 项追加到「待决议」，且**实际上 review 期间用户已经隐含给了 A1 / A4 / D2 / D3 决议**（A1 走价格表、D2 平级+缩进、D3 写 meta row、A4 注释 + 校准日），剩 D1 v1 选方案 ③（接受丢失 + 删除警告，soft-delete 推 v1.1）。最终 v1 入「待决议」清单的实际只剩原稿的 5 项 + D1 的 v1.1 后续。

---

### 总账：v1 实际改动清单

| 来源 | 改动 |
|---|---|
| A1 | 价格统一走 pricing.json（含 Claude SKU 全套）|
| A2 | 价格表覆盖 Claude 官方 + OpenAI 官方 + timicc/DeepSeek/GLM |
| A3 | core 内 import + appDataDir overrides 双轨（半天，非零）|
| A4 | source 注释 + 校准日期 header |
| B1 | 跨平台 path via appDataDir |
| B2 | 后端三个 by-X schema 列对齐 |
| B3 | unknownModels 按 (model, providerId) |
| B4 | response.usage 用 final 事件，文字改写 |
| C1 | OpenAI 合成 result 用 modelUsage shape |
| C2 | dated snapshot 不合并 |
| C3 | cache 字段映射文字补充 |
| **B5** | ✗ **反驳**：保持 Unicode glyph，不引入 lucide |
| **D1** | ⚠ **改方案 ③**（v1 接受丢失 + 警告，v1.1 单独立项 soft-delete）|
| **D2** | ⚠ 父子用 indentation 暗示，tree toggle 推 v1.1 |
| D3 | quickQuery 写 meta row（+0.5d）|
| E1-E6 | 全接受 |
| E3 | ⚠ CSV 跟随当前 groupBy（非只 daily）|
| F1-F5 | 全接受 |

**总估时调整**：原 2.5-3 天 → 接受 review 后 review 估 3-3.5 天 → 加上 A3 价格表外置实际 0.5d（review 低估）+ D3 meta row 0.5d → **3.5-4 天**。仍在「显式不做」范围内可控。

实施前需 user 拍板：原稿 §10 的 5 项（range 默认 / 趋势单位 / 价格表覆盖范围 / stat card #4 / CSV v1 是否要）+ 反驳点确认（B5 保留 Unicode + D1 走方案 ③ 接受丢失 + D2 v1 平级 indentation）。
