import type { TeamSummary } from "@agentorch/shared";

export async function listTeams(): Promise<TeamSummary[]> {
  const res = await fetch("/api/teams");
  if (!res.ok) throw new Error(`listTeams: ${res.status}`);
  return (await res.json()) as TeamSummary[];
}

export async function createTeam(input: {
  name: string;
  description?: string;
}): Promise<{ id: string }> {
  const res = await fetch("/api/teams", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`createTeam: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as { id: string };
}

export async function patchTeam(
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  const res = await fetch(`/api/teams/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patchTeam: ${res.status}`);
}

export async function deleteTeam(id: string): Promise<void> {
  const res = await fetch(`/api/teams/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteTeam: ${res.status}`);
}
