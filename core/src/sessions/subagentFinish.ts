// Terminal-state handoff for DETACHED subagents (`Task(background=true)` /
// spawn_subagent background=true).
//
// A blocking subagent is easy: the parent's tool call blocks and the child's
// final text comes back as the tool_result (exactly how Claude Code's native
// Task tool and the Codex bridge's `Task` work). A detached one has nobody
// listening — the parent got `{background:true, subagentId}` and moved on, and
// until now nothing ever told it how the child ended. The parent could only
// poll with peer_query, and a child that died stayed invisible until a human
// noticed the sidebar.
//
// This module builds the two artifacts the parent receives when its child
// reaches a terminal state:
//   1. a durable `system.background_subagent_finished` row in the PARENT's
//      transcript (UI + audit trail, broadcast immediately), and
//   2. the text of a real queued turn on the parent (the only channel that
//      reaches the model on ALL three runtimes — Claude reads its own CLI
//      session, Codex gets a fresh `codex exec` prompt, OpenAI replays DB
//      history; a DB-only system row reaches none of them reliably).
//
// Delivery (busy → queue, idle → run now) is handled by
// SessionManager.sendMessage; this module stays pure and unit-testable.

export interface SubagentTerminalOutcome {
  /** DONE = completed, ERROR = failed, IDLE = aborted/interrupted. */
  status: "DONE" | "ERROR" | "IDLE";
  error?: string;
  finalText?: string;
  /** The `description` the parent passed to Task/spawn_subagent. */
  description?: string;
}

export interface SubagentIdentity {
  id: string;
  name: string;
}

/** Bounded so a chatty subagent can never blow up its parent's context. */
const MAX_FINAL_TEXT = 4_000;

/** Tool-result text for a detached background spawn. The old wording told the
 *  model to "use peer_query on it later to read its progress/result" — i.e. the
 *  parent was on the hook to POLL, which is exactly why a dead background task
 *  stayed invisible. The contract is now push: you will be told. */
export function backgroundSubagentStartedText(childId: string): string {
  return (
    `Background task started (subagent id=${childId.slice(0, 8)}). ` +
    "It runs detached and is visible in the sidebar under you. " +
    "You will receive a `subagent-finished` message in this conversation when it reaches a terminal " +
    "state (completed / failed / interrupted) — do not poll for it and do not block waiting. " +
    "Keep working on other things; if nothing is left, end your turn."
  );
}

const STATUS_LABEL: Record<SubagentTerminalOutcome["status"], string> = {
  DONE: "DONE",
  ERROR: "ERROR",
  IDLE: "INTERRUPTED",
};

function truncate(text: string): string {
  if (text.length <= MAX_FINAL_TEXT) return text;
  return `${text.slice(0, MAX_FINAL_TEXT)}\n[… truncated ${text.length - MAX_FINAL_TEXT} chars]`;
}

/** One-line, human-facing summary. Also carried in the persisted system row so
 *  the transcript reads correctly without any client-side formatting. */
export function subagentFinishedSummary(
  child: SubagentIdentity,
  outcome: SubagentTerminalOutcome,
): string {
  const label = STATUS_LABEL[outcome.status];
  const desc = outcome.description?.trim();
  const head = desc ? `${child.name} (${desc})` : child.name;
  if (outcome.status === "DONE") return `✓ subagent finished · ${head}`;
  if (outcome.status === "ERROR") return `⚠ subagent failed · ${head}${outcome.error ? ` · ${outcome.error}` : ""}`;
  return `■ subagent interrupted · ${head}`;
}

/** The persisted/broadcast `system` payload for the parent's transcript. */
export function subagentFinishedSystemPayload(
  child: SubagentIdentity,
  outcome: SubagentTerminalOutcome,
): Record<string, unknown> {
  return {
    type: "system",
    subtype: "background_subagent_finished",
    subagent_id: child.id,
    subagent_name: child.name,
    status: outcome.status,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.description ? { description: outcome.description } : {}),
    text: subagentFinishedSummary(child, outcome),
  };
}

/** The queued-turn text delivered to the PARENT agent. Written as an explicit
 *  non-human notification so the model neither thanks the user for it nor
 *  treats it as a new instruction, and told what it may do about it (the
 *  "monitor → delete → respawn" loop the sidebar previously required a human
 *  to perform). */
export function formatSubagentFinishedNotice(
  child: SubagentIdentity,
  outcome: SubagentTerminalOutcome,
): string {
  const lines = [
    `<subagent-finished id=${child.id.slice(0, 8)} status=${STATUS_LABEL[outcome.status]} name="${child.name}">`,
    "An automatic notification (no human wrote this): a subagent you spawned in the background has reached a terminal state.",
    `Status: ${STATUS_LABEL[outcome.status]}`,
  ];
  if (outcome.description) lines.push(`Task: ${outcome.description}`);
  if (outcome.error) lines.push(`Error: ${outcome.error}`);
  const finalText = outcome.finalText?.trim();
  if (finalText) {
    lines.push("--- final output ---", truncate(finalText), "--- end final output ---");
  } else if (outcome.status === "DONE") {
    lines.push("(The subagent produced no final text.)");
  }
  lines.push(
    "What you can do: if the output above is usable, carry on — no acknowledgement is needed. " +
      "If the task failed or the output is unusable, the subagent is finished and will not run again on its own: " +
      "drop it from the sidebar (it is already terminal) and spawn a replacement with a corrected prompt via " +
      "Task(background=true), or read its full transcript with peer_query.",
    "</subagent-finished>",
  );
  return lines.join("\n");
}
