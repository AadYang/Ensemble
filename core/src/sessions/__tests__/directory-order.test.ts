import { beforeAll, describe, expect, it } from "vitest";

process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../../db.js").prisma;
let SessionManager: typeof import("../SessionManager.js").SessionManager;
let DirectoryOrderError: typeof import("../SessionManager.js").DirectoryOrderError;

class StubHub {
  broadcasts: unknown[] = [];
  size(): number {
    return 0;
  }
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
  ({ SessionManager, DirectoryOrderError } = await import("../SessionManager.js"));
});

describe("sidebar directory order", () => {
  it("appends new teams and persists a full reorder", async () => {
    const sessions = new SessionManager(new StubHub() as never);
    const a = await sessions.createTeam({ name: "order-team-a" });
    const b = await sessions.createTeam({ name: "order-team-b" });
    const listed = await sessions.listTeams();
    const ours = listed.filter((t) => t.name.startsWith("order-team-"));
    expect(ours.map((t) => t.id)).toEqual([a, b]);
    expect(ours[1]!.sortOrder).toBeGreaterThan(ours[0]!.sortOrder);

    const rest = listed.filter((t) => !t.name.startsWith("order-team-")).map((t) => t.id);
    await sessions.reorderTeams([...rest, b, a]);
    const after = (await sessions.listTeams()).filter((t) => t.name.startsWith("order-team-"));
    expect(after.map((t) => t.id)).toEqual([b, a]);
  });

  it("appends new agents in a team and reorders siblings", async () => {
    const sessions = new SessionManager(new StubHub() as never);
    const teamId = await sessions.createTeam({ name: "order-members" });
    const first = await sessions.createAgent({ name: "zeta", teamId });
    const second = await sessions.createAgent({ name: "alpha", teamId });
    const members = (await sessions.listTeams()).find((t) => t.id === teamId);
    const firstRow = await prisma.agent.findUnique({ where: { id: first } });
    const secondRow = await prisma.agent.findUnique({ where: { id: second } });
    expect(secondRow!.sortOrder).toBeGreaterThan(firstRow!.sortOrder);
    expect(members?.memberIds).toContain(first);

    await sessions.reorderAgents([second, first]);
    const reordered = [
      await prisma.agent.findUnique({ where: { id: first } }),
      await prisma.agent.findUnique({ where: { id: second } }),
    ];
    expect(reordered[1]!.sortOrder).toBe(0);
    expect(reordered[0]!.sortOrder).toBe(1);
  });

  it("refuses a mixed-team agent list", async () => {
    const sessions = new SessionManager(new StubHub() as never);
    const teamA = await sessions.createTeam({ name: "order-mix-a" });
    const teamB = await sessions.createTeam({ name: "order-mix-b" });
    const a = await sessions.createAgent({ name: "mix-a", teamId: teamA });
    const b = await sessions.createAgent({ name: "mix-b", teamId: teamB });
    await expect(sessions.reorderAgents([a, b])).rejects.toBeInstanceOf(DirectoryOrderError);
  });

  it("refuses a partial sibling list", async () => {
    const sessions = new SessionManager(new StubHub() as never);
    const teamId = await sessions.createTeam({ name: "order-partial" });
    const a = await sessions.createAgent({ name: "p-a", teamId });
    await sessions.createAgent({ name: "p-b", teamId });
    await expect(sessions.reorderAgents([a])).rejects.toBeInstanceOf(DirectoryOrderError);
  });
});
