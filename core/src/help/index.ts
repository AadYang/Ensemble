// Public surface for the help subsystem. Stateless — no closures over
// SessionManager needed; help content is static (HELP_TOPICS) so each runtime
// can call formatEnsembleHelp directly. This is intentionally simpler than
// the peer-mcp factory pattern: peer_send/peer_query need fromAgentId binding
// for self-exclusion + auditing; help has no such concern.

import { HELP_TOPICS, HELP_TOPIC_NAMES } from "./topics.js";

export { HELP_TOPIC_NAMES };
export { buildEnsemblePrimer } from "./primer.js";

export function formatEnsembleHelp(topic?: string): string {
  const t = (topic ?? "").trim().toLowerCase();
  if (!t) {
    return [
      "ensemble_help — Ensemble runtime guidance.",
      "",
      "Available topics (call ensemble_help <topic>):",
      ...HELP_TOPIC_NAMES.map((n) => `  - ${n}`),
      "",
      "Each topic returns precise UI steps + HTTP API hints. Use this BEFORE",
      "attempting to script Ensemble-specific changes — there's no source code",
      "for you to Grep here.",
    ].join("\n");
  }
  const body = HELP_TOPICS[t];
  if (!body) {
    return [
      `Unknown topic "${topic}". Available: ${HELP_TOPIC_NAMES.join(", ")}`,
      "Call ensemble_help with no argument for the full index.",
    ].join("\n");
  }
  return `[ensemble_help: ${t}]\n\n${body}`;
}
