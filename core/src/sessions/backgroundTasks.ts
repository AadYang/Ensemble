// Claude background-task lifecycle helpers (Slice 1, method A).
//
// Ensemble's turn loop historically treated the SDK `result` message as
// terminal (`break`). That silently drops Claude background subagents whose
// completion arrives AFTER the main result — the exact "warning/side-work
// becomes a silent stop" shape the unattended-dev mission forbids.
//
// These pure helpers let the loop keep DRAINING the SDK stream after `result`
// until every *drain-blocking* background task has reported terminal, then
// finalize. Kept as a standalone module so the decision logic is unit-testable
// without spinning up the whole SessionManager turn loop.
//
// SDK reference (@anthropic-ai/claude-agent-sdk@0.3.233, all `type:"system"`):
//   • task_started            — a (possibly background) task began. NOT proof
//                               that it is detached: Claude Code emits this for
//                               any long-running foreground Bash call too.
//   • task_progress           — running heartbeat (broadcast-only; NOT persisted
//                               to respect precise-memory: no context bloat).
//   • tool_progress           — same heartbeat shape for a plain tool call; also
//                               broadcast-only (it used to be persisted and
//                               rendered as a useless `[tool_progress]` row).
//   • task_updated            — { patch.status } incremental state.
//   • task_notification       — TERMINAL authority: completed | failed | stopped.
//                               (There is NO SDKTaskCompletedMessage.)
//   • background_tasks_changed — REPLACE-semantics live set (ids only). Emitted
//                               when the set CHANGES, including `[]` at turn end.
//
// Ambient/housekeeping tasks (skip_transcript === true, e.g. observers) run for
// the whole session and never "complete" — they must NEVER enter the drain set
// or the turn would hang forever. We therefore only ADD tasks from an explicit
// non-ambient task_started, and use background_tasks_changed to PRUNE (remove
// ids no longer live) but never to add.
//
// PRUNE IS NOT TERMINAL. Measured on a real transcript (agent 99e5f379):
//
//   seq=622 background_tasks_changed ["bnpivsq16"]
//   seq=623 task_started            bnpivsq16  "Build desktop installer"
//   seq=644 result                  (foreground turn done)
//   seq=645 background_tasks_changed []          ← live set emptied
//   seq=647 task_notification       bnpivsq16 stopped "No completion record…"
//
// The old code let the `[]` prune empty the drain set, finalized as a clean
// DONE, and never surfaced anything — the task's fate only appeared at the top
// of the NEXT turn. So a prune that removes a task we never saw terminate must
// report it as `lost`, and the caller must surface it (never silently finalize
// past a task whose terminal notification never arrived).

export interface BackgroundTaskInfo {
  taskId: string;
  description?: string;
  taskType?: string;
}

export type BackgroundTaskDelta =
  | { kind: "add"; task: BackgroundTaskInfo }
  | { kind: "remove"; taskId: string }
  | { kind: "prune"; liveIds: Set<string> }
  | { kind: "progress" }
  | null;

export interface BackgroundTaskApplyResult {
  /** Broadcast-only heartbeat: surface to the UI WITHOUT persisting. */
  broadcastOnly: boolean;
  /** Tracked tasks that left the live set without ever reporting terminal.
   *  Non-empty only for `prune`; the caller MUST surface these before it may
   *  finalize the turn. */
  lost: BackgroundTaskInfo[];
}

/** Why a tracked task never reached a terminal notification. */
export type BackgroundTaskLossReason = "live_set_dropped" | "stream_closed" | "turn_aborted";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Classify an SDK message into its effect on the drain-blocking task set.
 *  Returns null for anything that is not a recognised background-task event. */
export function classifyBackgroundTaskMessage(msg: unknown): BackgroundTaskDelta {
  if (!isRecord(msg)) return null;
  // `tool_progress` is a TOP-LEVEL message type (not a system subtype):
  //   {"type":"tool_progress","tool_use_id":"...-heartbeat-0","tool_name":"Bash",
  //    "parent_tool_use_id":"...","elapsed_time_seconds":30,"heartbeat":true}
  // It used to fall through to the persistence path and render as a
  // `[tool_progress]` row every 30 seconds (measured: seq 665/666).
  if (msg.type === "tool_progress") return { kind: "progress" };
  if (msg.type !== "system") return null;
  const subtype = msg.subtype;

  if (subtype === "task_started") {
    // Ambient/observer tasks never terminate; excluding them keeps the turn
    // from hanging. They still get persisted/broadcast for visibility.
    if (msg.skip_transcript === true) return null;
    if (typeof msg.task_id !== "string") return null;
    return {
      kind: "add",
      task: {
        taskId: msg.task_id,
        ...(readString(msg, "description") ? { description: readString(msg, "description")! } : {}),
        ...(readString(msg, "task_type") ?? readString(msg, "subagent_type")
          ? { taskType: (readString(msg, "task_type") ?? readString(msg, "subagent_type"))! }
          : {}),
      },
    };
  }

  if (subtype === "task_notification") {
    // Terminal authority regardless of status (completed | failed | stopped):
    // the task is no longer running, so it stops blocking the drain.
    return typeof msg.task_id === "string" ? { kind: "remove", taskId: msg.task_id } : null;
  }

  if (subtype === "task_updated") {
    const patch = isRecord(msg.patch) ? msg.patch : undefined;
    const status = patch?.status;
    if (typeof msg.task_id !== "string") return null;
    if (status === "completed" || status === "failed" || status === "killed") {
      return { kind: "remove", taskId: msg.task_id };
    }
    return null;
  }

  if (subtype === "background_tasks_changed") {
    const liveIds = new Set<string>();
    const tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
    for (const t of tasks) {
      if (isRecord(t) && typeof t.task_id === "string") liveIds.add(t.task_id);
    }
    return { kind: "prune", liveIds };
  }

  if (subtype === "task_progress" || subtype === "tool_progress") return { kind: "progress" };


  return null;
}

/** Apply a delta to the tracked drain-blocking task set (mutates in place). */
export function applyBackgroundTaskDelta(
  tasks: Map<string, BackgroundTaskInfo>,
  delta: BackgroundTaskDelta,
): BackgroundTaskApplyResult {
  if (!delta) return { broadcastOnly: false, lost: [] };
  switch (delta.kind) {
    case "add":
      tasks.set(delta.task.taskId, delta.task);
      return { broadcastOnly: false, lost: [] };
    case "remove":
      tasks.delete(delta.taskId);
      return { broadcastOnly: false, lost: [] };
    case "prune": {
      // A live set that stopped mentioning a tracked task is NOT a terminal
      // notification — report it so the caller can surface the loss instead of
      // finalizing a background task away in silence.
      const lost: BackgroundTaskInfo[] = [];
      for (const [id, info] of [...tasks]) {
        if (!delta.liveIds.has(id)) {
          lost.push(info);
          tasks.delete(id);
        }
      }
      // broadcastOnly: this is live-set bookkeeping, not transcript. Everything
      // it would say is already said durably by the task's own task_started and
      // task_notification rows; persisting it only added two meaningless rows
      // per background task ("running (1): …" / "none running"). The live set it
      // carries still reaches the UI, and `lost` is still surfaced by the caller
      // (that check runs BEFORE the broadcast-only short-circuit).
      return { broadcastOnly: true, lost };
    }
    case "progress":
      return { broadcastOnly: true, lost: [] };
  }
}

/** Whether the turn may finalize now: the main result has been seen AND no
 *  drain-blocking background task is still live. Before result is seen the turn
 *  always continues; this never changes pre-result behaviour. */
export function shouldFinalizeTurn(sawResult: boolean, tasks: ReadonlyMap<string, BackgroundTaskInfo>): boolean {
  return sawResult && tasks.size === 0;
}

const LOSS_REASON_TEXT: Record<BackgroundTaskLossReason, string> = {
  live_set_dropped: "the runtime dropped it from its live task set without a terminal notification",
  stream_closed: "no terminal notification before the runtime stream closed",
  turn_aborted: "the turn was aborted while it was still running (no longer supervised)",
};

function describeLost(info: BackgroundTaskInfo): string {
  const detail = info.description?.trim();
  const label = detail ? `${info.taskType ?? "task"} · ${detail}` : null;
  return label ? `${info.taskId} (${label})` : info.taskId;
}

/** Human-readable, persisted notice text naming every lost task. */
export function backgroundTaskLostText(
  lost: readonly BackgroundTaskInfo[],
  reason: BackgroundTaskLossReason,
): string {
  const list = lost.map(describeLost).join("; ");
  const noun = lost.length === 1 ? "background task" : "background tasks";
  return `${noun} not completed: ${LOSS_REASON_TEXT[reason]}${list ? ` — ${list}` : ""}`;
}

function noticePayload(
  subtype: "background_task_interrupted" | "background_task_orphaned",
  lost: readonly BackgroundTaskInfo[],
  reason: BackgroundTaskLossReason,
): Record<string, unknown> {
  return {
    type: "system",
    subtype,
    reason,
    task_ids: lost.map((t) => t.taskId),
    tasks: lost.map((t) => ({
      task_id: t.taskId,
      ...(t.taskType ? { task_type: t.taskType } : {}),
      ...(t.description ? { description: t.description } : {}),
    })),
    text: backgroundTaskLostText(lost, reason),
  };
}

/** Build the visible system message emitted when a tracked background task
 *  leaves the live set (or the stream closes) without a terminal notification.
 *  Kept pure so it is unit-testable and so a hang/death is NEVER silently
 *  swallowed into a `status:"DONE"` turn. */
export function backgroundTaskInterruptedMessage(
  lost: readonly BackgroundTaskInfo[],
  reason: BackgroundTaskLossReason = "stream_closed",
): Record<string, unknown> {
  return noticePayload("background_task_interrupted", lost, reason);
}

/** Build the visible system message emitted when the turn itself was aborted
 *  (user cancel / idle watchdog / peer interrupt) while background tasks were
 *  still live. Those shells are now detached from any supervisor — the old code
 *  skipped the notice entirely on abort, so a cancelled turn orphaned them in
 *  silence. */
export function backgroundTaskOrphanedMessage(
  lost: readonly BackgroundTaskInfo[],
  reason: BackgroundTaskLossReason = "turn_aborted",
): Record<string, unknown> {
  return noticePayload("background_task_orphaned", lost, reason);
}
