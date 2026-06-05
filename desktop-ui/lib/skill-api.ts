import type { AgentSummary } from "@agentorch/shared";

export type SkillSource = "project" | "ensemble" | "claude-user" | "codex-user";

export interface SkillDTO {
  name: string;
  description: string;
  tools: string[] | null;
  model: string | null;
  source: SkillSource;
  path: string;
  body: string;
}

export async function listSkills(): Promise<SkillDTO[]> {
  const res = await fetch("/api/skills");
  if (!res.ok) throw new Error(`listSkills: ${res.status}`);
  return (await res.json()) as SkillDTO[];
}

export async function reloadSkills(): Promise<{ ok: true; count: number }> {
  const res = await fetch("/api/skills/reload", { method: "POST" });
  if (!res.ok) throw new Error(`reloadSkills: ${res.status}`);
  return (await res.json()) as { ok: true; count: number };
}

export interface SkillUpsertInput {
  name: string;
  description: string;
  body: string;
  tools?: string[];
  model?: string;
}

export async function createSkill(input: SkillUpsertInput): Promise<SkillDTO> {
  const res = await fetch("/api/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`createSkill: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as SkillDTO;
}

export async function patchSkill(
  name: string,
  patch: Partial<Omit<SkillUpsertInput, "name">>,
): Promise<SkillDTO> {
  const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patchSkill: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as SkillDTO;
}

export async function deleteSkill(name: string): Promise<void> {
  const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteSkill: ${res.status}`);
}

export async function toggleAgentSkill(
  agentId: string,
  name: string,
  action: "enable" | "disable" | "auto",
): Promise<AgentSummary> {
  const res = await fetch(`/api/agents/${agentId}/skill-toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, action }),
  });
  if (!res.ok) throw new Error(`toggleAgentSkill: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as AgentSummary;
}
