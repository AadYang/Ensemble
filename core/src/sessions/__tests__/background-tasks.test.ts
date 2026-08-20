import { describe, it, expect } from "vitest";
import {
  classifyBackgroundTaskMessage,
  applyBackgroundTaskDelta,
  shouldFinalizeTurn,
} from "../backgroundTasks.js";

const started = (task_id: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id,
  description: "bg",
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

describe("classifyBackgroundTaskMessage", () => {
  it("classifies non-ambient task_started as add", () => {
    expect(classifyBackgroundTaskMessage(started("t1"))).toEqual({ kind: "add", taskId: "t1" });
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
  });

  it("classifies task_progress as a broadcast-only heartbeat", () => {
    expect(classifyBackgroundTaskMessage(progress("t1"))).toEqual({ kind: "progress" });
  });

  it("returns null for non-background messages", () => {
    expect(classifyBackgroundTaskMessage({ type: "result", subtype: "success" })).toBeNull();
    expect(classifyBackgroundTaskMessage({ type: "system", subtype: "thinking_tokens" })).toBeNull();
    expect(classifyBackgroundTaskMessage({ type: "assistant" })).toBeNull();
    expect(classifyBackgroundTaskMessage(null)).toBeNull();
  });
});

describe("applyBackgroundTaskDelta", () => {
  it("adds and removes ids, reporting non-broadcast-only", () => {
    const set = new Set<string>();
    expect(applyBackgroundTaskDelta(set, { kind: "add", taskId: "t1" })).toEqual({ broadcastOnly: false });
    expect(set.has("t1")).toBe(true);
    applyBackgroundTaskDelta(set, { kind: "remove", taskId: "t1" });
    expect(set.has("t1")).toBe(false);
  });

  it("prune drops ids no longer live but keeps still-live ones", () => {
    const set = new Set(["a", "b", "c"]);
    applyBackgroundTaskDelta(set, { kind: "prune", liveIds: new Set(["b"]) });
    expect([...set]).toEqual(["b"]);
  });

  it("prune never re-adds ids we never tracked (ambient-safe)", () => {
    const set = new Set<string>();
    applyBackgroundTaskDelta(set, { kind: "prune", liveIds: new Set(["observer-x"]) });
    expect(set.size).toBe(0);
  });

  it("progress reports broadcastOnly=true without mutating the set", () => {
    const set = new Set(["t1"]);
    expect(applyBackgroundTaskDelta(set, { kind: "progress" })).toEqual({ broadcastOnly: true });
    expect(set.has("t1")).toBe(true);
  });

  it("null delta is a no-op", () => {
    const set = new Set(["t1"]);
    expect(applyBackgroundTaskDelta(set, null)).toEqual({ broadcastOnly: false });
    expect(set.has("t1")).toBe(true);
  });
});

describe("shouldFinalizeTurn", () => {
  it("never finalizes before result is seen (pre-result behaviour unchanged)", () => {
    expect(shouldFinalizeTurn(false, new Set())).toBe(false);
    expect(shouldFinalizeTurn(false, new Set(["t1"]))).toBe(false);
  });

  it("finalizes immediately when result seen and no live tasks (regression)", () => {
    expect(shouldFinalizeTurn(true, new Set())).toBe(true);
  });

  it("waits while live background tasks remain, then finalizes when drained", () => {
    const set = new Set(["t1", "t2"]);
    expect(shouldFinalizeTurn(true, set)).toBe(false);
    set.delete("t1");
    expect(shouldFinalizeTurn(true, set)).toBe(false);
    set.delete("t2");
    expect(shouldFinalizeTurn(true, set)).toBe(true);
  });
});

describe("integration: drain sequence over a message stream", () => {
  it("blocks finalize until a backgrounded subagent completes after result", () => {
    const set = new Set<string>();
    let sawResult = false;
    const feed = (msg: unknown) =>
      applyBackgroundTaskDelta(set, classifyBackgroundTaskMessage(msg));

    // task starts (backgrounded) before the main result
    feed(started("t1"));
    expect(shouldFinalizeTurn(sawResult, set)).toBe(false);

    // main result arrives — but t1 is still live, so we must NOT finalize
    sawResult = true;
    expect(shouldFinalizeTurn(sawResult, set)).toBe(false);

    // progress heartbeat is broadcast-only and does not settle the task
    expect(feed(progress("t1"))).toEqual({ broadcastOnly: true });
    expect(shouldFinalizeTurn(sawResult, set)).toBe(false);

    // terminal notification settles t1 → now we finalize
    feed(notify("t1", "completed"));
    expect(shouldFinalizeTurn(sawResult, set)).toBe(true);
  });

  it("failed background task still unblocks finalize (visible, not a hang)", () => {
    const set = new Set<string>();
    applyBackgroundTaskDelta(set, classifyBackgroundTaskMessage(started("t1")));
    applyBackgroundTaskDelta(set, classifyBackgroundTaskMessage(notify("t1", "failed")));
    expect(shouldFinalizeTurn(true, set)).toBe(true);
  });

  it("ambient observer task never enters the set → turn is not held open", () => {
    const set = new Set<string>();
    applyBackgroundTaskDelta(
      set,
      classifyBackgroundTaskMessage(started("obs", { skip_transcript: true })),
    );
    expect(shouldFinalizeTurn(true, set)).toBe(true);
  });
});
