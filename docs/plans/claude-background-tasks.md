# Claude 后台任务(background agents)支持 — Slice 0 审计与协议草案

状态:Slice 0 审计完成(GitHub #16)。**Slice 1 已实现(Windows 侧核心生命周期,用户直接指令优先落地,不阻塞于跨端对齐)**。Slice 2(专用 UI 面板、恢复路径、macOS 真机)待跟进。

> Slice 1 落地说明:按用户指示先修复 Windows 侧,不再以 Mac 对齐为前置门槛。核心 turn 循环已改为「result 后 DRAIN 到后台任务清空再收尾」,后台事件经既有持久化/广播管线透出;UI 暂以现有泛化 system 行呈现(专用面板归 Slice 2)。跨端字段/状态若 Mac 组在 #16 有异议,再回归调整,不影响本次已验证的 Windows 行为。

方案裁定:方案 A(保留 Claude 后台任务语义,不强制前台降级)。

SDK 基线:`@anthropic-ai/claude-agent-sdk@0.3.233`(win32-x64 native 0.3.233)。

---

## 1. 根因(已确认)

`core/src/sessions/SessionManager.ts:3097`:

```ts
// A result message is terminal for this turn.
if (msg.type === "result") break;
```

Claude SDK 的后台任务生命周期:主 turn **先**产出 `result`,后台 subagent 仍在运行,其进度/完成通过后续 `system` 子类型消息投递。Ensemble 一见 `result` 就 `break` → 放弃 SDK 流、turn 收尾、下一次 turn 走 `resume` → 后台 subagent 被静默丢弃,完成通知永不到达。

## 2. SDK 事件协议(实测类型,sdk.d.ts)

注意:**不存在 `SDKTaskCompletedMessage`**。完成/失败/停止的权威信号是 `task_notification`。全部为 `type:"system"` + `subtype`,均带 `uuid`、`session_id`。

| subtype | 关键字段 | 语义 | 出现时机 |
|---|---|---|---|
| `task_started` | `task_id`, `tool_use_id?`, `description`, `subagent_type?`, `task_type?`, `workflow_name?`, `prompt?`, `skip_transcript?` | 一个(可能后台的)任务开始 | 主 result **之前或之后**均可 |
| `task_progress` | `task_id`, `tool_use_id?`, `description`, `subagent_type?`, `usage{total_tokens,tool_uses,duration_ms}`, `last_tool_name?`, `summary?` | 运行中进度心跳 | 任务运行期间 |
| `task_updated` | `task_id`, `patch{status?: pending\|running\|completed\|failed\|killed\|paused, description?, end_time?, total_paused_ms?, error?, is_backgrounded?}` | 增量状态,merge 进本地任务表 | 状态变更时 |
| `task_notification` | `task_id`, `tool_use_id?`, `status: completed\|failed\|stopped`, `output_file`, `summary`, `usage?`, `skip_transcript?` | **终态权威信号** | 任务结束 |
| `background_tasks_changed` | `tasks: {task_id,task_type,description}[]` | 存活后台任务全集,**REPLACE 语义**(整体替换本地集合) | 集合成员变化(start/complete/kill/前台被转后台) | 

补充约束(来自 SDK 注释):
- `background_tasks_changed` 是 level 信号,payload 只带 id;**进程级**:CLI 进程重启时不重发,消费者须在 (re)start 时把集合重置为空,靠下一次成员变化重填。
- `skip_transcript=true` 的任务为 ambient/housekeeping(如 observer),**不进内联 transcript**,但可进任务面板。
- query 对象控制面:`stopTask(taskId)`、`backgroundTasks(toolUseId?)`(把前台任务转后台)。

## 3. 现有消费链路审计(证据)

1. **入口过滤 `isInternalSystemMessage`** (`SessionManager.ts:135`):仅过滤 `subtype==="thinking_tokens"`。→ 上述后台子类型**不会**在此被丢弃。
2. **持久化+广播** (`SessionManager.ts:3045-3091`):非内部消息一律 `prisma.message.create({type: msg.type, payload})` 后 `hub.sendToSession({type:"message"})`。→ 管线本身能承载后台消息;**唯一障碍是 3097 的 break 让它们收不到**。
3. **历史重建 `runtimeHistoryFromCompletedTurns`** (`SessionManager.ts:592`):`lastResultIndex = rows.lastIndexOf("result")`,`rows.slice(0, lastResultIndex+1)`。→ **凡持久化在最后一个 result 之后的行会被历史裁掉**。这是 Slice 1 的硬约束:后台完成消息若持久化在 result 之后,resume 时会丢失,须重新设计 result 与后台完成消息的相对次序/归属(见 §5)。
4. **UI 映射 `sdkMessageToTurn`** (`desktop-ui/store/agents.ts:197`):未知 system 子类型 → 泛化 `{kind:"system", text:"system · <subtype>"}`,不会崩,但无任务面板/无终态展示/无活动计数。Slice 2 需补。
5. **空闲看门狗** (`SessionManager.ts:95, 3006`):默认 20min,每个 runtime 事件 `resetRuntimeIdleWatchdog`。→ 后台任务静默超过 20min 会误触 `RUNTIME_IDLE_TIMEOUT` 杀 turn。Slice 1 须定义:有存活后台任务时暂停看门狗或用独立更长阈值。

## 4. 拟定映射(Ensemble 内部)

- 维护 per-run `backgroundTasks: Map<task_id, {type, status, description, tool_use_id?, subagent_type?}>`。
- `task_started`(非 skip_transcript)→ 持久化+广播;计入活动集。
- `task_progress` → 广播(节流),**不逐条持久化**(契合"精准记忆,勿塞满上下文");仅保留最新一条/或不入库。
- `task_updated` → merge 本地状态;终态(completed/failed/killed)从活动集移除。
- `task_notification` → **权威终态**;持久化(summary + status + output_file 引用,不入 output 全文)+广播;从活动集移除。
- `background_tasks_changed` → REPLACE 本地活动集(用于校正,不作边沿配对)。

## 5. 主 result 后的结束条件(状态机草案)

turn 结束不再等价于"见到 result"。改为:

```
收到主 result:
  - 记录 finalText、usage、mark sawResult
  - 若 活动后台任务集为空 → 立即收尾(与现状一致)
  - 若 非空 → 进入 DRAINING 状态:继续消费 SDK 流,处理 task_* 事件,
             直到 活动集清空(或达到后台 drain 上限/被取消)
DRAINING 结束 → 正式收尾(status=DONE)
```

关键设计约束(承 §3.3):后台完成消息不能持久化在 result 行"之后"否则被历史裁剪。候选方案(留待 Slice 1 定夺,需 Mac 对齐):
- (a) 后台任务的 `task_notification` 持久化时 seq 归属到 result **之前**(逻辑归并入该 turn);
- (b) 或改 `runtimeHistoryFromCompletedTurns` 的裁剪规则,把"result 之后、下一 user 之前"的后台 system 行纳入历史;
- (c) 后台完成不入 runtime history(仅入 UI/记忆摘要),避免污染 resume 上下文。

## 6. 失败 / 取消 / 异常语义(硬性:禁止静默丢弃,禁止把异常收尾误标正常完成)

| 场景 | 期望行为 |
|---|---|
| 后台任务 `status=failed`(task_notification/task_updated) | 持久化为可见的失败记录(非 error 级 turn 失败),turn 仍可正常收尾;失败摘要进 transcript |
| 用户 cancel | abort 传播;对存活后台任务调用 `stopTask` 逐个停;收尾 status=IDLE;记录哪些被中止 |
| SDK 流异常/进程退出(DRAINING 中) | 视为可恢复:标记未决后台任务为 `unknown/interrupted`,turn 收尾为 ERROR 或 IDLE(不得标 DONE);下一 turn 自愈继续,不得静默 |
| 空闲超时 | 有存活后台任务时暂停看门狗或独立阈值;仅在确无后台活动时才按 idle 收尾 |
| 未知 subtype | 记录 warn + 原样持久化/广播,**绝不静默丢弃** |
| CLI 重启 | 按 SDK 语义把 background_tasks_changed 集合重置为空,靠后续事件重填 |

## 7. 测试矩阵(Slice 1/2 需覆盖)

核心(Slice 1,Vitest,mock runtime 事件流):
1. result 后无后台任务 → 立即收尾(回归,行为不变)。
2. result 后有 1 个后台任务,随后 task_notification(completed)→ turn 等到 drain 完再 DONE,完成消息被持久化+广播。
3. 多后台任务并发,乱序 task_updated/notification → 活动集精确增减,全清空才收尾。
4. background_tasks_changed REPLACE 语义 → 本地集合被整体替换。
5. task_notification(failed)→ turn 正常 DONE 但失败可见,未误标成功。
6. DRAINING 中 SDK 流抛错 → 收尾非 DONE,未决任务标记 interrupted,不静默。
7. cancel during DRAINING → stopTask 调用 + status=IDLE。
8. 空闲看门狗:后台任务静默 > 阈值不误杀(暂停/独立阈值)。
9. skip_transcript 任务不进内联 transcript。
10. 历史重建:后台完成消息在 resume 后按选定方案(§5)正确纳入/排除,不丢失、不污染。
11. task_progress 不逐条入库(精准记忆约束)。

UI/端到端(Slice 2):
12. 任务面板渲染活动/完成/失败;活动计数正确。
13. Windows 真机 + macOS 真机(Mac 项目组)后台任务全流程一致。

## 8. 待与 Mac 项目组对齐(经理经 issue 处理)

- 事件字段与状态模型是否两端一致采用本文 §2/§4 映射。
- §5 历史归属方案 (a)/(b)/(c) 二端统一选型(影响 resume 与记忆)。
- UI 表达:任务面板 vs 内联 transcript 的分工;活动计数展示位置。
- 后台 drain 是否设上限(时间/数量)及默认值。
- 空闲看门狗对后台任务的处理策略(暂停 vs 独立阈值 + 阈值值)。

## 8b. Slice 1 实现纪要(已落地 · Windows)

新增纯函数模块 `core/src/sessions/backgroundTasks.ts`(可单测,不依赖 turn 循环):
- `classifyBackgroundTaskMessage(msg)` → add / remove / prune / progress / null。
- `applyBackgroundTaskDelta(set, delta)` → 维护活动集,返回 `{broadcastOnly}`(仅 task_progress 为 true)。
- `shouldFinalizeTurn(sawResult, liveTasks)` → `sawResult && liveTasks.size===0`。

接入 `SessionManager.ts` turn 循环(最小改动):
- result 不再无条件 `break`;改为 `sawResultForDrain=true` 后按 `shouldFinalizeTurn` 判定。
- `task_progress` 广播-only(不持久化)→ 契合精准记忆,不污染 resume 上下文。
- 其余后台事件走既有持久化+广播管线(不静默丢弃)。

关键安全保证:
- **不 hang**:活动集只由「非 ambient 的 task_started」加入;`background_tasks_changed` 只做 prune(移除),绝不新增 → observer 等 ambient(skip_transcript)任务永不进集合。SDK 若在 result 后直接关流,for-await 自然结束 → 优雅收尾(退化为旧行为,不更差)。后台任务静默超空闲阈值 → 空闲看门狗 abort → 有界收尾。
- **不误标**:result 已置 `sawResult`,DRAIN 期间异常不会被判为 interrupted。

历史归属选型:采用 **(c)**。Claude 侧 resume 依赖 SDK 自身 `session_id`(CLI 会话文件已含后台完成),故后台完成消息虽持久化留档、但不注入 Ensemble 侧 `runtimeHistoryFromCompletedTurns` 重建历史(其按最后一个 result 裁剪,天然排除),避免二次污染。若 Mac 组在 #16 主张 (a)/(b),再回归。

测试:`core/src/sessions/__tests__/background-tasks.test.ts`(18 项);core 全量 30 files / 322 tests 通过;tsc --noEmit clean。

## 9. 分片与提交约束

- Slice 0(本文):审计+协议草案+测试矩阵,不改代码。
- Slice 1:核心生命周期状态机 + 持久化/广播 + §7 core 测试;独立提交、可回滚。
- Slice 2:UI + 恢复路径 + Windows/macOS 真机验证;独立提交、可回滚。
- 全程:禁止未知后台消息静默丢弃;禁止把异常收尾误标为正常完成。
