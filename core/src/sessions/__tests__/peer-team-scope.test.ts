import { beforeAll, describe, expect, it } from "vitest";

process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../../db.js").prisma;
let SessionManager: typeof import("../SessionManager.js").SessionManager;

class StubHub {
  broadcasts: unknown[] = [];
  size(): number { return 0; }
  add(): void {}
  remove(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  replayPendingFor(): void {}
  sendTo(): void {}
  sendToSession(): void {}
  broadcast(msg: unknown): void {
    this.broadcasts.push(msg);
  }
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager } = await import("../SessionManager.js"));
});

describe("peer_send team circle", () => {
  it("resolves a same-named teammate instead of a newer outsider", async () => {
    const teamA = await prisma.team.create({ data: { name: "circle-a" } });
    const teamB = await prisma.team.create({ data: { name: "circle-b" } });
    const manager = await prisma.agent.create({
      data: { name: "Jumpo经理", teamId: teamA.id },
    });
    const insider = await prisma.agent.create({
      data: { name: "Jumpo工程师", teamId: teamA.id },
    });
    const outsider = await prisma.agent.create({
      data: { name: "Jumpo工程师", teamId: teamB.id },
    });
    const sessions = new SessionManager(new StubHub() as never);
    const abort = new AbortController();
    // Keep the insider busy so delivery queues instead of launching a runtime.
    (sessions as unknown as { running: Map<string, { id: string; runId: string; abort: AbortController; seq: number; userInput: string; startedSeq: number; startedAt: string; autoAllowedTools: Set<string> }> }).running.set(insider.id, {
      id: insider.id,
      runId: "run-insider",
      abort,
      seq: 0,
      userInput: "busy",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });
    (sessions as unknown as { running: Map<string, unknown> }).running.set(outsider.id, {
      id: outsider.id,
      runId: "run-outsider",
      abort: new AbortController(),
      seq: 0,
      userInput: "busy",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    const result = await sessions.sendPeerMessage(manager.id, "Jumpo工程师", "hello teammate", "raw");
    expect(result).toContain("queued for");
    expect(result).toContain(insider.id.slice(0, 8));
    expect(result).not.toContain(outsider.id.slice(0, 8));
    expect(await prisma.pendingTurn.count({ where: { agentId: insider.id } })).toBe(1);
    expect(await prisma.pendingTurn.count({ where: { agentId: outsider.id } })).toBe(0);
  });

  it("refuses a UUID that belongs to another team", async () => {
    const teamA = await prisma.team.create({ data: { name: "uuid-a" } });
    const teamB = await prisma.team.create({ data: { name: "uuid-b" } });
    const manager = await prisma.agent.create({
      data: { name: "uuid-mgr", teamId: teamA.id },
    });
    const outsider = await prisma.agent.create({
      data: { name: "uuid-eng", teamId: teamB.id },
    });
    const sessions = new SessionManager(new StubHub() as never);

    const result = await sessions.sendPeerMessage(manager.id, outsider.id, "should not land", "raw");
    expect(result).toMatch(/not on your team/i);
    expect(await prisma.pendingTurn.count({ where: { agentId: outsider.id } })).toBe(0);
  });

  it("still lets ungrouped agents message other ungrouped agents", async () => {
    const source = await prisma.agent.create({ data: { name: "ungrouped-src" } });
    const target = await prisma.agent.create({ data: { name: "ungrouped-dst" } });
    const sessions = new SessionManager(new StubHub() as never);

    const result = await sessions.sendPeerMessage(source.id, target.name, "hi", "raw");
    expect(result).toContain("delivered to");
    expect(result).toContain(target.id.slice(0, 8));
  });
});
