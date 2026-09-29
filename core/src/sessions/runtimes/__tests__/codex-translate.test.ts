import { describe, expect, it } from "vitest";
import { translateEvent, translateItem } from "../codex.js";

type ContentBlock = { type?: string; name?: string; input?: unknown };

function singleContent(out: ReturnType<typeof translateItem>): ContentBlock[] {
  const msg = out.assistantMessage as { message?: { content?: ContentBlock[] } } | undefined;
  return msg?.message?.content ?? [];
}

const SESSION = "session-123";
const MODEL = "gpt-5.6-sol";

describe("translateItem collab_tool_call (native codex subagents)", () => {
  it("surfaces completed native subagent activity as a Subagent tool_use", () => {
    const out = translateItem(
      {
        id: "item_1",
        type: "collab_tool_call",
        tool: "wait",
        status: "completed",
        sender_thread_id: "thread-parent",
        receiver_thread_ids: [],
        prompt: null,
        agents_states: {},
      },
      SESSION,
      MODEL,
      true,
    );
    const content = singleContent(out);
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: "tool_use",
      name: "Subagent",
      input: { tool: "wait", status: "completed" },
    });
  });

  it("keeps receiver_thread_ids and prompt when codex provides them", () => {
    const out = translateItem(
      {
        id: "item_2",
        type: "collab_tool_call",
        tool: "spawn",
        status: "completed",
        receiver_thread_ids: ["thread-a", "thread-b"],
        prompt: "investigate the runtime",
      },
      SESSION,
      MODEL,
      true,
    );
    const content = singleContent(out);
    expect(content[0]?.input).toEqual({
      tool: "spawn",
      status: "completed",
      receiver_thread_ids: ["thread-a", "thread-b"],
      prompt: "investigate the runtime",
    });
  });

  it("does not surface the in-progress (started) collab event", () => {
    const out = translateItem(
      { id: "item_3", type: "collab_tool_call", tool: "wait", status: "in_progress" },
      SESSION,
      MODEL,
      false,
    );
    expect(out).toEqual({});
  });

  it("falls back gracefully when tool/status are missing", () => {
    const out = translateItem({ id: "item_4", type: "collab_tool_call" }, SESSION, MODEL, true);
    const content = singleContent(out);
    expect(content[0]?.input).toEqual({ tool: "unknown", status: "completed" });
  });
});

describe("translateItem reasoning", () => {
  it("surfaces completed reasoning as thinking_delta plus a thinking block", () => {
    const out = translateItem(
      { id: "r1", type: "reasoning", text: "consider the tests" },
      SESSION,
      MODEL,
      true,
    );
    expect(out.streamEvent).toMatchObject({
      event: { delta: { type: "thinking_delta", thinking: "consider the tests" } },
    });
    expect(singleContent(out)).toEqual([{ type: "thinking", thinking: "consider the tests" }]);
  });

  it("opens a thinking heartbeat when Codex only has encrypted_content", () => {
    const out = translateItem(
      { id: "r2", type: "reasoning", summary: [], encrypted_content: "x".repeat(400) },
      SESSION,
      MODEL,
      false,
    );
    expect(out.thinkingTokens).toBe(100);
    expect(out.streamEvent).toBeUndefined();
    expect(out.assistantMessage).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("encrypted");
  });

  it("does not persist encrypted_content when a completed reasoning item has no summary", () => {
    const out = translateItem(
      { id: "r3", type: "reasoning", summary: [], encrypted_content: "cipher" },
      SESSION,
      MODEL,
      true,
    );
    expect(out).toEqual({});
  });

  it("uses summary[] as the visible thinking text", () => {
    const out = translateItem(
      {
        id: "r4",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "check the protocol" }],
        encrypted_content: "cipher",
      },
      SESSION,
      MODEL,
      true,
    );
    expect(out.streamEvent).toMatchObject({
      event: { delta: { type: "thinking_delta", thinking: "check the protocol" } },
    });
    expect(singleContent(out)).toEqual([{ type: "thinking", thinking: "check the protocol" }]);
    expect(JSON.stringify(out)).not.toContain("cipher");
  });

  it("emits only the new summary suffix across item.updated events", () => {
    const cursor = new Map<string, string>();
    const first = translateItem(
      { id: "r5", type: "reasoning", summary: ["look at"] },
      SESSION,
      MODEL,
      false,
      cursor,
    );
    const second = translateItem(
      { id: "r5", type: "reasoning", summary: ["look at the tests"] },
      SESSION,
      MODEL,
      false,
      cursor,
    );
    expect(first.streamEvent).toMatchObject({
      event: { delta: { type: "thinking_delta", thinking: "look at" } },
    });
    expect(second.streamEvent).toMatchObject({
      event: { delta: { type: "thinking_delta", thinking: " the tests" } },
    });
  });
});

describe("translateEvent token_count", () => {
  it("maps live reasoning_output_tokens onto the thinking heartbeat", () => {
    const out = translateEvent(
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { reasoning_output_tokens: 420, input_tokens: 800000 } },
        },
      },
      SESSION,
      MODEL,
    );
    expect(out.thinkingTokens).toBe(420);
    expect(out.streamEvent).toBeUndefined();
  });
});
