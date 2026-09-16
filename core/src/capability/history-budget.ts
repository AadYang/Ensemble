// The turn's history budget: how much of the conversation actually goes to the
// model, decided ONCE, in the plan, and printed by /status.
//
// This module replaces a set of character constants (28 messages, 18 000 chars
// per history, 6 000 chars per message) that were applied silently: a marker in
// message #29 simply stopped existing, with nothing in the transcript, the plan
// or the UI to say so. Three rules replace them:
//
//   1. THE BUDGET COMES FROM THE WINDOW, not from a constant. The window is
//      `plan.context` — the runtime's effective ceiling minus the output
//      reservation minus what the system prompt and the tool schemas cost.
//   2. NOTHING IS TRUNCATED MID-CONTENT. Content either fits verbatim, or it is
//      covered by a ranged summary, or it is reported as overflow for the
//      compact path to cover. There is no third, quieter outcome.
//   3. A NUMBER THAT COULD NOT BE MEASURED SAYS SO. When the local tokenizer is
//      missing or returns 0 the count falls back to the UTF-8 byte length — an
//      explicitly labelled conservative upper bound with a diagnostic — never
//      to a hidden character constant that pretends to be a token count.
//
// The caller owns the I/O (reading rows, counting tokens); this resolver owns
// the arithmetic. That split is what keeps the planner pure and testable, and
// it is the same split `ProjectRootInput` uses for filesystem inspection.

import type {
  RunPlanContext,
  RunPlanHistory,
  RunPlanHistoryCounts,
  RunPlanHistoryStrategy,
  RunPlanHistorySummaryRef,
  RunPlanTokenCounting,
} from "@agentorch/shared";

/** One piece of prior conversation, in the order it happened.
 *
 *  `text` is the VERBATIM content. A caller that pre-truncates has moved the
 *  silent truncation one layer up, where this module cannot report it. */
export interface HistoryTurn {
  seq: number | null;
  kind: "user" | "assistant" | "summary" | "interrupted" | "peer-source" | "subagent-final" | "system";
  text: string;
  /** Must survive the budget: the newest summary and the latest interrupted
   *  turn carry continuity that a budget calculation is not allowed to drop. */
  pinned?: boolean;
  /** Present on `kind: "summary"` turns — the ranged compact this text is. */
  summary?: RunPlanHistorySummaryRef;
  /** How many original messages this turn stands for (1 for a plain turn). */
  covers?: number;
}

export interface HistoryBudgetRequest {
  /** Chronological, oldest first. */
  turns: HistoryTurn[];
  systemPrompt: string | null;
  /** The actual tool schemas this turn carries, serialized. Counted because
   *  they are part of the same window and pretending otherwise overstates the
   *  budget — the exact error that made 18 000 chars "safe". */
  toolsText: string | null;
  /** This turn's own prompt (the user request plus any peer source / queued
   *  segment it carries). It occupies the same window, so leaving it out of the
   *  subtraction would hand the model a transcript that fits only if the turn
   *  itself were free. */
  turnPrompt?: string | null;
  context: RunPlanContext;
  strategy: RunPlanHistoryStrategy;
  strategyReason: string;
  /** Injected measurer. `null` = unmeasurable (no local tokenizer / it threw). */
  measure: (text: string) => number | null;
}

export interface HistoryBudgetOutcome {
  history: RunPlanHistory;
  /** What to actually hand the runtime, chronological. */
  included: HistoryTurn[];
}

/** The labelled conservative upper bound: tokens cannot exceed UTF-8 bytes for
 *  any BPE vocabulary in use here, so this over-counts rather than under-counts
 *  and can never make a transcript look smaller than it is. */
export function utf8TokenUpperBound(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface TokenMeasurer {
  count: (text: string) => number;
  counting: () => RunPlanTokenCounting;
  degradedReason: () => string | null;
}

/** Wrap a raw measurer into one that NEVER returns a silent zero.
 *
 *  `countTokens` in the local tokenizer returns 0 for "vocab file missing",
 *  "encoder threw" and "empty string" alike. Treating that 0 as a real count is
 *  how a 200K transcript would fit in a 1K budget; so a 0 for non-empty text is
 *  reported as unmeasurable and answered with the byte bound. */
export function makeTokenMeasurer(measure: (text: string) => number | null): TokenMeasurer {
  let degraded: string | null = null;
  return {
    count: (text: string): number => {
      if (!text) return 0;
      let raw: number | null = null;
      try {
        raw = measure(text);
      } catch (err) {
        degraded ??= `the local tokenizer threw (${err instanceof Error ? err.message : String(err)})`;
        raw = null;
      }
      if (raw === null || !Number.isFinite(raw) || raw <= 0) {
        degraded ??=
          raw === null || !Number.isFinite(raw)
            ? "the local tokenizer is unavailable for this model"
            : "the local tokenizer returned 0";
        return utf8TokenUpperBound(text);
      }
      return Math.ceil(raw);
    },
    counting: () => (degraded === null ? "exact" : "estimated"),
    degradedReason: () => degraded,
  };
}

const emptyCounts = (): RunPlanHistoryCounts => ({ included: 0, dropped: 0, summarized: 0 });

/** The plan field for a turn that supplied no history facts at all (a bare
 *  planner call). An explicit "unavailable" beats a zeroed structure that a
 *  reader could mistake for "the conversation is empty". */
export function unavailablePlanHistory(reason: string): RunPlanHistory {
  return {
    status: "unavailable",
    strategy: null,
    reason,
    tokenBudget: null,
    measuredTokens: null,
    actualIncludedTokens: 0,
    overBudget: false,
    counting: "unmeasured",
    counts: emptyCounts(),
    includedRanges: [],
    overflow: null,
    summaries: [],
    diagnostics: [reason],
  };
}

/** A share of the turn's usable window: (effective/advertised window − output
 *  reserve) × fraction, or `null` when no window was established.
 *
 *  This is the one place that arithmetic lives. A share of the REAL window is
 *  not a character constant, and two consumers deriving "their" share
 *  differently is how one of them ends up with room the other never had — the
 *  skills section and the inline-result budget are both sections of the same
 *  window. */
export function windowFractionBudget(
  context: RunPlanContext | null | undefined,
  fraction: number,
): number | null {
  if (!context) return null;
  const window = context.effectiveWindow;
  if (window === null) return null;
  return Math.max(0, Math.floor((window - (context.outputReserve ?? 0)) * fraction));
}

/** Assemble the turn's context from the newest content backwards. */
export function resolveHistoryBudget(req: HistoryBudgetRequest): HistoryBudgetOutcome {
  const measurer = makeTokenMeasurer(req.measure);
  const diagnostics: string[] = [`history strategy: ${req.strategy} (${req.strategyReason})`];

  const counts = req.turns.map((t) => measurer.count(t.text));
  const totalTokens = counts.reduce((sum, n) => sum + n, 0);

  const window = req.context.effectiveWindow;
  const systemTokens = req.systemPrompt ? measurer.count(req.systemPrompt) : 0;
  const toolTokens = req.toolsText ? measurer.count(req.toolsText) : 0;
  const turnTokens = req.turnPrompt ? measurer.count(req.turnPrompt) : 0;

  let tokenBudget: number | null = null;
  if (window === null) {
    diagnostics.push(
      "no context window was established for this route, so no history budget could be derived: " +
        "nothing was dropped on a guess",
    );
  } else {
    const reserve = req.context.outputReserve;
    if (reserve === null) {
      diagnostics.push("the output reservation is unknown for this route, so none was subtracted");
    }
    const derived = window - (reserve ?? 0) - systemTokens - toolTokens - turnTokens;
    diagnostics.push(
      `window ${window} − output reserve ${reserve ?? 0} − system prompt ${systemTokens} − tools ${toolTokens} ` +
        `− this turn's prompt ${turnTokens} = history budget ${derived}`,
    );
    // The user's own ceiling can only LOWER the budget: it is a wish about our
    // spending, not a claim about the model. Applying it as an upper bound is
    // the one reading under which it can never raise a transcript past the
    // window it has to fit in.
    const requested = req.context.contextBudget;
    tokenBudget = requested !== null && requested < derived ? requested : derived;
    if (requested !== null) {
      diagnostics.push(
        requested < derived
          ? `the configured history budget of ${requested} tokens is lower than the derived ${derived}, so it is the one applied`
          : `the configured history budget of ${requested} tokens does not raise the derived ${derived} — the window is the ceiling`,
      );
    }
    if (tokenBudget < 0) {
      diagnostics.push(
        "the window is already consumed by the system prompt, the tool schemas and this turn's prompt alone",
      );
    }
  }

  const includedIndexes = new Set<number>();
  let used = 0;
  // Pinned turns are counted first: they are the continuity of the
  // conversation, and a budget that would evict the summary explaining where
  // the conversation came from is a budget that loses the thread.
  for (let i = 0; i < req.turns.length; i++) {
    if (!req.turns[i]!.pinned) continue;
    includedIndexes.add(i);
    used += counts[i]!;
  }

  let firstExcluded = req.turns.length;
  if (tokenBudget !== null) {
    const budget = Math.max(0, tokenBudget);
    for (let i = req.turns.length - 1; i >= 0; i--) {
      if (includedIndexes.has(i)) continue;
      if (used + counts[i]! <= budget) {
        includedIndexes.add(i);
        used += counts[i]!;
        continue;
      }
      // The cut is CONTIGUOUS: everything older than the first turn that did
      // not fit is overflow too, even if it is small enough to fit. A hole in
      // the middle of the transcript would make the overflow range
      // un-describable, and there would be no honest seq range for the compact
      // path to cover.
      firstExcluded = i + 1;
      break;
    }
  } else if (tokenBudget === null) {
    // No window: include everything and say so. Dropping content against an
    // unknown ceiling would be a guess dressed as a limit.
    for (let i = 0; i < req.turns.length; i++) includedIndexes.add(i);
    used = totalTokens;
  }

  const included = req.turns.filter((_, i) => includedIndexes.has(i));
  const excluded = req.turns.slice(0, firstExcluded).filter((_, i) => !includedIndexes.has(i));

  const summaries: RunPlanHistorySummaryRef[] = [];
  let summarized = 0;
  for (const turn of included) {
    if (turn.summary) summaries.push(turn.summary);
    if (turn.kind === "summary") summarized += turn.covers ?? 0;
  }

  const includedRanges: Array<{ fromSeq: number; toSeq: number }> = [];
  let runStart: number | null = null;
  let runEnd: number | null = null;
  for (const turn of included) {
    if (turn.seq === null) continue;
    if (runStart === null) {
      runStart = turn.seq;
      runEnd = turn.seq;
      continue;
    }
    if (turn.seq === runEnd! + 1) {
      runEnd = turn.seq;
      continue;
    }
    includedRanges.push({ fromSeq: runStart, toSeq: runEnd! });
    runStart = turn.seq;
    runEnd = turn.seq;
  }
  if (runStart !== null) includedRanges.push({ fromSeq: runStart, toSeq: runEnd! });

  const overflowSeqs = excluded.map((t) => t.seq).filter((s): s is number => s !== null);
  const overflow =
    excluded.length === 0
      ? null
      : {
          fromSeq: overflowSeqs.length > 0 ? Math.min(...overflowSeqs) : 0,
          toSeq: overflowSeqs.length > 0 ? Math.max(...overflowSeqs) : 0,
          count: excluded.length,
        };
  if (overflow) {
    diagnostics.push(
      `${overflow.count} earlier turn(s) do not fit the budget (seq ${overflow.fromSeq}–${overflow.toSeq}); ` +
        "they are covered by the ranged compact path, not silently dropped",
    );
  }

  // What the turns actually being sent cost. `used` is the sum of the included
  // turns' counts, and it is NOT bounded by the budget: a pinned turn is counted
  // whatever the budget says. Reporting it (rather than only the budget) is what
  // makes "the transcript we are about to send does not fit" visible.
  const actualIncludedTokens = used;
  const overBudget = tokenBudget !== null && actualIncludedTokens > tokenBudget;
  if (tokenBudget !== null && overBudget) {
    const pinnedTokens = req.turns.reduce(
      (sum, t, i) => (t.pinned && includedIndexes.has(i) ? sum + counts[i]! : sum),
      0,
    );
    diagnostics.push(
      `the included history is ${actualIncludedTokens} tokens against a budget of ${tokenBudget} ` +
        `(${actualIncludedTokens - tokenBudget} over) — ${pinnedTokens} of those tokens are pinned continuity ` +
        "(the newest summary and the latest interrupted turn), which the budget may not evict; " +
        "the transcript must be re-summarized before this turn can be dispatched",
    );
  }

  const degraded = measurer.degradedReason();
  if (degraded) {
    diagnostics.push(
      `${degraded}; token numbers are the UTF-8 byte upper bound, reported as "estimated"`,
    );
  }

  return {
    included,
    history: {
      status: "resolved",
      strategy: req.strategy,
      reason: req.strategyReason,
      tokenBudget,
      measuredTokens: totalTokens,
      actualIncludedTokens,
      overBudget,
      counting: measurer.counting(),
      counts: {
        included: included.length,
        dropped: excluded.length,
        summarized,
      },
      includedRanges,
      overflow,
      summaries,
      diagnostics,
    },
  };
}
