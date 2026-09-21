import { describe, expect, it, vi } from "vitest";
import type { ServerMsg } from "@agentorch/shared";
import { createStreamEventWsBatcher } from "../stream-event-batch.js";

function thinkingDelta(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: text } },
  };
}

function textDelta(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

describe("stream event WS batcher", () => {
  it("folds same-kind 1-char deltas into one send per flush window", () => {
    vi.useFakeTimers();
    const sent: ServerMsg[] = [];
    const batcher = createStreamEventWsBatcher({
      send: (_id, payload) => sent.push(payload),
      flushMs: 32,
    });
    batcher.push("s1", thinkingDelta("a"));
    batcher.push("s1", thinkingDelta("b"));
    batcher.push("s1", thinkingDelta("c"));
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(32);
    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    expect(msg.type).toBe("message");
    if (msg.type !== "message") return;
    expect(
      (msg.msg as { event: { delta: { thinking: string } } }).event.delta.thinking,
    ).toBe("abc");
    vi.useRealTimers();
  });

  it("flushes thinking before a text delta so order is preserved", () => {
    vi.useFakeTimers();
    const sent: ServerMsg[] = [];
    const batcher = createStreamEventWsBatcher({
      send: (_id, payload) => sent.push(payload),
      flushMs: 32,
    });
    batcher.push("s1", thinkingDelta("hmm"));
    batcher.push("s1", textDelta("hi"));
    expect(sent).toHaveLength(1);
    expect(
      ((sent[0] as Extract<ServerMsg, { type: "message" }>).msg as { event: { delta: { thinking: string } } })
        .event.delta.thinking,
    ).toBe("hmm");
    vi.advanceTimersByTime(32);
    expect(sent).toHaveLength(2);
    expect(
      ((sent[1] as Extract<ServerMsg, { type: "message" }>).msg as { event: { delta: { text: string } } }).event
        .delta.text,
    ).toBe("hi");
    vi.useRealTimers();
  });
});
