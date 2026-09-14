import { describe, it, expect } from "vitest";
import {
  classifyBackgroundTaskMessage,
  applyBackgroundTaskDelta,
  shouldFinalizeTurn,
  backgroundTaskInterruptedMessage,
  backgroundTaskOrphanedMessage,
  backgroundTaskLostText,
  type BackgroundTaskInfo,
} from "../backgroundTasks.js";

const started = (task_id: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id,
  description: "bg",
  task_type: "local_bash",
  ...extra,
});
const notify = (task_id: string, status: string) => ({
  type: "system",
  subtype: "task_notification",
  task_id,
  status,
  output_file: "/tmp/x",
  summary: "done",
});
const updated = (task_id: string, status: string) => ({
  type: "system",
  subtype: "task_updated",
  task_id,
  patch: { status },
});
const changed = (ids: string[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({ task_id: id, task_type: "subagent", description: "d" })),
});
const progress = (task_id: string) => ({
  type: "system",
  subtype: "task_progress",
  task_id,
  description: "working",
  usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
});
/** Real shape (measured, seq 665): a top-level `tool_progress`, not a system
 *  subtype — one heartbeat every 30s of a foreground Bash call. */
const toolProgress = (toolUseId: string) => ({
  type: "tool_progress",
  tool_use_id: `${toolUseId}-heartbeat-0`,
  tool_name: "Bash",
  parent_tool_use_id: toolUseId,
  elapsed_time_seconds: 30,
  heartbeat: true,
});

/** Feed a message stream through the same pure steps the turn loop uses. */
function feed(tasks: Map<string, BackgroundTaskInfo>, msg: unknown) {
  return applyBackgroundTaskDelta(tasks, classifyBackgroundTaskMessage(msg));
}

describe("classifyBackgroundTaskMessage", () => {
  it("classifies non-ambient task_started as add, carrying description + type", () => {
    expect(classifyBackgroundTaskMessage(started("t1"))).toEqual({
      kind: "add",
      task: { taskId: "t1", description: "bg", taskType: "local_bash" },
    });
  });

  it("ignores ambient (skip_transcript) task_started so it never blocks drain", () => {
    expect(classifyBackgroundTaskMessage(started("obs", { skip_transcript: true }))).toBeNull();
  });

  it("treats task_notification as terminal remove for any status", () => {
    for (const status of ["completed", "failed", "stopped"]) {
      expect(classifyBackgroundTaskMessage(notify("t1", status))).toEqual({
        kind: "remove",
        taskId: "t1",
      });
    }
  });

  it("removes only on terminal task_updated statuses", () => {
    expect(classifyBackgroundTaskMessage(updated("t1", "completed"))).toEqual({
      kind: "remove",
      taskId: "t1",
    });
    expect(classifyBackgroundTaskMessage(updated("t1", "failed"))).toEqual({
      kind: "remove",
      taskId: "t1",
    });
    expect(classifyBackgroundTaskMessage(updated("t1", "killed"))).toEqual({
      kind: "remove",
      taskId: "t1",
    });
    expect(classifyBackgroundTaskMessage(updated("t1", "running"))).toBeNull();
    expect(classifyBackgroundTaskMessage(updated("t1", "paused"))).toBeNull();
  });

  it("classifies background_tasks_changed as a prune with the live id set", () => {
    const d = classifyBackgroundTaskMessage(changed(["a", "b"]));
    expect(d?.kind).toBe("prune");
    expect(d && d.kind === "prune" && [...d.liveIds].sort()).toEqual(["a", "b"]);
    const empty = classifyBackgroundTaskMessage(changed([]));
    expect(empty && empty.kind === "prune" && empty.liveIds.size).toBe(0);
  });

  it("classifies task_progress AND tool_progress as broadcast-only heartbeats", () => {
    expect(classifyBackgroundTaskMessage(progress("t1"))).toEqual({ kind: "progress" });
    // tool_progress used to fall through and get persisted, which is how the
    // chat ended up with a `[tool_progress]` row every 30 seconds.
    expect(classifyBackgroundTaskMessage(toolProgress("call_1"))).toEqual({ kind: "progress" });
  });

  it("returns null for non-background messages", () => {
    expect(classifyBackgroundTaskMessage({ type: "result", subtype: "success" })).toBeNull();
    expect(classifyBackgroundTaskMessage({ type: "system", subtype: "thinking_tokens" })).toBeNull();
    expect(classifyBackgroundTaskMessage({ type: "assistant" })).toBeNull();
    expect(classifyBackgroundTaskMessage(null)).toBeNull();
  });
});

describe("applyBackgroundTaskDelta", () => {
  it("adds and removes ids without reporting a loss", () => {
    const tasks = new Map<string, BackgroundTaskInfo>();
    expect(applyBackgroundTaskDelta(tasks, { kind: "add", task: { taskId: "t1" } })).toEqual({
      broadcastOnly: false,
      lost: [],
    });
    expect(tasks.has("t1")).toBe(true);
    expect(applyBackgroundTaskDelta(tasks, { kind: "remove", taskId: "t1" })).toEqual({
      broadcastOnly: false,
      lost: [],
    });
    expect(tasks.has("t1")).toBe(false);
  });

  it("prune keeps still-live ids and reports the dropped ones as lost", () => {
    const tasks = new Map<string, BackgroundTaskInfo>([
      ["a", { taskId: "a", description: "build A" }],
      ["b", { taskId: "b" }],
      ["c", { taskId: "c" }],
    ]);
    const { lost, broadcastOnly } = applyBackgroundTaskDelta(tasks, {
      kind: "prune",
      liveIds: new Set(["b"]),
    });
    expect([...tasks.keys()]).toEqual(["b"]);
    expect(lost.map((t) => t.taskId)).toEqual(["a", "c"]);
    // the loss carries the description so the notice can name the real work
    expect(lost.find((t) => t.taskId === "a")?.description).toBe("build A");
    // Live-set bookkeeping only: the caller must still surface `lost`, but the
    // row itself is not transcript (task_started/task_notification already are).
    expect(broadcastOnly).toBe(true);
  });

  it("prune never re-adds ids we never tracked (ambient-safe)", () => {
    const tasks = new Map<string, BackgroundTaskInfo>();
    const { lost } = applyBackgroundTaskDelta(tasks, { kind: "prune", liveIds: new Set(["observer-x"]) });
    expect(tasks.size).toBe(0);
    expect(lost).toEqual([]);
  });

  it("progress reports broadcastOnly=true without mutating the set", () => {
    const tasks = new Map<string, BackgroundTaskInfo>([["t1", { taskId: "t1" }]]);
    expect(applyBackgroundTaskDelta(tasks, { kind: "progress" })).toEqual({
      broadcastOnly: true,
      lost: [],
    });
    expect(tasks.has("t1")).toBe(true);
  });

  it("null delta is a no-op", () => {
    const tasks = new Map<string, BackgroundTaskInfo>([["t1", { taskId: "t1" }]]);
    expect(applyBackgroundTaskDelta(tasks, null)).toEqual({ broadcastOnly: false, lost: [] });
    expect(tasks.has("t1")).toBe(true);
  });
});

describe("shouldFinalizeTurn", () => {
  it("never finalizes before result is seen (pre-result behaviour unchanged)", () => {
    expect(shouldFinalizeTurn(false, new Map())).toBe(false);
    expect(shouldFinalizeTurn(false, new Map([["t1", { taskId: "t1" }]]))).toBe(false);
  });

  it("finalizes immediately when result seen and no live tasks (regression)", () => {
    expect(shouldFinalizeTurn(true, new Map())).toBe(true);
  });

  it("waits while live background tasks remain, then finalizes when drained", () => {
    const tasks = new Map<string, BackgroundTaskInfo>([
      ["t1", { taskId: "t1" }],
      ["t2", { taskId: "t2" }],
    ]);
    expect(shouldFinalizeTurn(true, tasks)).toBe(false);
    tasks.delete("t1");
    expect(shouldFinalizeTurn(true, tasks)).toBe(false);
    tasks.delete("t2");
    expect(shouldFinalizeTurn(true, tasks)).toBe(true);
  });
});

describe("background task loss notices", () => {
  const lost: BackgroundTaskInfo[] = [
    { taskId: "t1", description: "Build desktop installer", taskType: "local_bash" },
    { taskId: "t2" },
  ];

  it("interrupted notice names the ids, the descriptions and the reason", () => {
    const msg = backgroundTaskInterruptedMessage(lost, "live_set_dropped");
    expect(msg.type).toBe("system");
    expect(msg.subtype).toBe("background_task_interrupted");
    expect(msg.reason).toBe("live_set_dropped");
    expect(msg.task_ids).toEqual(["t1", "t2"]);
    expect(String(msg.text)).toContain("t1 (local_bash · Build desktop installer)");
    expect(String(msg.text)).toContain("t2");
    expect(String(msg.text)).toContain("live task set");
  });

  it("defaults to the stream-closed reason", () => {
    const msg = backgroundTaskInterruptedMessage(lost);
    expect(msg.reason).toBe("stream_closed");
    expect(String(msg.text)).toContain("stream closed");
  });

  it("orphaned notice uses its own subtype for aborted turns", () => {
    const msg = backgroundTaskOrphanedMessage(lost, "turn_aborted");
    expect(msg.subtype).toBe("background_task_orphaned");
    expect(msg.reason).toBe("turn_aborted");
    expect(String(msg.text)).toContain("no longer supervised");
  });

  it("singular/plural wording and empty input stay readable", () => {
    expect(backgroundTaskLostText([{ taskId: "t1" }], "stream_closed")).toContain("background task not completed");
    expect(backgroundTaskLostText(lost, "stream_closed")).toContain("background tasks not completed");
    expect(backgroundTaskInterruptedMessage([], "stream_closed").text).toBeTruthy();
  });
});

describe("integration: drain sequence over a message stream", () => {
  it("blocks finalize until a backgrounded subagent completes after result", () => {
    const tasks = new Map<string, BackgroundTaskInfo>();
    let sawResult = false;
    const step = (msg: unknown) => {
      const out = feed(tasks, msg);
      if ((msg as { type?: string }).type === "result") sawResult = true;
      return out;
    };

    step(started("t1"));
    expect(shouldFinalizeTurn(sawResult, tasks)).toBe(false);

    step({ type: "result", subtype: "success" });
    expect(shouldFinalizeTurn(sawResult, tasks)).toBe(false);

    expect(step(progress("t1"))).toEqual({ broadcastOnly: true, lost: [] });
    expect(shouldFinalizeTurn(sawResult, tasks)).toBe(false);

    step(notify("t1", "completed"));
    expect(shouldFinalizeTurn(sawResult, tasks)).toBe(true);
  });

  it("failed background task still unblocks finalize (visible, not a hang)", () => {
    const tasks = new Map<string, BackgroundTaskInfo>();
    applyBackgroundTaskDelta(tasks, classifyBackgroundTaskMessage(started("t1")));
    applyBackgroundTaskDelta(tasks, classifyBackgroundTaskMessage(notify("t1", "failed")));
    expect(shouldFinalizeTurn(true, tasks)).toBe(true);
  });

  it("ambient observer task never enters the set → turn is not held open", () => {
    const tasks = new Map<string, BackgroundTaskInfo>();
    applyBackgroundTaskDelta(
      tasks,
      classifyBackgroundTaskMessage(started("obs", { skip_transcript: true })),
    );
    expect(shouldFinalizeTurn(true, tasks)).toBe(true);
  });

  // The exact shape measured in a real transcript (agent 99e5f379, seq 621-647):
  // the SDK detaches a long build, the foreground result lands, then the live set
  // empties to [] and the terminal notification only arrives in the NEXT turn.
  // Pruning silently here is what made a dead background build read as DONE.
  it("reports the loss when the live set empties before any terminal notification", () => {
    const tasks = new Map<string, BackgroundTaskInfo>();
    const step = (msg: unknown) => {
      const delta = classifyBackgroundTaskMessage(msg);
      return applyBackgroundTaskDelta(tasks, delta);
    };

    step(changed(["bnpivsq16"])); // seq 622 — nothing tracked yet
    step(started("bnpivsq16", { description: "Build desktop installer (prep + Tauri bundling)" })); // 623
    step({ type: "result", subtype: "success" }); // 644
    expect(shouldFinalizeTurn(true, tasks)).toBe(false);

    // seq 645 — the live set empties. This is NOT a terminal notification.
    const { lost } = step(changed([]));
    expect(lost.map((t) => t.taskId)).toEqual(["bnpivsq16"]);
    expect(lost[0]?.description).toBe("Build desktop installer (prep + Tauri bundling)");

    // The turn may now finalize, but only because the caller surfaced `lost`.
    expect(shouldFinalizeTurn(true, tasks)).toBe(true);
    const notice = backgroundTaskInterruptedMessage(lost, "live_set_dropped");
    expect(String(notice.text)).toContain("Build desktop installer");
  });

  it("a terminal notification before the prune is not reported as a loss", () => {
    const tasks = new Map<string, BackgroundTaskInfo>();
    applyBackgroundTaskDelta(tasks, classifyBackgroundTaskMessage(started("t1")));
    applyBackgroundTaskDelta(tasks, classifyBackgroundTaskMessage(notify("t1", "completed")));
    const { lost } = applyBackgroundTaskDelta(
      tasks,
      classifyBackgroundTaskMessage(changed([])),
    );
    expect(lost).toEqual([]);
  });
});
