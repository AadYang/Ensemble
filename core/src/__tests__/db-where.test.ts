// Regression test: NOT (and AND/OR) clauses recurse via buildWhere — earlier
// the recursive call returned SQL that already had "WHERE " prepended, so
// `NOT (where ...)` got rendered as `NOT WHERE ...` and SQLite threw
// "near 'WHERE': syntax error". This crashed peer_send / peer_query (both
// resolve target via findFirst({ where: { NOT: { id: fromAgentId } } })).

import { describe, it, expect, beforeAll } from "vitest";

// Force an in-memory DB so the import side-effect of db.ts doesn't touch the
// user's real %APPDATA% file.
process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../db.js").prisma;

beforeAll(async () => {
  ({ prisma } = await import("../db.js"));
});

describe("db where-clause", () => {
  it("NOT { id: X } on findFirst does not crash (no 'near WHERE' SQL error)", async () => {
    const a = await prisma.agent.create({ data: { name: "alpha" } });
    const b = await prisma.agent.create({ data: { name: "beta" } });

    // The exact shape resolvePeerTarget uses. Pre-fix this threw a SqliteError.
    const found = prisma.agent.findFirst({
      where: { name: "alpha", NOT: { id: b.id } },
      orderBy: { createdAt: "desc" },
    });
    expect(found?.id).toBe(a.id);

    // Self-exclusion variant — should return null, not crash.
    const excluded = prisma.agent.findFirst({
      where: { name: "alpha", NOT: { id: a.id } },
      orderBy: { createdAt: "desc" },
    });
    expect(excluded).toBeNull();
  });

  it("case-insensitive equals composes with NOT", async () => {
    const c = await prisma.agent.create({ data: { name: "Gamma" } });
    const found = prisma.agent.findFirst({
      where: {
        name: { equals: "gamma", mode: "insensitive" },
        NOT: { id: "00000000-0000-0000-0000-000000000000" },
      },
    });
    expect(found?.id).toBe(c.id);
  });

  it("createdAt gte/lt filters UsageEvent in SQL", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    await prisma.usageEvent.create({
      data: {
        agentName: "range-a",
        providerName: "p",
        providerKind: "openai-compat",
        model: "deepseek-flash",
        source: "result",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        costKnown: 0,
        createdAt: t0 - 100,
      },
    });
    await prisma.usageEvent.create({
      data: {
        agentName: "range-b",
        providerName: "p",
        providerKind: "openai-compat",
        model: "deepseek-flash",
        source: "result",
        inputTokens: 2,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        costKnown: 0,
        createdAt: t0 - 10,
      },
    });
    const hit = prisma.usageEvent.findMany({
      where: { createdAt: { gte: t0 - 20, lt: t0 } },
    });
    expect(hit.map((r) => r.agentName)).toEqual(["range-b"]);
  });
});
