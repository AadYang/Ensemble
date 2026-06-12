// Public skills surface. SessionManager + routes import from here only.
//
// Per-agent skill control lives in Agent.metadata:
//   - disabledSkills: string[]   names that auto-activation should skip
//   - forcedSkills:   string[]   names ALWAYS injected this turn regardless of score

export type { SkillEntry, SkillSource } from "./loader.js";
export { loadSkills, findSkill, reloadSkills, __setSkillsForTest, __setSkillRootOverridesForTest } from "./loader.js";
export {
  pickActiveSkills,
  formatActiveSkills,
  formatSkillBody,
  scoreSkillMatch,
} from "./activate.js";
export { formatSkillListForTool, formatSkillInvokeForTool } from "./tool-format.js";

export function readSkillBlocklist(metadata: unknown): Set<string> {
  if (metadata && typeof metadata === "object" && "disabledSkills" in metadata) {
    const v = (metadata as { disabledSkills: unknown }).disabledSkills;
    if (Array.isArray(v)) return new Set(v.filter((x): x is string => typeof x === "string"));
  }
  return new Set();
}

export function readSkillForcelist(metadata: unknown): Set<string> {
  if (metadata && typeof metadata === "object" && "forcedSkills" in metadata) {
    const v = (metadata as { forcedSkills: unknown }).forcedSkills;
    if (Array.isArray(v)) return new Set(v.filter((x): x is string => typeof x === "string"));
  }
  return new Set();
}
