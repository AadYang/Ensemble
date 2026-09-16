import { describe, expect, it } from "vitest";
import { contextBarView, contextPlanFacts, contextTone, formatTokens } from "./context-bar-view.js";
import type { ContextUsage } from "./protocol.js";
import type { RunPlanStatusView } from "./run-plan-view.js";

const usage = (u: Partial<ContextUsage> & { usedTokens: number }): ContextUsage => u;

describe("formatTokens", () => {
  it("formats the magnitudes the bar actually shows", () => {
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(828_400)).toBe("828k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_050_000)).toBe("1.05M");
    expect(formatTokens(10_500_000)).toBe("11M");
  });

  it("does not invent a number for a bad input", () => {
    expect(formatTokens(Number.NaN)).toBe("?");
    expect(formatTokens(-1)).toBe("?");
  });
});

describe("contextTone", () => {
  it("uses the quality-degradation bands, not window fullness", () => {
    expect(contextTone(0)).toBe("ok");
    expect(contextTone(20)).toBe("ok");
    expect(contextTone(21)).toBe("warn");
    expect(contextTone(40)).toBe("warn");
    expect(contextTone(41)).toBe("err");
  });
});

describe("contextBarView", () => {
  it("has no data for an absent reading", () => {
    expect(contextBarView(null).kind).toBe("no-data");
    expect(contextBarView(undefined).kind).toBe("no-data");
    expect(contextBarView(null).tipKey).toBe("pane.context.unknownTip");
  });

  it("renders the effective window as the denominator", () => {
    const view = contextBarView(usage({
      usedTokens: 100_000,
      contextWindow: 828_400,
      percent: 12,
      advertisedContextWindow: 1_050_000,
      advertisedWindowConfidence: "confirmed",
      windowOrigin: "runtime-profile",
      windowObservedAt: "2026-09-15",
      windowClamped: true,
    }));
    expect(view.kind).toBe("bar");
    expect(view.windowText).toBe("828k");
    expect(view.percentText).toBe("12%");
    expect(view.filled).toBe(1);
    expect(view.tone).toBe("ok");
  });

  // The regression this module exists for: a known advertised maximum must not
  // disappear just because the live ceiling is unknown.
  it("still shows the advertised maximum when the effective window is unknown", () => {
    const view = contextBarView(usage({
      usedTokens: 250_000,
      advertisedContextWindow: 1_050_000,
      advertisedWindowConfidence: "confirmed",
    }));
    expect(view.kind).toBe("count-only");
    expect(view.usedText).toBe("250k");
    expect(view.showAdvertised).toBe(true);
    expect(view.advertisedText).toBe("1.05M");
    expect(view.advertisedIsConfirmed).toBe(true);
    expect(view.tipKey).toBe("pane.context.tipUnknownCeiling");
    // Critically: no denominator, no percentage, no bar.
    expect(view.windowText).toBeUndefined();
    expect(view.percentText).toBeUndefined();
    expect(view.glyph).toBeUndefined();
  });

  it("says nothing about a maximum when we do not know one either", () => {
    const view = contextBarView(usage({ usedTokens: 250_000 }));
    expect(view.kind).toBe("count-only");
    expect(view.showAdvertised).toBe(false);
    expect(view.advertisedText).toBeUndefined();
    expect(view.tipKey).toBe("pane.context.unknownTip");
  });

  // The advertised value is never allowed to become the denominator.
  it("never derives a percentage from the advertised value", () => {
    const view = contextBarView(usage({
      usedTokens: 500_000,
      advertisedContextWindow: 1_000_000,
    }));
    expect(view.percentText).toBeUndefined();
    expect(view.windowText).toBeUndefined();
    expect(view.kind).toBe("count-only");
  });

  it("calls out a clamped window and keeps the official max beside it", () => {
    const view = contextBarView(usage({
      usedTokens: 300_000,
      contextWindow: 828_400,
      percent: 36,
      advertisedContextWindow: 1_050_000,
      advertisedWindowConfidence: "confirmed",
      windowClamped: true,
    }));
    expect(view.clamped).toBe(true);
    expect(view.showAdvertised).toBe(true);
    expect(view.advertisedIsConfirmed).toBe(true);
    expect(view.tipKey).toBe("pane.context.tipClamped");
    expect(view.tipParams.advertised).toBe("1.05M");
    expect(view.tipParams.window).toBe("828k");
    expect(view.tone).toBe("warn");
  });

  it("does not repeat the maximum when the runtime window IS the advertised one", () => {
    const view = contextBarView(usage({
      usedTokens: 100_000,
      contextWindow: 1_000_000,
      percent: 10,
      advertisedContextWindow: 1_000_000,
      windowOrigin: "session-observed",
    }));
    expect(view.showAdvertised).toBe(false);
    expect(view.tipKey).toBe("pane.context.tip");
    expect(view.tipParams.advertised).toBeUndefined();
  });

  it("uses the plain tip when there is no advertised figure at all", () => {
    const view = contextBarView(usage({
      usedTokens: 100_000,
      contextWindow: 200_000,
      percent: 50,
      windowOrigin: "session-observed",
    }));
    expect(view.showAdvertised).toBe(false);
    expect(view.tipKey).toBe("pane.context.tip");
    expect(view.tone).toBe("err");
  });

  // A number we never verified must not read as settled fact.
  it("labels an unverified advertised maximum and carries its source", () => {
    const view = contextBarView(usage({
      usedTokens: 100_000,
      contextWindow: 200_000,
      percent: 50,
      advertisedContextWindow: 1_050_000,
      advertisedWindowConfidence: "unverified",
      advertisedWindowSource: "LiteLLM snapshot 2026-06-01 (community-maintained)",
    }));
    expect(view.showAdvertised).toBe(true);
    expect(view.advertisedCaveatKey).toBe("pane.context.noteUnverified");
    expect(view.advertisedSource).toContain("LiteLLM");
    // The WORDING follows too: "model maximum" is a claim about the vendor's
    // documentation, which a community snapshot does not support.
    expect(view.advertisedIsConfirmed).toBe(false);
    expect(view.tipKey).toBe("pane.context.tipAdvertisedUnverified");
  });

  it("gives a legacy-migrated maximum the migration hint", () => {
    const view = contextBarView(usage({
      usedTokens: 100_000,
      advertisedContextWindow: 777_777,
      advertisedWindowConfidence: "legacy",
    }));
    expect(view.kind).toBe("count-only");
    expect(view.advertisedCaveatKey).toBe("pane.context.noteLegacy");
    expect(view.advertisedIsConfirmed).toBe(false);
    expect(view.tipKey).toBe("pane.context.tipUnknownCeilingUnverified");
  });

  it("flags a family analogy as such", () => {
    const view = contextBarView(usage({
      usedTokens: 1,
      contextWindow: 100_000,
      percent: 1,
      advertisedContextWindow: 1_050_000,
      advertisedWindowConfidence: "family-analogy",
    }));
    expect(view.advertisedCaveatKey).toBe("pane.context.noteFamilyAnalogy");
    expect(view.tipKey).toBe("pane.context.tipAdvertisedUnverified");
  });

  // An unverified figure can also be clamped, and then the note must not start
  // calling it the model's official maximum just because the runtime disagreed
  // with it.
  it("keeps the unverified wording on a clamped unverified value", () => {
    const view = contextBarView(usage({
      usedTokens: 100,
      contextWindow: 128_000,
      percent: 1,
      advertisedContextWindow: 200_000,
      advertisedWindowConfidence: "unverified",
      windowClamped: true,
    }));
    expect(view.tipKey).toBe("pane.context.tipClampedUnverified");
  });

  it("adds no caveat for a confirmed maximum, but still names the source", () => {
    const view = contextBarView(usage({
      usedTokens: 1,
      contextWindow: 100_000,
      percent: 1,
      advertisedContextWindow: 1_050_000,
      advertisedWindowConfidence: "confirmed",
      advertisedWindowSource: "https://platform.openai.com/docs/models",
    }));
    expect(view.advertisedCaveatKey).toBeUndefined();
    expect(view.advertisedSource).toBe("https://platform.openai.com/docs/models");
    expect(view.advertisedIsConfirmed).toBe(true);
    expect(view.tipKey).toBe("pane.context.tipAdvertised");
  });

  // Absent provenance is NOT "confirmed". Assuming a value is verified because
  // nobody said otherwise is exactly how an unchecked number ends up labelled
  // "model maximum" — so the default is the weaker claim.
  it("does not treat a missing confidence as confirmed", () => {
    const bar = contextBarView(usage({
      usedTokens: 100,
      contextWindow: 128_000,
      percent: 1,
      advertisedContextWindow: 200_000,
    }));
    expect(bar.advertisedIsConfirmed).toBe(false);
    expect(bar.tipKey).toBe("pane.context.tipAdvertisedUnverified");
    // Silence would render it exactly like a confirmed figure, so an untagged
    // value (older persisted record, or a producer that never set the field)
    // must still carry a visible caveat.
    expect(bar.advertisedCaveatKey).toBe("pane.context.noteUnknownProvenance");

    const countOnly = contextBarView(usage({
      usedTokens: 100,
      advertisedContextWindow: 200_000,
    }));
    expect(countOnly.advertisedIsConfirmed).toBe(false);
    expect(countOnly.tipKey).toBe("pane.context.tipUnknownCeilingUnverified");
    expect(countOnly.advertisedCaveatKey).toBe("pane.context.noteUnknownProvenance");

    // Nothing advertised ⇒ nothing to certify, and no unverified claim either.
    expect(contextBarView(usage({ usedTokens: 100 })).advertisedIsConfirmed).toBe(false);
    expect(contextBarView(null).advertisedIsConfirmed).toBe(false);
  });

  it("adds no caveat when there is no advertised figure to caveat", () => {
    const view = contextBarView(usage({
      usedTokens: 1,
      contextWindow: 100_000,
      percent: 1,
      advertisedWindowConfidence: "legacy",
    }));
    expect(view.advertisedCaveatKey).toBeUndefined();
  });

  it("fills the gauge proportionally to the effective window", () => {
    for (const [percent, expected] of [[0, 0], [5, 1], [50, 5], [100, 10], [150, 10]] as const) {
      const view = contextBarView(usage({ usedTokens: 10, contextWindow: 100, percent }));
      expect(view.filled, `percent=${percent}`).toBe(expected);
      expect(view.glyph).toHaveLength(11); // "▕" + 10 segments
    }
  });
});

// The plan half of the bar. `contextBarView` projects it, so a ContextBar that
// is handed the plan must render the plan's own limits, counting quality,
// compaction state and degraded reasons — and must say WHERE its denominator
// came from rather than leaving that to be inferred from which number is bigger.
describe("contextPlanFacts", () => {
  const plan = (over: {
    effectiveWindow?: number | null;
    outputReserve?: number | null;
    counting?: "exact" | "estimated" | "unmeasured";
    status?: string;
    reason?: string;
    summaries?: number;
    overBudget?: boolean;
  } = {}): RunPlanStatusView =>
    ({
      context: {
        effectiveWindow: over.effectiveWindow === undefined ? 828_400 : over.effectiveWindow,
        outputReserve: over.outputReserve === undefined ? 16_000 : over.outputReserve,
      },
      history: {
        counting: over.counting ?? "exact",
        status: over.status ?? "resolved",
        reason: over.reason ?? "the transcript fits the budget",
        strategy: "local-rebuild",
        overBudget: over.overBudget ?? false,
        summaries: new Array(over.summaries ?? 0).fill({}),
        counts: { summarized: over.summaries ?? 0, dropped: 0 },
      },
    }) as unknown as RunPlanStatusView;

  it("names the live reading as the denominator's source when there is one", () => {
    const facts = contextPlanFacts(plan(), 828_400);
    expect(facts!.effectiveSource).toBe("runtime-observed");
    // The plan's window is still reported next to it, never in its place.
    expect(facts!.effectiveWindowText).toBe("828k");
    expect(facts!.outputReserveText).toBe("16k");
    expect(facts!.degraded).toBe(false);
    expect(facts!.degradedReason).toBeNull();
  });

  // The bar is HANDED the plan, so `view.plan` must be populated. The defect
  // this catches: a renderer that calls `contextBarView(context)` with one
  // argument gets `plan: null` for every agent that ever ran, and the whole
  // plan half of the bar silently renders as "unknown".
  it("carries the plan through the bar's own view-model", () => {
    const view = contextBarView(
      usage({ usedTokens: 100_000, contextWindow: 828_400, percent: 12 }),
      plan(),
    );
    expect(view.kind).toBe("bar");
    expect(view.plan).not.toBeNull();
    expect(view.plan!.effectiveSource).toBe("runtime-observed");
    expect(view.plan!.effectiveWindowText).toBe("828k");
  });

  it("falls back to the plan's window, and to `none` when neither exists", () => {
    expect(contextPlanFacts(plan(), null)!.effectiveSource).toBe("plan");
    const empty = contextPlanFacts(plan({ effectiveWindow: null, outputReserve: null }), null);
    expect(empty!.effectiveSource).toBe("none");
    expect(empty!.effectiveWindowText).toBeNull();
    expect(empty!.outputReserveText).toBeNull();
    // A missing limit is stated, not filled with a plausible number.
    expect(empty!.degraded).toBe(true);
    expect(empty!.degradedReason).toContain("effective context window");
    expect(empty!.degradedReason).toContain("output reservation");
  });

  // The two states the bar must not render as a healthy turn: a count that is a
  // byte estimate rather than a measurement, and a transcript the plan itself
  // admits is over budget. Both are marked, and the plan's own sentence travels
  // with them.
  it("marks an estimated, over-budget turn degraded, and reports compaction", () => {
    const facts = contextPlanFacts(
      plan({
        counting: "estimated",
        status: "unavailable",
        reason: "the transcript does not fit the budget",
        overBudget: true,
        summaries: 2,
      }),
      null,
    );
    expect(facts!.counting).toBe("estimated");
    expect(facts!.history!.compacted).toBe(true);
    expect(facts!.history!.summarised).toBe(2);
    expect(facts!.history!.overBudget).toBe(true);
    expect(facts!.degraded).toBe(true);
    expect(facts!.degradedReason).toContain("estimated byte upper bound");
    expect(facts!.degradedReason).toContain("over its own token budget");
    // The plan's own reason is quoted, not replaced by a generic "degraded".
    expect(facts!.degradedReason).toContain("the transcript does not fit the budget");
  });

  it("reports `no plan` as its own state, never as an empty plan", () => {
    expect(contextPlanFacts(null, 828_400)).toBeNull();
    expect(contextPlanFacts(undefined, null)).toBeNull();
    // …and a bar with a live reading but no plan still renders the live half,
    // with `plan: null` rather than a fabricated block.
    expect(contextBarView(usage({ usedTokens: 1, contextWindow: 100, percent: 1 }), null).plan).toBeNull();
  });
});
