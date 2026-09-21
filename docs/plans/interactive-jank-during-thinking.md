# 思考期间整窗交互卡死（质量缺陷）

> **状态**：P0–P2 已落地（0.0.48）· 2026-09-21  
> **等级**：质量缺陷。有 agent 在思考时，切换 agent、在另一个输入框打字、加成员、开设置都应保持可交互。  
> **相关**：[`sidecar-event-loop-starvation.md`](sidecar-event-loop-starvation.md) 只覆盖 sidecar Node 循环。本文补上 **WebView 主线程**——这才是「点侧栏 / 打字也卡死」的直接原因。

---

## 0. 锁定不改

| 主题 | 保持 |
|---|---|
| 进程模型 | 单一 sidecar + Tauri WebView。不拆第二条 HTTP、不加 Redis、不为 UI 开 Worker 渲染 |
| 思考可见 | 思考过程仍要显示（样式弱于结论）。优化不得改成「藏起来就不卡了」 |
| 多 agent 并行 | 允许同时 thinking。热路径便宜，不加全局锁 |
| 三 runtime | Claude / OpenAI / Codex 同一套节流与订阅规则 |

---

## 1. 缺陷定义

**不变量（验收用这一句）**：任意 agent 正在流式输出（含 DeepSeek 按字 thinking）时：

1. sidecar 200ms 内回答 `/health`、处理 `create_agent` / 取消 / `GET /providers`（沿用 starvation 文档）
2. **点侧栏另一个 agent，到输入框能打字，体感 < 100ms**
3. **正在打字的输入框不丢键、不卡顿**（与那个 agent 是否在思考无关）

违反即质量缺陷。占用条和思考正文可以节流，**不能**拿整窗假死换一条会动的字。

这不是「加成员等 4 秒确认」的表面问题。那只是同一根因在对话框上的一种表现。

---

## 2. 根因：两条主线程，缺一不可

Ensemble 桌面端是两个单线程绑在一起：

| 线程 | 进程 | 卡住时用户看到什么 |
|---|---|---|
| **A. Node 事件循环** | `ensemble-core` sidecar | 加成员超时、设置页转圈、发消息无响应、取消迟钝 |
| **B. WebView JS** | `ensemble.exe`（WebView2 / WebKit） | **切换 agent 没反应、在另一个框打字卡、侧栏点不动** |

A 已在 starvation 文档里实测：DeepSeek `thinking_delta` 一字一块，sidecar 同步 `JSON.stringify` +（0.0.47）tiktoken，假 `await` 让不出 Fastify。

B 是这次新定位，解释「体验和以前完全没法比」里 **交互面** 那一半。

### 2.1 为什么打字 / 切换也卡（B，已读代码）

流式路径：WS `message` → `page.tsx` 里 `JSON.parse` + `ingestLiveSdkMessage` → 32ms 合批后 `ingestStreamDisplayChunks` → `set({ agents: { ...s.agents, [id]: { ...ag, turns } } })`。

这会换掉 **整个** `agents` 对象引用。下面三处订阅的是整张 map，不是某一个 agent：

| 位置 | 订阅 | 后果 |
|---|---|---|
| `desktop-ui/app/page.tsx` | `useStore((s) => s.agents)` | 每个 flush（32ms）**根页面重渲染**：顶栏 running 计数、窗口栏、LayoutRenderer |
| `desktop-ui/components/AgentTree.tsx` | 同上 | 侧栏整树 `groupAgents` + 所有 TreeRow 重渲染。TreeRow **只用** `summary`（name/status），却跟着 turns 一起刷 |
| `desktop-ui/components/PaneShell.tsx` | 同上（后台任务条） | **每个可见分栏**都订整张 map。你在 agent-2 打字，墨水屏的 thinking 仍让这个 PaneShell / ChatPane 当子组件重跑 |

ChatPane 自己订的是 `s.agents[agentId]`，Zustand 对 **未改 id** 是引用相等，本可以不更新。但父级 Page / PaneShell 每帧重渲染，`memo` 又没包 ChatPane，**输入框所在组件照样跑完一遍**。keystroke 和思考 flush 抢同一条 Chromium 主线程。

另外，0.0.47 安装包里 sidecar **还没合批**，WebView 上还是一字一帧 `JSON.parse`。32ms 合批只挡了 Zustand，没挡 parse。墨水屏 `reasoningEffort=high` 时这是持续的主线程税。

可见的思考 pane：流式中已是 `whitespace-pre-wrap`（不跑 remark）。但几万字持续改 DOM 仍会 layout；切到该 agent 后，**已结束**的思考块会走 `ReactMarkdown + remarkGfm`（`ChatPane.tsx` Turn）。长思考一次性 parse 会再卡一下。这是第二刀，不是「在另一个框打字」的主因。

### 2.2 为什么和以前没法比

不是「以前就能并行、现在 magically 不行」。形状变了：

| 以前（官方 Claude 为主） | 现在（墨水屏 DeepSeek high） |
|---|---|
| 思考常是 redacted CoT：`thinking_tokens` 心跳，几乎无正文 | `thinking_delta` 按字推，一轮可以万字级 |
| 占用条 0.0.34 才接到流上；更早根本不算 | 每个 delta 进 occupancy + WS |
| 面板上思考很少、很短 | 产品要求思考可见，Turn 里挂全文 |

同一套「整表订阅 + 一字一帧」，Claude 心跳几乎无感，DeepSeek 长思考把 A 和 B 同时打满。这是质量缺陷，不是「思考中操作变慢很正常」。

### 2.3 和「加成员 4 秒红字」的关系

对话框空等 `agent_created` 是 **错的 UX**（建团队并不等）。即使改成发出去就关：

- A 没让出循环 → 成员实际要过好几秒才进库
- B 没切断订阅 → 对话框按钮本身也点不动

必须两层一起修。工作树里 sidecar Slice 1–2（字符估占用、WS 合批、真 `setImmediate`）和「加入不空等」**还没进你装的 0.0.47**。即便打进包，**不修 B，切换/打字仍会卡**。

---

## 3. 方案（按 slice，可停在 P0）

### P0-A — 把已写的 sidecar 热路径打进安装包

与 starvation 文档 Slice 1–2 同一份代码，不另开炉灶：

1. 流式占用条 `ceil(chars/4)`，禁止 `countTokens`
2. 同 kind 的 `thinking_delta` / `text_delta` 在 sidecar 合批 32ms 再 `ws.send`
3. 每 8 个 delta 或 16ms **`setImmediate`**（不能只 `await` 已 resolved 的 Promise）
4. 加入成员：发出 `create_agent` 即关对话框（与 NewTeamDialog 一致）

验收：合成 8k 一字 thinking 时 `createAgent` < 200ms（`event-loop-yield.test.ts` 已有）。

### P0-B — 切断「思考改 turns → 整窗重渲染」（前端，本缺陷的主修）

原则：turns 变化只通知 **那个 agent 的 ChatPane**。侧栏、顶栏、其它分栏只订它们真正用到的字段。

1. **Page**：不要 `useStore((s) => s.agents)`。顶栏 `activeCount` / `idleCount`、窗口活动点，改订 `summary.status` 的投影（例如 `Record<id, status>`，只在 status 变时换引用）。`nextDefaultName` 用 `getState()` 或只在打开 NewAgent 时算。
2. **AgentTree**：只订创建树需要的 summary 字段（`id/name/status/teamId/parentId/subagentKind/closed`）。禁止订带 `turns` 的 `AgentState`。
3. **PaneShell**：后台任务条只订「parentId + subagentKind + closed + status」，不要整张 `agents`。`turnCount` 从本 pane 的 `s.agents[agentId].turns.length` 来。
4. **`memo(ChatPane)` / `memo(Turn)`**：父级万一重渲染，未改 props 的 pane 不跑。

验收：墨水屏长思考时，React  Profiler 里 agent-2 的 ChatPane **不应**随 thinking flush 更新；在 agent-2 连续输入 30 个字符不丢键。

### P1 — 不可见 agent 的流更粗；可见 thinking 限制 DOM

P0-B 之后，不可见 agent 仍会 32ms 写 store（内存拷贝 turns）。墨水屏不在任何 pane 时，这一步可以更懒：

- **不在可见 pane 的 session**：stream 合批提到 200ms，或只更新 occupancy/status，turns 用 tail 缓冲，切到该 pane 再 flush
- **正在流的 thinking 正文**：DOM 只保留尾部 N 字（建议 4–8k 字符）+「此前省略」；完整正文仍在 store，停止流式后再一次渲染。切到该 agent 仍看得到思考，只是不每帧把 80KB 塞进 layout

验收：墨水屏不在当前窗口时，思考中点侧栏其它 agent，点击处理器在 100ms 内跑完。

### P2 — 长会话不要一次端到端

- `GET /agents/:id/messages` 默认 200；打开超长会话按需向前翻（墨水屏已 3500+ 行）
- sidecar `resolveHistoryBudget` 不要先 `turns.map(measure)` 全表（starvation Slice 3）

这解决「点开墨水屏那一下卡死」，不是「在别人框里打字卡」的主因。可后做。

### 明确不做

- 不把思考默认折叠当性能开关（和已定 UX 冲突）
- 不为 remark 开 Worker（先切断订阅；不够再议）
- 不拆 sidecar、不加第二条 WS
- 不限制多 agent 同时 thinking

---

## 4. 建议落地顺序

```
[P0-A] sidecar 合批 + 真 yield + 加入不空等   → 打进下一安装包
[P0-B] Page / AgentTree / PaneShell 停止订整张 agents  → 打字和切换不再跟 thinking 绑死
[P1]   不可见 session 粗合批 + thinking DOM 尾窗     → 墨水屏不在屏上时侧栏也顺
[P2]   消息分页 + 预算测量早停                      → 打开超长会话不卡一下
```

P0-A 与 P0-B **必须同一版**。只出 A，WebView 照样卡；只出 B，加成员/设置仍可能被 Node 循环拖死。

Win / Mac 同一套逻辑，无平台分支。

---

## 5. 现场验收清单

墨水屏APP工程师 DeepSeek high 长思考进行中：

- [ ] 侧栏点任意其它 agent，输入框可聚焦、可打字
- [ ] 该输入框连续输入不掉字、不明显顿
- [ ] 顶栏 running/idle 可以最多 200ms 一跳，但点击不排队数秒
- [ ] 「加入」立即关对话框；成员在侧栏出现（允许略晚于点击，但不再出 4s 红字）
- [ ] 设置页能列出供应商
- [ ] 思考 pane（若可见）文字仍在增长；占用条仍动
- [ ] 取消思考中的 agent，1s 内进入 interrupted（不回退 abort-first）
