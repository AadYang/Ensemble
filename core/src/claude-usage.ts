// Claude CLI `result.modelUsage` is not a stable unit: official Claude
// reports the current query, while some anthropic-compat resume sessions
// (DeepSeek) dump session-lifetime totals. Billing must delta the latter
// the same way Codex already deltas `_codexUsageSnapshot`. Message payloads
// keep the raw map; UsageEvent gets the billed counters.

export const CLAUDE_USAGE_SNAPSHOT_KEY = "claudeUsageSnapshot";

export interface ClaudeUsageCounters {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ClaudeUsageSnapshot {
  sessionId: string | null;
  models: Record<string, ClaudeUsageCounters>;
}

const asNonNegativeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
};

export function isClaudeUsageRuntime(providerKind: string): boolean {
  return providerKind === "anthropic-local" || providerKind === "anthropic";
}

export function normalizeClaudeUsageCounters(value: unknown): ClaudeUsageCounters | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  return {
    inputTokens: asNonNegativeInteger(r.inputTokens),
    outputTokens: asNonNegativeInteger(r.outputTokens),
    cacheReadInputTokens: asNonNegativeInteger(r.cacheReadInputTokens),
    cacheCreationInputTokens: asNonNegativeInteger(r.cacheCreationInputTokens),
  };
}

export function readClaudeUsageSnapshot(metadata: unknown): ClaudeUsageSnapshot | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[CLAUDE_USAGE_SNAPSHOT_KEY];
  return normalizeClaudeUsageSnapshot(raw);
}

export function normalizeClaudeUsageSnapshot(value: unknown): ClaudeUsageSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const sessionId = typeof r.sessionId === "string" && r.sessionId.length > 0 ? r.sessionId : null;
  const modelsRaw = r.models;
  if (!modelsRaw || typeof modelsRaw !== "object" || Array.isArray(modelsRaw)) return null;
  const models: Record<string, ClaudeUsageCounters> = {};
  for (const [id, usage] of Object.entries(modelsRaw as Record<string, unknown>)) {
    const counters = normalizeClaudeUsageCounters(usage);
    if (counters) models[id] = counters;
  }
  return { sessionId, models };
}

type CountersRelation = "equal" | "cumulative" | "independent";

function countersRelation(current: ClaudeUsageCounters, previous: ClaudeUsageCounters): CountersRelation {
  if (
    current.inputTokens === previous.inputTokens &&
    current.outputTokens === previous.outputTokens &&
    current.cacheReadInputTokens === previous.cacheReadInputTokens &&
    current.cacheCreationInputTokens === previous.cacheCreationInputTokens
  ) {
    return "equal";
  }
  if (
    current.inputTokens >= previous.inputTokens &&
    current.outputTokens >= previous.outputTokens &&
    current.cacheReadInputTokens >= previous.cacheReadInputTokens &&
    current.cacheCreationInputTokens >= previous.cacheCreationInputTokens
  ) {
    return "cumulative";
  }
  return "independent";
}

function subtractCounters(current: ClaudeUsageCounters, previous: ClaudeUsageCounters): ClaudeUsageCounters {
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    cacheReadInputTokens: current.cacheReadInputTokens - previous.cacheReadInputTokens,
    cacheCreationInputTokens: current.cacheCreationInputTokens - previous.cacheCreationInputTokens,
  };
}

/** Same CLI session + every overlapping model is non-decreasing → per-turn
 *  delta. Any drop (official Claude per-query reports) → use the raw map. */
export function claudeModelUsageForBilling(
  rawModels: Record<string, ClaudeUsageCounters>,
  previous: ClaudeUsageSnapshot | null,
  sessionId: string | null,
): Record<string, ClaudeUsageCounters> {
  if (!previous || !previous.sessionId || !sessionId || previous.sessionId !== sessionId) {
    return rawModels;
  }
  for (const [id, current] of Object.entries(rawModels)) {
    const prev = previous.models[id];
    if (!prev) continue;
    if (countersRelation(current, prev) === "independent") return rawModels;
  }
  const billed: Record<string, ClaudeUsageCounters> = {};
  for (const [id, current] of Object.entries(rawModels)) {
    const prev = previous.models[id];
    billed[id] = prev ? subtractCounters(current, prev) : current;
  }
  return billed;
}

export function resultWithBillableClaudeUsage(
  message: unknown,
  previous: ClaudeUsageSnapshot | null,
): { message: unknown; snapshot: ClaudeUsageSnapshot | null } {
  if (!message || typeof message !== "object") return { message, snapshot: null };
  const m = message as Record<string, unknown>;
  if (m.type !== "result") return { message, snapshot: null };
  const usageRaw = m.modelUsage;
  if (!usageRaw || typeof usageRaw !== "object" || Array.isArray(usageRaw)) {
    return { message, snapshot: null };
  }
  const originals = usageRaw as Record<string, unknown>;
  const rawModels: Record<string, ClaudeUsageCounters> = {};
  for (const [id, usage] of Object.entries(originals)) {
    const counters = normalizeClaudeUsageCounters(usage);
    if (counters) rawModels[id] = counters;
  }
  if (Object.keys(rawModels).length === 0) return { message, snapshot: null };

  const sessionId = typeof m.session_id === "string" && m.session_id.length > 0 ? m.session_id : null;
  const billed = claudeModelUsageForBilling(rawModels, previous, sessionId);
  const billedUsage: Record<string, unknown> = {};
  for (const [id, counters] of Object.entries(billed)) {
    const orig = originals[id];
    billedUsage[id] =
      orig && typeof orig === "object" && !Array.isArray(orig)
        ? { ...(orig as Record<string, unknown>), ...counters }
        : counters;
  }
  return {
    message: { ...m, modelUsage: billedUsage },
    snapshot: { sessionId, models: rawModels },
  };
}

export function billableResultForUsageAccounting(
  message: unknown,
  metadata: unknown,
  providerKind: string,
): { message: unknown; snapshot: ClaudeUsageSnapshot | null } {
  if (!isClaudeUsageRuntime(providerKind)) return { message, snapshot: null };
  return resultWithBillableClaudeUsage(message, readClaudeUsageSnapshot(metadata));
}
