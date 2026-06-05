// W17 Slice 2: pricing table + cost computation.
//
// All providers — Claude and OpenAI alike — flow through this table. The
// Anthropic SDK's costUSD field is intentionally ignored: for third-party
// anthropic-compat upstreams (MiniMax / GLM via Claude protocol) it's
// computed using Anthropic's official rates and would be wildly off. The
// authoritative price source is `pricing.json` plus a per-user override
// file at `${appDataDir}/pricing-overrides.json`.
//
// Coverage decision (W17 v3 user pick): v1 ships Claude official + OpenAI
// official only. Anything else (DeepSeek, GLM, MiniMax, timicc, …) lands in
// the unknownModels bucket. Users with active third-party providers can
// supply rates via pricing-overrides.json without waiting for a release.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import builtInPricing from "./pricing.json" with { type: "json" };
import { ensureDataDir } from "./paths.js";

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read input tokens. Omitted = no cache discount. */
  cacheRead?: number;
  /** USD per 1M cache-creation input tokens. Omitted = same as `input`. */
  cacheWrite?: number;
  /** Free-form annotation; not used at runtime. */
  _source?: string;
}

export interface PricingTable {
  version: string;
  note?: string;
  models: Record<string, ModelPricing>;
}

const BUILT_IN: PricingTable = builtInPricing as PricingTable;

let cached: PricingTable | null = null;

export function pricingOverridesPath(): string {
  return join(ensureDataDir(), "pricing-overrides.json");
}

export function loadBuiltInPricingTable(): PricingTable {
  return BUILT_IN;
}

export function loadPricingOverrides(): Partial<PricingTable> {
  const overridesPath = pricingOverridesPath();
  if (!existsSync(overridesPath)) return { version: "user", models: {} };
  try {
    const raw = readFileSync(overridesPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PricingTable>;
    return {
      version: typeof parsed.version === "string" ? parsed.version : "user",
      note: typeof parsed.note === "string" ? parsed.note : undefined,
      models: parsed.models && typeof parsed.models === "object" ? parsed.models : {},
    };
  } catch (err) {
    console.warn(`[pricing] failed to read ${overridesPath}: ${(err as Error).message}`);
    return { version: "user", models: {} };
  }
}

export function savePricingOverride(model: string, pricing: ModelPricing): PricingTable {
  const overrides = loadPricingOverrides();
  const next: PricingTable = {
    version: typeof overrides.version === "string" ? overrides.version : "user",
    note: overrides.note,
    models: {
      ...(overrides.models ?? {}),
      [model]: pricing,
    },
  };
  writeFileSync(pricingOverridesPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  _resetPricingCache();
  return loadPricingTable();
}

export function deletePricingOverride(model: string): PricingTable {
  const overrides = loadPricingOverrides();
  const models = { ...(overrides.models ?? {}) };
  delete models[model];
  const next: PricingTable = {
    version: typeof overrides.version === "string" ? overrides.version : "user",
    note: overrides.note,
    models,
  };
  writeFileSync(pricingOverridesPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  _resetPricingCache();
  return loadPricingTable();
}

/** Merge the built-in table with the user's `pricing-overrides.json` if
 *  present. Shallow merge at the per-model key. Called once at the first
 *  pricing lookup and cached. */
export function loadPricingTable(): PricingTable {
  if (cached) return cached;
  const overridesPath = pricingOverridesPath();
  let merged: PricingTable = {
    version: BUILT_IN.version,
    note: BUILT_IN.note,
    models: { ...BUILT_IN.models },
  };
  if (existsSync(overridesPath)) {
    try {
      const raw = readFileSync(overridesPath, "utf8");
      const overrides = JSON.parse(raw) as Partial<PricingTable>;
      if (overrides.models && typeof overrides.models === "object") {
        merged.models = { ...merged.models, ...overrides.models };
      }
      if (typeof overrides.version === "string") {
        merged.version = `${BUILT_IN.version}+overrides@${overrides.version}`;
      }
    } catch (err) {
      // Don't crash on a malformed override file; just log and use built-ins.
      console.warn(`[pricing] failed to read ${overridesPath}: ${(err as Error).message}`);
    }
  }
  cached = merged;
  return cached;
}

/** Test hook: drop the memoized table so the next call re-reads from disk. */
export function _resetPricingCache(): void {
  cached = null;
}

export interface ModelUsageRecord {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface CostResult {
  /** USD. 0 when costKnown=false; otherwise the computed amount. */
  costUSD: number;
  /** false = model not in the pricing table (built-in or overrides). The
   *  caller should bucket this row under `unknownModels` and exclude it
   *  from the project-level total. */
  costKnown: boolean;
}

/** Compute the USD cost of a single model's per-turn usage record. Cache
 *  fields default to 0 when missing. */
export function computeCost(model: string, usage: ModelUsageRecord): CostResult {
  const table = loadPricingTable();
  const price = table.models[model];
  if (!price) return { costUSD: 0, costKnown: false };

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreate = usage.cacheCreationInputTokens ?? 0;

  // Anthropic-style accounting: when cache is in play, `inputTokens` reported
  // by the SDK already excludes the cached portion. We charge:
  //   - input: regular input tokens × input price
  //   - output: output tokens × output price
  //   - cacheRead: cache_read tokens × cacheRead price (falls back to input
  //                price * 0 if cacheRead unset — model just doesn't surface
  //                a discount)
  //   - cacheCreate: cache_creation tokens × cacheWrite price (falls back to
  //                  input price when cacheWrite unset)
  const usdInput = (input / 1_000_000) * price.input;
  const usdOutput = (output / 1_000_000) * price.output;
  const usdCacheRead = (cacheRead / 1_000_000) * (price.cacheRead ?? 0);
  const usdCacheCreate = (cacheCreate / 1_000_000) * (price.cacheWrite ?? price.input);

  return {
    costUSD: round6(usdInput + usdOutput + usdCacheRead + usdCacheCreate),
    costKnown: true,
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
