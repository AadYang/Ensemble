import { describe, expect, it } from "vitest";
import { createStreamDisplayBatcher, type StreamDisplayChunk } from "./stream-display-batch.js";

function makeBatcher() {
  const emitted: Array<{ sessionId: string; chunks: StreamDisplayChunk[] }> = [];
  const timers: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  const batcher = createStreamDisplayBatcher({
    flushMs: 32,
    schedule: (fn) => {
      const id = nextId++;
      timers.push({ id, fn });
      return id;
    },
    cancel: (id) => {
      const idx = timers.findIndex((t) => t.id === id);
      if (idx >= 0) timers.splice(idx, 1);
    },
    emit: (sessionId, chunks) => {
      emitted.push({ sessionId, chunks: chunks.map((c) => ({ ...c })) });
    },
  });
  return { batcher, emitted, timers };
}

describe("createStreamDisplayBatcher", () => {
  it("folds one-character deltas into a single emit", () => {
    const { batcher, emitted, timers } = makeBatcher();
    for (const ch of "派工完成") {
      batcher.push("agent-a", { seq: -1, kind: "assistant_text", text: ch });
    }
    expect(emitted).toEqual([]);
    expect(timers).toHaveLength(1);
    timers[0]!.fn();
    expect(emitted).toEqual([
      { sessionId: "agent-a", chunks: [{ seq: -1, kind: "assistant_text", text: "派工完成" }] },
    ]);
  });

  it("keeps thinking then answer as two chunks in one flush", () => {
    const { batcher, emitted, timers } = makeBatcher();
    batcher.push("agent-a", { seq: -1, kind: "thinking", text: "Delivered. " });
    batcher.push("agent-a", { seq: -1, kind: "thinking", text: "Now summarize." });
    batcher.push("agent-a", { seq: -1, kind: "assistant_text", text: "派" });
    batcher.push("agent-a", { seq: -1, kind: "assistant_text", text: "工" });
    timers[0]!.fn();
    expect(emitted).toEqual([
      {
        sessionId: "agent-a",
        chunks: [
          { seq: -1, kind: "thinking", text: "Delivered. Now summarize." },
          { seq: -1, kind: "assistant_text", text: "派工" },
        ],
      },
    ]);
  });

  it("flushSession emits immediately and cancels the pending timer", () => {
    const { batcher, emitted, timers } = makeBatcher();
    batcher.push("agent-a", { seq: -1, kind: "assistant_text", text: "派" });
    expect(timers).toHaveLength(1);
    batcher.flushSession("agent-a");
    expect(timers).toHaveLength(0);
    expect(emitted).toEqual([
      { sessionId: "agent-a", chunks: [{ seq: -1, kind: "assistant_text", text: "派" }] },
    ]);
    batcher.push("agent-a", { seq: -1, kind: "assistant_text", text: "工" });
    batcher.flushSession("agent-a");
    expect(emitted).toHaveLength(2);
  });

  it("dropSession discards pending tokens instead of painting them after cancel", () => {
    const { batcher, emitted, timers } = makeBatcher();
    batcher.push("agent-a", { seq: -1, kind: "assistant_text", text: "派" });
    expect(timers).toHaveLength(1);
    batcher.dropSession("agent-a");
    expect(timers).toHaveLength(0);
    expect(emitted).toEqual([]);
  });

  it("uses flushMsFor so a hidden session can wait longer before emit", () => {
    const emitted: Array<{ sessionId: string; chunks: StreamDisplayChunk[] }> = [];
    const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
    let nextId = 1;
    const batcher = createStreamDisplayBatcher({
      flushMs: 32,
      flushMsFor: (id) => (id === "hidden" ? 200 : 32),
      schedule: (fn, ms) => {
        const id = nextId++;
        timers.push({ id, fn, ms });
        return id;
      },
      cancel: (id) => {
        const idx = timers.findIndex((t) => t.id === id);
        if (idx >= 0) timers.splice(idx, 1);
      },
      emit: (sessionId, chunks) => {
        emitted.push({ sessionId, chunks: chunks.map((c) => ({ ...c })) });
      },
    });
    batcher.push("hidden", { seq: -1, kind: "thinking", text: "x" });
    batcher.push("shown", { seq: -1, kind: "thinking", text: "y" });
    expect(timers.map((t) => t.ms)).toEqual([200, 32]);
  });
});
