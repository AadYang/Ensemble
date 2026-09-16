// Pure view-model for the agent-pane context-fill indicator.
//
// Kept in `shared` (not the React component) so the display contract can be
// tested without a UI test runner: desktop-ui has no vitest setup, and the
// rules encoded here are exactly the ones that were wrong before — which number
// is the denominator, and what to show when we do not have one.
//
// THE RULES:
//   1. The bar's denominator is `contextWindow` — the runtime's EFFECTIVE
//      window for this session. The model's advertised capacity is never
//      substituted for it.
//   2. When we have a token count but no effective window, we still render the
//      count AND the advertised capacity we do know. Hiding a known 1.05M behind
//      "context: unknown" loses information the user needs to judge the
//      situation — but the LABEL follows the provenance: only a value we
//      verified against the vendor's own page may be called the "model maximum"
//      (`advertisedIsConfirmed`), everything else is a "listed" figure.
//   3. A clamped window (runtime enforces less than the model documents) is
//      called out, because "828.4K" next to "max 1.05M" is otherwise confusing.
//   4. The advertised figure carries its PROVENANCE. A number we never verified
//      (community snapshot) or one migrated out of the old override file must
//      not be shown as settled fact — it gets a marker and a migration hint.
//
// The module returns i18n KEYS + params rather than sentences, so it stays
// language-agnostic.

import type { ContextWindowConfidence, ContextUsage } from "./protocol.js";
import type { RunPlanTokenCounting } from "./capability.js";
import type { RunPlanStatusView } from "./run-plan-view.js";

/** The plan's half of the bar.
 *
 *  The bar answers two different questions and must never confuse them:
 *
 *    • how full is this session?  — a RUNTIME-OBSERVED number (`ContextUsage`),
 *      which is the numerator and the only thing that moves during a turn;
 *    • what are this session's limits and what has history done to them? — the
 *      plan's numbers, resolved once before dispatch.
 *
 *  This block is the second half, projected verbatim. Every field is optional
 *  because "no plan has been resolved for this agent yet" is a real state, and
 *  an absent block renders as unknown rather than as a default. */
export interface ContextPlanFacts {
  /** Where the bar's DENOMINATOR actually came from. `runtime-observed` is the
   *  Claude SDK's live reading; `plan` is the window the plan resolved for the
   *  session; `none` means there is no denominator and the bar must not invent
   *  one. The advertised capacity is NEVER a denominator, which is why this
   *  field exists: it names the one source in use instead of leaving a reader to
   *  guess which of the two numbers was used. */
  effectiveSource: "runtime-observed" | "plan" | "none";
  /** The plan's effective window, formatted. `null` when the plan established
   *  none — not a fallback to the advertised value. */
  effectiveWindowText: string | null;
  /** Output tokens held back from the input budget. */
  outputReserveText: string | null;
  /** Compaction / history state for the last turn, from `plan.history`. Never
   *  recomputed: `strategy` and `reason` are the plan's own words. */
  history: {
    strategy: string | null;
    reason: string;
    summarised: number;
    dropped: number;
    overBudget: boolean;
    /** True when a compact summary stands in for part of the transcript. */
    compacted: boolean;
  } | null;
  /** `exact` (a real tokenizer measured it) / `estimated` (a labelled UTF-8 byte
   *  upper bound) / `unmeasured` / `null` (no plan). The bar's numbers are only
   *  as good as this, so it is displayed beside them. */
  counting: RunPlanTokenCounting | null;
  /** Something the plan could not establish. Rendered as a marker, never filled
   *  with a plausible number. */
  degraded: boolean;
  /** Why, when `degraded`. Never empty when `degraded` is true. */
  degradedReason: string | null;
}

/** The plan's contribution, or null when no plan is held for this agent.
 *
 *  Pure projection: it reads the view-model and formats; it does not resolve,
 *  measure or fall back.
 *
 *  `runtimeObservedWindow` is the live reading the bar itself is rendering, when
 *  there is one. It is needed here for ONE reason: `effectiveSource` must name
 *  where the denominator ACTUALLY came from, and the plan alone cannot know
 *  whether a live reading outranked it. Claiming "plan" while the bar is
 *  dividing by the runtime's own number would be a provenance lie of exactly the
 *  kind this module exists to prevent. */
export function contextPlanFacts(
  plan: RunPlanStatusView | null | undefined,
  runtimeObservedWindow?: number | null,
): ContextPlanFacts | null {
  if (!plan) return null;
  const window = plan.context.effectiveWindow;
  const observed = typeof runtimeObservedWindow === "number" && runtimeObservedWindow > 0;
  const summaryCount = plan.history.summaries.length;
  const degraded: string[] = [];
  if (window === null && !observed) degraded.push("no effective context window was established for this route");
  if (plan.history.counting !== "exact") {
    degraded.push(
      plan.history.counting === "estimated"
        ? "token counts are an estimated byte upper bound, not a tokenizer measurement"
        : "no token count was measured for this turn",
    );
  }
  if (plan.history.overBudget) degraded.push("the assembled transcript is over its own token budget");
  if (plan.history.status !== "resolved") degraded.push(plan.history.reason);
  if (plan.context.outputReserve === null) degraded.push("no output reservation was established for this route");
  return {
    // The live reading wins: it is the number the bar divides by. The plan's
    // window is reported next to it, never in its place.
    effectiveSource: observed ? "runtime-observed" : window === null ? "none" : "plan",
    effectiveWindowText: window === null ? null : formatTokens(window),
    outputReserveText: plan.context.outputReserve === null ? null : formatTokens(plan.context.outputReserve),
    history: {
      strategy: plan.history.strategy,
      reason: plan.history.reason,
      summarised: plan.history.counts.summarized,
      dropped: plan.history.counts.dropped,
      overBudget: plan.history.overBudget,
      compacted: summaryCount > 0,
    },
    counting: plan.history.counting,
    degraded: degraded.length > 0,
    degradedReason: degraded.length > 0 ? degraded.join("; ") : null,
  };
}

/** i18n key for the "this number is not verified" note, or null when the
 *  advertised figure is confirmed and needs no caveat. */
function caveatKeyFor(
  confidence: ContextWindowConfidence | undefined,
): string | null {
  switch (confidence) {
    case "confirmed":
      return null;
    case "legacy":
      return "pane.context.noteLegacy";
    case "family-analogy":
      return "pane.context.noteFamilyAnalogy";
    case "unverified":
      return "pane.context.noteUnverified";
    default:
      // No provenance at all — an older persisted record, or a producer that
      // never tagged the value. Staying silent here would render it exactly like
      // a confirmed figure; saying "unverified" would claim we know it is a
      // community snapshot. Name the actual situation instead.
      return "pane.context.noteUnknownProvenance";
  }
}

export interface ContextBarView {
  /** Which branch the renderer should take. */
  kind: "no-data" | "count-only" | "bar";
  usedText: string;
  /** Absent for `count-only` / `no-data`. */
  percentText?: string;
  /** The effective window, formatted. Absent for `count-only` / `no-data`. */
  windowText?: string;
  /** The model's advertised capacity, formatted — shown BESIDE the bar. */
  advertisedText?: string;
  /** True when the advertised figure should be rendered inline (it exists and
   *  differs from the effective window). */
  showAdvertised: boolean;
  /** i18n key for the "unverified / migrated" caveat, when the advertised value
   *  is not `confirmed`. The renderer shows a marker and appends the note to the
   *  tooltip. */
  advertisedCaveatKey?: string;
  /** False unless we actually verified the advertised figure. The label must
   *  change with it: calling a community snapshot "the official maximum" is the
   *  same lie as using it as a denominator. */
  advertisedIsConfirmed: boolean;
  /** Where the advertised value came from, for the tooltip. */
  advertisedSource?: string;
  /** True when the runtime enforces less than the model documents. */
  clamped: boolean;
  filled: number;
  glyph?: string;
  tone: "ok" | "warn" | "err" | "dim";
  tipKey: string;
  tipParams: Record<string, string | number>;
  /** The plan's half of the bar — limits, output reserve, history/compaction
   *  state, counting quality, degraded markers. `null` when no plan is held for
   *  this agent. NEVER a substitute for `windowText`: the denominator's one
   *  source is named by `plan.effectiveSource`, and a renderer that shows the
   *  advertised capacity in the denominator's place is showing a number the
   *  session is not running under. */
  plan: ContextPlanFacts | null;
}

export const CONTEXT_BAR_SEGMENTS = 10;

/** 1_050_000 → "1.05M", 828_400 → "828k", 512 → "512". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Number(m.toFixed(2))}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

/** Thresholds are the context-rot QUALITY-DEGRADATION bands (user decision),
 *  not window-fullness: ≤20% green, 20–40% yellow, >40% red. */
export function contextTone(percent: number): "ok" | "warn" | "err" {
  if (percent <= 20) return "ok";
  if (percent <= 40) return "warn";
  return "err";
}

export function contextBarView(
  context: ContextUsage | null | undefined,
  planView?: RunPlanStatusView | null,
): ContextBarView {
  const plan = contextPlanFacts(planView, context?.contextWindow ?? null);
  if (!context || (context.usedTokens <= 0 && context.contextWindow === undefined)) {
    return {
      kind: "no-data",
      usedText: "",
      showAdvertised: false,
      advertisedIsConfirmed: false,
      clamped: false,
      filled: 0,
      tone: "dim",
      tipKey: "pane.context.unknownTip",
      tipParams: {},
      plan,
    };
  }

  const usedText = formatTokens(context.usedTokens);
  const advertised = context.advertisedContextWindow;
  const advertisedText =
    advertised !== undefined && advertised > 0 ? formatTokens(advertised) : undefined;
  const clamped = context.windowClamped === true;
  // Provenance only matters when we are actually showing the figure.
  const caveatKey = caveatKeyFor(context.advertisedWindowConfidence);
  // Only a value we checked may be called "official"; an unknown provenance is
  // treated as unconfirmed rather than assumed good.
  const advertisedIsConfirmed = context.advertisedWindowConfidence === "confirmed";
  const provenance = advertisedText
    ? {
        advertisedIsConfirmed,
        ...(caveatKey ? { advertisedCaveatKey: caveatKey } : {}),
        ...(context.advertisedWindowSource
          ? { advertisedSource: context.advertisedWindowSource }
          : {}),
      }
    : { advertisedIsConfirmed: false };

  // We know how much is in the context but not how much fits. Show both facts
  // we have — never invent the denominator.
  if (context.contextWindow === undefined || context.percent === undefined) {
    return {
      kind: "count-only",
      usedText,
      advertisedText,
      showAdvertised: advertisedText !== undefined,
      ...provenance,
      clamped,
      filled: 0,
      tone: "dim",
      tipKey: !advertisedText
        ? "pane.context.unknownTip"
        : advertisedIsConfirmed
          ? "pane.context.tipUnknownCeiling"
          : "pane.context.tipUnknownCeilingUnverified",
      tipParams: advertisedText ? { used: usedText, advertised: advertisedText } : {},
      plan,
    };
  }

  const percent = context.percent;
  const windowText = formatTokens(context.contextWindow);
  const filled = Math.max(
    0,
    Math.min(CONTEXT_BAR_SEGMENTS, Math.round((percent / 100) * CONTEXT_BAR_SEGMENTS)),
  );
  const glyph = `▕${"█".repeat(filled)}${"░".repeat(CONTEXT_BAR_SEGMENTS - filled)}`;
  const showAdvertised = advertisedText !== undefined && advertised !== context.contextWindow;

  // "model maximum" is a claim about the vendor's documentation. Only a value we
  // checked gets to make it; anything else is a "listed" figure and says so.
  const tipKey = !showAdvertised
    ? "pane.context.tip"
    : clamped
      ? advertisedIsConfirmed
        ? "pane.context.tipClamped"
        : "pane.context.tipClampedUnverified"
      : advertisedIsConfirmed
        ? "pane.context.tipAdvertised"
        : "pane.context.tipAdvertisedUnverified";

  return {
    kind: "bar",
    usedText,
    percentText: `${percent}%`,
    windowText,
    advertisedText,
    showAdvertised,
    advertisedIsConfirmed,
    ...(showAdvertised ? provenance : {}),
    clamped,
    filled,
    glyph,
    tone: contextTone(percent),
    tipKey,
    tipParams: {
      used: usedText,
      window: windowText,
      percent,
      ...(showAdvertised && advertisedText ? { advertised: advertisedText } : {}),
    },
    plan,
  };
}
