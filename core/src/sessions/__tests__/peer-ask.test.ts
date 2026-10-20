// peer_ask is a BLOCKING request/response: the sender's tool call parks until
// the peer answers, and the answer is returned into the SAME turn. A reply
// must therefore be consumed by the parked call, not queued as a future turn.
//
// A timeout is a failure, not permission to continue: the whole point is that
// guessing produces more wrong work.

import { describe, it, expect, beforeAll } from "vitest";

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

function markRunning(sessions: InstanceType<typeof SessionManager>, agentId: string, runId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sessions as any).running.set(agentId, {
    id: agentId,
    runId,
    abort: new AbortController(),
    seq: 0,
    userInput: "turn in progress",
    startedSeq: 0,
    startedAt: new Date().toISOString(),
    pendingTurnHighWaterId: 0,
    autoAllowedTools: new Set<string>(),
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("peer_ask", () => {
  it("returns the peer's answer into the same turn and does not queue it", async () => {
    const asker = await prisma.agent.create({ data: { name: "asker-agent" } });
    const peer = await prisma.agent.create({ data: { name: "answer-agent" } });
    const sessions = new SessionManager(new StubHub() as any);
    markRunning(sessions, asker.id, "run-asker");
    markRunning(sessions, peer.id, "run-peer");

    const pending = sessions.askPeer(
      asker.id,
      peer.name,
      "Which protocol version?",
      "the wire contract is ambiguous and guessing would produce incompatible code",
      5_000,
    );
    for (let i = 0; i < 3; i += 1) await tick();

    const question = await prisma.pendingTurn.findFirst({
      where: { agentId: peer.id },
      orderBy: { id: "asc" },
    });
    expect(question).not.toBeNull();
    const askId = /replyToCorrelationId="([^"]+)"/.exec(question!.userInput)?.[1];
    expect(askId).toBeTruthy();

    const reply = await sessions.sendPeerMessage(peer.id, asker.name, "Use v2", "raw", {
      replyToCorrelationId: askId,
    });
    expect(reply).toContain("pending peer_ask");

    await expect(pending).resolves.toEqual({ text: 'Answer from "answer-agent":\nUse v2' });
    // The answer belongs to the parked call; it must not wake the asker later.
    expect(await prisma.pendingTurn.findMany({ where: { agentId: asker.id } })).toHaveLength(0);
  });

  it("treats a timeout as a blocking failure, never as permission to continue", async () => {
    const asker = await prisma.agent.create({ data: { name: "timeout-asker" } });
    const peer = await prisma.agent.create({ data: { name: "timeout-peer" } });
    const sessions = new SessionManager(new StubHub() as any);
    markRunning(sessions, asker.id, "run-timeout-asker");
    markRunning(sessions, peer.id, "run-timeout-peer");

    const result = await sessions.askPeer(
      asker.id,
      peer.name,
      "Which signing key?",
      "using the wrong key would invalidate every device token",
      25,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("BLOCKED");
    expect(result.text).toContain("Do NOT continue on assumptions");
  });

  it("refuses an ask without a concrete blocking reason", async () => {
    const asker = await prisma.agent.create({ data: { name: "reason-asker" } });
    const peer = await prisma.agent.create({ data: { name: "reason-peer" } });
    const sessions = new SessionManager(new StubHub() as any);
    markRunning(sessions, asker.id, "run-reason-asker");

    const before = await prisma.pendingTurn.findMany({ where: { agentId: peer.id } });
    const result = await sessions.askPeer(asker.id, peer.name, "status?", "short", 25);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("blockingReason");
    const after = await prisma.pendingTurn.findMany({ where: { agentId: peer.id } });
    expect(after).toHaveLength(before.length);
  });

  it("caps asks per turn so a peer cannot be used as a search engine", async () => {
    const asker = await prisma.agent.create({ data: { name: "budget-asker" } });
    const peer = await prisma.agent.create({ data: { name: "budget-peer" } });
    const sessions = new SessionManager(new StubHub() as any);
    markRunning(sessions, asker.id, "run-budget-asker");
    markRunning(sessions, peer.id, "run-budget-peer");

    const reason = "cannot proceed without this protocol detail";
    for (let i = 0; i < 5; i += 1) {
      const r = await sessions.askPeer(asker.id, peer.name, `q${i}`, reason, 10);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("BLOCKED");
    }
    const sixth = await sessions.askPeer(asker.id, peer.name, "q6", reason, 10);
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toContain("budget");
  });
});
