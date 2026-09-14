// Static context-window fallback for runtimes that don't surface it in their
// result usage (OpenAI / Codex / third-party OpenAI-compat). Claude reports an
// authoritative contextWindow via the SDK, so this table is only consulted when
// a result carries 0 / no value.
//
// Values are per-model, NOT a single default — a 1M model and a 200K model must
// not share a window or the header percentage will be wrong. Every non-legacy
// value below was verified against the provider's official docs on 2026-09-11
// (sources inlined per section). Keys are matched case-insensitively.

export const CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  // ── OpenAI ──────────────────────────────────────────────────────────────
  // Source: https://platform.openai.com/docs/models/<id> ("context window")
  "gpt-5": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.6": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-cyber": 400_000,
  "gpt-6-astra": 1_050_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o3-mini": 200_000,

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  // Source: https://api-docs.deepseek.com/quick_start/pricing ("CONTEXT LENGTH 1M")
  "deepseek-flash": 1_000_000, // DeepSeek-V4.1-Flash
  "deepseek-v4-pro": 1_000_000, // DeepSeek-V4-Pro-0813
  // Legacy V3/R1-era API names kept in DEEPSEEK_OFFICIAL_MODELS for existing
  // agents; they are no longer documented on the current pricing page. Last
  // documented window for deepseek-chat (V3) / deepseek-reasoner (R1) was 64K.
  "deepseek-chat": 64_000,
  "deepseek-reasoner": 64_000,

  // ── MiniMax ─────────────────────────────────────────────────────────────
  // Source: https://platform.minimaxi.com/docs/api-reference/text-anthropic-api
  // ("上下文窗口" column: M2.x = 204,800; M3 = 1,000,000)
  "minimax-m2": 204_800,
  "minimax-m2.1": 204_800,
  "minimax-m2.1-highspeed": 204_800,
  "minimax-m2.5": 204_800,
  "minimax-m2.5-highspeed": 204_800,
  "minimax-m2.7": 204_800,
  "minimax-m2.7-highspeed": 204_800,
  "minimax-m3": 1_000_000,

  // ── Zhipu GLM ────────────────────────────────────────────────────────────
  // Current docs (https://docs.bigmodel.cn/cn/guide/models) list GLM-5.3 at
  // 1M context. The app preset still ships the glm-4.5 family, whose last
  // documented window was 128K.
  "glm-5.3": 1_000_000,
  "glm-5.3-flash": 1_000_000,
  "glm-4.5": 128_000,
  "glm-4.5-air": 128_000,
  "glm-4.5-flash": 128_000,
  "glm-4.5-x": 128_000,
};

/** Resolve a model's context window. A positive SDK-reported value wins
 *  (Claude), otherwise fall back to the static table. Returns null when the
 *  model is unknown so callers can hide the indicator instead of guessing. */
export function resolveContextWindow(model: string, reported?: number): number | null {
  if (reported && reported > 0) return reported;
  return CONTEXT_WINDOW_TOKENS[model.toLowerCase()] ?? null;
}
