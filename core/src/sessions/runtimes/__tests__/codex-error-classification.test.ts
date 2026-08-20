import { describe, expect, it } from "vitest";
import { translateEvent } from "../codex.js";

// Regression guard for the "warning shown as interrupted turn" bug.
//
// @openai/codex-sdk distinguishes two `type: "error"` shapes:
//   • ErrorItem        — "non-fatal error surfaced as an item" (arrives via
//                        item.started / item.updated / item.completed)
//   • ThreadErrorEvent — "unrecoverable error emitted directly by the event
//                        stream" (top-level `error` event)
// The codex runtime must only abort the turn on the fatal ThreadErrorEvent.
// A non-fatal ErrorItem — e.g. the skills-context-budget notice — must NOT be
// routed to errorMessage, otherwise the turn is aborted and the UI renders an
// interrupted turn even though codex kept working.
describe("Codex error classification", () => {
  const SID = "sess-codex-1";
  const MODEL = "gpt-5-codex";
  const SKILL_WARNING =
    "Skill descriptions were shortened to fit the skills context budget. " +
    "Codex can still see every skill, but some descriptions are shorter. " +
    "Disable unused skills or plugins to leave more room for the rest.";

  it("does NOT treat a non-fatal error item as a turn-aborting error", () => {
    const out = translateEvent(
      { type: "item.completed", item: { id: "e1", type: "error", message: SKILL_WARNING } },
      SID,
      MODEL,
    );
    // Must not abort the turn.
    expect(out.errorMessage).toBeUndefined();
    // Surfaced as an informational assistant block so the user still sees it.
    const content = (out.assistantMessage as { message?: { content?: Array<{ text?: string }> } })
      ?.message?.content;
    expect(content?.[0]?.text).toContain(SKILL_WARNING);
  });

  it("still treats a top-level error event as a fatal turn error", () => {
    const out = translateEvent(
      { type: "error", message: "stream disconnected before completion" },
      SID,
      MODEL,
    );
    expect(out.errorMessage).toBe("stream disconnected before completion");
    expect(out.assistantMessage).toBeUndefined();
  });

  it("still treats turn.failed as a fatal turn error", () => {
    const out = translateEvent(
      { type: "turn.failed", error: { message: "model overloaded" } },
      SID,
      MODEL,
    );
    expect(out.errorMessage).toBe("model overloaded");
  });
});
