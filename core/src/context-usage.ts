// Compute a per-turn ContextUsage for the agent-pane context-fill indicator.
//
// The numerator is a LOCAL tokenizer count of the actual conversation text
// (system prompt + persisted message text), NOT the provider-reported
// `inputTokens + outputTokens + cacheRead + cacheCreation` sum.
//
// Why (verified against high-star open-source projects on 2026-09-14):
//   - LiteLLM counts tokens locally with tiktoken and treats the context window
//     as static model metadata (model_prices_and_context_window.json).
//   - OpenHands renders `min(100, per_turn_token / context_window)` where
//     `per_turn_token` is a backend "tokens in context" metric, not raw
//     provider usage; unknown windows render as raw counts, not a fake %.
//   - aider counts real chat + repo-map tokens locally with tiktoken.
//   None of them sums provider cache fields for a "how full is the window" bar.
//   Provider `usage` is billing data, and third-party Anthropic-compat upstreams
//   (DeepSeek) over-report `cache_read_input_tokens` (observed 2.83M on a 1M
//   window), which makes a provider-sum numerator garbage.
//
// The percentage is capped at 100 (OpenHands does `Math.min(100, …)`). The raw
// `usedTokens` is NOT clamped, so the tooltip can still show a truthful
// `used/window` when local counting slightly exceeds the window.
//
// When the local tokenizer is unavailable (vocab files missing) the count is 0
// and we return null → the UI shows "unknown" instead of a fabricated number.

import type { ContextUsage } from "@agentorch/shared";
import { resolveContextWindow } from "./context-window.js";
import { countTokensMany } from "./local-tokenizer.js";

interface ModelUsageEntry {
  contextWindow?: number;
}

interface ResultPayload {
  type?: string;
  modelUsage?: Record<string, ModelUsageEntry>;
}

/** Extract the SDK-reported context window for `model` from a result message,
 *  when present and positive. The Claude SDK provides an authoritative value;
 *  OpenAI/Codex write 0 and rely on the curated/static tables. */
export function reportedContextWindowFromResult(
  msg: unknown,
  model: string,
): number | undefined {
  const payload = msg as ResultPayload | null;
  if (!payload || payload.type !== "result") return undefined;
  const w = payload.modelUsage?.[model]?.contextWindow;
  return typeof w === "number" && w > 0 ? w : undefined;
}

/** Build a ContextUsage from locally-tokenized transcript text. */
export function contextUsageFromTranscript(
  model: string,
  reportedContextWindow: number | undefined,
  transcriptTexts: readonly string[],
): ContextUsage | null {
  const contextWindow = resolveContextWindow(model, reportedContextWindow);
  if (!contextWindow || contextWindow <= 0) return null;

  const usedTokens = countTokensMany(model, transcriptTexts);
  if (usedTokens <= 0) return null; // tokenizer unavailable → "unknown", not 0%

  return {
    usedTokens,
    contextWindow,
    percent: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
  };
}
