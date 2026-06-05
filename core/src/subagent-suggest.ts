// W14: helpers for the suggest-children endpoint that benefit from being
// unit-testable in isolation. The route handler in index.ts just orchestrates
// these against SessionManager.quickQuery.

import { catalogPromptTable } from "./subagent-catalog.js";

export interface Pick { key: string; hint?: string }

/** Extract the {picks: [...]} payload from a model response. Tolerates code
 *  fences, surrounding prose, and the first valid JSON object on the line.
 *  Returns null when no parseable object is found OR `picks` isn't an array. */
export function extractJsonPicks(raw: string): Pick[] | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end)) as { picks?: { key?: string; hint?: string }[] };
    if (!obj || !Array.isArray(obj.picks)) return null;
    return obj.picks
      .filter((p): p is { key: string; hint?: string } => typeof p?.key === "string")
      .map((p) => ({ key: p.key, hint: typeof p.hint === "string" ? p.hint : undefined }));
  } catch {
    return null;
  }
}

/** v2 design §5: 极简 prompt — 历史 + 角色表 + JSON-only instruction.
 *  Kept here so the prompt format stays unit-testable as it evolves. */
export function buildSuggestPrompt(historyChunks: string[]): string {
  const history = historyChunks.length > 0 ? historyChunks.join("\n") : "(no prior messages)";
  return [
    "最近父 agent 对话:",
    history,
    "",
    "从以下角色 keys 选 3 个 (按相关性降序):",
    catalogPromptTable(),
    "",
    "仅输出 JSON，无解释:",
    '{"picks":[{"key":"<key>","hint":"<≤80 字定制化提示，可空>"},{...},{...}]}',
  ].join("\n");
}
