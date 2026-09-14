// Compute a per-turn ContextUsage from a Claude-shaped result SDK message.
//
// `usedTokens` is the total number of tokens currently occupying the model
// context window at the end of that turn. Per the project-wide convention
// (see pricing.ts + runtimes/openai.ts), `inputTokens` is the NON-cached
// portion of the prompt, with cache reads/creations tracked separately — so
// the full window occupancy is:
//
//   inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens
//
// Pure function — no DB, no runtime imports — so it's directly unit-testable.

import type { ContextUsage } from "@agentorch/shared";
import { resolveContextWindow } from "./context-window.js";

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
}

interface ResultPayload {
  type?: string;
  modelUsage?: Record<string, ModelUsageEntry>;
}

function usedTokensOf(u: ModelUsageEntry): number {
  return (
    (u.inputTokens ?? 0) +
    (u.outputTokens ?? 0) +
    (u.cacheReadInputTokens ?? 0) +
    (u.cacheCreationInputTokens ?? 0)
  );
}

export function contextUsageFromResult(msg: unknown, currentModel: string): ContextUsage | null {
  const payload = msg as ResultPayload | null;
  if (!payload || payload.type !== "result" || !payload.modelUsage) return null;

  let model = currentModel;
  let usage: ModelUsageEntry | undefined = payload.modelUsage[currentModel];
  if (!usage) {
    // Multi-model turn (rare): fall back to the entry with the largest
    // token footprint so the indicator still reflects the dominant model.
    for (const [name, u] of Object.entries(payload.modelUsage)) {
      if (!u) continue;
      if (!usage || usedTokensOf(u) > usedTokensOf(usage)) {
        model = name;
        usage = u;
      }
    }
  }
  if (!usage) return null;

  const usedTokens = usedTokensOf(usage);
  const contextWindow = resolveContextWindow(model, usage.contextWindow);
  if (usedTokens <= 0 || !contextWindow || contextWindow <= 0) return null;

  return {
    usedTokens,
    contextWindow,
    percent: Math.round((usedTokens / contextWindow) * 100),
  };
}
