import type { AgentSummary } from "./protocol";

/** The ONE subagent peer-contact rule.
 *
 *  A subagent is private to the agent that spawned it. It was given one agent's
 *  task, in one agent's project, under one agent's permissions, and its answer
 *  belongs in that agent's transcript — so nobody else may hand it work
 *  (peer_send's continue/review/fork modes are literally task handoffs), and it
 *  may not reach past that one relationship either: not sideways to a sibling,
 *  not down to a subagent of its own. A nested task's result travels up through
 *  the existing completion notice, not through a peer channel.
 *
 *  This module is shared because BOTH sides need it and they must not drift:
 *  `core` enforces it (SessionManager.peerContactRefusal — the security
 *  boundary, which is authoritative), and the desktop UI calls the same
 *  function to avoid offering a target whose only possible outcome is a
 *  refusal. Neither side re-derives the relationship on its own.
 *
 *  A user-created agent — top-level, or nested under another agent by a human
 *  choosing a parent — is NOT covered by this rule in either direction. */

/** The relationship in its minimal form, as the server already reports it. */
export interface PeerContactIdentity {
  id: string;
  /** The agent that SPAWNED this one (`metadata.spawnedAsTaskFor`), or null for
   *  an agent no agent created. */
  spawnedBy: string | null;
}

/** Read that relationship off an AgentSummary. `subagentKind` is exactly
 *  "an agent spawned this one" (see agentRowToSummary), and `parentId` is then
 *  the spawner — so both halves already travel in the summary and no raw
 *  metadata has to be exposed to do this. */
export const peerIdentityFromSummary = (a: AgentSummary): PeerContactIdentity => ({
  id: a.id,
  spawnedBy: a.subagentKind === null ? null : a.parentId,
});

export const peerContactAllowed = (
  from: PeerContactIdentity,
  target: PeerContactIdentity,
): boolean => {
  // A subagent's one link points UP: it may contact the agent that spawned it,
  // and nothing else — not siblings, not its spawner's other agents, and not
  // the subagents it spawned itself. This has to be checked before the clause
  // below, or "my own child is mine to contact" would reopen the downward
  // channel through the back door.
  if (from.spawnedBy !== null) return target.id === from.spawnedBy;
  // A subagent is private to its spawner: only that agent may contact it.
  if (target.spawnedBy !== null) return target.spawnedBy === from.id;
  return true;
};
