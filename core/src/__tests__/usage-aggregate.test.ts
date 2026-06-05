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

  it("excludes costKnown=false rows from costUSD but counts their turns elsewhere", () => {
    const rows = [
      mk({ costUSD: 1.0, costKnown: true }),
      mk({ model: "fake", costUSD: 0, costKnown: false, inputTokens: 999 }),
    ];
    const r = aggregateUsage(rows);
    expect(r.totals.costUSD).toBe(1.0);
    expect(r.totals.turns).toBe(1); // only known counted in totals
    expect(r.unknownModels).toHaveLength(1);
    expect(r.unknownModels[0]!.model).toBe("fake");
    expect(r.unknownModels[0]!.inputTokens).toBe(999);
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
