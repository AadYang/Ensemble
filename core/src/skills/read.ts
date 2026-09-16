// The ONE skill read/render path.
//
// Explicit `skill_invoke` (MCP tool, OpenAI tool, SessionManager handler),
// the auto-activation loader and the selection renderer all funnel through
// readSkillByName / renderSkill. That is the point: a body that renders one
// way when the user names it and another way when auto-activation picks it is
// a body that has two behaviours to debug, and "the skill is in the prompt"
// stops being a single verifiable claim.
//
// Two rules hold here and nowhere else needs to re-implement them:
//   1. Never truncate. If a body does not fit a budget it is deferred (see
//      select.ts) with a handle; it is never sliced.
//   2. Failures are structured. A read either succeeds (whole body + a token
//      count, possibly null for "unmeasurable") or returns a coded error the
//      caller can act on. No success-shaped error strings.

import { readFileSync } from "node:fs";
import { findSkill, loadSkills, parseFrontmatter, type SkillEntry, type SkillSource } from "./loader.js";

export type SkillFailureCode =
  | "SKILL_NOT_FOUND"
  | "SKILL_UNREADABLE"
  | "SKILL_INCOMPLETE_BODY"
  | "SKILL_BUDGET_EXCEEDED";

export interface SkillReadOk {
  ok: true;
  name: string;
  source: SkillSource;
  /** Fully rendered skill text — the whole body, never a slice of it. */
  text: string;
  /** Tokens in `text`, or null when the injected measurer could not measure. */
  tokens: number | null;
}

export interface SkillReadError {
  ok: false;
  code: SkillFailureCode;
  name: string;
  message: string;
  /** Up to 20 discovered skill names, sorted — so a caller can say what IS
   *  available without a second registry call. */
  available: string[];
  /** What the body WOULD have cost, and what was available. Present on
   *  SKILL_BUDGET_EXCEEDED so the caller can report the numbers instead of a
   *  vague "too big", and useful to a human who wants to trim the skill. */
  tokenCost?: number;
  availableBudget?: number;
}

export type SkillReadResult = SkillReadOk | SkillReadError;

export interface SkillReadOpts {
  runtimeKind: string;
  workspaces?: string[];
  /** Injected token measurer; `null` result means "unmeasurable". */
  measure?: (text: string) => number | null;
  /** The assembly budget this read must fit, when one is established. `null`
   *  (or omitted) means no budget was established, so nothing is refused for
   *  size. Never a licence to send more than the plan allows: a caller that has
   *  a plan passes its budget, and the conservative figure when it cannot know
   *  the exact remainder. */
  tokenBudget?: number | null;
}

const AVAILABLE_LIMIT = 20;

export interface SkillCost {
  tokens: number;
  /** True when the number is the conservative UTF-8 byte upper bound rather
   *  than a measurement, because the measurer returned nothing usable. */
  estimated: boolean;
}

/** Token cost of a skill body under an injected measurer.
 *
 *  A measurer that returns null or 0 for a NON-empty body has not measured
 *  anything — treating that as "0 tokens" is how a budget silently over-fills.
 *  UTF-8 byte length is a conservative upper bound (every tokenizer we target
 *  emits at most one token per byte) and the caller labels it as an estimate.
 *  Shared with `select.ts` so both paths refuse on the SAME number. */
export function costOfSkillText(text: string, measure?: (text: string) => number | null): SkillCost {
  if (text.length === 0) return { tokens: 0, estimated: false };
  let n: number | null = null;
  try {
    n = measure ? measure(text) : null;
  } catch {
    n = null;
  }
  if (n === null || !Number.isFinite(n) || n <= 0) {
    return { tokens: Buffer.byteLength(text, "utf8"), estimated: true };
  }
  return { tokens: Math.ceil(n), estimated: false };
}

/** Names in the same scope the read used, sorted, capped. */
function availableNames(workspaces: string[]): string[] {
  return loadSkills(workspaces)
    .map((s) => s.name)
    .sort()
    .slice(0, AVAILABLE_LIMIT);
}

/** The one body renderer. Header, optional tool note, blank line, body.
 *
 *  The Codex tool note spells out both consequences ("no per-call tool gate"
 *  and "ignores this") in one sentence because callers on both runtimes read
 *  this text and each had grown its own half of the explanation. */
function renderSkillText(skill: SkillEntry, runtimeKind: string): string {
  const lines = [`[skill: ${skill.name}]`, `[description: ${skill.description}]`];
  if (skill.tools && skill.tools.length > 0) {
    lines.push(
      runtimeKind === "openai-codex"
        ? `(skill recommends restricting to: ${skill.tools.join(", ")} — note: Codex runtime has no per-call tool gate, so Codex runtime ignores this; sandboxMode is the gate)`
        : `(skill recommends restricting to: ${skill.tools.join(", ")})`,
    );
  }
  lines.push("", skill.body);
  return lines.join("\n");
}

/** Render one already-loaded skill entry (same renderer, no second format).
 *  `tokens` is null — there is no measurer on this path; a caller that needs a
 *  count calls readSkillByName with `measure`. */
export function renderSkill(skill: SkillEntry, runtimeKind: string): SkillReadOk {
  const text = renderSkillText(skill, runtimeKind);
  return { ok: true, name: skill.name, source: skill.source, text, tokens: null };
}

/** The single complete read path: explicit skill_invoke, the MCP tool and the
 *  auto-activation loader all go through here. Never truncates.
 *
 *  The body is re-read from `skill.path` rather than taken from the registry
 *  entry. The registry is a 30s cache, and "the body is in the prompt" is a
 *  stronger promise than "the body existed when the dir was last scanned": a
 *  skill deleted or emptied after discovery would otherwise be injected from
 *  a stale copy the user believes is gone. If the re-read fails we report
 *  UNREADABLE — silently falling back to the cached body is how a deleted
 *  skill keeps steering the agent. */
export function readSkillByName(name: string, opts: SkillReadOpts): SkillReadResult {
  const workspaces = opts.workspaces ?? [];
  const skill = findSkill(name, workspaces);
  if (!skill) {
    return {
      ok: false,
      code: "SKILL_NOT_FOUND",
      name,
      message: `No skill named "${name}"`,
      available: availableNames(workspaces),
    };
  }
  let raw: string;
  try {
    raw = readFileSync(skill.path, "utf8");
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return {
      ok: false,
      code: "SKILL_UNREADABLE",
      name,
      // The errno code is stated up front AND left in the message: the code is
      // what callers branch on, the full message is what a human debugging a
      // moved skills dir needs. ENOENT is not special-cased — a missing file
      // and a permissions failure are both "we cannot read this right now".
      message: `Could not read ${skill.path} (${errno}): ${(err as Error).message}`,
      available: availableNames(workspaces),
    };
  }
  const body = parseFrontmatter(raw).body;
  if (!body.trim()) {
    return {
      ok: false,
      code: "SKILL_INCOMPLETE_BODY",
      name,
      message: `Skill "${name}" has an empty body (${skill.path})`,
      available: availableNames(workspaces),
    };
  }
  // The freshly parsed body wins over the cached one; the entry's other fields
  // (name/description/tools/source) come from the registry.
  const text = renderSkillText({ ...skill, body }, opts.runtimeKind);
  const available = availableNames(workspaces);
  // The budget is checked on the RENDERED text — the header and the runtime's
  // tool note are part of what goes into the context. Over budget is a REFUSAL,
  // not a slice: a half-injected procedure reads as a complete one, and the
  // model has no way to notice the missing tail. The body stays fully readable
  // through the registry (`loadSkills`), so nothing is lost by refusing.
  if (opts.tokenBudget !== undefined && opts.tokenBudget !== null) {
    const cost = costOfSkillText(text, opts.measure);
    if (cost.tokens > opts.tokenBudget) {
      return {
        ok: false,
        code: "SKILL_BUDGET_EXCEEDED",
        name,
        message:
          `Skill "${name}" needs ${cost.tokens} tokens but only ${opts.tokenBudget} are available for skills this turn` +
          ` (${skill.path}); it is not truncated — raise the budget, or trim the skill body`,
        available,
        tokenCost: cost.tokens,
        availableBudget: opts.tokenBudget,
      };
    }
    return { ok: true, name: skill.name, source: skill.source, text, tokens: cost.tokens };
  }
  return {
    ok: true,
    name: skill.name,
    source: skill.source,
    text,
    tokens: opts.measure ? opts.measure(text) : null,
  };
}
