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
//   • task_started            — a (possibly background) task began.
//   • task_progress           — running heartbeat (broadcast-only; NOT persisted
//                               to respect precise-memory: no context bloat).
//   • task_updated            — { patch.status } incremental state.
//   • task_notification       — TERMINAL authority: completed | failed | stopped.
//                               (There is NO SDKTaskCompletedMessage.)
//   • background_tasks_changed — REPLACE-semantics live set (ids only).
//
// Ambient/housekeeping tasks (skip_transcript === true, e.g. observers) run for
// the whole session and never "complete" — they must NEVER enter the drain set
// or the turn would hang forever. We therefore only ADD tasks from an explicit
// non-ambient task_started, and use background_tasks_changed to PRUNE (remove
// ids no longer live) but never to add.

export type BackgroundTaskDelta =
  | { kind: "add"; taskId: string }
  | { kind: "remove"; taskId: string }
  | { kind: "prune"; liveIds: Set<string> }
  | { kind: "progress" }
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Classify an SDK message into its effect on the drain-blocking task set.
 *  Returns null for anything that is not a recognised background-task event. */
export function classifyBackgroundTaskMessage(msg: unknown): BackgroundTaskDelta {
  if (!isRecord(msg) || msg.type !== "system") return null;
  const subtype = msg.subtype;

  if (subtype === "task_started") {
    // Ambient/observer tasks never terminate; excluding them keeps the turn
    // from hanging. They still get persisted/broadcast for visibility.
    if (msg.skip_transcript === true) return null;
    return typeof msg.task_id === "string" ? { kind: "add", taskId: msg.task_id } : null;
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

  if (subtype === "task_progress") return { kind: "progress" };

  return null;
}

/** Apply a delta to the live drain-blocking task set (mutates in place).
 *  Returns true when the message is a broadcast-only heartbeat that the caller
 *  should surface to the UI WITHOUT persisting (task_progress). */
export function applyBackgroundTaskDelta(
  liveTasks: Set<string>,
  delta: BackgroundTaskDelta,
): { broadcastOnly: boolean } {
  if (!delta) return { broadcastOnly: false };
  switch (delta.kind) {
    case "add":
      liveTasks.add(delta.taskId);
      return { broadcastOnly: false };
    case "remove":
      liveTasks.delete(delta.taskId);
      return { broadcastOnly: false };
    case "prune":
      for (const id of [...liveTasks]) {
        if (!delta.liveIds.has(id)) liveTasks.delete(id);
      }
      return { broadcastOnly: false };
    case "progress":
      return { broadcastOnly: true };
  }
}

/** Whether the turn may finalize now: the main result has been seen AND no
 *  drain-blocking background task is still live. Before result is seen the turn
 *  always continues; this never changes pre-result behaviour. */
export function shouldFinalizeTurn(sawResult: boolean, liveTasks: Set<string>): boolean {
  return sawResult && liveTasks.size === 0;
}
