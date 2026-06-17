// W16 Slice 5.6: closure binding + behavior tests for the 3 session-aware
// NormalizedTools and ExitPlanMode. Mirrors the Slice 1.7 invariant for
// peer-mcp / ask-user-mcp at the new tool layer.

import { describe, it, expect } from "vitest";
import { makePeerSendTool, makePeerQueryTool, makeAskUserTool, makeTaskTool } from "../session-aware.js";
import { exitPlanModeTool } from "../exit-plan-mode.js";
import { shouldRequireApproval } from "../index.js";

describe("makePeerSendTool", () => {
  it("each factory call binds its own callback (no cross-talk)", async () => {
    const calls: Array<{ which: string; target: string; mode?: string }> = [];
    const sendA = async (args: { target: string; message: string; mode?: "continue" | "review" | "fork" | "raw" }) => {
      calls.push({ which: "A", target: args.target, mode: args.mode });
      return "delivered by A";
    };
    const sendB = async (args: { target: string; message: string; mode?: "continue" | "review" | "fork" | "raw" }) => {
      calls.push({ which: "B", target: args.target, mode: args.mode });
      return "delivered by B";
    };
    const toolA = makePeerSendTool(sendA);
    const toolB = makePeerSendTool(sendB);

    expect(await toolA.execute({ target: "x", message: "m1" })).toBe("delivered by A");
    expect(await toolB.execute({ target: "y", message: "m2", mode: "review" })).toBe("delivered by B");
    expect(await toolA.execute({ target: "z", message: "m3" })).toBe("delivered by A");

    expect(calls).toEqual([
      { which: "A", target: "x", mode: undefined },
      { which: "B", target: "y", mode: "review" },
      { which: "A", target: "z", mode: undefined },
    ]);
  });

  it("forwards correlation metadata", async () => {
    let observed: unknown;
    const send = async (args: {
      target: string;
      message: string;
      messageId?: string;
      correlationId?: string;
      correlationKind?: "decision" | "request";
      replyToCorrelationId?: string;
      causalRunId?: string;
    }) => {
      observed = args;
      return "sent";
    };
    const tool = makePeerSendTool(send);

    expect(
      await tool.execute({
        target: "peer",
        message: "body",
        messageId: "msg-1",
        correlationId: "corr-1",
        correlationKind: "request",
        replyToCorrelationId: "decision-0",
        causalRunId: "run-1",
      }),
    ).toBe("sent");
    expect(observed).toMatchObject({
      messageId: "msg-1",
      correlationId: "corr-1",
      correlationKind: "request",
      replyToCorrelationId: "decision-0",
      causalRunId: "run-1",
    });
  });
});

describe("makePeerQueryTool", () => {
  it("binds its own query callback and forwards args", async () => {
    const calls: Array<{ target: string; limit?: number }> = [];
    const query = async (args: { target: string; limit?: number }) => {
      calls.push(args);
      return `history for ${args.target}`;
    };
    const tool = makePeerQueryTool(query);
    expect(await tool.execute({ target: "agent-1", limit: 5 })).toBe("history for agent-1");
    expect(await tool.execute({ target: "agent-2" })).toBe("history for agent-2");
    expect(calls).toEqual([
      { target: "agent-1", limit: 5 },
      { target: "agent-2" },
    ]);
  });
});

describe("makeAskUserTool", () => {
  it("binds its own ask callback", async () => {
    let observed = "";
    const ask = async (args: { question: string; options: string[] }) => {
      observed = `${args.question}|${args.options.join(",")}`;
      return args.options[0]!;
    };
    const tool = makeAskUserTool(ask);
    const result = await tool.execute({ question: "go?", options: ["yes", "no"] });
    expect(result).toBe("yes");
    expect(observed).toBe("go?|yes,no");
  });
});

describe("makeTaskTool", () => {
  it("returns finalText from spawn callback", async () => {
    let receivedDescription = "";
    let receivedPrompt = "";
    const spawn = async (args: { description: string; prompt: string }) => {
      receivedDescription = args.description;
      receivedPrompt = args.prompt;
      return { finalText: "subagent done", subagentId: "child-id" };
    };
    const tool = makeTaskTool(spawn);
    const result = await tool.execute({ description: "search docs", prompt: "find the relevant section" });
    expect(result).toBe("subagent done");
    expect(receivedDescription).toBe("search docs");
    expect(receivedPrompt).toBe("find the relevant section");
  });
});

describe("ExitPlanMode tool", () => {
  it("echoes the plan text on execute", async () => {
    const plan = "# Plan\n\n- Step 1\n- Step 2";
    const out = await exitPlanModeTool.execute({ plan });
    expect(out).toBe(plan);
  });

  it("gates only in plan mode", () => {
    expect(shouldRequireApproval("plan", "ExitPlanMode")).toBe(true);
    expect(shouldRequireApproval("default", "ExitPlanMode")).toBe(false);
    expect(shouldRequireApproval("acceptEdits", "ExitPlanMode")).toBe(false);
    expect(shouldRequireApproval("bypassPermissions", "ExitPlanMode")).toBe(false);
    expect(shouldRequireApproval("dontAsk", "ExitPlanMode")).toBe(false);
  });
});

describe("session-aware tools never gate", () => {
  it.each([
    ["default", "peer_send"],
    ["default", "peer_query"],
    ["default", "ask_user"],
    ["default", "Task"],
    ["plan", "peer_send"],
    ["plan", "peer_query"],
    ["plan", "ask_user"],
    ["plan", "Task"],
    ["acceptEdits", "peer_send"],
    ["acceptEdits", "peer_query"],
    ["acceptEdits", "ask_user"],
    ["acceptEdits", "Task"],
  ])("%s mode + %s tool → no approval", (mode, tool) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(shouldRequireApproval(mode as any, tool)).toBe(false);
  });
});
