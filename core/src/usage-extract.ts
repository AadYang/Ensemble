// W17 Slice 3: extract UsageEvent rows from a result-style SDK message.
//
// Both ClaudeAgentRuntime and OpenAIAgentRuntime emit `result` messages
// shaped like `{type:"result", subtype:"success", modelUsage: {[model]:
// ModelUsage}, ...}` (OpenAI side synthesizes this in W17.1 to match Claude).
// This helper takes the snapshot context + message and returns the rows
// SessionManager should insert into UsageEvent.
//
// Pure function — no DB access, no SDK runtime imports — so it's directly
// unit-testable.

import { randomUUID } from "node:crypto";
import { computeCost } from "./pricing.js";
import type { UsageEvent } from "./db.js";

/** Snapshot context captured by SessionManager at sendMessage time. */
export interface UsageContext {
  agentId: string;
  agentName: string;
  parentId: string | null;
  providerId: string | null;
  providerName: string;
  providerKind: string;
}

interface SdkResultPayload {
  type?: string;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    inputTokensLocal?: number;
    outputTokensLocal?: number;
  }>;
}

/** Inserts that SessionManager passes to db.usageEvent.create. id is
 *  pre-generated so the caller can log / track it without a round-trip. */
export type UsageEventInsert = Omit<UsageEvent, "createdAt">;

/** Pull every model's usage out of a result message and produce one
 *  UsageEventInsert per model. Returns [] when the message isn't a result
 *  or carries no modelUsage. */
export function extractUsageEvents(
  context: UsageContext,
  message: unknown,
  source: "result" | "meta" = "result",
): UsageEventInsert[] {
  const m = message as SdkResultPayload | null;
  if (!m || m.type !== "result") return [];
  const models = m.modelUsage;
  if (!models || typeof models !== "object") return [];

  // W20 Slice 5.6: codex turns are flat-rate billing (ChatGPT subscription).
  // Marginal $ per turn is 0 regardless of token counts; aggregator separates
  // these rows from pay-per-token rollups so we don't double-charge usage
  // already paid for via the ChatGPT plan.
  const isSubscription = context.providerKind === "openai-codex";
  const billingModel: "usage" | "subscription" = isSubscription ? "subscription" : "usage";

  const out: UsageEventInsert[] = [];
  for (const [model, u] of Object.entries(models)) {
    if (!u) continue;
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    const cacheReadTokens = u.cacheReadInputTokens ?? 0;
    const cacheCreationTokens = u.cacheCreationInputTokens ?? 0;
    const inputTokensLocal = u.inputTokensLocal ?? 0;
    const outputTokensLocal = u.outputTokensLocal ?? 0;
    // Skip purely-empty rows (model emits nothing useful — e.g. dry-run).
    // Local counts alone (no upstream tokens) are also pointless to persist.
    if (
      inputTokens === 0 && outputTokens === 0 &&
      cacheReadTokens === 0 && cacheCreationTokens === 0 &&
      inputTokensLocal === 0 && outputTokensLocal === 0
    ) {
      continue;
    }
    const cost = isSubscription
      ? { costUSD: 0, costKnown: true }
      : computeCost(model, {
          inputTokens,
          outputTokens,
          cacheReadInputTokens: cacheReadTokens,
          cacheCreationInputTokens: cacheCreationTokens,
        });
    out.push({
      id: randomUUID(),
      agentId: context.agentId,
      agentName: context.agentName,
      parentId: context.parentId,
      providerId: context.providerId,
      providerName: context.providerName,
      providerKind: context.providerKind,
      model,
      source,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUSD: cost.costUSD,
      costKnown: cost.costKnown,
      billingModel,
      inputTokensLocal,
      outputTokensLocal,
    });
  }
  return out;
}

/** Build a single UsageEvent insert for quickQuery / other meta calls where
 *  we already know token counts directly. Used by SessionManager.quickQuery
 *  in Slice 5.10. */
export function buildMetaUsageEvent(
  context: UsageContext,
  model: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  },
): UsageEventInsert {
  const isSubscription = context.providerKind === "openai-codex";
  const cost = isSubscription
    ? { costUSD: 0, costKnown: true }
    : computeCost(model, tokens);
  return {
    id: randomUUID(),
    agentId: context.agentId,
    agentName: context.agentName,
    parentId: context.parentId,
    providerId: context.providerId,
    providerName: context.providerName,
    providerKind: context.providerKind,
    model,
    source: "meta",
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadInputTokens ?? 0,
    cacheCreationTokens: tokens.cacheCreationInputTokens ?? 0,
    costUSD: cost.costUSD,
    costKnown: cost.costKnown,
    billingModel: isSubscription ? "subscription" : "usage",
    // meta calls (quickQuery / subagent suggestions) don't run through the
    // OpenAI tokenizer pipeline — leave local counts at 0 to signal "no
    // audit available for this row" rather than masquerade as agreement.
    inputTokensLocal: 0,
    outputTokensLocal: 0,
  };
}
