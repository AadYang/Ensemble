import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.js";

const SKILLS: Record<"tdd" | "ralph" | "pr-gate", { name: string; description: string; body: string }> = {
  tdd: {
    name: "loop-tdd",
    description: "Test-driven loop: fix one failing test at a time until the verifier is green.",
    body: `You are in an Ensemble Loop (test-driven).

Rules:
- Do one failing test (or one failing assertion) per inner turn.
- Run the verifier after the edit. Do not claim done if it is red.
- Never start a long test suite as a background shell — it is already the Loop verifier / a job.
- Update TASKS.md checkboxes when an item is finished. Write ## DONE only when the whole goal is met.
`,
  },
  ralph: {
    name: "loop-ralph",
    description: "Fresh-session outer loop: state lives in TASKS.md, not in chat memory.",
    body: `You are in an Ensemble Loop (Ralph / fresh-disk).

Rules:
- Each outer iteration may start with an empty runtime session. TASKS.md is the memory.
- Read TASKS.md first. Do the first unfinished item only.
- After the verifier is green for that item, tick it. When nothing remains, write ## DONE.
- Do not rely on earlier chat turns being in context.
`,
  },
  "pr-gate": {
    name: "loop-pr-gate",
    description: "PR gate loop: fix lint, types and tests on the current branch until they pass review.",
    body: `You are in an Ensemble Loop (PR gate).

Rules:
- Stay on the current branch. Do not push unless the user asked.
- Fix what the verifier reports: lint, typecheck, tests.
- If a reviewer agent replies, treat LGTM as done and anything else as more work.
- Keep diffs surgical.
`,
  },
};

export function ensureLoopSkills(): void {
  const dir = join(DATA_DIR, "skills");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const skill of Object.values(SKILLS)) {
    const dest = join(dir, skill.name);
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    const file = join(dest, "SKILL.md");
    if (existsSync(file)) continue;
    writeFileSync(
      file,
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}`,
      "utf8",
    );
  }
}

export function loopSkillName(recipe: "tdd" | "ralph" | "pr-gate"): string {
  return SKILLS[recipe].name;
}
