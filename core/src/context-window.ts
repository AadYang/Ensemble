// Context-window FACTS, in separate layers — because "the context window" is
// not one number, and collapsing it into one field is what made the bar lie.
//
// THE LAYERS (each has one owner, one job, and one SCOPE):
//
//   A. CATALOG — `MODEL_CATALOG`, keyed by `vendor/model`.
//      The vendor's documented capacity for the MODEL ITSELF. It is a fact
//      about the model, so it is the same wherever the model runs — but the
//      vendor is part of the key because the same id can be served by the
//      vendor's own endpoint or re-exposed by a compatible gateway, and a
//      gateway is free to serve a different effective model under the same
//      name. Fields:
//        • `advertisedContextWindow` — the vendor's OFFICIAL CONTEXT WINDOW.
//          Note this is the vendor's context-window figure, NOT "max input
//          tokens": max input, total context, and max output are three
//          different published quantities and must not be conflated.
//        • `maxOutputTokens` — the vendor's published output cap, where one is
//          actually documented. Absent means "not verified", never a guess.
//
//   B. RUNTIME PROFILE — `RUNTIME_WINDOW_PROFILES`, keyed by
//      `runtime/vendor/model` and matched on `runtimeVersion`.
//      What a specific runtime actually ENFORCES: `runtimeEffectiveWindow`
//      (the real usable ceiling after the runtime clamps it) and
//      `compactionThreshold` (where it throws context away). This is OBSERVED,
//      so it carries the runtime/CLI version, the date, and — critically —
//      `measuredUnder`, the configuration condition the number came from.
//      Two numbers measured under different conditions must never be stitched
//      into one record (see the gpt-5.6-sol entry).
//
//   C. OVERRIDES — a per-user `context-window-overrides.json` in the app data
//      dir, field-scoped and scope-aware. The legacy pre-scope shape
//      (`models.<id>.maxInputTokens`) is still READ, migrated into the catalog
//      layer as `legacy` display-only facts, and reported with a warning —
//      silently ignoring it would be a silent behaviour change. A legacy entry
//      outranks our built-in catalog for DISPLAY (the user's number used to
//      take effect and must keep doing so) but is barred from policy: it is
//      never declared, and — because skipping it in the policy path would be
//      just as wrong — it does not suppress a confirmed declaration either.
//
// WHY LAYER B CANNOT BE DERIVED FROM LAYER A. Measured on this machine:
//   • Codex advertises gpt-5.6-sol at context_window 272,000 and compacts at
//     258,400 (95%); its own backend exposes max_context_window 872,000, and its
//     binary bundles a third copy (272000/400000/1.05M strings). When we declare
//     the documented 1.05M it does not error — it CLAMPS silently to 95% of
//     872,000 = 828,400. So "the model is 1.05M" and "you have 828.4K usable
//     right now" are both true, and only one of them can be a progress bar.
//   • Claude Code has no row for anthropic-compat models (deepseek / glm /
//     minimax) and falls back to "≈200k for an unrecognized model", enforcing it
//     by auto-compacting at ~85%. Measured on a `deepseek-flash` agent: six
//     compactions at 167k–172k `pre_tokens`, ~1.1M tokens of context dropped for
//     nothing.
//
// THE RESOLUTION RULE (one per field, never one for "the window"):
//
//   advertisedWindow(model, vendor)   catalog override > catalog > LiteLLM
//                                     snapshot, where the snapshot is
//                                     `unverified` and only ever a DISPLAY
//                                     fallback.
//   effectiveWindow(model, scope)     session-observed > version-matched runtime
//                                     profile > **null**. It never falls back to
//                                     the advertised value: an unknown ceiling is
//                                     shown as unknown, not disguised as headroom.
//   compactionThreshold(model, scope) version-matched runtime profile > null.
//                                     Unknown means "do not set the env var" —
//                                     the runtime keeps its own policy.
//
// THE DISPLAY RULE: the bar's denominator is `effectiveWindow` only. The
// advertised value is shown BESIDE it ("Codex 可用 828.4K · 模型官方上限 1.05M"),
// never substituted for it — including in the unknown-ceiling state, which must
// still surface the advertised figure it does know.
//
// THE POLICY RULE (separate from display, on purpose — reading facts must not
// write config): `requestedRuntimeWindow(model, scope)` is the only thing a
// runtime may declare, and it returns a value ONLY when the catalog value is
// `confirmed` AND that runtime's config key has verified semantics. An
// unverified / legacy / family-analogy number must never reach a config file.
//
// `REVIEWED_SNAPSHOT_DISAGREEMENTS` records every case where a confirmed catalog
// value intentionally differs from the vendored LiteLLM snapshot, with the
// reason. core/src/__tests__/context-window.test.ts fails on an unacknowledged
// (or newly-agreeing, i.e. stale) entry. Keys match case-insensitively.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isReasoningToken } from "@agentorch/shared";
import type { ContextWindowConfidence } from "@agentorch/shared";
import builtInContextWindows from "./context-windows.json" with { type: "json" };
import { ensureDataDir } from "./paths.js";

/** How much a catalog number can be trusted. Only `confirmed` may drive policy
 *  (a runtime declaration) or stand in for a denominator. `legacy` marks a
 *  value migrated out of the pre-scope override file: it is the user's own
 *  number, but we never verified it, so it is display-only.
 *
 *  The union itself lives in `@agentorch/shared` because the UI must label these
 *  values too; one definition keeps core and the protocol from drifting. */
export type WindowConfidence = ContextWindowConfidence;

/** Layer A: the model's documented capacity. A fact about the MODEL (scoped to
 *  its vendor), never about a runtime. */
export interface ModelCatalogEntry {
  /** The vendor's OFFICIAL CONTEXT WINDOW. This is the vendor's context-window
   *  figure — NOT "max input tokens". Max input, total context, and max output
   *  are different published quantities. Display-only fallback; never the live
   *  bar. */
  advertisedContextWindow: number;
  /** The vendor's published MAX OUTPUT cap, where one is documented. Omitted
   *  when we have not verified one — an absent value is honest, a guessed one
   *  is not. Not used to derive a compaction threshold. */
  maxOutputTokens?: number;
  /** The model's reasoning/effort ladder, as the vendor serves it. OPEN
   *  strings, because the set is a per-model fact: gpt-6-astra lists `ultra`,
   *  which no closed enum in this codebase could represent. Omitted when we
   *  have no evidence — an absent ladder is honest, and the planner then treats
   *  a syntactically valid token as user-declared/unverified instead of
   *  claiming it is supported. */
  reasoningLevels?: readonly string[];
  /** The level the vendor marks as default for this model. Only meaningful
   *  alongside `reasoningLevels`, and only reported when it is one of them. */
  defaultReasoningLevel?: string;
  /** Where the LADDER came from, when that is not the same evidence as the
   *  window's `source`. The two are different facts with different origins: a
   *  vendor's model page states a context window, while the ladder was read off
   *  the vendor's model list. Reporting one provenance for both would put a
   *  citation on a value that citation never covered. */
  reasoningSource?: string;
  /** Confidence of the LADDER, when it is not the same rung as the window.
   *  Omitted = reuse `confidence`. */
  reasoningConfidence?: WindowConfidence;
  /** Provider doc URL, or who/where the value was confirmed. */
  source: string;
  /** ISO date this value was last checked against `source`. */
  verifiedAt: string;
  confidence: WindowConfidence;
}

/** Layer B: what one runtime actually enforces for one model. Observed, so it
 *  carries the version it was observed on, the date, and the exact
 *  configuration condition it was measured under. */
export interface RuntimeWindowProfile {
  /** The real usable ceiling after the runtime's own clamping. */
  runtimeEffectiveWindow: number | null;
  /** Where the runtime compacts/throws context away, measured UNDER THE SAME
   *  CONFIGURATION as `runtimeEffectiveWindow`. `null` when we have not
   *  measured it under that condition — do not source it from a different
   *  experiment. */
  compactionThreshold: number | null;
  /** Runtime/CLI version this was observed on. `null` = unversioned, which
   *  makes the value unusable for a versioned caller (see `profileFor`). */
  runtimeVersion: string | null;
  observedAt: string;
  /** The configuration condition the numbers describe. Required so a later
   *  reader can tell whether two numbers may live in one record. */
  measuredUnder: string;
  source: string;
}

/** Layer C: the user's override file. Field-scoped AND scope-aware. */
export interface ContextWindowOverrides {
  version?: string;
  /** Keyed by `vendor/model` (case-insensitive). */
  catalog?: Record<string, Partial<ModelCatalogEntry>>;
  /** Keyed by `runtime/vendor/model` (case-insensitive). */
  runtime?: Record<string, Partial<RuntimeWindowProfile>>;
  /** LEGACY (pre-scope) shape: `models.<modelId>.maxInputTokens`. Read for
   *  backwards compatibility and migrated into the catalog layer as
   *  `legacy`/display-only. */
  models?: Record<string, { maxInputTokens?: number; maxOutputTokens?: number }>;
}

/** Which runtime + which model-vendor scope a fact belongs to. */
export interface WindowScope {
  /** Runtime id: "claude" | "openai" | "codex". */
  runtime: string;
  /** Model-vendor scope: "openai" | "anthropic" | "deepseek" | "minimax" |
   *  "zhipu" | "unknown". Part of the key so the same model id served by the
   *  vendor and by a compatible gateway cannot cross-contaminate. */
  vendor: string;
  /** Runtime/CLI version, when known. Required for a profile to apply. */
  runtimeVersion?: string | null;
  /** The configured provider row this agent runs through, when known. Two
   *  openai-compat providers can expose the same model id with different real
   *  limits, so an OVERRIDE may be pinned to one provider
   *  (`<runtime>/<vendor>/<model>#<providerId>`); the pinned key wins over the
   *  broad one. Built-in values stay provider-agnostic on purpose — a vendor's
   *  documented capacity and a CLI's observed clamp are facts about the model
   *  and the runtime build, not about one of our provider rows. */
  providerId?: string | null;
}

/** An effective (live) window plus where it came from, so the UI can say
 *  "measured" vs "unknown" instead of inventing a number. */
export interface EffectiveWindow {
  tokens: number;
  origin: "session-observed" | "runtime-profile";
  runtimeVersion: string | null;
  observedAt: string | null;
  /** True when the runtime is known to clamp our declared value — i.e. this
   *  number is smaller than what we asked for. */
  clamped: boolean;
}

/** Which runtimes can be DECLARED a context window, and with what semantics.
 *  `verified` means we have confirmed the config key's meaning against the
 *  installed binary; anything else must not be written. */
export const RUNTIME_DECLARES_WINDOW: Record<
  string,
  { verified: boolean; keys: readonly string[]; note: string }
> = {
  claude: {
    verified: true,
    keys: ["CLAUDE_CODE_MAX_CONTEXT_TOKENS"],
    note:
      "Capacity declaration only. CLAUDE_CODE_AUTO_COMPACT_WINDOW is a POLICY " +
      "knob and is deliberately NOT set from the catalog — see claude.ts.",
  },
  openai: {
    verified: false,
    keys: [],
    note:
      "The in-process OpenAI runtime reads its window from the provider's own " +
      "response; we have not verified a config key for it, so we declare " +
      "nothing and the session observation is the only source.",
  },
  codex: {
    verified: true,
    keys: ["model_context_window"],
    note:
      "Accepted, but the backend clamps silently to 95% of max_context_window " +
      "(1.05M requested → 828,400 effective for gpt-5.6-sol). The clamp result " +
      "is read back from the rollout as a session observation; the bar follows " +
      "that, not the requested value.",
  },
};

/** Map a provider kind (the app's own vocabulary) onto the runtime id used as
 *  the profile scope key. Every kind in PROVIDER_KINDS must appear here — a
 *  missing case would silently hand one runtime another runtime's identity. */
export function runtimeIdForProviderKind(kind: string | null | undefined): string {
  switch (kind) {
    case "openai-codex":
      return "codex";
    case "openai-local":
    case "openai-compat":
      return "openai";
    case "anthropic":
    case "anthropic-local":
      return "claude";
    default:
      return "claude";
  }
}

/** The model-vendor scope for a model id. Vendor docs describe a model, so the
 *  scope follows the id's family; a runtime observation additionally carries
 *  the runtime, so the two can never be confused. Unknown families stay
 *  "unknown" rather than being attributed to a vendor we cannot prove. */
export function vendorScopeForModel(model: string | null | undefined): string {
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return "unknown";
  if (/^(gpt-|o1|o3|o4|chatgpt)/.test(m)) return "openai";
  if (/^claude-/.test(m)) return "anthropic";
  if (/^deepseek/.test(m)) return "deepseek";
  if (/^minimax/.test(m)) return "minimax";
  if (/^glm-/.test(m)) return "zhipu";
  return "unknown";
}

/** Build the scope used to look up facts for a bound agent. */
export function scopeForAgent(
  model: string | null | undefined,
  providerKind: string | null | undefined,
  runtimeVersion?: string | null,
  providerId?: string | null,
): WindowScope {
  return {
    runtime: runtimeIdForProviderKind(providerKind),
    vendor: vendorScopeForModel(model),
    runtimeVersion: runtimeVersion ?? null,
    providerId: providerId ?? null,
  };
}

/** Per-model doc page. Each OpenAI entry cites ITS OWN page rather than a
 *  shared index: "the family is 1.05M" is an analogy, "/models/gpt-5.6-luna
 *  says 1,050,000" is a citation. Verified 2026-09-15. */
const openaiDoc = (id: string) => `https://developers.openai.com/api/docs/models/${id}`;
const DEEPSEEK_PRICING_DOC = "https://api-docs.deepseek.com/quick_start/pricing";
const DEEPSEEK_THINKING_DOC = "https://api-docs.deepseek.com/guides/thinking_mode";
const ANTHROPIC_EFFORT_DOC = "https://platform.claude.com/docs/en/build-with-claude/effort";
const MINIMAX_DOC = "https://platform.minimaxi.com/docs/api-reference/text-anthropic-api";
const GLM_DOC = "https://docs.bigmodel.cn/cn/guide/models";

/** Where the reasoning ladders below come from: the VENDOR's own model list, as
 *  served to the Codex CLI and cached on this machine. It is the only source in
 *  this repository that states, per model, which efforts exist — the published
 *  model pages we cite for context windows do not enumerate them. Recorded with
 *  its fetch date and client version because it is a snapshot, not a document:
 *  a level can be added upstream without any page changing.
 *
 *  Scoped to `vendor/model` like every other catalog field. The ladder belongs
 *  to the model, not to the runtime that happened to report it: the Codex CLI
 *  asks the vendor's model endpoint, so `openai/gpt-5.6-sol` is the right key
 *  even though the observation arrived through a native CLI. */
const CODEX_MODEL_CATALOG_SOURCE =
  "OpenAI model list served to codex CLI 0.154.0 (model catalog cached 2026-09-15)";

const key = (vendor: string, model: string): string => `${vendor}/${model}`.toLowerCase();

/** Layer A — the documented capacities, keyed `vendor/model`. `confirmed` means
 *  the value was checked against the named source (or explicitly confirmed by
 *  the owner); anything derived by family analogy is `family-analogy` and is
 *  barred from policy. */
export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = {
  // ── OpenAI (`openai/*`) ─────────────────────────────────────────────────
  // Every entry below was read off its OWN model page on 2026-09-15 (context
  // window AND max output tokens are printed side by side there). The gpt-5.6
  // family and gpt-6-astra were previously carried as `family-analogy` because
  // only a family-level figure was known; the individual pages exist, so they
  // are now cited individually and may drive a runtime declaration. The vendor
  // index currently lists exactly these five gpt-5.x/gpt-6 ids.
  [key("openai", "gpt-5")]: {
    advertisedContextWindow: 400_000,
    maxOutputTokens: 128_000,
    source: openaiDoc("gpt-5"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
  },
  [key("openai", "gpt-5.2")]: {
    advertisedContextWindow: 400_000,
    maxOutputTokens: 128_000,
    source: openaiDoc("gpt-5.2"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
  },
  [key("openai", "gpt-5.4")]: {
    advertisedContextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    source: openaiDoc("gpt-5.4"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
  },
  // ── reasoning ladders ───────────────────────────────────────────────
  // Only the models whose vendor-served ladder we actually have are listed.
  // A model without `reasoningLevels` stays unknown: the planner then accepts a
  // syntactically valid token as user-declared rather than inventing a set.
  // Note what the real data says — `ultra` exists, and `minimal` appears
  // nowhere on the OpenAI list, which is the whole argument against a closed
  // enum shared by six files.
  [key("openai", "gpt-5.5")]: {
    advertisedContextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    source: openaiDoc("gpt-5.5"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
    reasoningLevels: ["low", "medium", "high", "xhigh"],
    defaultReasoningLevel: "medium",
    reasoningSource: CODEX_MODEL_CATALOG_SOURCE,
  },
  // Bare `gpt-5.6` is an alias: the vendor's own page 301s to /gpt-5.6-sol, so
  // it resolves to the same documented model rather than being a family guess.
  [key("openai", "gpt-5.6")]: {
    advertisedContextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    source: `${openaiDoc("gpt-5.6")} (301 → /gpt-5.6-sol)`,
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
    // The alias resolves to gpt-5.6-sol for the window above, so it carries
    // that model's ladder too. Nothing is extrapolated: it is one model id
    // under two spellings, which this entry already asserts for the window.
    reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningLevel: "low",
    reasoningSource: CODEX_MODEL_CATALOG_SOURCE,
  },
  [key("openai", "gpt-5.6-sol")]: {
    advertisedContextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    source: openaiDoc("gpt-5.6-sol"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningLevel: "low",
    reasoningSource: CODEX_MODEL_CATALOG_SOURCE,
  },
  [key("openai", "gpt-5.6-terra")]: {
    advertisedContextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    source: openaiDoc("gpt-5.6-terra"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningLevel: "medium",
    reasoningSource: CODEX_MODEL_CATALOG_SOURCE,
  },
  [key("openai", "gpt-5.6-luna")]: {
    advertisedContextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    source: openaiDoc("gpt-5.6-luna"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningLevel: "medium",
    reasoningSource: CODEX_MODEL_CATALOG_SOURCE,
  },
  // Cyber is the small-window member: 400,000, not 1.05M. Worth its own entry
  // precisely because assuming the family value here would over-declare by 2.6×.
  [key("openai", "gpt-5.6-cyber")]: {
    advertisedContextWindow: 400_000,
    maxOutputTokens: 128_000,
    source: openaiDoc("gpt-5.6-cyber"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
  },
  [key("openai", "gpt-6-astra")]: {
    advertisedContextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    source: openaiDoc("gpt-6-astra"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningLevel: "medium",
    reasoningSource: CODEX_MODEL_CATALOG_SOURCE,
  },
  [key("openai", "gpt-4o")]: {
    advertisedContextWindow: 128_000,
    maxOutputTokens: 16_384,
    source: openaiDoc("gpt-4o"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
  },
  [key("openai", "gpt-4o-mini")]: {
    advertisedContextWindow: 128_000,
    maxOutputTokens: 16_384,
    source: openaiDoc("gpt-4o-mini"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
  },
  [key("openai", "o1")]: {
    advertisedContextWindow: 200_000,
    maxOutputTokens: 100_000,
    source: openaiDoc("o1"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
  },
  [key("openai", "o1-mini")]: {
    advertisedContextWindow: 128_000,
    maxOutputTokens: 65_536,
    source: openaiDoc("o1-mini"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
  },
  [key("openai", "o3-mini")]: {
    advertisedContextWindow: 200_000,
    maxOutputTokens: 100_000,
    source: openaiDoc("o3-mini"),
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
  },

  // ── DeepSeek (`deepseek/*`) ─────────────────────────────────────────────
  // "CONTEXT LENGTH 1M" on the pricing page; confirmed by the owner on
  // 2026-09-15 when the Claude runtime's ≈200k default was overriding it.
  [key("deepseek", "deepseek-flash")]: {
    advertisedContextWindow: 1_000_000,
    source: `${DEEPSEEK_PRICING_DOC} (owner-confirmed 2026-09-15)`,
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
    // Official Chat Completions / Responses ladder: low / high / max.
    // Default effort is high with thinking enabled. Compatibility aliases
    // (minimal→low, medium/xhigh→high, ultra→max) are the vendor's mapping,
    // not extra levels we offer in the picker.
    reasoningLevels: ["low", "high", "max"],
    defaultReasoningLevel: "high",
    reasoningSource: `${DEEPSEEK_THINKING_DOC} (verified 2026-09-16)`,
  },
  [key("deepseek", "deepseek-v4-pro")]: {
    advertisedContextWindow: 1_000_000,
    source: `${DEEPSEEK_PRICING_DOC} (owner-confirmed 2026-09-15)`,
    verifiedAt: "2026-09-15",
    confidence: "confirmed",
    reasoningLevels: ["low", "high", "max"],
    defaultReasoningLevel: "high",
    reasoningSource: `${DEEPSEEK_THINKING_DOC} (verified 2026-09-16)`,
  },
  // Legacy V3/R1-era ids kept in DEEPSEEK_OFFICIAL_MODELS for existing agents;
  // the current pricing page no longer lists them. Held at the last documented
  // V3/R1 window — the LiteLLM snapshot claims 131,072 for the same ids (a newer
  // serving), and raising this without a doc check risks overflowing a real API
  // limit. The id is no longer on the page, so the value is unverified.
  [key("deepseek", "deepseek-chat")]: {
    advertisedContextWindow: 64_000,
    source: `${DEEPSEEK_PRICING_DOC} (V3-era window; no longer on the current page)`,
    verifiedAt: "2026-09-11",
    confidence: "unverified",
  },
  [key("deepseek", "deepseek-reasoner")]: {
    advertisedContextWindow: 64_000,
    source: `${DEEPSEEK_PRICING_DOC} (R1-era window; no longer on the current page)`,
    verifiedAt: "2026-09-11",
    confidence: "unverified",
  },

  // ── MiniMax (`minimax/*`) ───────────────────────────────────────────────
  // ("上下文窗口" column: M2.x = 204,800; M3 = 1,000,000)
  [key("minimax", "minimax-m2")]: {
    advertisedContextWindow: 204_800,
    source: MINIMAX_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("minimax", "minimax-m2.1")]: {
    advertisedContextWindow: 204_800,
    source: MINIMAX_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("minimax", "minimax-m2.1-highspeed")]: {
    advertisedContextWindow: 204_800,
    source: MINIMAX_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("minimax", "minimax-m2.5")]: {
    advertisedContextWindow: 204_800,
    source: MINIMAX_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("minimax", "minimax-m2.5-highspeed")]: {
    advertisedContextWindow: 204_800,
    source: MINIMAX_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("minimax", "minimax-m2.7")]: {
    advertisedContextWindow: 204_800,
    source: MINIMAX_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("minimax", "minimax-m2.7-highspeed")]: {
    advertisedContextWindow: 204_800,
    source: MINIMAX_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("minimax", "minimax-m3")]: {
    advertisedContextWindow: 1_000_000,
    source: MINIMAX_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },

  // ── Zhipu GLM (`zhipu/*`) ───────────────────────────────────────────────
  // GLM-5.3 is documented at 1M. The app preset still ships the glm-4.5 family,
  // whose last documented window was 128K.
  [key("zhipu", "glm-5.3")]: {
    advertisedContextWindow: 1_000_000,
    source: GLM_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("zhipu", "glm-5.3-flash")]: {
    advertisedContextWindow: 1_000_000,
    source: GLM_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("zhipu", "glm-4.5")]: {
    advertisedContextWindow: 128_000,
    source: GLM_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("zhipu", "glm-4.5-air")]: {
    advertisedContextWindow: 128_000,
    source: GLM_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("zhipu", "glm-4.5-flash")]: {
    advertisedContextWindow: 128_000,
    source: GLM_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
  [key("zhipu", "glm-4.5-x")]: {
    advertisedContextWindow: 128_000,
    source: GLM_DOC,
    verifiedAt: "2026-09-11",
    confidence: "confirmed",
  },
};

/** Official Claude `output_config.effort` ladders, keyed `vendor/model`.
 *
 *  These sit beside `MODEL_CATALOG` rather than on it because we have not
 *  independently verified Anthropic context windows (those still come from the
 *  LiteLLM snapshot). A ladder is a different fact: the effort page names the
 *  levels per model, verified 2026-09-16. Hanging them on an unverified window
 *  entry would either invent a window or mark a documented ladder unverified.
 *
 *  Default effort is `high` (equivalent to omitting the parameter).
 *  `xhigh` is not universal: the page lists it for Fable 5 / Mythos 5 /
 *  Opus 5 / Opus 4.8 / Opus 4.7 / Sonnet 5, and explicitly notes that not
 *  every `max`-capable model has it (Opus 4.6, Sonnet 4.6, Mythos Preview).
 *  Opus 4.5 is effort-capable but on neither the `max` nor `xhigh` list. */
const ANTHROPIC_EFFORT_SOURCE = `${ANTHROPIC_EFFORT_DOC} (verified 2026-09-16)`;
const ANTHROPIC_EFFORT_FULL = ["low", "medium", "high", "xhigh", "max"] as const;
const ANTHROPIC_EFFORT_NO_XHIGH = ["low", "medium", "high", "max"] as const;
const ANTHROPIC_EFFORT_CORE = ["low", "medium", "high"] as const;

type BuiltinReasoningLadder = {
  levels: readonly string[];
  defaultLevel: string;
  source: string;
  confidence: WindowConfidence;
};

const anthropicEffort = (levels: readonly string[]): BuiltinReasoningLadder => ({
  levels,
  defaultLevel: "high",
  source: ANTHROPIC_EFFORT_SOURCE,
  confidence: "confirmed",
});

const MODEL_REASONING_LADDERS: Record<string, BuiltinReasoningLadder> = {
  [key("anthropic", "claude-opus-5")]: anthropicEffort(ANTHROPIC_EFFORT_FULL),
  [key("anthropic", "claude-opus-4-8")]: anthropicEffort(ANTHROPIC_EFFORT_FULL),
  [key("anthropic", "claude-opus-4-7")]: anthropicEffort(ANTHROPIC_EFFORT_FULL),
  [key("anthropic", "claude-opus-4-7-20260416")]: anthropicEffort(ANTHROPIC_EFFORT_FULL),
  [key("anthropic", "claude-sonnet-5")]: anthropicEffort(ANTHROPIC_EFFORT_FULL),
  [key("anthropic", "claude-fable-5")]: anthropicEffort(ANTHROPIC_EFFORT_FULL),
  [key("anthropic", "claude-fable-5-1")]: anthropicEffort(ANTHROPIC_EFFORT_FULL),
  [key("anthropic", "claude-mythos-5")]: anthropicEffort(ANTHROPIC_EFFORT_FULL),
  [key("anthropic", "claude-mythos-5-1")]: anthropicEffort(ANTHROPIC_EFFORT_FULL),
  [key("anthropic", "claude-opus-4-6")]: anthropicEffort(ANTHROPIC_EFFORT_NO_XHIGH),
  [key("anthropic", "claude-opus-4-6-20260205")]: anthropicEffort(ANTHROPIC_EFFORT_NO_XHIGH),
  [key("anthropic", "claude-sonnet-4-6")]: anthropicEffort(ANTHROPIC_EFFORT_NO_XHIGH),
  [key("anthropic", "claude-mythos-preview")]: anthropicEffort(ANTHROPIC_EFFORT_NO_XHIGH),
  [key("anthropic", "claude-opus-4-5")]: anthropicEffort(ANTHROPIC_EFFORT_CORE),
  [key("anthropic", "claude-opus-4-5-20251101")]: anthropicEffort(ANTHROPIC_EFFORT_CORE),
};

/** The configuration condition a codex observation is only valid under. Kept
 *  as a named constant because the two numbers it describes come from ONE
 *  experiment and must not be recombined later. */
const CODEX_SOL_MEASURED_UNDER =
  "codex CLI 0.154.0, backend max_context_window 872,000, model_context_window " +
  "declared by us as 1,050,000 (clamped to 828,400)";

/** Layer B — measured runtime ceilings, keyed `runtime/vendor/model`. An entry
 *  is a fact about a runtime BUILD plus the endpoint behind it, so it must name
 *  the version, the date, and the condition. Never populated from
 *  documentation. */
export const RUNTIME_WINDOW_PROFILES: Record<string, RuntimeWindowProfile> = {
  // Measured on the installed CLI 0.154.0 during the gpt-5.6-sol investigation.
  //
  // `compactionThreshold` is deliberately NULL. The 258,400 figure that used to
  // live here was codex's compaction point under the DEFAULT config
  // (context_window 272,000 × 95%), which is a DIFFERENT configuration from the
  // one that produced the 828,400 effective window (our declared 1.05M, clamped
  // to 95% of the backend's 872,000). Stitching the two into one record would
  // describe a configuration we never measured: it would claim that a session
  // told "you have 828,400" compacts at 258,400. It does not. Until someone
  // re-measures the compaction point under the declared-1.05M condition, the
  // honest answer is "unknown", and callers must not set a compaction policy.
  [`codex/openai/gpt-5.6-sol`]: {
    runtimeEffectiveWindow: 828_400,
    compactionThreshold: null,
    runtimeVersion: "0.154.0",
    observedAt: "2026-09-15",
    measuredUnder: CODEX_SOL_MEASURED_UNDER,
    source:
      "Measured with installed codex CLI 0.154.0: backend max_context_window " +
      "872000 → our declared 1,050,000 is clamped silently to 828400. The " +
      "258400 default-mode compaction point is NOT valid under this condition.",
  },
};

/** Every case where a confirmed catalog value intentionally differs from the
 *  vendored LiteLLM snapshot, with the reason. Locked in both directions by
 *  core/src/__tests__/context-window.test.ts: a new disagreement fails until it
 *  is listed here, and a listed entry that starts agreeing fails as stale.
 *  Keys are bare model ids (the snapshot has no vendor scope). */
export const REVIEWED_SNAPSHOT_DISAGREEMENTS: Record<string, string> = {
  "gpt-5": "Docs: 400k for the API. Snapshot 272k matches the codex serving path, which also declares max_context_window 272k for this family.",
  "gpt-5.2": "Same as gpt-5: docs 400k vs the 272k codex-path default in the snapshot.",
  "gpt-5.6": "Docs 1.05M (/gpt-5.6 301s to /gpt-5.6-sol); the snapshot's 922k lagged the release. Codex's path caps at max_context_window 872k.",
  "gpt-5.6-sol": "Docs 1.05M (verified 2026-09-15); snapshot 922k is stale. Codex reports 258,400 by default and 828,400 once we declare our value.",
  "gpt-5.6-terra": "Docs 1.05M (own page, verified 2026-09-15); snapshot 922k is stale.",
  "gpt-5.6-luna": "Docs 1.05M (own page, verified 2026-09-15); snapshot 922k is stale.",
  "gpt-6-astra": "Docs 1.05M (own page, verified 2026-09-15); snapshot 922k is stale.",
  "glm-5.3-flash": "Docs list 1M for the GLM-5.3 family; the snapshot's 1,048,576 is a 1MiB rounding, not a documented value.",
};

/** The vendored LiteLLM snapshot, typed loosely: its rows are a community
 *  long-tail hint, never a confirmed value. */
interface SnapshotTable {
  version: string;
  note?: string;
  models: Record<string, { maxInputTokens: number; maxOutputTokens?: number; _source?: string }>;
}

const SNAPSHOT: SnapshotTable = builtInContextWindows as SnapshotTable;

const norm = (s: string): string => s.trim().toLowerCase();
const profileKey = (scope: WindowScope, model: string): string =>
  `${norm(scope.runtime)}/${norm(scope.vendor)}/${norm(model)}`;

/** An override may be pinned to one provider row: `<base>#<providerId>`. */
const providerPinnedKey = (base: string, providerId?: string | null): string | null =>
  providerId && providerId.trim() ? `${base}#${norm(providerId)}` : null;

/** Look an override up, preferring the provider-pinned key. Every override map
 *  is normalized to lower-case keys at load time, so a user writing
 *  `"OpenAI/GPT-4o"` is honoured exactly like the documented form. */
function lookupOverride<T>(
  overrides: Record<string, T>,
  base: string,
  providerId?: string | null,
): T | undefined {
  const pinned = providerPinnedKey(base, providerId);
  return (pinned ? overrides[pinned] : undefined) ?? overrides[base];
}

let cachedOverrides: ContextWindowOverrides | null = null;
let legacyWarningEmitted = false;

export function contextWindowOverridesPath(): string {
  return join(ensureDataDir(), "context-window-overrides.json");
}

/** The user's legacy (pre-scope) entries, migrated into catalog-shaped facts.
 *  These are DISPLAY-ONLY: `legacy` confidence keeps them out of the policy
 *  gate, so a hand-written number can never be declared to a runtime as if we
 *  had verified it. */
function legacyCatalogEntries(): Record<string, ModelCatalogEntry> {
  const legacy = loadContextWindowOverrides().models;
  if (!legacy || typeof legacy !== "object") return {};
  const out: Record<string, ModelCatalogEntry> = {};
  for (const [model, entry] of Object.entries(legacy)) {
    const tokens = entry?.maxInputTokens;
    if (typeof tokens !== "number" || tokens <= 0) continue;
    out[key(vendorScopeForModel(model), model)] = {
      advertisedContextWindow: tokens,
      maxOutputTokens: entry.maxOutputTokens,
      source: "legacy context-window-overrides.json (models.*.maxInputTokens)",
      verifiedAt: "unknown",
      confidence: "legacy",
    };
  }
  return out;
}

/** Validate + normalize a parsed override file. The file is user-editable, so
 *  it can be `null`, an array, a string, or a map with mixed-case keys; all of
 *  those must degrade to "no overrides" rather than to a crash. */
function normalizeOverrides(raw: unknown): ContextWindowOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;

  // Keys are documented as case-insensitive; enforcing that HERE (rather than
  // at each lookup) is what makes the promise true.
  const section = (v: unknown): Record<string, never> | undefined => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out: Record<string, never> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val && typeof val === "object" && !Array.isArray(val)) out[norm(k)] = val as never;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  return {
    ...(typeof r.version === "string" ? { version: r.version } : {}),
    catalog: section(r.catalog),
    runtime: section(r.runtime),
    // `models` keys are model ids; lower-casing them matches the id
    // normalisation used everywhere else.
    models: section(r.models),
  };
}

/** Takes the already-parsed file rather than re-reading it: calling
 *  `loadContextWindowOverrides()` from here would recurse if the cache ever
 *  failed to hold a value. */
function warnAboutLegacyOnce(overrides: ContextWindowOverrides): void {
  if (legacyWarningEmitted) return;
  const legacy = overrides.models;
  if (!legacy || Object.keys(legacy).length === 0) return;
  legacyWarningEmitted = true;
  const ids = Object.keys(legacy).slice(0, 8).join(", ");
  console.warn(
    `[context-window] ${contextWindowOverridesPath()} uses the legacy ` +
      `"models" shape (${ids}${Object.keys(legacy).length > 8 ? ", …" : ""}). ` +
      `Read as display-only (confidence=legacy) and never used to declare a ` +
      `window to a runtime. Migrate to {"catalog":{"<vendor>/<model>":` +
      `{"advertisedContextWindow":N,"confidence":"unverified",...}}} — write ` +
      `"confidence":"confirmed" ONLY once you have checked the vendor's own ` +
      `documentation, because that is what grants declaration rights.`,
  );
}

/** Read the user's override file (memoized). A malformed file must not crash a
 *  run — log and behave as if it were absent. The memo always holds an OBJECT
 *  (never null), so a file containing literal `null` cannot send the loader
 *  into a re-read loop. */
export function loadContextWindowOverrides(): ContextWindowOverrides {
  if (cachedOverrides) return cachedOverrides;
  const path = contextWindowOverridesPath();
  let parsed: ContextWindowOverrides = {};
  if (existsSync(path)) {
    try {
      parsed = normalizeOverrides(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      console.warn(`[context-window] failed to read ${path}: ${(err as Error).message}`);
      parsed = {};
    }
  }
  cachedOverrides = parsed;
  warnAboutLegacyOnce(parsed);
  return cachedOverrides;
}

/** Test hook: drop the memoized overrides so the next call re-reads from disk. */
export function _resetContextWindowCache(): void {
  cachedOverrides = null;
  legacyWarningEmitted = false;
}

/** Raw vendored LiteLLM snapshot value, WITHOUT any overlay. Exported for the
 *  catalog-vs-snapshot guard in context-window.test.ts. */
export function snapshotContextWindow(model: string): number | null {
  const entry = SNAPSHOT.models[model] ?? SNAPSHOT.models[norm(model)];
  if (entry && typeof entry.maxInputTokens === "number" && entry.maxInputTokens > 0) {
    return entry.maxInputTokens;
  }
  return null;
}

/** Layer A resolved: the documented capacity for `model` in `vendor` scope.
 *
 *  Precedence: scoped user override > LEGACY user override > built-in catalog >
 *  LiteLLM snapshot. The user's own number outranks our built-in one because
 *  silently ignoring a value that used to take effect IS a behaviour change —
 *  but a legacy entry carries `legacy` confidence, so it can never be declared
 *  to a runtime (see `requestedRuntimeWindow`).
 *
 *  `ignoreLegacy` skips the legacy layer. The policy gate uses it so that a
 *  stale hand-written number neither gets declared itself NOR disables the
 *  confirmed declaration we already have. */
export function catalogEntry(
  model: string,
  vendor: string = vendorScopeForModel(model),
  opts: { ignoreLegacy?: boolean; providerId?: string | null } = {},
): ModelCatalogEntry | null {
  const overrides = loadContextWindowOverrides().catalog ?? {};
  const k = key(vendor, model);
  const scoped = lookupOverride(overrides, k, opts.providerId);
  const base = MODEL_CATALOG[k] ?? null;

  const scopedValue = scoped?.advertisedContextWindow;
  if (typeof scopedValue === "number" && scopedValue > 0) {
    // A number the user supplied is only as trustworthy as they say it is. We
    // must not inherit our catalog's `confirmed` for a value WE never checked —
    // that is how an unverified number would reach a config file. A value that
    // merely restates the catalog keeps the catalog's provenance.
    const restatesCatalog = scopedValue === base?.advertisedContextWindow;
    return {
      advertisedContextWindow: scopedValue,
      maxOutputTokens: scoped!.maxOutputTokens ?? base?.maxOutputTokens,
      source: scoped!.source ?? base?.source ?? "user override",
      verifiedAt: scoped!.verifiedAt ?? base?.verifiedAt ?? "unknown",
      confidence: scoped!.confidence ?? (restatesCatalog ? base!.confidence : "unverified"),
    };
  }

  if (!opts.ignoreLegacy) {
    const legacy = legacyCatalogEntries()[k];
    if (legacy) return legacy;
  }
  if (base) return base;

  const snap = snapshotContextWindow(model);
  if (snap) {
    return {
      advertisedContextWindow: snap,
      source: `LiteLLM snapshot ${SNAPSHOT.version} (community-maintained, unverified)`,
      verifiedAt: "unknown",
      confidence: "unverified",
    };
  }
  return null;
}

/** The vendor's official context window. DISPLAY ONLY — never the live bar.
 *  `opts.providerId` lets a provider-pinned override win. */
export function advertisedWindow(
  model: string,
  vendor: string = vendorScopeForModel(model),
  opts: { providerId?: string | null } = {},
): number | null {
  return catalogEntry(model, vendor, opts)?.advertisedContextWindow ?? null;
}

/** The published max-output cap WITH ITS OWN PROVENANCE.
 *
 *  `catalogEntry` resolves one `confidence` for the whole entry, and that
 *  confidence belongs to the ADVERTISED WINDOW. Reusing it for the output cap
 *  labels a number the user typed as `catalog-confirmed` as soon as they restate
 *  the window figure in the same override — an unverified cap would then reach a
 *  runtime as if we had checked it. The cap's own rung is a different question,
 *  so it is resolved here: the user's own numbers first (scoped override, then
 *  the deprecated legacy shape — the same order `catalogEntry` uses), then our
 *  built-in catalog. */
export function maxOutputTokensEntry(
  model: string,
  vendor: string = vendorScopeForModel(model),
  opts: { providerId?: string | null } = {},
): { value: number; source: string; confidence: WindowConfidence } | null {
  const k = key(vendor, model);
  const scoped = lookupOverride(loadContextWindowOverrides().catalog ?? {}, k, opts.providerId);
  const base = MODEL_CATALOG[k] ?? null;

  const scopedValue = scoped?.maxOutputTokens;
  if (typeof scopedValue === "number" && scopedValue > 0) {
    // Same rule as the window: a value that merely restates the catalog keeps
    // the catalog's provenance, anything else is only as good as the user says.
    const restatesCatalog = scopedValue === base?.maxOutputTokens;
    return {
      value: scopedValue,
      source: scoped!.source ?? base?.source ?? "user override",
      confidence: scoped!.confidence ?? (restatesCatalog ? base!.confidence : "unverified"),
    };
  }

  const legacy = legacyCatalogEntries()[k];
  if (legacy && typeof legacy.maxOutputTokens === "number" && legacy.maxOutputTokens > 0) {
    return { value: legacy.maxOutputTokens, source: legacy.source, confidence: "legacy" };
  }

  if (base && typeof base.maxOutputTokens === "number" && base.maxOutputTokens > 0) {
    return { value: base.maxOutputTokens, source: base.source, confidence: base.confidence };
  }
  return null;
}

/** The vendor's published max-output cap, when documented. */
export function maxOutputTokensFor(
  model: string,
  vendor: string = vendorScopeForModel(model),
  opts: { providerId?: string | null } = {},
): number | null {
  return maxOutputTokensEntry(model, vendor, opts)?.value ?? null;
}

/** The reasoning ladder for a model, WITH ITS OWN PROVENANCE.
 *
 *  A separate resolver from `catalogEntry` for the same reason
 *  `maxOutputTokensEntry` is separate: one entry resolves one confidence for the
 *  advertised window, and reusing it here would label a ladder the USER typed as
 *  `catalog-confirmed` as soon as they restated a window figure in the same
 *  override object.
 *
 *  The ladder is a MODEL fact (`vendor/model`), so the runtime is not consulted
 *  — a level is not more or less true because it was reached through a native
 *  CLI. Three outcomes, and the middle one matters:
 *
 *    null               — we have no evidence. The caller reports UNKNOWN and
 *                         the planner accepts a syntactically valid token as
 *                         user-declared/unverified. It must never be read as
 *                         "supports nothing".
 *    { ok: false }      — a user override exists but is unusable (empty, or it
 *                         contains a token that is not a legal level). Silently
 *                         filtering it would leave the user believing their
 *                         configuration took effect.
 *    { ok: true }       — the ladder, with its source and confidence. */
export type ReasoningCatalogEntry =
  | {
      ok: true;
      levels: string[];
      /** The vendor's default, when it is one of `levels`; null otherwise. */
      defaultLevel: string | null;
      source: string;
      confidence: WindowConfidence;
    }
  | { ok: false; reason: string; source: string };

export function reasoningLevelsEntry(
  model: string,
  vendor: string = vendorScopeForModel(model),
  opts: { providerId?: string | null } = {},
): ReasoningCatalogEntry | null {
  const k = key(vendor, model);
  const scoped = lookupOverride(loadContextWindowOverrides().catalog ?? {}, k, opts.providerId);
  const base = MODEL_CATALOG[k] ?? null;
  const baseSource = base?.reasoningSource ?? base?.source ?? "user override";

  // A user override is only usable if EVERY entry is a legal token: half a
  // ladder is worse than none, because the planner would then reject a level the
  // model really has.
  if (scoped && scoped.reasoningLevels !== undefined) {
    const raw = scoped.reasoningLevels;
    const source = scoped.reasoningSource ?? scoped.source ?? "user override (catalog.reasoningLevels)";
    if (!Array.isArray(raw) || raw.length === 0) {
      return { ok: false, source, reason: "the override's reasoningLevels is empty" };
    }
    const bad = raw.find((l) => !isReasoningToken(l));
    if (bad !== undefined) {
      return {
        ok: false,
        source,
        reason: `the override's reasoningLevels contains ${JSON.stringify(bad)}, which is not a legal reasoning token`,
      };
    }
    const levels = [...raw];
    // Same rule as the window: restating the catalog keeps the catalog's
    // provenance, anything else is only as good as the user says.
    const restatesCatalog =
      base?.reasoningLevels !== undefined &&
      levels.length === base.reasoningLevels.length &&
      levels.every((l, i) => l === base.reasoningLevels![i]);
    const defaultLevel = scoped.defaultReasoningLevel ?? base?.defaultReasoningLevel ?? null;
    return {
      ok: true,
      levels,
      defaultLevel: defaultLevel !== null && levels.includes(defaultLevel) ? defaultLevel : null,
      source,
      confidence: scoped.confidence ?? (restatesCatalog ? base!.confidence : "unverified"),
    };
  }

  if (base?.reasoningLevels !== undefined) {
    const levels = [...base.reasoningLevels];
    const dflt = base.defaultReasoningLevel ?? null;
    return {
      ok: true,
      levels,
      defaultLevel: dflt !== null && levels.includes(dflt) ? dflt : null,
      source: baseSource,
      confidence: base.reasoningConfidence ?? base.confidence,
    };
  }

  const extra = MODEL_REASONING_LADDERS[k];
  if (extra === undefined) return null;
  const levels = [...extra.levels];
  return {
    ok: true,
    levels,
    defaultLevel: levels.includes(extra.defaultLevel) ? extra.defaultLevel : null,
    source: extra.source,
    confidence: extra.confidence,
  };
}

/** Layer B resolved: a runtime profile, but only when it can be trusted for the
 *  caller's runtime version. A profile observed on a different CLI version (or
 *  on an unknown version, which we cannot compare) is NOT reused — a runtime
 *  upgrade can change the effective window and server-side policy. "Unknown" is
 *  the honest answer.
 *
 *  PROVIDER IDENTITY: an override can be pinned to one provider row
 *  (`...#<providerId>`), and that pinned entry wins. Matching a built-in profile
 *  does NOT require the provider to match, because a profile records what a
 *  runtime BUILD does for a model (the codex CLI's clamp), which stays true
 *  whichever of our provider rows points at that runtime. If that assumption
 *  ever stops holding for a route, pin an override to that provider. */
export function runtimeWindowProfile(
  model: string,
  scope: WindowScope,
): RuntimeWindowProfile | null {
  const k = profileKey(scope, model);
  const overrides = loadContextWindowOverrides().runtime ?? {};
  const override = lookupOverride(overrides, k, scope.providerId);
  const base = RUNTIME_WINDOW_PROFILES[k] ?? null;
  if (!base && !override) return null;

  const merged: RuntimeWindowProfile = {
    runtimeEffectiveWindow:
      override?.runtimeEffectiveWindow ?? base?.runtimeEffectiveWindow ?? null,
    compactionThreshold: override?.compactionThreshold ?? base?.compactionThreshold ?? null,
    runtimeVersion: override?.runtimeVersion ?? base?.runtimeVersion ?? null,
    observedAt: override?.observedAt ?? base?.observedAt ?? "unknown",
    measuredUnder: override?.measuredUnder ?? base?.measuredUnder ?? "unspecified",
    source: override?.source ?? base?.source ?? "user override",
  };

  // Version guard: no version on either side → we cannot claim the observation
  // still applies.
  if (!merged.runtimeVersion || !scope.runtimeVersion) return null;
  if (norm(merged.runtimeVersion) !== norm(scope.runtimeVersion)) return null;
  return merged;
}

/** What the runtime reported for THIS session, when it did. */
export interface EffectiveWindowContext extends WindowScope {
  /** Provider/runtime-reported window for THIS session. Highest priority: it is
   *  the window the running process actually enforced, including any clamp. */
  sessionObserved?: number | null;
  /** Value we asked the runtime to use, when we declared one. Used only to flag
   *  `clamped` — never to compute the bar. */
  requested?: number | null;
}

/** Layer B resolved for a live session: what the bar's denominator must be.
 *  Returns null when there is no trustworthy live ceiling — callers must show
 *  "unknown", never fall back to the advertised value. */
export function effectiveWindow(
  model: string,
  ctx: EffectiveWindowContext,
): EffectiveWindow | null {
  const observed = ctx.sessionObserved;
  const requested = ctx.requested ?? null;
  if (typeof observed === "number" && observed > 0) {
    return {
      tokens: observed,
      origin: "session-observed",
      runtimeVersion: ctx.runtimeVersion ?? null,
      observedAt: null,
      clamped: requested !== null && requested > observed,
    };
  }
  const profile = runtimeWindowProfile(model, ctx);
  if (profile?.runtimeEffectiveWindow && profile.runtimeEffectiveWindow > 0) {
    return {
      tokens: profile.runtimeEffectiveWindow,
      origin: "runtime-profile",
      runtimeVersion: profile.runtimeVersion,
      observedAt: profile.observedAt,
      clamped: requested !== null && requested > profile.runtimeEffectiveWindow,
    };
  }
  return null;
}

/** The runtime's compaction threshold, when known FOR THIS SCOPE AND VERSION.
 *  Unknown → null, and the caller must NOT set a compaction env var (the
 *  runtime keeps its own policy; inventing one risks compacting with no
 *  headroom left for output). Never derived from the catalog or from
 *  maxOutputTokens. */
export function compactionThreshold(model: string, scope: WindowScope): number | null {
  const profile = runtimeWindowProfile(model, scope);
  const value = profile?.compactionThreshold ?? null;
  return typeof value === "number" && value > 0 ? value : null;
}

/** THE POLICY GATE. The only function a runtime may use to write config. It
 *  returns a value only when the runtime's key semantics are verified AND the
 *  catalog value is `confirmed` — a family analogy, a legacy override, or an
 *  unverified snapshot must never reach a config file. Display never calls
 *  this; reading must not write config.
 *
 *  Legacy entries are skipped rather than consulted: a hand-written number must
 *  not be declared, but neither may it DISABLE a confirmed declaration we
 *  already hold (that would re-create the very misconfiguration this refactor
 *  removes — codex left on its 272k default because of a stale override). */
export function requestedRuntimeWindow(model: string, scope: WindowScope): number | null {
  const spec = RUNTIME_DECLARES_WINDOW[norm(scope.runtime)];
  if (!spec?.verified) return null;
  const entry = catalogEntry(model, scope.vendor, { ignoreLegacy: true });
  if (!entry || entry.confidence !== "confirmed") return null;
  return entry.advertisedContextWindow > 0 ? entry.advertisedContextWindow : null;
}
