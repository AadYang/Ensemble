import { closeSync, openSync, readSync, statSync } from "node:fs";

// Context-bar data for a codex turn. `turn.completed.usage` (the snapshot
// above) is a CUMULATIVE thread total — verified monotonic across
// `_codexUsageSnapshot` rows of two live agents (5.18M → 5.35M → … → 12.1M
// input tokens) — so it can size the billing delta but never the prompt.
// The per-request number lives in the rollout file the CLI writes: the newest
// `event_msg / token_count` event carries `last_token_usage` for the last
// model request plus the `model_context_window` the backend declared.
//
// READ THIS BEFORE TRUSTING A WINDOW: the declared value is DEPENDENT ON WHAT
// WE ASKED FOR. Left on its default, codex declares 272,000 for `gpt-5.6-sol`
// (compacting at 258,400); once we declare the documented 1,050,000 it does not
// error — it clamps silently to 95% of its backend `max_context_window` and
// declares 828,400. So 258,400 is NOT "the codex window" and must not be
// recorded as one: it belongs to a different configuration.
//
// Whatever the rollout reports is the value this session is actually running
// under, so it is authoritative for the bar (highest priority in
// `effectiveWindow`) and is read back through
// `reportedContextWindowFromResult` → `sessionObserved`. The static
// `RUNTIME_WINDOW_PROFILES` entry is only a version-matched fallback for a
// session that has not produced a rollout yet.
export interface CodexTurnContext {
  /** Prompt size of the last request of the turn, cached prefix INCLUDED —
   *  codex's `last_token_usage.input_tokens` counts cached tokens as a subset,
   *  same as the OpenAI usage API. */
  promptTokens: number;
  /** Subset of `promptTokens` that was served from cache (billing only). */
  cachedInputTokens: number;
  /** Window the backend declared for this model, or null when the event
   *  didn't carry one. */
  contextWindow: number | null;
}

/**
 * Newest `token_count` event in a rollout file tail, or null when the tail
 * holds none. The tail read may start mid-line, so an unparseable first line
 * is expected and skipped rather than treated as an error.
 */
export function parseCodexTurnContextTail(tail: string): CodexTurnContext | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    // Cheap prefilter: a rollout is mostly conversation items, and JSON.parse
    // on every one of them is the only expensive part of this scan.
    if (!line.includes("token_count")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    const payload = (ev as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") continue;
    const info = (payload as { type?: unknown; info?: unknown }).info;
    if (!info || typeof info !== "object") continue;
    const last = (info as { last_token_usage?: unknown }).last_token_usage;
    if (!last || typeof last !== "object") continue;
    const promptTokens = asNonNegativeInteger((last as { input_tokens?: unknown }).input_tokens);
    if (promptTokens <= 0) continue;
    const window = asNonNegativeInteger(
      (info as { model_context_window?: unknown }).model_context_window,
    );
    return {
      promptTokens,
      cachedInputTokens: asNonNegativeInteger(
        (last as { cached_input_tokens?: unknown }).cached_input_tokens,
      ),
      contextWindow: window > 0 ? window : null,
    };
  }
  return null;
}

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

const ROLLOUT_TAIL_BYTES = 256 * 1024;

/** Read the newest turn context out of a codex rollout file. Only the tail is
 *  read: a long thread's rollout grows into the megabytes, and the event we
 *  need is always the last `token_count`. Returns null on any IO/parse failure
 *  — the caller then leaves the context bar to the local fallback count, since
 *  a missing indicator beats a fabricated one. */
export function readCodexTurnContext(rolloutPath: string): CodexTurnContext | null {
  if (!rolloutPath) return null;
  try {
    const size = statSync(rolloutPath).size;
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return null;
    const fd = openSync(rolloutPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      return parseCodexTurnContextTail(buffer.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
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
