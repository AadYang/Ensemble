import { describe, expect, it } from "vitest";
import { makeSpawnSubagentHandler, SUBAGENT_TOOL_NAME } from "../subagent-mcp.js";

// The Claude runtime previously had NO way to spawn an Ensemble subagent — the
// native SDK Task tool produces in-SDK subagents that never become Ensemble
// Agent rows, so the user never saw them in the sidebar. makeSpawnSubagentHandler
// closes over the parentId and round-trips through spawnTaskSubagent so the
// child is a real, visible agent. These tests pin the closure binding + the
// background flag forwarding without booting the SDK.
describe("subagent-mcp handler", () => {
  it("binds parentId and forwards description/prompt (blocking by default)", async () => {
    const calls: Array<{ parentId: string; description: string; prompt: string; opts?: { background?: boolean } }> = [];
    const sessions = {
      async spawnTaskSubagent(parentId: string, description: string, prompt: string, opts?: { background?: boolean }) {
        calls.push({ parentId, description, prompt, opts });
        return { finalText: "child result", subagentId: "child-1" };
      },
    };
    const handler = makeSpawnSubagentHandler(sessions, "parent-42");
    const out = await handler({ description: "audit", prompt: "review the diff" });
    expect(out).toEqual({ finalText: "child result", subagentId: "child-1" });
    expect(calls).toEqual([
      { parentId: "parent-42", description: "audit", prompt: "review the diff", opts: { background: false } },
    ]);
  });

  it("forwards background=true so the child runs detached", async () => {
    let receivedOpts: { background?: boolean } | undefined;
    const sessions = {
      async spawnTaskSubagent(_p: string, _d: string, _pr: string, opts?: { background?: boolean }) {
        receivedOpts = opts;
        return { finalText: "", subagentId: "bg-1", background: true };
      },
    };
    const handler = makeSpawnSubagentHandler(sessions, "parent-42");
    const out = await handler({ description: "build", prompt: "compile", background: true });
    expect(receivedOpts).toEqual({ background: true });
    expect(out.background).toBe(true);
    expect(out.subagentId).toBe("bg-1");
  });

  it("does not cross-bind parentId between two handlers", async () => {
    const seen: string[] = [];
    const sessions = {
      async spawnTaskSubagent(parentId: string) {
        seen.push(parentId);
        return { finalText: "", subagentId: "x" };
      },
    };
    const a = makeSpawnSubagentHandler(sessions, "agent-A");
    const b = makeSpawnSubagentHandler(sessions, "agent-B");
    await a({ description: "d", prompt: "p" });
    await b({ description: "d", prompt: "p" });
    expect(seen).toEqual(["agent-A", "agent-B"]);
  });

  it("exposes the fully-qualified MCP tool name for the allow-list", () => {
    expect(SUBAGENT_TOOL_NAME).toBe("mcp__agentorch-subagent__spawn_subagent");
  });
});
