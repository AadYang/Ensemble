import type { LayoutWorkspace } from "@agentorch/shared";

export interface WorkspaceSummaryDTO {
  id: string;
  name: string;
  createdAt: string;
}

export async function listWorkspaces(): Promise<WorkspaceSummaryDTO[]> {
  const res = await fetch("/api/workspaces");
  if (!res.ok) throw new Error(`listWorkspaces: ${res.status}`);
  return (await res.json()) as WorkspaceSummaryDTO[];
}

export async function fetchWorkspace(
  id: string,
): Promise<{ id: string; name: string; layout: LayoutWorkspace }> {
  const res = await fetch(`/api/workspaces/${id}`);
  if (!res.ok) throw new Error(`fetchWorkspace: ${res.status}`);
  return (await res.json()) as { id: string; name: string; layout: LayoutWorkspace };
}

export async function putWorkspaceLayout(id: string, layout: LayoutWorkspace): Promise<void> {
  const res = await fetch(`/api/workspaces/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout }),
  });
  if (!res.ok) throw new Error(`putWorkspaceLayout: ${res.status}`);
}

export async function createWorkspace(name: string): Promise<WorkspaceSummaryDTO> {
  const res = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createWorkspace: ${res.status}`);
  return (await res.json()) as WorkspaceSummaryDTO;
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`renameWorkspace: ${res.status}`);
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteWorkspace: ${res.status}`);
}
