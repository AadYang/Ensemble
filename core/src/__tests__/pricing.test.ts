import { describe, it, expect, beforeEach } from "vitest";
import { computeCost, loadPricingTable, _resetPricingCache } from "../pricing.js";

// W17 Slice 2: pricing computation invariants.

beforeEach(() => {
  _resetPricingCache();
});

describe("loadPricingTable", () => {
  it("returns the built-in table when no overrides file exists", () => {
    // The standard test env doesn't have a pricing-overrides.json next to the
    // built-in catalog, so we should see the built-in models intact.
    const t = loadPricingTable();
    expect(t.models["claude-opus-4-7"]).toBeDefined();
    expect(t.models["gpt-4o"]).toBeDefined();
    expect(t.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("memoizes between calls", () => {
    const a = loadPricingTable();
    const b = loadPricingTable();
    expect(a).toBe(b);
  });
});

describe("computeCost", () => {
  it("returns costKnown=false for an unknown model", () => {
    const r = computeCost("totally-fake-model-name", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(r.costKnown).toBe(false);
    expect(r.costUSD).toBe(0);
  });

  it("computes input + output for a known model", () => {
    const r = computeCost("gpt-4o-mini", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // gpt-4o-mini: input 0.15 / output 0.60
    expect(r.costKnown).toBe(true);
    expect(r.costUSD).toBeCloseTo(0.75, 6);
  });

  it("applies cacheRead discount when set", () => {
    // gpt-4o: input 2.50, cacheRead 1.25.
    // 1M input + 2M cache_read → 2.50 + 2*1.25 = 5.00
    const r = computeCost("gpt-4o", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 2_000_000,
    });
    expect(r.costUSD).toBeCloseTo(5.00, 6);
  });

  it("applies cacheWrite price when set, falls back to input price otherwise", () => {
    // claude-opus-4-7: input 15.00, cacheWrite 18.75.
    const r1 = computeCost("claude-opus-4-7", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(r1.costUSD).toBeCloseTo(18.75, 6);

    // glm-4.5 (would be in overrides, not in built-in) → use a model without
    // cacheWrite for the fallback assertion. gpt-4o-mini has no cacheWrite,
    // so cache_creation should fall back to its input price (0.15).
    const r2 = computeCost("gpt-4o-mini", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(r2.costUSD).toBeCloseTo(0.15, 6);
  });

  it("treats missing usage fields as 0", () => {
    const r = computeCost("gpt-4o-mini", {
      inputTokens: 100,
      outputTokens: 50,
    });
    // Only input + output, no cache, no creation.
    expect(r.costUSD).toBeCloseTo(
      (100 / 1_000_000) * 0.15 + (50 / 1_000_000) * 0.60,
      9,
    );
  });

  it("rounds to 6 decimal places", () => {
    // Ensure we don't return floating cruft like 1.2300000000000001.
    const r = computeCost("gpt-4o-mini", {
      inputTokens: 1234,
      outputTokens: 567,
    });
    const stringified = String(r.costUSD);
    // No tail of nine 9s or zero zeros from float drift.
    expect(stringified).not.toMatch(/0{6}\d|9{6}\d/);
  });
});
