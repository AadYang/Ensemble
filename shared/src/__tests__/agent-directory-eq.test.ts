import { describe, expect, it } from "vitest";
import { agentDirectoryUnchanged } from "../agent-directory-eq.js";

describe("agentDirectoryUnchanged", () => {
  it("treats a turns-only update as unchanged", () => {
    const summary = { id: "a" };
    const before = { a: { summary, turns: [{ text: "" }] } };
    const after = { a: { summary, turns: [{ text: "thinking…" }] } };
    expect(agentDirectoryUnchanged(before, after)).toBe(true);
  });

  it("re-renders when status (new summary object) changes", () => {
    const before = { a: { summary: { id: "a", status: "running" } } };
    const after = { a: { summary: { id: "a", status: "done" } } };
    expect(agentDirectoryUnchanged(before, after)).toBe(false);
  });

  it("re-renders when an agent is added or removed", () => {
    const summary = { id: "a" };
    const before = { a: { summary } };
    expect(agentDirectoryUnchanged(before, { a: { summary }, b: { summary: { id: "b" } } })).toBe(false);
    expect(agentDirectoryUnchanged(before, {})).toBe(false);
  });
});
