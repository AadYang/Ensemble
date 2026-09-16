// Phase 0 replacement for the window read-back in `core/src/context-usage.ts`.
//
// WHY A REPLACEMENT: the shipped `reportedContextWindowFromResult()` falls back,
// on an exact-key miss, to "the only distinct positive window in the payload".
// That is still unsafe. Two DIFFERENT models can legitimately report the SAME
// window (a family shares a platform limit, or a fallback path bills two ids at
// 200k), and the set collapses to one element — so a result for model A gets
// attributed model B's window, silently, with no way for the bar to notice.
//
// The rule here is narrower and has to be:
//
//   1. Exact key hit                      → use it.
//   2. An explicit alias mapping          → use the mapped key.
//   3. EXACTLY ONE positive entry overall → use it (a single-model result whose
//      id the runtime renamed; there is nothing else it could mean).
//   4. Anything else                      → unknown.
//
// Case 4 is the important one. "Unknown" costs the bar a denominator; guessing
// costs the user a wrong ceiling and a wrong compaction decision, with no
// visible symptom. The first is recoverable, the second is not.
//
// This module is additive: it does not modify the frozen context-window batch.
// It is wired in when that batch is unfrozen, at which point the old function
// is deleted rather than left as a second, disagreeing reader.

import type { ResolvedCapability } from "./types.js";
import { unknownCapability } from "./types.js";

interface ModelUsageLike {
  contextWindow?: number;
}

interface ResultLike {
  modelUsage?: Record<string, ModelUsageLike | undefined> | null;
}

/** Alias map: the id the runtime reports → the id the caller asked for. Only
 *  explicit, known renames belong here; a fuzzy match is the guessing this
 *  function exists to prevent. */
export type ModelAliases = Readonly<Record<string, string>>;

export interface ReportedWindowOptions {
  aliases?: ModelAliases;
  /** Identifies the result the reading came from. Prepended to every `source`
   *  the resolver returns, including the unknown ones — "we could not attribute
   *  a window" is only actionable next to which result we looked at. */
  origin?: string;
}

export function reportedContextWindow(
  payload: ResultLike | null | undefined,
  model: string,
  opts: ReportedWindowOptions = {},
): ResolvedCapability<number> {
  // One prefix for every return path below, so the option is never silently
  // dropped on some of them (which is how it came to be unused entirely).
  const from = opts.origin ? `[${opts.origin}] ` : "";
  const usage = payload?.modelUsage ?? {};
  const keys = Object.keys(usage);
  const positive = (k: string): number | undefined => {
    const w = usage[k]?.contextWindow;
    return typeof w === "number" && w > 0 ? w : undefined;
  };

  // 1. The runtime keyed it exactly as we asked.
  const exact = positive(model);
  if (exact !== undefined) {
    return {
      value: exact,
      origin: "runtime-observed",
      confidence: "observed",
      source: `${from}the runtime reported modelUsage["${model}"].contextWindow`,
      considered: [{ origin: "runtime-observed", outcome: "used", reason: "exact model key" }],
    };
  }

  // 2. A rename we have been told about explicitly.
  const aliased = opts.aliases?.[model];
  if (aliased) {
    const value = positive(aliased);
    if (value !== undefined) {
      return {
        value,
        origin: "runtime-observed",
        confidence: "observed",
        source: `${from}the runtime reported the aliased key "${aliased}" for "${model}"`,
        considered: [
          { origin: "runtime-observed", outcome: "absent", reason: `no exact key "${model}"` },
          { origin: "runtime-observed", outcome: "used", reason: `explicit alias "${aliased}"` },
        ],
      };
    }
  }

  // 3. Exactly one positive window in the whole payload. Anything more is
  //    ambiguous even when the NUMBERS happen to agree — two ids reporting the
  //    same window are still two models.
  const positiveKeys = keys.filter((k) => positive(k) !== undefined);
  const considered = [
    {
      origin: "runtime-observed" as const,
      outcome: positiveKeys.length === 0 ? ("absent" as const) : ("rejected" as const),
      reason:
        positiveKeys.length === 0
          ? "the result carried no positive contextWindow"
          : `${positiveKeys.length} models reported a window (${positiveKeys.join(", ")}); ` +
            `attributing one of them to "${model}" would guess` +
            (aliased ? ` (alias "${aliased}" was also absent)` : ""),
    },
  ];
  if (positiveKeys.length === 1 && !aliased) {
    const value = positive(positiveKeys[0]!)!;
    return {
      value,
      origin: "runtime-observed",
      confidence: "observed",
      source: `${from}the only model in this result ("${positiveKeys[0]}") reported it`,
      considered,
    };
  }
  if (positiveKeys.length === 1 && aliased) {
    // An alias was configured but absent, and a single unrelated model reported
    // a window. Do not quietly use it: the alias is a statement about which id
    // belongs to which model, and the payload contradicts it.
    return unknownCapability(
      `${from}alias "${aliased}" was configured for "${model}" but absent from the result; ` +
        `the single other entry is not assumed to be it`,
      considered,
    );
  }

  return unknownCapability(
    `${from}no window can be attributed to "${model}" without guessing`,
    considered,
  );
}
