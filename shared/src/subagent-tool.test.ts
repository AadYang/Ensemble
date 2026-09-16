import { describe, expect, it } from "vitest";
import { countSubagentStartsThisTurn, isSubagentToolName } from "./subagent-tool.js";

describe("isSubagentToolName", () => {
  it("matches native and Ensemble spawn names, including MCP prefixes", () => {
    expect(isSubagentToolName("Agent")).toBe(true);
    expect(isSubagentToolName("Task")).toBe(true);
    expect(isSubagentToolName("Subagent")).toBe(true);
    expect(isSubagentToolName("spawn_subagent")).toBe(true);
    expect(isSubagentToolName("mcp__agentorch-subagent__spawn_subagent")).toBe(true);
    expect(isSubagentToolName("mcp__agentorch-internal__spawn_ensemble_agent")).toBe(true);
  });

  it("does not treat ordinary tools as subagents", () => {
    expect(isSubagentToolName("Read")).toBe(false);
    expect(isSubagentToolName("Bash")).toBe(false);
    expect(isSubagentToolName("mcp__agentorch-peer__peer_send")).toBe(false);
    expect(isSubagentToolName("agent")).toBe(false);
    expect(isSubagentToolName("")).toBe(false);
    expect(isSubagentToolName(undefined)).toBe(false);
  });
});

describe("countSubagentStartsThisTurn", () => {
  it("counts spawn-like tool_use after the last user turn", () => {
    expect(
      countSubagentStartsThisTurn([
        { kind: "user" },
        { kind: "tool_use", toolName: "Read" },
        { kind: "tool_use", toolName: "Agent" },
        { kind: "tool_use", toolName: "Agent" },
        { kind: "assistant_text" },
      ]),
    ).toBe(2);
  });

  it("resets at the latest user message", () => {
    expect(
      countSubagentStartsThisTurn([
        { kind: "user" },
        { kind: "tool_use", toolName: "Task" },
        { kind: "user" },
        { kind: "tool_use", toolName: "Bash" },
        { kind: "tool_use", toolName: "mcp__agentorch-subagent__spawn_subagent" },
      ]),
    ).toBe(1);
  });

  it("is zero when this turn has no nested agent", () => {
    expect(
      countSubagentStartsThisTurn([
        { kind: "user" },
        { kind: "tool_use", toolName: "Grep" },
        { kind: "assistant_text" },
      ]),
    ).toBe(0);
    expect(countSubagentStartsThisTurn([])).toBe(0);
  });
});
