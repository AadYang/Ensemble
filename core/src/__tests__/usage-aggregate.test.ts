import { describe, it, expect } from "vitest";
import { aggregateUsage } from "../usage-aggregate.js";
import type { UsageEvent } from "../db.js";

// W17 Slice 4: aggregation invariants.

const baseEvent: Omit<UsageEvent, "id" | "createdAt"> = {
  agentId: "a1",
  agentName: "main",
  parentId: null,
  providerId: "p1",
  providerName: "anthropic-default",
  providerKind: "anthropic-local",
  model: "claude-opus-4-7",
  source: "result",
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUSD: 0.0525, // (1000/1e6 * 15) + (500/1e6 * 75)
  costKnown: true,
  billingModel: "usage",
  inputTokensLocal: 0,
  outputTokensLocal: 0,
};

function mk(overrides: Partial<UsageEvent>, dateIso = "2026-05-11T10:00:00Z"): UsageEvent {
  return {
    id: Math.random().toString(36).slice(2),
    ...baseEvent,
    ...overrides,
    createdAt: new Date(dateIso),
  } as UsageEvent;
}

describe("aggregateUsage totals", () => {
  it("sums token + cost across all known rows", () => {
    const rows = [
      mk({ inputTokens: 100, outputTokens: 50, costUSD: 1.0 }),
      mk({ inputTokens: 200, outputTokens: 100, costUSD: 2.0 }),
    ];
    const r = aggregateUsage(rows);
    expect(r.totals.costUSD).toBe(3.0);
    expect(r.totals.inputTokens).toBe(300);
    expect(r.totals.outputTokens).toBe(150);
    expect(r.totals.turns).toBe(2);
    expect(r.totals.agents).toBe(1); // both rows under agent a1
  });

  it("keeps unpriced rows in the totals and reports how much of the cost they are missing from", () => {
    const rows = [
      mk({ costUSD: 1.0, costKnown: true }),
      mk({ model: "fake", costUSD: 0, costKnown: false, inputTokens: 999 }),
    ];
    const r = aggregateUsage(rows);
    // Cost is still the priced half — an unpriced turn has no price to add.
    expect(r.totals.costUSD).toBe(1.0);
    // …but the turn and its tokens are MEASURED facts and are counted, so the
    // panel does not under-report work it can see.
    expect(r.totals.turns).toBe(2);
    expect(r.totals.inputTokens).toBe(1999);
    // And the sum says out loud that it covers 1 of 2 turns.
    expect(r.totals.turnsCostKnown).toBe(1);
    expect(r.totals.turnsCostUnknown).toBe(1);
    expect(r.unknownModels).toHaveLength(1);
    expect(r.unknownModels[0]!.model).toBe("fake");
    expect(r.unknownModels[0]!.inputTokens).toBe(999);
  });

  // THE OUTAGE THIS FILE EXISTS TO CATCH (2026-09-15).
  //
  // Regression: `aggregateUsage` partitioned rows by `costKnown` and walked
  // only the priced half — in the live DB, 411 of the last 30 days' 2325 turns,
  // running seven models that had no price configured (deepseek-v4-pro,
  // claude-fable-5, deepseek-v4-flash, deepseek-flash, claude-opus-5, …). Those
  // turns, their tokens, their models and their AGENTS were absent from totals,
  // from the daily chart and from all three tables, so an agent that ran only
  // unpriced models — every deepseek agent on the team — showed up as having no
  // usage at all, and the cost card printed a subset sum as a total.
  it("does not drop unpriced agents, models or days out of the report", () => {
    const rows = [
      mk({ agentId: "priced", agentName: "priced", costUSD: 2.0, costKnown: true }, "2026-05-11T10:00:00Z"),
      mk(
        {
          agentId: "unpriced",
          agentName: "deepseek-agent",
          model: "deepseek-v4-pro",
          costUSD: 0,
          costKnown: false,
          inputTokens: 500,
          outputTokens: 250,
        },
        "2026-05-12T10:00:00Z",
      ),
    ];
    const r = aggregateUsage(rows, { tz: "UTC" });

    // The agent is in the table, with its work, at a cost of 0 that is
    // labelled as "not priced" rather than passed off as "free".
    const agent = r.byAgent.find((a) => a.agentId === "unpriced")!;
    expect(agent).toBeDefined();
    expect(agent.turns).toBe(1);
    expect(agent.inputTokens).toBe(500);
    expect(agent.outputTokens).toBe(250);
    expect(agent.costUSD).toBe(0);
    expect(agent.turnsCostKnown).toBe(0);
    expect(agent.turnsCostUnknown).toBe(1);

    // Same for the model, and for the day it ran on.
    const model = r.byModel.find((m) => m.model === "deepseek-v4-pro")!;
    expect(model.turns).toBe(1);
    expect(model.turnsCostUnknown).toBe(1);
    expect(r.daily.map((d) => d.date)).toEqual(["2026-05-11", "2026-05-12"]);
    expect(r.daily[1]!.turns).toBe(1);
    expect(r.daily[1]!.costUSD).toBe(0);
    // …and provider, which also carries the coverage.
    expect(r.byProvider.some((p) => p.turnsCostUnknown === 1)).toBe(true);

    // Totals count both turns; the cost is a lower bound and says so.
    expect(r.totals.turns).toBe(2);
    expect(r.totals.turnsCostKnown).toBe(1);
    expect(r.totals.turnsCostUnknown).toBe(1);
    expect(r.totals.agents).toBe(2);
  });

  it("distinguishes flat-rate subscription turns from unpriced ones", () => {
    const rows = [
      // Codex / ChatGPT plan: $0 per turn BY CONTRACT — priced, and known.
      mk({ model: "gpt-5.6-sol", costUSD: 0, costKnown: true, billingModel: "subscription" }),
      // No price configured for this model at all.
      mk({ model: "mystery", costUSD: 0, costKnown: false }),
    ];
    const r = aggregateUsage(rows);
    expect(r.totals.turns).toBe(2);
    expect(r.totals.turnsCostKnown).toBe(1);
    expect(r.totals.turnsSubscription).toBe(1);
    expect(r.totals.turnsCostUnknown).toBe(1);
    // A subscription-only history is NOT "unavailable": cost is known, it is
    // just zero. Only `turnsCostKnown === 0` means the cost cannot be stated.
    expect(r.totals.turnsCostKnown > 0).toBe(true);
  });
});

describe("aggregateUsage daily bucket", () => {
  it("buckets by date in the given tz", () => {
    const rows = [
      // 2026-05-10 23:30 UTC = 2026-05-11 07:30 in Asia/Shanghai
      mk({ costUSD: 1.0 }, "2026-05-10T23:30:00Z"),
      // 2026-05-11 23:30 UTC = 2026-05-12 07:30 in Asia/Shanghai
      mk({ costUSD: 2.0 }, "2026-05-11T23:30:00Z"),
    ];
    const r = aggregateUsage(rows, { tz: "Asia/Shanghai" });
    expect(r.daily).toHaveLength(2);
    expect(r.daily[0]!.date).toBe("2026-05-11");
    expect(r.daily[1]!.date).toBe("2026-05-12");
  });

  it("populates byProvider per-day breakdown", () => {
    const rows = [
      mk({ providerKind: "anthropic-local", costUSD: 1.0 }, "2026-05-11T10:00:00Z"),
      mk({ providerKind: "openai-compat", costUSD: 2.0 }, "2026-05-11T10:00:00Z"),
    ];
    const r = aggregateUsage(rows, { tz: "UTC" });
    expect(r.daily[0]!.byProvider["anthropic-local"]).toBe(1.0);
    expect(r.daily[0]!.byProvider["openai-compat"]).toBe(2.0);
  });
});

describe("aggregateUsage byAgent", () => {
  it("groups by agentId and snapshots agentName", () => {
    const rows = [
      mk({ agentId: "a1", agentName: "main", costUSD: 1.0 }),
      mk({ agentId: "a2", agentName: "explorer", costUSD: 2.5 }),
    ];
    const r = aggregateUsage(rows);
    expect(r.byAgent).toHaveLength(2);
    // Sorted desc by costUSD
    expect(r.byAgent[0]!.agentName).toBe("explorer");
    expect(r.byAgent[1]!.agentName).toBe("main");
  });

  it("buckets deleted agents (agentId=null) into a snapshot-keyed row", () => {
    const rows = [
      mk({ agentId: null, agentName: "deleted-main", costUSD: 1.0 }),
      mk({ agentId: null, agentName: "deleted-main", costUSD: 0.5 }),
    ];
    const r = aggregateUsage(rows);
    expect(r.byAgent).toHaveLength(1);
    expect(r.byAgent[0]!.agentId).toBeNull();
    expect(r.byAgent[0]!.costUSD).toBe(1.5);
  });
});

describe("aggregateUsage includeDescendants", () => {
  it("rolls subagent cost into ancestor row when toggled on", () => {
    const rows = [
      mk({ agentId: "parent", agentName: "main", parentId: null, costUSD: 1.0 }),
      mk({ agentId: "child1", agentName: "task1", parentId: "parent", costUSD: 0.5 }),
      mk({ agentId: "child2", agentName: "task2", parentId: "parent", costUSD: 0.25 }),
    ];
    const flat = aggregateUsage(rows);
    const parentFlat = flat.byAgent.find((a) => a.agentId === "parent")!;
    expect(parentFlat.costUSD).toBe(1.0); // its own only

    const rolled = aggregateUsage(rows, { includeDescendants: true });
    const parentRolled = rolled.byAgent.find((a) => a.agentId === "parent")!;
    expect(parentRolled.costUSD).toBe(1.75); // 1.0 + 0.5 + 0.25
    expect(parentRolled.descendantIds).toEqual(["child1", "child2"]);
  });

  it("doesn't double-count via grandchild chains", () => {
    const rows = [
      mk({ agentId: "g", agentName: "grand", parentId: null, costUSD: 1.0 }),
      mk({ agentId: "p", agentName: "parent", parentId: "g", costUSD: 0.5 }),
      mk({ agentId: "c", agentName: "child", parentId: "p", costUSD: 0.25 }),
    ];
    const r = aggregateUsage(rows, { includeDescendants: true });
    const grand = r.byAgent.find((a) => a.agentId === "g")!;
    expect(grand.costUSD).toBe(1.75); // adds p and c once each
    expect(grand.descendantIds!.sort()).toEqual(["c", "p"]);
  });
});

describe("aggregateUsage byModel and byProvider", () => {
  it("groups by model", () => {
    const rows = [
      mk({ model: "claude-opus-4-7", costUSD: 1.0 }),
      mk({ model: "claude-opus-4-7", costUSD: 0.5 }),
      mk({ model: "gpt-4o", costUSD: 2.0 }),
    ];
    const r = aggregateUsage(rows);
    expect(r.byModel).toHaveLength(2);
    expect(r.byModel[0]!.model).toBe("gpt-4o");
    expect(r.byModel[1]!.model).toBe("claude-opus-4-7");
    expect(r.byModel[1]!.costUSD).toBe(1.5);
  });

  it("groups by provider with snapshot fields preserved", () => {
    const rows = [
      mk({ providerId: "p1", providerName: "anthropic-default", providerKind: "anthropic-local", costUSD: 1.0 }),
      mk({ providerId: "p2", providerName: "minimax", providerKind: "anthropic", costUSD: 2.0 }),
    ];
    const r = aggregateUsage(rows);
    expect(r.byProvider[0]!.providerName).toBe("minimax");
    expect(r.byProvider[1]!.providerName).toBe("anthropic-default");
  });
});

describe("aggregateUsage topAgent", () => {
  it("returns the highest-cost agent or null when empty", () => {
    expect(aggregateUsage([]).topAgent).toBeNull();
    const r = aggregateUsage([
      mk({ agentId: "x", agentName: "x", costUSD: 0.5 }),
      mk({ agentId: "y", agentName: "y", costUSD: 1.5 }),
    ]);
    expect(r.topAgent?.agentName).toBe("y");
    expect(r.topAgent?.costUSD).toBe(1.5);
  });
});
