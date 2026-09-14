// Static context-window fallback for runtimes that don't surface it in their
// result usage (OpenAI / Codex / third-party OpenAI-compat). Claude reports an
// authoritative contextWindow via the SDK, so this table is only consulted when
// a result carries 0 / no value.
//
// Resolution order (highest priority first):
//   1. SDK-reported `contextWindow` (Claude) — authoritative.
//   2. Curated `CURATED_CONTEXT_WINDOW_TOKENS` — verified against provider docs
//      on 2026-09-11 for the models the app actually ships / newest families.
//   3. `context-windows.json` — a filtered LiteLLM snapshot (653 models) for
//      the long tail, refreshed via scripts/update-context-windows.mjs.
//   4. Per-user `context-window-overrides.json` in the app data dir — mirrors
//      the pricing.ts "built-in + override" pattern so users with third-party
//      model ids can fill in exact values without waiting for a release.
//
// Unknown models resolve to null so callers can hide the indicator instead of
// guessing. Keys are matched case-insensitively.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import builtInContextWindows from "./context-windows.json" with { type: "json" };
import { ensureDataDir } from "./paths.js";

export interface ModelContextWindow {
  /** Context window size (input tokens). */
  maxInputTokens: number;
  /** Max output tokens. Not used for the % bar, kept for completeness. */
  maxOutputTokens?: number;
  _source?: string;
}

export interface ContextWindowTable {
  version: string;
  note?: string;
  models: Record<string, ModelContextWindow>;
}

/** Curated windows for the models the app ships by default and the newest
 *  families. These override the LiteLLM snapshot because they were verified
 *  against provider docs more recently than the snapshot's refresh cadence. */
export const CURATED_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
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

const BUILT_IN: ContextWindowTable = builtInContextWindows as ContextWindowTable;

let cached: ContextWindowTable | null = null;

export function contextWindowOverridesPath(): string {
  return join(ensureDataDir(), "context-window-overrides.json");
}

/** Merge the LiteLLM snapshot, the curated table, and the user's
 *  `context-window-overrides.json`. Priority: user > curated > snapshot.
 *  Memoized; call `_resetContextWindowCache` in tests. */
export function loadContextWindowTable(): ContextWindowTable {
  if (cached) return cached;
  const overridesPath = contextWindowOverridesPath();
  const models: Record<string, ModelContextWindow> = { ...BUILT_IN.models };

  for (const [model, maxInputTokens] of Object.entries(CURATED_CONTEXT_WINDOW_TOKENS)) {
    models[model] = { ...models[model], maxInputTokens };
  }

  const merged: ContextWindowTable = {
    version: BUILT_IN.version,
    note: BUILT_IN.note,
    models,
  };

  if (existsSync(overridesPath)) {
    try {
      const raw = readFileSync(overridesPath, "utf8");
      const overrides = JSON.parse(raw) as Partial<ContextWindowTable>;
      if (overrides.models && typeof overrides.models === "object") {
        merged.models = { ...merged.models, ...overrides.models };
      }
      if (typeof overrides.version === "string") {
        merged.version = `${BUILT_IN.version}+overrides@${overrides.version}`;
      }
    } catch (err) {
      // Malformed override must not crash the run — log and use built-ins.
      console.warn(`[context-window] failed to read ${overridesPath}: ${(err as Error).message}`);
    }
  }

  cached = merged;
  return cached;
}

/** Test hook: drop the memoized table so the next call re-reads from disk. */
export function _resetContextWindowCache(): void {
  cached = null;
}

function lookupModelWindow(model: string): number | null {
  const entry =
    loadContextWindowTable().models[model] ??
    loadContextWindowTable().models[model.toLowerCase()];
  if (entry && typeof entry.maxInputTokens === "number" && entry.maxInputTokens > 0) {
    return entry.maxInputTokens;
  }
  return null;
}

/** Look up a curated (verified-against-docs) window only. Curated covers
 *  third-party / OpenAI models the app ships; Claude-native models are
 *  intentionally absent so their SDK-reported window keeps priority. */
function lookupCuratedWindow(model: string): number | null {
  const v =
    CURATED_CONTEXT_WINDOW_TOKENS[model] ??
    CURATED_CONTEXT_WINDOW_TOKENS[model.toLowerCase()];
  return typeof v === "number" && v > 0 ? v : null;
}

/** Resolve a model's context window. Priority:
 *   1. Curated table (verified third-party/OpenAI windows) — must win over the
 *      Claude SDK's `contextWindow`, which is a Claude default (≈200k) for
 *      third-party anthropic-compat models like deepseek-v4-pro / glm / minimax
 *      and not the real window.
 *   2. SDK-reported value (authoritative for Claude-native models, which are
 *      absent from the curated table).
 *   3. Merged table (LiteLLM snapshot + user overrides) as last resort.
 *  Returns null when unknown so callers can hide the indicator instead of
 *  guessing. */
export function resolveContextWindow(model: string, reported?: number): number | null {
  const curated = lookupCuratedWindow(model);
  if (curated) return curated;
  if (reported && reported > 0) return reported;
  return lookupModelWindow(model);
}
