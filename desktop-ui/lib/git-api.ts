import type { GitBranches, GitCheckoutRequest, GitCheckoutResult, GitStatus } from "@agentorch/shared";
import { apiError, apiFetch } from "@/lib/api";

const GIT_READ_TIMEOUT_MS = 20_000;
const GIT_CHECKOUT_TIMEOUT_MS = 30_000;

/** The repository behind an agent's project root.
 *
 *  The chip renders what this returns and nothing else: no path is turned into
 *  a repository on the client, and no earlier answer is kept as a fallback. A
 *  branch name the server did not just confirm is worse than an empty chip.
 *
 *  apiFetch resolves the sidecar origin. Bare fetch("/api/...") on
 *  tauri://localhost never reaches core, so the chip stays empty and the
 *  picker cannot switch. */
export async function getGitStatus(agentId: string): Promise<GitStatus> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/git`, {
    signal: AbortSignal.timeout(GIT_READ_TIMEOUT_MS),
  });
  if (!res.ok) throw await apiError(res, "getGitStatus");
  return (await res.json()) as GitStatus;
}

export async function listGitBranches(agentId: string): Promise<GitBranches> {
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/git/branches`, {
    signal: AbortSignal.timeout(GIT_READ_TIMEOUT_MS),
  });
  if (!res.ok) throw await apiError(res, "listGitBranches");
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
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/git/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(GIT_CHECKOUT_TIMEOUT_MS),
  });
  if (res.status === 404) throw new Error("this agent no longer exists");
  return (await res.json()) as GitCheckoutResult;
}
