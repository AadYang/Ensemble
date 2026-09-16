import type { GitBranches, GitCheckoutRequest, GitCheckoutResult, GitStatus } from "@agentorch/shared";

/** The repository behind an agent's project root.
 *
 *  The chip renders what this returns and nothing else: no path is turned into
 *  a repository on the client, and no earlier answer is kept as a fallback. A
 *  branch name the server did not just confirm is worse than an empty chip. */
export async function getGitStatus(agentId: string): Promise<GitStatus> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/git`);
  if (!res.ok) throw new Error(`getGitStatus: ${res.status}`);
  return (await res.json()) as GitStatus;
}

export async function listGitBranches(agentId: string): Promise<GitBranches> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/git/branches`);
  if (!res.ok) throw new Error(`listGitBranches: ${res.status}`);
  return (await res.json()) as GitBranches;
}

/** Switch branches.
 *
 *  A refusal is a VALUE, not an exception. git declining to switch a dirty work
 *  tree is an answer the picker has to render together with its reason ("your
 *  local changes would be overwritten"), and throwing it would leave the caller
 *  matching on a message string to find that out.
 *
 *  Only a transport-level failure — no agent, no server — throws. */
export async function checkoutGitBranch(
  agentId: string,
  input: GitCheckoutRequest,
): Promise<GitCheckoutResult> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/git/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 404) throw new Error("this agent no longer exists");
  return (await res.json()) as GitCheckoutResult;
}
