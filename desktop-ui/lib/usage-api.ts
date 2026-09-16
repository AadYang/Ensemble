// W17 client: thin REST wrapper for /api/usage/summary.

export interface UsageBucket {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Local-tokenizer sums. 0 when no row in this bucket recorded local counts. */
  inputTokensLocal: number;
  outputTokensLocal: number;
  /** How many rows in this bucket contributed local counts (≥1 nonzero). */
  turnsWithLocal: number;
  turns: number;
  /** How many of `turns` are actually IN `costUSD` (priced, including
   *  flat-rate subscription turns whose price is genuinely $0). */
  turnsCostKnown: number;
  /** How many of `turns` have no price configured and contributed nothing to
   *  `costUSD` — so `costUSD` is a lower bound whenever this is > 0. */
  turnsCostUnknown: number;
  /** Flat-rate turns inside `turnsCostKnown`. Their $0 is a billing model, not
   *  a measurement. */
  turnsSubscription: number;
}

export interface UsageSummary {
  range: { since: string; until: string; tz: string };
  totals: UsageBucket & { agents: number };
  daily: Array<UsageBucket & { date: string; byProvider: Record<string, number> }>;
  byAgent: Array<UsageBucket & {
    agentId: string | null;
    agentName: string;
    parentId: string | null;
    descendantIds?: string[];
  }>;
  byModel: Array<UsageBucket & { model: string }>;
  byProvider: Array<UsageBucket & {
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

export async function fetchUsageSummary(params: {
  since?: string;
  until?: string;
  tz?: string;
  includeDescendants?: boolean;
}): Promise<UsageSummary> {
  const qs = new URLSearchParams();
  if (params.since) qs.set("since", params.since);
  if (params.until) qs.set("until", params.until);
  if (params.tz) qs.set("tz", params.tz);
  if (params.includeDescendants) qs.set("includeDescendants", "true");
  const url = `/api/usage/summary${qs.toString() ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchUsageSummary: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as UsageSummary;
}
