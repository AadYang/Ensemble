// Regression: a running loop re-injects its own prompt at the end of every
// turn, and that continuation used to start immediately — taking the drain
// branch out of the picture. Anything parked in PendingTurn while the turn was
// in flight (a manager's peer_send, a user message) therefore starved: the
// agent kept looping on its stale goal and the supplement was never delivered.
//
// Delivery wins over the loop's next prompt; the loop decides again after the
// queued turn.

import { describe, it, expect, beforeAll } from "vitest";
import type { AgentRuntime, RuntimeOptions } from "../runtimes/types.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../../db.js").prisma;
let SessionManager: typeof import("../SessionManager.js").SessionManager;

type Broadcast = Record<string, unknown>;

class StubHub {
  broadcasts: Broadcast[] = [];
  sessionMessages: Array<{ sessionId: string; msg: Broadcast }> = [];
  socketMessages: Broadcast[] = [];
  size(): number { return 0; }
  add(): void {}
  remove(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  replayPendingFor(): void {}
  sendTo(_socket: unknown, msg: Broadcast): void {
    this.socketMessages.push(msg);
  }
  sendToSession(sessionId: string, msg: Broadcast): void {
    this.sessionMessages.push({ sessionId, msg });
  }
  broadcast(msg: Broadcast): void {
    this.broadcasts.push(msg);
  }
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager } = await import("../SessionManager.js"));
});

describe("loop continuation vs queued turns", () => {
  it("delivers a queued message before the loop's next continuation", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "loop-queue-provider",
        kind: "openai-compat",
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        models: ["test-model"],
      },
    });
    const agent = await prisma.agent.create({
      data: { name: "loop-queue-agent", providerId: provider.id, model: "test-model" },
    });

    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const runtime: AgentRuntime = {
      async *query(opts: RuntimeOptions) {
        calls.push(opts.prompt);
        if (calls.length === 1) {
          markFirstStarted();
          await firstGate;
        }
        yield {
          type: "sdk_message",
          payload: {
            type: "assistant",
            session_id: "loop-queue-thread",
            message: { content: [{ type: "text", text: `assistant ${calls.length}` }] },
          },
        };
        yield {
          type: "sdk_message",
          payload: { type: "result", subtype: "success", session_id: "loop-queue-thread" },
        };
      },
    };

    const hub = new StubHub();
    const sessions = new SessionManager(hub as any, () => runtime);
    let continues = 1;
    let decisions = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessions.attachLoops({
      onTurnSettled: async () => {
        decisions += 1;
        return continues-- > 0 ? { userInput: "LOOP CONTINUE" } : null;
      },
    } as any);

    const first = sessions.sendMessage(agent.id, "first turn");
    await firstStarted;
    // The manager's supplement arrives while the first turn is still running.
    const queued = sessions.sendMessage(agent.id, "manager supplement");
    releaseFirst();

    await expect(first).resolves.toEqual({ finalText: "assistant 1" });
    await queued;
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(["first turn", "manager supplement", "LOOP CONTINUE"]);
    // The first turn settled with work still queued; the loop must not have
    // consumed it as an iteration decision. Two decisions remain: after the
    // queued turn, and after the continuation.
    expect(decisions).toBe(2);
  });
});
