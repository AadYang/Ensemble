import type { AgentSummary } from "./protocol";

/** Who may contact whom over peer_send / peer_query.
 *
 *  Two stacked rules, both enforced here so core and the UI cannot drift:
 *
 *  1. Team circle. A teamed agent may only reach members of that same team.
 *     An ungrouped agent may only reach other ungrouped agents. Same display
 *     name on another team is a different agent and is out of reach.
 *  2. Subagent privacy. A subagent is private to the agent that spawned it.
 *     Nobody else may hand it work, and it may only talk back to that one
 *     parent — not siblings, not its own children.
 *
 *  `core` enforces this (SessionManager.peerContactRefusal). The desktop UI
 *  calls the same function so the picker never offers a target whose only
 *  outcome is a refusal. */

export interface PeerContactIdentity {
  id: string;
  /** The agent that SPAWNED this one (`metadata.spawnedAsTaskFor`), or null for
   *  an agent no agent created. */
  spawnedBy: string | null;
  teamId: string | null;
}

export const peerIdentityFromSummary = (a: AgentSummary): PeerContactIdentity => ({
  id: a.id,
  spawnedBy: a.subagentKind === null ? null : a.parentId,
  teamId: a.teamId,
});

/** Same team, or both ungrouped. Name collisions across teams do not count. */
export const samePeerCircle = (
  from: PeerContactIdentity,
  target: PeerContactIdentity,
): boolean => {
  if (from.teamId) return target.teamId === from.teamId;
  return target.teamId === null;
};

export const peerContactAllowed = (
  from: PeerContactIdentity,
  target: PeerContactIdentity,
): boolean => {
  if (!samePeerCircle(from, target)) return false;
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
