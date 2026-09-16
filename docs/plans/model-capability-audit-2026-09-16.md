# 模型能力限制复审与修复路线（2026-09-16）

> 基线：`e45f2cf`，审计开始时工作树干净。  
> 目标：识别 Ensemble 适配层仍在静默限制模型能力的路径，并记录本轮修复与后续边界。  
> 总方案：[`model-capability-run-plan.md`](./model-capability-run-plan.md)。

## 1. 结论

早期的 28 条/18K 历史、OpenAI SDK 默认 10 回合、Skill 4K 截断、5 分钟静默误杀、
peer/subagent 多层截断、跨 Runtime cwd 错位等限制已经消除。

本次复审仍确认以下问题：

| 优先级 | 问题 | 影响 | 当前状态 |
|---|---|---|---|
| P0 | advertised/effective context 被 Runtime 和本地预算当作声明值 | 未核实展示值可改变 Runtime 配置；兼容端历史预算可能虚高 | 本轮已修（静态复核通过） |
| P0 | Claude 在自定义 `systemPrompt` + `settingSources: []` 下未获得项目指令 | Claude 忽略 `AGENTS.md`/`CLAUDE.md` | 本轮已修（静态复核通过） |
| P1 | OpenAI Responses 未保存服务端 conversation/response id | 跨轮 reasoning/tool items、原生 compaction 与连续状态未利用 | 本轮已实施（仅官方端点，见 §4） |
| P1 | OpenAI approval-resume 固定 32 轮 | 审批密集任务仍可能被硬终止 | 本轮已修（改为可观察循环检测，见 §5） |
| P1 | OpenAI hosted tools 未进入能力模型 | web/file search、code interpreter 等官方能力不可用 | 待产品与权限设计 |
| P1 | Cloud 服务端仍有静默裁剪 | 远端 system prompt/metadata 可能成为半份数据 | 待独立修复 |
| P2 | Skill 自动激活仍以词面匹配为主 | 跨语言与同义表达可能零命中 | 待语义路由批次 |

## 2. 本轮已修：context 三种语义重新隔离

### 2.1 新的不变量

`RunPlanContext` 明确携带三个互不替代的值：

- `advertisedContextWindow`：厂商标称值，只供 UI 与诊断。
- `effectiveWindow`：当前 Runtime/版本/会话实际有效值，只供历史、Skill、Artifact、compact 预算。
- `requestedRuntimeWindow`：唯一允许 Runtime adapter 写入配置的值；必须通过
  `requestedRuntimeWindow()` 策略门（配置键语义已验证 + catalog confirmed）。

禁止关系：

```text
advertisedContextWindow -X-> Runtime config
advertisedContextWindow -X-> history/skill/artifact/compact budget
effectiveWindow          -X-> Runtime declaration
```

### 2.2 修改范围

- Planner 在每轮只解析一次 `requestedRuntimeWindow`。
- Claude 只用 `requestedRuntimeWindow` 写 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`。
- Codex 只用 `requestedRuntimeWindow` 写 `model_context_window`。
- history、Skill/Artifact 比例预算与 layered compact 只认 `effectiveWindow`。
- effective 未知时保持未知，不借 advertised 伪造预算；诊断明确“不基于猜测丢内容”。

这恢复了总方案的核心禁令：展示事实不得反向控制运行行为，legacy/unverified 值不得取得声明权。

## 3. 本轮已修：Claude 项目指令

Claude adapter 当前同时使用完整字符串 `systemPrompt` 与 `settingSources: []`。在这个配置下，
不能再假设 SDK 会替 Ensemble 加载项目 `CLAUDE.md`。修复后的职责是：

- Codex CLI：继续从 RunPlan 的 cwd 自行加载项目规则，Ensemble 不重复注入。
- OpenAI API：Ensemble 完整加载并注入根目录 `AGENTS.md`/`CLAUDE.md`。
- Claude：与 OpenAI 共用同一完整读取器并注入一次；文件存在但不可读时拒绝 turn，禁止无规则运行。
- 项目规则内容进入稳定 system-prompt hash；内容变化会使旧 resume 失效，避免继续使用旧规则。
- `/status` 使用同一哈希输入；规则不可读时仍可返回状态，但不会把旧 resume 标成匹配。

## 3.1 本轮对两项 P0 的静态复核结论

- **context 三分**：`advertisedContextWindow` 的生产代码消费者只剩 facts 解析、
  plan 字段与展示（`context-usage.ts`、`context-bar-view.ts`、`run-plan-view.ts`、
  `ChatPane.tsx` 的诊断行）；`windowFractionBudget`、`resolveHistoryBudget`、
  `compactChunkBudgets` 与两个 runtime adapter 全部改读 policy 值。`effectiveWindow`
  为 null 时预算保持 unknown、不丢内容（`history-budget.ts` 的
  “nothing was dropped on a guess”），artifact inline 与 skill 预算同样按“未知即不猜”
  处理，方向一致。
- **Claude 项目指令**：注入点唯一（`promptParts`），与 OpenAI 共用读取器；
  `hashStableSystemPrompt` 的两个调用点（`/status` 与 turn）输入一致；
  `Codex` 仍自行加载，未重复注入；项目规则进入稳定 prompt hash，内容变化会失效旧 resume。
- 唯一发现的空缺是**展示层**：新增的 `context.requestedRuntimeWindow` 未出现在
  `/status` 或调试行里，用户看不到“到底向 runtime 声明了哪个值”。本轮未改展示层，
  记录在此作为后续 UI 项（不影响任何运行行为）。

## 4. OpenAI Responses 服务端续接（本轮已实施）

### 4.1 已验证的 SDK / API 事实（`@openai/agents` 0.16.1、`openai` 7.4.0）

| 事实 | 证据 |
|---|---|
| run 选项接受 `previousResponseId` / `conversationId` | `@openai/agents-core/dist/run.d.ts:172-173` |
| 二者互斥，只有无 `conversation` 时才发送 `previous_response_id` | `@openai/agents-openai/dist/openaiResponsesModel.mjs:2530-2535` |
| 每轮都重发 `instructions`（Responses 不继承上一轮 instructions） | 同上 `:2530`；`openai/resources/responses/responses.d.ts:762-772` |
| 流式路径同样产出 response id | 同 mjs `:2665-2680`（`response_done.response.id`）→ `agents-core/dist/run.mjs:1554-1560` |
| `RunResult.lastResponseId` 取最后一个 raw response 的 id | `agents-core/dist/result.mjs:68-75` |
| SDK 自身有“唯一 server-conversation 所有者”概念，并在同一 turn 的多次 model 调用间推进 id | `agents-core/dist/runner/conversation.mjs:10-20`、`:306-316` |
| 续接时 input 只发增量：SDK 只在 server 管理会话时跳过本地历史 | `agents-core/dist/run.mjs:266-270` |
| resume 时若重复传入旧 id 会被拒绝（必须让 state 持有最新 id） | `agents-core/dist/runner/runLoop.mjs:19-35` |
| `store` 由 modelSettings 透传；`context_management` 是原生压缩开关 | 同 mjs `:2546`；`agents-core/dist/model.d.ts:296-302` |

结论：SDK 能可靠取得并复用 id，且**已经是**“单一所有者”语义 —— 无需引入
Conversation 或 SDK Session 作为第二个所有者。

### 4.2 实施形态

- 所有者唯一：`previous_response_id`，按 agent 存于
  `capability/server-conversation.ts`（id + 签名 + `storedAt`，签名覆盖
  provider/model/projectRoot/systemPromptHash/transport）。
- 续接时 input **只发本轮输入**；非续接时仍整份重放。两条路径由
  `buildInputItems(opts, { continueFrom })` 一处决定，且 `continueFrom` 只在
  Responses 尝试上生效 —— chat-completions 回退会重建完整历史，不会对着
  “服务器没有的会话”发增量。
- id 只在**官方端点**（host = `api.openai.com`）上取得与使用：provider kind 是标签，
  host 才是事实。兼容端即使应答 `/responses`，也保持 `local-rebuild` 并给出原因 ——
  一个接受参数却忽略它的实现会静默丢掉整份 transcript，而“有 /responses 路由”并不
  等于具备 `store`/`previous_response_id` 语义。
- 端点若拒绝续接（结构化判定：request/unsupported 分类，或 400/404/422），
  写入 24h 的 provider 级否决并丢弃 id，下一轮回到本地重建；过期后可重试。
  判定只看结构化字段，不做文案匹配（与 `transport-errors.ts` 同一规则）。
- 该类路由显式 `store: true`（`previous_response_id` 只能指向服务器保留的响应）；
  `context_management` 仅在 plan 已有**经核实**的阈值时才透传 —— 目前 HTTP 路由的
  `compactionThreshold` 恒为 null，因此原生压缩保持关闭（不发明阈值），
  `/responses/compact` 端点调用未实现。

### 4.3 仍未做

- 兼容端（`openai-compat`）的续接资格验证：需要一个能确证 `store`/`previous_response_id`
  语义的探针（例如带哨兵 id 的探测请求），本轮未实现，因此这些路由一律本地重建。
- `POST /responses/compact` 端点式压缩与超窗无损重试。
- hosted tools（web/file search、code interpreter）的能力建模。

### 4.4 官方 OpenAI 文档确认

- `previous_response_id` 可用于多轮连续状态，且不能与 `conversation` 同时使用；
- 使用 `previous_response_id` 时，上一轮 instructions 不会自动继承，必须每轮重传；
- Responses 可保留原生 reasoning/output/tool items；
- `context_management` 与 `POST /responses/compact` 提供原生压缩；
- 默认 truncation 为 disabled，超窗会失败，而不是自动无损处理。

参考：

- https://developers.openai.com/api/reference/cli/resources/responses/methods/create
- https://developers.openai.com/api/reference/java/resources/responses/methods/compact

§4.1 的表格即“先验证 SDK 契约”的结果：所有者选定 `previous_response_id`（不是
Conversation，也不是 SDK Session），不重放完整历史，不把原生 tool/reasoning item
压回纯文本（它们留在服务器上，本地不再重发）。

## 5. 审批循环：从固定轮数改为可观察检测（本轮已实施）

`MAX_INTERRUPT_ROUNDS = 32` 已删除，替换为三件事，缺一不可：

1. **可观察的重复检测**（`makeApprovalLoopTracker`，上限 3 次同一
   `(tool, arguments)`）：只有“同一调用、同一参数”反复要求审批才判定为循环，
   每次都做新工作的长 turn 不再被任何数字截断 —— 这是原先 32 轮上限做不到的区分。
   第 2 次重复即告警，第 3 次以 `RUNTIME_TOOL_APPROVAL_LOOP` 结束本 turn，
   消息指名工具、次数与可选动作（旧消息只有一个无人能处理的数字）。
2. **Liveness**：每个审批轮次上报 `toolProgress()`，等待用户授权不会被误判为停顿；
   静默、异常关闭与用户墙钟上限（`maxRunDurationMs`）仍由 LivenessController 决定。
3. **用户取消**：`abortController` 在每轮与每项审批前检查，语义与之前一致。

这符合总方案既有的终止规则：终止来自取消、循环检测、liveness 与可选硬上限，
而不是一个会截断正常工作模型的 model-turn 数字（`maxModelTurns` 仍为 null）。

## 6. 其余后续修复顺序

1. 兼容端 `/responses` 的续接资格探针（哨兵 `previous_response_id`）；通过后把
   `openai-compat` 纳入服务端续接。
2. `POST /responses/compact` 端点式压缩与超窗（truncation=disabled）无损重试。
3. Cloud 服务端裁剪改为完整保存或结构化拒绝；禁止返回“成功但半份”。
4. hosted tools 建立模型/transport/账号/权限级 capability，再开放 UI，未知不默认启用。
5. Skill 零命中时加入缓存的结构化跨语言语义路由；显式调用仍为确定性兜底。
6. 展示层补 `context.requestedRuntimeWindow`（§3.1 记录的唯一空缺）。

## 7. 验收门禁

- unverified/legacy advertised 值可显示，但 Runtime 配置与本地预算均不读取它。
- observed effective 值可作为预算分母，但不能被重新写回 Runtime 声明。
- Claude/OpenAI/Codex 在同一 projectRoot 下获得一致的项目规则；Claude 规则变化会失效旧 resume。
- OpenAI 服务端续接启用后，不同时发送 continuation id 与完整历史。
- 续接只在被端点证实可用时声明；被拒绝时降级并丢弃 id（24h 后可重试）。
- 超窗失败只在请求未执行时触发无损压缩重试；原 transcript 永久保留。
- 审批不再有固定轮数上限；循环由可观察的重复判定终止，其他终止权归取消与 Liveness。
- 所有未实现能力保持 `unknown`/`local-rebuild`，不得用 UI 文案冒充已支持。

