# Sidecar 事件循环饥饿（质量缺陷）

> **状态**：提案 · 2026-09-20  
> **等级**：质量缺陷。模型只是在吐 thinking / 正文，产品整窗假死（发消息、设置页、取消、其它 agent）不可接受。  
> **触发动机**：0.0.43 安装包上「墨水屏APP工程师」DeepSeek 长思考期间，`ensemble-core` `/healthz` 8s 超时；agent-2 / Yolo-World 等全部无响应。那些 agent 自己是 `DONE`，被同一条 Node 事件循环拖死。

---

## 0. 锁定不改

| 主题 | 保持 |
|---|---|
| 进程模型 | 单一 sidecar（Node SEA）+ Tauri shell。不加 Redis / worker 进程 / 第二条 HTTP 服务 |
| Runtime | Claude / OpenAI / Codex 三条路径行为一致 |
| Occupancy 条 | 继续在 ChatPane 头部显示；分子优先用 **provider usage**，本地 tokenizer 只是兜底 |
| Tokenizer 用途 | `js-tiktoken` 是审计 / 预算近似（`local-tokenizer.ts` 已写明），**不是**计费合同，更不是流式热路径 |

不在本次范围：拆进程、把 tokenizer 换成官方 tokenizer API、改 WebSocket 协议字段。

---

## 1. 缺陷定义

**不变量（验收用这一句）**：任意 agent 正在流式输出（含 DeepSeek 按字 thinking）时，sidecar 必须仍能在 **200ms 内**回答 `/health`、处理取消、打开设置页的 `GET /providers`、以及其它 agent 的 `send_message`。

违反即质量缺陷。Occupancy 条可以慢、可以估，**不能**用主线程同步 `encode()` 换一条会动的进度条。

---

## 2. 根因（已实测）

Sidecar 是 **一条** Node 事件循环：Fastify HTTP、WS `JSON.stringify`、SQLite、三条 runtime 的 `for await` 都在上面。`running` 只按 **单个 agent** 排队，**不同 agent 并行**，同步工作会互相卡住。

2026-09-20 现场：

| 项 | 值 |
|---|---|
| 进程 | `ensemble-core` 自 2026-09-18 16:02 未重启，RSS ~564 MB |
| 真正 RUNNING | 仅「墨水屏APP工程师」（anthropic / deepseek-flash），1700+ 行，持续 thinking + tool + 本地测试任务 |
| 用户点的 agent-2 / Yolo-World | 库里是 `DONE`，HTTP 进不去所以像卡死 |
| 阻塞形状 | DeepSeek `thinking_delta` 大量 1 字块；主线程对 **每一个** delta 调 `countTokens` → `Tiktoken.encode`；循环里没有 `await`，`/health` 排不上队 |

这不是「以前也能同时 thinking」。占用条接到流式事件是 0.0.34 才加上的。官方 Claude 常走 redacted CoT（只有 `thinking_tokens` 心跳，不算正文）。DeepSeek 把思考拆成海量 `thinking_delta`，才把这条路径打满。

### 2.1 热路径清单（都在主线程、同步）

| 优先级 | 位置 | 何时 | 为什么能卡死 |
|---|---|---|---|
| P0 | `SessionManager.noteLiveStreamOccupancy` | 每个 `stream_event` | 工作树已改为 200ms 批量，**未进安装包**。0.0.42/0.0.43 仍是每 delta 一次 `encode` |
| P0 | `hub.sendToSession` | 每个 `stream_event` | 前端 32ms 合批了，sidecar 仍对每字 `JSON.stringify` + `ws.send` |
| P0 | result 回退 `contextUsageFromTranscript` | 无 provider usage 时 | `findMany` 全表 + `countTokensMany` 整段 transcript。工作树已删这条回退，**未进安装包** |
| P1 | `resolveHistoryBudget` | 每轮 dispatch | 先 `turns.map(measure)` **全部**历史，再从新往旧装预算。1700 行是一次长卡 |
| P1 | `openai.ts` `countTokensMany(history)` | OpenAI 每轮开始 | 注释写明是 billing audit，却挡在 `runner.run` 前面 |
| P1 | `/compact` / skill `measure` | 用户触发或 overflow | 允许慢，但必须分段 `await`，不能连续 encode 数秒 |
| P2 | `GET /agents/:id/messages` | 打开长会话 | 一次 JSON 解析几百条大 payload；不该堵死别的路由，但要分页/截断意识 |

`LIVE_CONTEXT_MIN_EMIT_MS = 200` 只节流了 **发布**，0.0.43 仍对每个 delta `encode`。这是 0.0.42「增量计数」半成品：复杂度从 O(n²) 降到 O(n) 次调用，调用次数仍等于字数。

---

## 3. 方案（按 slice，可停在 P0）

### Slice 0 — 已在工作树、必须进下一包（0.0.44）

不发明新抽象，把已经写好的行为打进安装包：

1. 流式 occupancy：delta 先拼 `pendingStreamText`，只在 200ms 发布窗口 `encode` 一次。
2. 流式循环：至少每 50ms `setImmediate`，让 Fastify 插队。
3. result：**禁止**整篇 transcript tiktoken；有 provider / live 数字就用，没有就保留上一次占用条。

验收：合成 80+ 个 1 字 delta 的单测已有（`live-context-usage.test.ts`）。装上后：一边 DeepSeek 长思考，一边打开设置页必须能列出供应商。

### Slice 1 — 流式路径零 tokenizer（P0 补完）

**决议**：流式占用条的分子用 `ceil(pendingChars / 4)`（或等价启发式），**不要**在 `stream_event` 上调用 `countTokens`。

- 条是装饰；DeepSeek 的 BPE 和 `cl100k` 本来就 ±10–30%（tokenizer 文件头已承认）。
- 持久化 assistant / `result` 时仍用 **provider `usage`** 校准（Claude `input_tokens`+cache、OpenAI `contextUsage`）。校准失败则保持启发式，绝不回扫全表。
- 单次 `pending` 超过例如 32 KiB 也只按字符估，避免「一个超大 delta 卡 200ms」。

测试：`noteLiveStreamOccupancy` 路径在 mock 掉 `countTokens` 后占用条仍上升；`GET /health` 在 10_000 个同步 yield 的 thinking_delta 期间 p99 < 200ms（core 集成测，用 fake runtime，不打网）。

### Slice 2 — sidecar 侧合批 `stream_event`（P0）

前端 `STREAM_DISPLAY_FLUSH_MS = 32` 已经合批。缺口在 **写出 WS 之前**。

- 对 `type: "stream_event"` 且带 text/thinking/json delta 的消息，按 session 在 hub（或 SessionManager）合批 32ms，拼成一条再 `JSON.stringify`。
- 协议不变：客户端仍收 `stream_event`。合批失败（进程退出）flush 即可。
- `permission_request` / `status` / 持久化 `message` **不合批**。

三条 runtime 都走 `SessionManager` 的同一 `for await`，只改这一处即全覆盖。

### Slice 3 — 预算测量不要先扫完全部历史（P1）

`resolveHistoryBudget` 今天：

```ts
const counts = req.turns.map((t) => measurer.count(t.text)); // 全量
```

改为与装载顺序一致：先测 pinned，再从新到旧测，**预算装满即停**。`measuredTokens`（诊断用的「全部有多大」）对未测到的旧轮用 UTF-8 字节上界，并标记 `counting: "estimated"` —— 与 `makeTokenMeasurer` 已有语义一致。

OpenAI `inputTokensLocal`：历史字符合计超过阈值（建议 80k）则跳过 audit，写 0。Audit 不得挡 `runner.run`。

`/compact`：每层 summarize 之间 `await setImmediate()`；禁止一轮 compact 连续 encode 整库。

### Slice 4 — 忙时 UX（P1，可选但便宜）

设置页 / 发消息的 `apiFetch` 已有超时的，补一条产品语义：

- `/health` 超过 2s：顶部条显示「核心正忙（有 agent 在跑）」，不要转圈到死。
- 这不能替代 Slice 0–2。没有让出循环，超时也只是更快失败。

---

## 4. 明确不做

- **不为 tokenizer 开 worker 线程**（除非 Slice 1–3 之后仍有实测 >200ms 的单次 encode）。Worker 是猜测性复杂度，违反简单优先。
- **不改 occupancy 条的产品位置 / 阈值**（已由 `context-window-display.md` 锁定）。
- **不把 live 条做成计费精度**。校准点只有 persist/result 上的 provider 数字。
- **不限制多 agent 并行 thinking**。产品就是群智；正确做法是热路径便宜，不是加全局锁。并行时 CPU 会抬高、条会顿，但 HTTP 必须活。

---

## 5. 多 agent / 三 runtime

| 场景 | 期望 |
|---|---|
| 同一 agent 第二轮 | 继续排队（已有 `enqueueTurn`） |
| N 个 agent 同时 thinking | 允许。合批 + 启发式 + yield 之后，设置页仍可用 |
| Claude redacted CoT | 继续只广播 `thinking_tokens`，不算 occupancy 热路径 |
| DeepSeek anthropic-compat | 与 Claude 同一 SessionManager 循环，吃到全部 slice |
| OpenAI / Codex | 同样的 `stream_event` 合批；OpenAI 额外跳过超大 `countTokensMany` |

---

## 6. 验收

1. **合成**：fake runtime 打 10_000 次 1 字 `thinking_delta`；并行 `GET /health` 与 `GET /providers` 在 200ms 内 200。三条 runtime 的 fake 各跑一次。
2. **现场**：DeepSeek 长思考时能打开任意其它 agent 的设置并改供应商（用户本次打中的缺陷）。
3. **取消**：思考中点取消，1s 内 `interrupted_turn`（与既有 abort-first 叠加，不得回退）。
4. **占用条**：思考中条会动；turn 结束数字与 provider usage 同量级（允许启发式偏差，不允许整窗假死）。

Win / Mac 同一套逻辑，无平台分支。

---

## 7. 建议落地顺序

```
[Slice 0] 打进 0.0.44 安装包     → 验证：思考中能开设置
[Slice 1] 流式零 tokenizer        → 验证：10k delta 时 /health < 200ms
[Slice 2] sidecar WS 合批         → 验证：长思考时 CPU 不再被 stringify 打满
[Slice 3] 预算/audit 不再全量扫   → 验证：1700+ 行会话 dispatch 不卡设置
[Slice 4] 忙时文案                → 仅当 0–2 已合并
```

Slice 0 已在工作树。用户要恢复 **当前** 卡住的 0.0.43 进程：先退出 Ensemble（会打断墨水屏APP工程师这一轮），再装 0.0.44。
