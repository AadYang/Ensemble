// Tool-facing adapters over the one skill read path (skills/read.ts).
//
// There is no header/body rendering here — formatSkillInvokeForTool and the
// MCP layer both hand the read result straight through, so the text a tool
// returns and the text auto-activation injects cannot drift apart.

import { loadSkills } from "./loader.js";
import { readSkillByName, type SkillReadOpts, type SkillReadResult } from "./read.js";

export function formatSkillListForTool(workspaces: string[] = []): string {
  const list = loadSkills(workspaces);
  if (list.length === 0) return "No skills loaded.";
  return list
    .map((s) => `${s.name} [${s.source}] - ${s.description}` + (s.tools ? ` (tools: ${s.tools.join(", ")})` : ""))
    .join("\n");
}

/** Structured skill_invoke result. Returns the read result object itself — the
 *  MCP layer decides how to present a failure (isError + JSON), and string
 *  mangling here would destroy the code/available fields it needs. */
export function skillInvokeToolResult(name: string, opts: SkillReadOpts): SkillReadResult {
  return readSkillByName(name, opts);
}

export function formatSkillInvokeForTool(
  name: string,
  workspaces: string[] = [],
  runtimeKind: string,
): string {
  const res = readSkillByName(name, { runtimeKind, workspaces });
  if (res.ok) return res.text;
  // Text-only callers (and humans reading a log) get the code AND the message
  // in the same string, so a failure is never mistaken for a skill body.
  const available = res.available.length > 0 ? ` Available: ${res.available.join(", ")}` : "";
  return `Skill error [${res.code}]: ${res.message}.${available}`;
}
