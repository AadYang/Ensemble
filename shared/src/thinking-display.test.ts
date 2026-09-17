import { describe, expect, it } from "vitest";
import {
  streamDisplayDeltaFromSdkMessage,
  thinkingTextFromContentBlocks,
  thinkingTokensEstimate,
} from "./thinking-display.js";

describe("streamDisplayDeltaFromSdkMessage", () => {
  it("keeps ordinary answer tokens as assistant text", () => {
    expect(
      streamDisplayDeltaFromSdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "done" } },
      }),
    ).toEqual({ kind: "assistant_text", text: "done" });
  });

  it("does not drop thinking_delta", () => {
    expect(
      streamDisplayDeltaFromSdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "first," } },
      }),
    ).toEqual({ kind: "thinking", text: "first," });
  });

  it("accepts Claude-shaped thinking_delta that puts the body in text", () => {
    expect(
      streamDisplayDeltaFromSdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", text: "hmm" } },
      }),
    ).toEqual({ kind: "thinking", text: "hmm" });
  });

  it("opens a thinking row on content_block_start even before the first delta", () => {
    expect(
      streamDisplayDeltaFromSdkMessage({
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
      }),
    ).toEqual({ kind: "thinking", text: "" });
  });

  it("ignores empty and unrelated stream events", () => {
    expect(
      streamDisplayDeltaFromSdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "" } },
      }),
    ).toBeNull();
    expect(
      streamDisplayDeltaFromSdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
      }),
    ).toBeNull();
  });
});

describe("thinkingTokensEstimate", () => {
  it("reads the running total from system/thinking_tokens", () => {
    expect(
      thinkingTokensEstimate({ type: "system", subtype: "thinking_tokens", estimated_tokens: 12400 }),
    ).toBe(12400);
    expect(thinkingTokensEstimate({ type: "system", subtype: "thinking_tokens" })).toBeNull();
    expect(thinkingTokensEstimate({ type: "stream_event" })).toBeNull();
  });
});

describe("thinkingTextFromContentBlocks", () => {
  it("reads Anthropic thinking blocks and ignores answer text", () => {
    expect(
      thinkingTextFromContentBlocks([
        { type: "thinking", thinking: "plan A" },
        { type: "text", text: "here is the answer" },
        { type: "thinking", text: " then B" },
      ]),
    ).toBe("plan A then B");
  });
});
