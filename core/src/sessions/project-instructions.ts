// Project instructions for runtimes that do not read them under Ensemble's
// actual adapter configuration.
//
// Codex reads project instructions from the cwd itself. The OpenAI/API runtime
// has no directory awareness, so Ensemble must load them. Claude Code normally
// understands CLAUDE.md, but our adapter supplies a complete string
// `systemPrompt` and disables filesystem `settingSources`; under that exact
// configuration the SDK performs no CLAUDE.md walk-up. Ensemble therefore
// injects the same full block for Claude too, while leaving Codex alone.
//
// The boundaries are the ones the plan drew:
//   • files directly inside the project root — never a parent directory and
//     never the user's home, so a repo cannot pull in rules from above itself;
//   • no root at all (an unbound agent working in scratch) means no project
//     instructions: a scratch dir is a session buffer, not the user's project;
//   • the WHOLE file is injected, or the turn is refused. The native CLIs read
//     these files in full, so a silently shortened copy would mean the same
//     project has two different rule sets depending on which runtime ran —
//     and the half that gets dropped is exactly the part a user would put at
//     the end (constraints, "never do X"). Budgeting belongs to the token
//     accounting work, not here.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Instruction files read from the project root, in order. `AGENTS.md` is the
 *  cross-tool convention; `CLAUDE.md` is honored because projects that already
 *  keep their rules there should not have to duplicate the file. */
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export type ProjectInstructionsErrorCode = "PROJECT_INSTRUCTIONS_UNREADABLE";

/** An instruction file that EXISTS but cannot be read into the prompt. This is
 *  not "no instructions": the project has rules and the API runtime would run
 *  without them, so the turn is refused with a code the caller can show. */
export class ProjectInstructionsRejected extends Error {
  readonly code: ProjectInstructionsErrorCode;
  readonly path: string;
  constructor(code: ProjectInstructionsErrorCode, path: string, reason: string) {
    super(reason);
    this.name = "ProjectInstructionsRejected";
    this.code = code;
    this.path = path;
  }
}

export const isProjectInstructionsRejection = (
  err: unknown,
): err is ProjectInstructionsRejected =>
  err instanceof ProjectInstructionsRejected ||
  (typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "PROJECT_INSTRUCTIONS_UNREADABLE");

const ENOENT = "ENOENT";

export interface ProjectInstructionFile {
  /** Absolute path of the file that was read. */
  path: string;
  /** Basename, used as the heading. */
  name: string;
  text: string;
}

/** Read the project instruction files that exist directly under `projectRoot`.
 *
 *  A file that is simply absent is ignored — most projects have none. A file
 *  that is present but unreadable (permissions, a directory in its place, an
 *  I/O error) THROWS: see the module header for why the API runtime must not
 *  carry on with a partial rule set. */
export function loadProjectInstructions(projectRoot: string | null): ProjectInstructionFile[] {
  if (!projectRoot) return [];
  const out: ProjectInstructionFile[] = [];
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const path = join(projectRoot, name);
    let exists = true;
    try {
      // A directory named AGENTS.md is NOT an instruction file to skip: the
      // user put something at that name and we cannot read rules out of it.
      if (!statSync(path).isFile()) {
        throw new ProjectInstructionsRejected(
          "PROJECT_INSTRUCTIONS_UNREADABLE",
          path,
          `${name} exists in the project root but is not a file: ${path}`,
        );
      }
    } catch (err) {
      if (isProjectInstructionsRejection(err)) throw err;
      if ((err as { code?: string }).code === ENOENT) exists = false;
      else {
        throw new ProjectInstructionsRejected(
          "PROJECT_INSTRUCTIONS_UNREADABLE",
          path,
          `the project instruction file could not be inspected (${String(err)}): ${path}`,
        );
      }
    }
    if (!exists) continue;
    try {
      out.push({ path, name, text: readFileSync(path, "utf8") });
    } catch (err) {
      throw new ProjectInstructionsRejected(
        "PROJECT_INSTRUCTIONS_UNREADABLE",
        path,
        `the project instruction file could not be read (${String(err)}): ${path}`,
      );
    }
  }
  return out;
}

/** Render the loaded files as ONE prompt block, or null when there is nothing
 *  to inject. Callers add the result to the system prompt once per turn; the
 *  block is delimited so the model can tell project rules apart from its own
 *  agent instructions. */
export function renderProjectInstructionsBlock(files: ProjectInstructionFile[]): string | null {
  if (files.length === 0) return null;
  const sections = files.map(
    (f) => `<project-instruction file="${f.name}">\n${f.text.trim()}\n</project-instruction>`,
  );
  return [
    "## Project instructions",
    "",
    "Loaded from the directory this agent is bound to. They describe the project",
    "you are working in and apply to everything you do in this turn.",
    "",
    ...sections,
  ].join("\n");
}
