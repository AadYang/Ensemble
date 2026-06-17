import { describe, it, expect } from "vitest";
import { makePeerSendHandler } from "../../../peer-mcp.js";
import { makeAskUserHandler } from "../../../ask-user-mcp.js";
import type { SessionManager } from "../../SessionManager.js";

// W16 Slice 1.7: peer-mcp / ask-user-mcp closure binding invariant.
//
// The MCP servers passed to the Claude SDK capture `fromAgentId` in their
// tool handler closure. SessionManager constructs a fresh server *per
// sendMessage call* (peer-mcp.ts:55-59 + ask-user-mcp.ts:29-33) — if the
// AgentRuntime refactor (Slice 1.6) ever moves construction up to module
// load or shares an instance across agents, the closure binds the wrong
// id and peer_send / ask_user calls cross-talk between agents.
//
// These tests pin the invariant: each construction binds its own id;
// concurrent invocations from different sources route correctly.

describe("peer-mcp closure binding", () => {
  it("each handler binds its own fromAgentId without cross-talk", async () => {
    const calls: Array<{ from: string; target: string; mode: string }> = [];
    const mockSessions = {
      sendPeerMessage: async (from: string, target: string, _msg: string, mode: string) => {
        calls.push({ from, target, mode });
        return "ok";
      },
    } as unknown as SessionManager;

    const handlerA = makePeerSendHandler(mockSessions, "agent-A");
    const handlerB = makePeerSendHandler(mockSessions, "agent-B");

    // Interleaved invocations — if either closure aliased the other's
    // fromAgentId, calls[1].from would be "agent-A".
    await handlerA({ target: "x", message: "m1" });
    await handlerB({ target: "y", message: "m2" });
    await handlerA({ target: "z", message: "m3", mode: "review" });

    expect(calls).toEqual([
      { from: "agent-A", target: "x", mode: "raw" },
      { from: "agent-B", target: "y", mode: "raw" },
      { from: "agent-A", target: "z", mode: "review" },
    ]);
  });

  it("constructing twice with the same id returns independent closures", () => {
    const mockSessions = {
      sendPeerMessage: async () => "ok",
    } as unknown as SessionManager;
    const h1 = makePeerSendHandler(mockSessions, "agent-X");
    const h2 = makePeerSendHandler(mockSessions, "agent-X");
    expect(h1).not.toBe(h2);
  });

  it("default mode is raw when omitted", async () => {
    let observedMode = "";
    const mockSessions = {
      sendPeerMessage: async (_from: string, _target: string, _msg: string, mode: string) => {
        observedMode = mode;
        return "ok";
      },
    } as unknown as SessionManager;
    const h = makePeerSendHandler(mockSessions, "agent-Z");
    await h({ target: "p", message: "hi" });
    expect(observedMode).toBe("raw");
  });

  it("forwards correlation metadata to SessionManager", async () => {
    let observed: unknown;
    const mockSessions = {
      sendPeerMessage: async (
        _from: string,
        _target: string,
        _msg: string,
        _mode: string,
        opts: unknown,
      ) => {
        observed = opts;
        return "ok";
      },
    } as unknown as SessionManager;
    const h = makePeerSendHandler(mockSessions, "agent-Z");

    await h({
      target: "p",
      message: "hi",
      messageId: "msg-1",
      correlationId: "corr-1",
      correlationKind: "decision",
      replyToCorrelationId: "req-1",
      causalRunId: "run-1",
    });

    expect(observed).toMatchObject({
      messageId: "msg-1",
      correlationId: "corr-1",
      correlationKind: "decision",
      replyToCorrelationId: "req-1",
      causalRunId: "run-1",
    });
  });
});

describe("ask-user-mcp closure binding", () => {
  it("each handler binds its own fromAgentId without cross-talk", async () => {
    const calls: Array<{ from: string; question: string }> = [];
    const mockSessions = {
      askUser: async (from: string, question: string, _options: string[]) => {
        calls.push({ from, question });
        return "first";
      },
    } as unknown as SessionManager;

    const handlerA = makeAskUserHandler(mockSessions, "agent-A");
    const handlerB = makeAskUserHandler(mockSessions, "agent-B");

    await handlerA({ question: "q1?", options: ["yes", "no"] });
    await handlerB({ question: "q2?", options: ["a", "b"] });

    expect(calls).toEqual([
      { from: "agent-A", question: "q1?" },
      { from: "agent-B", question: "q2?" },
    ]);
  });
});
