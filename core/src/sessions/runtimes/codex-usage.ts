export interface CodexUsageSnapshot {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface CodexUsageDelta {
  regularInputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

const asNonNegativeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
};

export function normalizeCodexUsageSnapshot(value: unknown): CodexUsageSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  return {
    input_tokens: asNonNegativeInteger(r.input_tokens),
    cached_input_tokens: asNonNegativeInteger(r.cached_input_tokens),
    output_tokens: asNonNegativeInteger(r.output_tokens),
    reasoning_output_tokens: asNonNegativeInteger(r.reasoning_output_tokens),
  };
}

export function readCodexUsageSnapshot(metadata: unknown): CodexUsageSnapshot | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return normalizeCodexUsageSnapshot((metadata as Record<string, unknown>).codexUsageSnapshot);
}

function monotonicDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

export function codexUsageSnapshotToDelta(
  current: CodexUsageSnapshot,
  previous: CodexUsageSnapshot | null,
): CodexUsageDelta {
  const inputDelta = monotonicDelta(current.input_tokens, previous?.input_tokens ?? 0);
  const cacheReadDelta = monotonicDelta(current.cached_input_tokens, previous?.cached_input_tokens ?? 0);
  const outputDelta = monotonicDelta(current.output_tokens, previous?.output_tokens ?? 0);
  const reasoningOutputDelta = monotonicDelta(
    current.reasoning_output_tokens,
    previous?.reasoning_output_tokens ?? 0,
  );
  return {
    regularInputTokens: Math.max(0, inputDelta - cacheReadDelta),
    outputTokens: outputDelta + reasoningOutputDelta,
    cacheReadInputTokens: cacheReadDelta,
    cacheCreationInputTokens: 0,
  };
}
