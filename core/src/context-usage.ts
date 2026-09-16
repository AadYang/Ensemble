// Compute a per-turn ContextUsage for the agent-pane context-fill indicator.
//
// Two numerators, picked by what the runtime can tell us — both measure "how
// many tokens is the next request going to carry", neither is a billing sum:
//
//   1. PROVIDER-REPORTED per-call prompt size (Claude runtime, including
//      third-party anthropic-compat upstreams like DeepSeek). Every persisted
//      assistant row carries the `usage` of the single API call that produced
//      it, and on the Anthropic wire protocol `input_tokens` EXCLUDES the
//      cached prefix, so the prompt is `input + cache_read + cache_creation`.
//      Measured on the dev agent (deepseek-flash, 6 auto-compactions): this sum
//      reproduced Claude Code's own `compact_boundary.compact_metadata.
//      pre_tokens` within 2-5% (ratios 0.95…1.00). It also self-resets after a
//      compaction, because the next call reports the shrunken prompt.
//
//      What must NOT be used is the *result* row's usage: it aggregates every
//      API call of the turn (observed 19.6M cache-read on a 200K window), which
//      is why provider data was previously rejected wholesale.
//
//   2. PROVIDER-REPORTED per-response prompt size on the *result* payload, for
//      the in-process OpenAI runtime (openai-compat / openai-local). Its
//      assistant rows carry no usage, but it writes the last response's usage to
//      `contextUsage` (see openai.ts W22). `readResponseUsage` splits the cached
//      prefix OUT of `inputTokens` for billing, so the prompt size is
//      `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`.
//
//   3. LOCAL tokenizer count of the exact history the runtime replays — the
//      fallback when 1 and 2 are both absent (today: Codex, whose
//      `turn.completed.usage` is a cumulative thread total, not a per-request
//      prompt). Those prompts are reconstructed from the DB by
//      `buildRuntimeHistoryForTurn`, so counting that same trimmed history is a
//      faithful model of it rather than a guess.
//
// In every case the percentage is capped at 100 (OpenHands does
// `Math.min(100, …)`) while the raw `usedTokens` is NOT clamped, so the tooltip
// can show a truthful `used/window`.
//
// When neither source yields a positive count we return null → the UI shows
// "unknown" instead of a fabricated number. The local tokenizer returns 0 when
// its vocab files are missing (see local-tokenizer.ts), which keeps the
// "unknown, not 0%" behaviour for the local path.

import type { ContextUsage } from "@agentorch/shared";
import {
  catalogEntry,
  effectiveWindow,
  type EffectiveWindowContext,
} from "./context-window.js";
import { countTokensMany } from "./local-tokenizer.js";

interface ModelUsageEntry {
  contextWindow?: number;
}

/** Last response's usage as the OpenAI runtime writes it (openai.ts W22). The
 *  cached prefix is already subtracted from `inputTokens` there. */
interface ResultContextUsage {
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ResultPayload {
  type?: string;
  modelUsage?: Record<string, ModelUsageEntry>;
  contextUsage?: ResultContextUsage | null;
}

type Row = { type: string; payload: unknown };

/** Extract the SDK-reported context window for `model` from a result message,
 *  when present and positive. This is a SESSION OBSERVATION of the runtime's
 *  own window — it outranks a static runtime profile, but it is still a runtime
 *  fact: it never becomes the advertised/model-capacity number.
 *
 *  Keying: `modelUsage` is written by the runtime under the model id IT saw, so
 *  an exact-key miss is normal rather than exceptional (an upstream alias like
 *  `gpt-5.6-sol-2026-01`, or a runtime that had no `opts.model` to key by).
 *
 *  On a miss we accept the fallback ONLY when it is unambiguous: the result must
 *  report exactly ONE distinct positive window. A result can legitimately carry
 *  several models (the billing path writes a row per model), and picking the
 *  largest of several would silently attribute another model's ceiling to this
 *  one — the opposite of the honesty this module exists for. Ambiguous ⇒
 *  undefined, and the caller falls through to the version-matched profile.
 *  There is deliberately no path from here to a static table. */
export function reportedContextWindowFromResult(
  msg: unknown,
  model: string,
): number | undefined {
  const payload = msg as ResultPayload | null;
  if (!payload || payload.type !== "result") return undefined;
  const exact = payload.modelUsage?.[model]?.contextWindow;
  if (typeof exact === "number" && exact > 0) return exact;

  const distinct = new Set<number>();
  for (const entry of Object.values(payload.modelUsage ?? {})) {
    const w = entry?.contextWindow;
    if (typeof w === "number" && w > 0) distinct.add(w);
  }
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

const num = (v: unknown): number => (typeof v === "number" && v > 0 ? v : 0);

/** Provider-reported prompt size of the most recent API call, read from the
 *  per-call `usage` on persisted assistant rows (anthropic wire shape). Scans
 *  backwards so a row whose stream hadn't finished (no usage yet) can't hide
 *  the previous call's number. Returns null when no row carries usable usage —
 *  i.e. for the OpenAI/Codex runtimes, which is the caller's signal to fall
 *  back to a local count. */
export function promptTokensFromLastCall(rows: readonly Row[]): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type !== "assistant") continue;
    const usage = (row.payload as { message?: { usage?: Record<string, unknown> } } | null)
      ?.message?.usage;
    if (!usage || typeof usage !== "object") continue;
    // OpenAI chat-completions shape: prompt_tokens already INCLUDES the cached
    // prefix, so it is the prompt size on its own.
    const promptTokens = num(usage.prompt_tokens);
    if (promptTokens > 0) return promptTokens;
    // Anthropic shape: input_tokens excludes the cached prefix → add it back.
    const anthropic =
      num(usage.input_tokens) +
      num(usage.cache_read_input_tokens) +
      num(usage.cache_creation_input_tokens);
    if (anthropic > 0) return anthropic;
  }
  return null;
}

/** Provider-reported prompt size of the last response, read from the OpenAI
 *  runtime's own result payload (`contextUsage`, W22). That runtime's assistant
 *  rows carry no usage, so this is its only provider-side number.
 *
 *  `readResponseUsage` reports the cached prefix as a SEPARATE field (it
 *  subtracts it from `inputTokens` so the billing path can price it at the
 *  cache rate), so the prompt size the model actually saw is the sum. Returns
 *  null when the runtime didn't report one — Codex, or a turn that failed
 *  before any response completed — which leaves the local count in charge. */
export function promptTokensFromResultContextUsage(msg: unknown): number | null {
  const payload = msg as ResultPayload | null;
  if (!payload || payload.type !== "result") return null;
  const usage = payload.contextUsage;
  if (!usage || typeof usage !== "object") return null;
  const tokens =
    num(usage.inputTokens) + num(usage.cacheReadInputTokens) + num(usage.cacheCreationInputTokens);
  return tokens > 0 ? tokens : null;
}

/** Text of one history message as the model receives it: user content (string
 *  or block array, including tool_results and their nested content), assistant
 *  text + tool_use arguments, and OpenAI-style tool_calls. Used only for the
 *  local-context fallback — `messageRowText` in SessionManager deliberately
 *  keeps its narrower, human-readable semantics. */
export function promptTextFromMessage(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const message = (msg as { message?: Record<string, unknown> }).message;
  if (!message) return "";
  const parts: string[] = [];
  const content = message.content;
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      const text = blockText(block);
      if (text) parts.push(text);
    }
  }
  // Legacy chat-completions tool calls carry their arguments as a JSON string.
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const args = (call as { function?: { arguments?: unknown } })?.function?.arguments;
      if (typeof args === "string" && args) parts.push(args);
    }
  }
  return parts.filter(Boolean).join("\n");
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const b = block as { type?: unknown; text?: unknown; content?: unknown; name?: unknown; input?: unknown };
  const type = typeof b.type === "string" ? b.type : "";
  if (type === "text" || type === "thinking" || type === "output_text") {
    return typeof b.text === "string" ? b.text : "";
  }
  if (type === "tool_result") {
    if (typeof b.content === "string") return b.content;
    if (Array.isArray(b.content)) return b.content.map(blockText).filter(Boolean).join("\n");
    return "";
  }
  if (type === "tool_use" || type === "function_call") {
    const name = typeof b.name === "string" ? b.name : "";
    let args = "";
    if (b.input !== undefined) {
      try {
        args = JSON.stringify(b.input) ?? "";
      } catch {
        args = "";
      }
    }
    return [name, args].filter(Boolean).join(" ");
  }
  if (typeof b.text === "string") return b.text;
  if (typeof b.content === "string") return b.content;
  return "";
}

/** Build a ContextUsage from a token count we already trust (provider-reported
 *  per-call prompt size, or a local count of the replayed history).
 *
 *  The denominator is the runtime's EFFECTIVE window for this session — a
 *  window measured on this run (session-observed) or a version-matched runtime
 *  profile. When neither exists we return null and the UI shows the used tokens
 *  with "有效上限未知"; we deliberately do NOT fall back to the catalog's
 *  advertised capacity, because that would render an unenforced 1.05M model
 *  limit as if the session had that much room. The advertised value travels
 *  alongside (`advertisedContextWindow`) purely for display. */
export function contextUsageFromUsedTokens(
  model: string,
  ctx: EffectiveWindowContext,
  usedTokens: number,
): ContextUsage | null {
  if (usedTokens <= 0) return null; // nothing countable → "unknown", not 0%
  const entry = catalogEntry(model, ctx.vendor, { providerId: ctx.providerId });
  const advertised = entry?.advertisedContextWindow ?? 0;
  const win = effectiveWindow(model, ctx);

  // The advertised figure travels with its provenance so the UI can label an
  // unverified / legacy-migrated number instead of presenting it as settled.
  const advertisedFields =
    advertised > 0
      ? {
          advertisedContextWindow: advertised,
          advertisedWindowConfidence: entry!.confidence,
          advertisedWindowSource: entry!.source,
        }
      : {};

  // We have a count but no trustworthy live ceiling: report the count and say
  // the ceiling is unknown. Deliberately NOT `contextWindow: advertised` — see
  // the type doc.
  if (!win || win.tokens <= 0) {
    return { usedTokens, ...advertisedFields };
  }

  return {
    usedTokens,
    contextWindow: win.tokens,
    percent: Math.min(100, Math.round((usedTokens / win.tokens) * 100)),
    ...advertisedFields,
    windowOrigin: win.origin,
    ...(win.observedAt ? { windowObservedAt: win.observedAt } : {}),
    ...(win.clamped ? { windowClamped: true } : {}),
  };
}

/** Build a ContextUsage from locally-tokenized transcript text. */
export function contextUsageFromTranscript(
  model: string,
  ctx: EffectiveWindowContext,
  transcriptTexts: readonly string[],
): ContextUsage | null {
  return contextUsageFromUsedTokens(model, ctx, countTokensMany(model, transcriptTexts));
}
