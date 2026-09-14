import { describe, expect, it } from "vitest";
import { translateItem } from "../codex.js";

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
