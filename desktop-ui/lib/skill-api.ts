import type { AgentStatusReport, AgentSummary } from "@agentorch/shared";
import { getAgentStatusReport } from "@/lib/agent-api";

export type SkillSource = "project" | "ensemble" | "claude-user" | "codex-user" | "system";

export interface SkillDTO {
  name: string;
  description: string;
  tools: string[] | null;
  model: string | null;
  source: SkillSource;
  path: string;
  body: string;
  /** Optional matching inputs (`triggers` / `examples` frontmatter). */
  triggers?: string[] | null;
  examples?: string[] | null;
}

/** Discovery scope. Pass an agent id so its own project skills
 *  (`.agents/skills`, `.claude/skills`, …) are discovered — the same scope the
 *  agent's turns use. Without it the list is the user/ensemble/system set only,
 *  and an enabled project skill would look like it does not exist. */
export async function listSkills(agentId?: string | null): Promise<SkillDTO[]> {
  const qs = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
  const res = await fetch(`/api/skills${qs}`);
  if (!res.ok) throw new Error(`listSkills: ${res.status}`);
  return (await res.json()) as SkillDTO[];
}

/** This turn's skill state for one agent, straight from `plan.skills` — the
 *  same object selection used, so the panel cannot report a skill as loaded
 *  that the prompt never carried.
 *
 *  Aliased to the report's own field rather than re-declared: the panel and
 *  `/status` are reading one object, and a second declaration is how the panel
 *  ends up missing a field the server started sending. */
export type AgentSkillStatus = NonNullable<AgentStatusReport["skills"]["turn"]>;
export type AgentSkillState = AgentStatusReport["skills"];

/** Read the skills slice of the SAME report `/status` prints, through the same
 *  client. No cast: the response is the report type, so a renamed or removed
 *  field is a compile error instead of a `body.skills ?? null` that quietly
 *  reads `undefined` and renders an empty panel. */
export async function getAgentSkillState(agentId: string): Promise<AgentSkillState | null> {
  const report = await getAgentStatusReport(agentId);
  return report?.skills ?? null;
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
