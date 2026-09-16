// W17 Slice 4: aggregation logic for the /api/usage/summary endpoint.
//
// Pure functions operating on raw UsageEvent rows + parameters. The route
// handler stays thin (parse params → SQL fetch → call this → return JSON).
//
// Day-bucket math runs in the user's timezone (passed as IANA name) using
// Intl.DateTimeFormat — SQLite has no timezone awareness beyond UTC + a
// hardcoded 'localtime' modifier, which doesn't generalize.

import type { UsageEvent } from "./db.js";

export interface AggregateOptions {
  /** IANA timezone name. Defaults to UTC if absent. */
  tz?: string;
  /** When true, byAgent rows accumulate their descendant subagents' rows. */
  includeDescendants?: boolean;
}

interface BucketTotals {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Local-tokenizer sums for the audit panel. Rows that didn't record local
   *  counts (claude / codex runtimes or older entries) contribute 0 — so a
   *  bucket with mixed sources will under-report local vs upstream. */
  inputTokensLocal: number;
  outputTokensLocal: number;
  /** Number of rows that DID contribute local counts (≥1 nonzero local
   *  field). Used by the UI to decide whether the bucket has enough audit
   *  data to be worth displaying a diff. */
  turnsWithLocal: number;
  turns: number;
  /** How many of `turns` had a price — i.e. are actually IN `costUSD`.
   *
   *  `costUSD` is a sum, and a sum of a subset is not a total. Every row is
   *  counted here that `computeCost` could price, INCLUDING flat-rate
   *  subscription rows (whose price is genuinely $0 per turn, by contract). */
  turnsCostKnown: number;
  /** How many of `turns` had NO price configured, and therefore contributed
   *  nothing to `costUSD`. Nonzero means `costUSD` is a LOWER BOUND and the
   *  surface showing it must say so — this is the field that makes "unpriced"
   *  distinguishable from "free", which a bare sum cannot express. */
  turnsCostUnknown: number;
  /** How many of `turns` are flat-rate (`billingModel === "subscription"`):
   *  counted in `turnsCostKnown`, but their $0 is a billing model, not a
   *  measurement, and a UI that shows it as $0.00 is claiming a saving it
   *  cannot see. */
  turnsSubscription: number;
}

const EMPTY_TOTALS = (): BucketTotals => ({
  costUSD: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  inputTokensLocal: 0,
  outputTokensLocal: 0,
  turnsWithLocal: 0,
  turns: 0,
  turnsCostKnown: 0,
  turnsCostUnknown: 0,
  turnsSubscription: 0,
});

// EVERY row lands in the token/turn counters. Only `costUSD` is conditional.
//
// Rows used to be partitioned by `costKnown` and only the priced half walked,
// which dropped 411 of the last 30 days' 2325 turns — and every token they
// billed, and the models and agents that ran them — out of totals, the daily
// chart, and all three tables. The unpriced rows were not "unknown" in the
// dimensions people read: `inputTokens` on a deepseek turn is as measured as
// on a priced one; it was the PRICE that was unknown. Keeping them out made
// the panel silently under-report and made the agents running those models
// vanish from the agent table entirely. Coverage is now carried alongside the
// sum (`turnsCostKnown` / `turnsCostUnknown`) so the display can be honest
// instead of the aggregation being lossy.
function addInto(target: BucketTotals, ev: UsageEvent): void {
  if (ev.costKnown) {
    target.costUSD += ev.costUSD;
    target.turnsCostKnown += 1;
    if (ev.billingModel === "subscription") target.turnsSubscription += 1;
  } else {
    target.turnsCostUnknown += 1;
  }
  target.inputTokens += ev.inputTokens;
  target.outputTokens += ev.outputTokens;
  target.cacheReadTokens += ev.cacheReadTokens;
  target.cacheCreationTokens += ev.cacheCreationTokens;
  target.inputTokensLocal += ev.inputTokensLocal;
  target.outputTokensLocal += ev.outputTokensLocal;
  if (ev.inputTokensLocal > 0 || ev.outputTokensLocal > 0) target.turnsWithLocal += 1;
  target.turns += 1;
}

function bucketDateKey(date: Date, tz: string): string {
  // Format as YYYY-MM-DD in the target timezone using Intl. This works
  // cross-locale because we feed `en-CA` which always emits ISO order.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    // Bad tz string → fall back to UTC.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
}

export interface AggregateResult {
  totals: BucketTotals & { agents: number };
  daily: Array<BucketTotals & {
    date: string;
    byProvider: Record<string, number>;
  }>;
  byAgent: Array<BucketTotals & {
    agentId: string | null;
    agentName: string;
    parentId: string | null;
    descendantIds?: string[];
  }>;
  byModel: Array<BucketTotals & { model: string }>;
  byProvider: Array<BucketTotals & {
    providerId: string | null;
    providerName: string;
    kind: string;
  }>;
  unknownModels: Array<{
    model: string;
    providerId: string | null;
    turns: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  topAgent: { agentId: string | null; agentName: string; costUSD: number } | null;
}

/** Aggregate a flat array of UsageEvent rows along the 4 dimensions the
 *  stats panel renders. Pure function — caller fetches rows and passes
 *  them in. */
export function aggregateUsage(rows: UsageEvent[], opts: AggregateOptions = {}): AggregateResult {
  const tz = opts.tz || "UTC";
  const includeDescendants = !!opts.includeDescendants;

  // Walk once. `unknown` collects the unpriced rows for the "no price
  // configured" list; it is NOT the set of rows that get counted.
  const unknown: UsageEvent[] = [];
  for (const r of rows) {
    if (!r.costKnown) unknown.push(r);
  }

  const totals = EMPTY_TOTALS();
  const dailyMap = new Map<string, BucketTotals & {
    byProvider: Record<string, number>;
  }>();
  const agentMap = new Map<string, BucketTotals & {
    agentId: string | null;
    agentName: string;
    parentId: string | null;
  }>();
  const modelMap = new Map<string, BucketTotals & { model: string }>();
  const providerMap = new Map<string, BucketTotals & {
    providerId: string | null;
    providerName: string;
    kind: string;
  }>();
  const agentsSeen = new Set<string>();

  for (const ev of rows) {
    addInto(totals, ev);
    if (ev.agentId) agentsSeen.add(ev.agentId);
    else agentsSeen.add(`__deleted__:${ev.agentName}`);

    // daily
    const dateKey = bucketDateKey(ev.createdAt, tz);
    const d = dailyMap.get(dateKey) ?? { ...EMPTY_TOTALS(), byProvider: {} };
    addInto(d, ev);
    // Priced rows only: an unpriced row has no cost to attribute to a kind.
    if (ev.costKnown) {
      d.byProvider[ev.providerKind] = (d.byProvider[ev.providerKind] ?? 0) + ev.costUSD;
    }
    dailyMap.set(dateKey, d);

    // byAgent (group key includes agentId or a snapshot fallback for deleted)
    const agentKey = ev.agentId ?? `__deleted__:${ev.agentName}`;
    const a = agentMap.get(agentKey) ?? {
      ...EMPTY_TOTALS(),
      agentId: ev.agentId,
      agentName: ev.agentName,
      parentId: ev.parentId,
    };
    addInto(a, ev);
    agentMap.set(agentKey, a);

    // byModel
    const m = modelMap.get(ev.model) ?? { ...EMPTY_TOTALS(), model: ev.model };
    addInto(m, ev);
    modelMap.set(ev.model, m);

    // byProvider
    const providerKey = ev.providerId ?? `__deleted__:${ev.providerName}`;
    const p = providerMap.get(providerKey) ?? {
      ...EMPTY_TOTALS(),
      providerId: ev.providerId,
      providerName: ev.providerName,
      kind: ev.providerKind,
    };
    addInto(p, ev);
    providerMap.set(providerKey, p);
  }

  // Cost first, then turns. On an all-subscription or all-unpriced history
  // every cost is 0, and "the top agent" has to fall back to who actually ran
  // the most work rather than to whichever row the Map happened to yield first.
  let byAgent = [...agentMap.values()].sort(
    (a, b) => b.costUSD - a.costUSD || b.turns - a.turns,
  );

  // Rollup descendants if requested.
  if (includeDescendants) {
    byAgent = rollupAgentDescendants(byAgent);
  }

  // unknownModels: collapse by (model, providerId)
  const unknownMap = new Map<string, {
    model: string;
    providerId: string | null;
    turns: number;
    inputTokens: number;
    outputTokens: number;
  }>();
  for (const ev of unknown) {
    const k = `${ev.model}__${ev.providerId ?? "_null_"}`;
    const u = unknownMap.get(k) ?? {
      model: ev.model,
      providerId: ev.providerId,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    u.turns += 1;
    u.inputTokens += ev.inputTokens;
    u.outputTokens += ev.outputTokens;
    unknownMap.set(k, u);
  }

  const topAgent = byAgent[0]
    ? { agentId: byAgent[0].agentId, agentName: byAgent[0].agentName, costUSD: byAgent[0].costUSD }
    : null;

  return {
    totals: { ...totals, agents: agentsSeen.size },
    daily: [...dailyMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date, ...v })),
    byAgent,
    byModel: [...modelMap.values()].sort((a, b) => b.costUSD - a.costUSD || b.turns - a.turns),
    byProvider: [...providerMap.values()].sort((a, b) => b.costUSD - a.costUSD || b.turns - a.turns),
    unknownModels: [...unknownMap.values()].sort((a, b) => b.turns - a.turns),
    topAgent,
  };
}

/** Build a parentId → children map and add each subagent's costs into its
 *  ancestor rows. Returns a new array — the input is mutated only on its
 *  cloned slots. descendantIds is populated for any ancestor that has at
 *  least one child in the input set. */
type AgentRow = BucketTotals & {
  agentId: string | null;
  agentName: string;
  parentId: string | null;
  descendantIds?: string[];
};

function rollupAgentDescendants(rows: AgentRow[]): AgentRow[] {
  // Clone so we don't mutate input. Use a mutable descendantIds slot which
  // we may clear back to undefined at the end for empties.
  const cloned: Array<AgentRow & { descendantIds: string[] }> = rows.map((r) => ({
    ...r,
    descendantIds: [],
  }));
  const byId = new Map<string, typeof cloned[number]>();
  for (const r of cloned) {
    if (r.agentId) byId.set(r.agentId, r);
  }

  // For each row with a parent in the set, walk up the chain adding to
  // every ancestor.
  for (const child of cloned) {
    if (!child.parentId || !child.agentId) continue;
    let cursor = byId.get(child.parentId);
    const seen = new Set<string>([child.agentId]);
    while (cursor && cursor.agentId && !seen.has(cursor.agentId)) {
      seen.add(cursor.agentId);
      cursor.costUSD += child.costUSD;
      cursor.inputTokens += child.inputTokens;
      cursor.outputTokens += child.outputTokens;
      cursor.cacheReadTokens += child.cacheReadTokens;
      cursor.cacheCreationTokens += child.cacheCreationTokens;
      cursor.inputTokensLocal += child.inputTokensLocal;
      cursor.outputTokensLocal += child.outputTokensLocal;
      cursor.turnsWithLocal += child.turnsWithLocal;
      cursor.turns += child.turns;
      cursor.turnsCostKnown += child.turnsCostKnown;
      cursor.turnsCostUnknown += child.turnsCostUnknown;
      cursor.turnsSubscription += child.turnsSubscription;
      cursor.descendantIds!.push(child.agentId);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }

  // Strip empty descendantIds arrays for cleaner JSON output.
  const finalized: AgentRow[] = cloned.map((r) => {
    if (r.descendantIds.length === 0) {
      const { descendantIds: _ignored, ...rest } = r;
      return rest;
    }
    return r;
  });
  return finalized.sort((a, b) => b.costUSD - a.costUSD || b.turns - a.turns);
}
