const SUBAGENT_TOOL_NAMES = new Set([
  "Agent",
  "Task",
  "Subagent",
  "spawn_subagent",
  "spawn_ensemble_agent",
]);

function shortToolName(raw: string): string {
  const i = raw.lastIndexOf("__");
  return i >= 0 ? raw.slice(i + 2) : raw;
}

/** Claude native Agent, OpenAI Task, Codex Subagent, and Ensemble spawn tools. */
export function isSubagentToolName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return SUBAGENT_TOOL_NAMES.has(shortToolName(raw));
}

export function countSubagentStartsThisTurn(
  turns: readonly { kind: string; toolName?: string | null }[],
): number {
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.kind === "user") {
      start = i + 1;
      break;
    }
  }
  let n = 0;
  for (let i = start; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.kind === "tool_use" && isSubagentToolName(turn.toolName)) n++;
  }
  return n;
}
