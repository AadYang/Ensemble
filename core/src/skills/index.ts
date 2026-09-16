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
  skillMatchScore,
} from "./activate.js";
export { formatSkillListForTool, formatSkillInvokeForTool, skillInvokeToolResult } from "./tool-format.js";
// The one read/render path + the budget-aware selection on top of it.
export { readSkillByName, renderSkill } from "./read.js";
export type {
  SkillReadResult,
  SkillReadOk,
  SkillReadError,
  SkillReadOpts,
  SkillFailureCode,
} from "./read.js";
export { selectSkills, renderSkillSelection } from "./select.js";
export type {
  SkillSelection,
  SkillSelectionLoaded,
  SkillSelectionDeferred,
  SkillSelectionUnavailable,
  SelectSkillsOpts,
} from "./select.js";

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

/** Whether this agent's automatic skill activation is on.
 *
 *  Off by default nothing: an agent that never touched the switch keeps
 *  auto-activation. The switch is a hard gate on SELECTION only — an explicit
 *  `skill_invoke`, and a name in `forcedSkills`, still load their full body,
 *  because turning off auto-activation is not the same as turning off skills. */
export function readSkillAutoActivation(metadata: unknown): boolean {
  if (metadata && typeof metadata === "object" && "skillsAutoActivation" in metadata) {
    return (metadata as { skillsAutoActivation: unknown }).skillsAutoActivation !== false;
  }
  return true;
}
