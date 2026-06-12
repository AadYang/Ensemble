import { formatSkillBody } from "./activate.js";
import { findSkill, loadSkills } from "./loader.js";

export function formatSkillListForTool(workspaces: string[] = []): string {
  const list = loadSkills(workspaces);
  if (list.length === 0) return "No skills loaded.";
  return list
    .map((s) => `${s.name} [${s.source}] - ${s.description}` + (s.tools ? ` (tools: ${s.tools.join(", ")})` : ""))
    .join("\n");
}

export function formatSkillInvokeForTool(
  name: string,
  workspaces: string[] = [],
  runtimeKind: string,
): string {
  const skill = findSkill(name, workspaces);
  if (!skill) {
    const all = loadSkills(workspaces).map((s) => s.name).join(", ") || "(none)";
    return `No skill named "${name}". Available: ${all}`;
  }
  return formatSkillBody(skill, runtimeKind);
}
