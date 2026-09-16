// Budget-aware skill selection for one turn.
//
// This is the piece that makes "no silent truncation" affordable: instead of
// cutting a body that does not fit, the skill is DEFERRED with a one-line
// handle that tells the model the skill exists and how to load it. The
// deferred skill stays reachable (skill_invoke returns it in full), the prompt
// stays inside its budget, and nothing in the prompt is a half-instruction.
//
// Order of authority, highest first:
//   1. forcedSkills  — the user named it; loaded IN FULL at its turn in the
//                      queue, which is why it can use the whole section budget
//                      before auto-selection sees any of it
//   2. score >= 0.18 — the description/trigger/example match, best first
//   3. the token budget — decides loaded vs deferred for BOTH of the above
//
// Nothing here is capped by a COUNT. There is no "top 3 skills" rule: the
// number of auto-activated skills is whatever fits the token budget, and every
// match that does not fit is deferred with a handle (never dropped). A count
// cap could only ever make a skill disappear without a trace.

import { DEFAULT_THRESHOLD, MIN_MESSAGE_TOKENS, skillMatchScore, tokenize } from "./activate.js";
import { findSkill, type SkillEntry, type SkillSource } from "./loader.js";
import { costOfSkillText, readSkillByName, type SkillFailureCode } from "./read.js";

export interface SkillSelectionLoaded {
  name: string;
  source: SkillSource;
  text: string;
  tokens: number | null;
}

export interface SkillSelectionDeferred {
  name: string;
  source: SkillSource;
  /** Doubles as the rendered handle: it states the cost, the budget left, the
   *  skill's own description and the skill_invoke call that loads it. The
   *  selection shape has no separate handle field because the handle IS the
   *  reason — anything else would be a second, drift-prone explanation. */
  reason: string;
  tokenCost: number | null;
}

export interface SkillSelectionUnavailable {
  name: string;
  source: SkillSource;
  code: SkillFailureCode;
  reason: string;
  /** What the body would have cost and what was available, when the failure is
   *  SKILL_BUDGET_EXCEEDED. Stated as fields (not only inside `reason`) so a
   *  reader of `plan.skills` gets the numbers, not a sentence to parse. */
  tokenCost?: number;
  availableBudget?: number;
}

export interface SkillSelection {
  loaded: SkillSelectionLoaded[];
  deferred: SkillSelectionDeferred[];
  unavailable: SkillSelectionUnavailable[];
  discovered: number;
  selected: number;
  tokens: number;
  counting: "exact" | "estimated" | "unmeasured";
  diagnostics: string[];
}

export interface SelectSkillsOpts {
  userInput: string;
  /** every discovered skill in scope */
  all: SkillEntry[];
  /** disabledSkills */
  blocked: Set<string>;
  /** forcedSkills — EXPLICIT: beats auto, the score threshold and the
   *  disabledSkills list. It does NOT beat the assembly budget: a body that
   *  cannot fit is refused with SKILL_BUDGET_EXCEEDED (and its numbers), never
   *  sliced and never accepted as if it had been loaded whole. */
  forced: Set<string>;
  runtimeKind: string;
  /** The assembly budget every load on this path must fit. `null` = no budget
   *  was established (nothing is refused for size). This is the SAME number the
   *  explicit `skill_invoke` tool is given, so the two cannot disagree about
   *  what fits. */
  tokenBudget: number | null;
  measure: (text: string) => number | null;
  /** Same scope the skills were discovered in. Needed because a skill read is
   *  a registry lookup by name (readSkillByName) and project skills only exist
   *  for the workspaces they were scanned from. */
  workspaces?: string[];
  /** false = this agent turned AUTOMATIC activation off. Scoring is skipped
   *  entirely; forced skills still load in full, because switching auto off is
   *  not switching skills off. */
  autoActivation?: boolean;
}

export function selectSkills(opts: SelectSkillsOpts): SkillSelection {
  const workspaces = opts.workspaces ?? [];
  const diagnostics: string[] = [];
  const loaded: SkillSelectionLoaded[] = [];
  const deferred: SkillSelectionDeferred[] = [];
  const unavailable: SkillSelectionUnavailable[] = [];
  const byName = new Map(opts.all.map((s) => [s.name, s] as const));
  // A failed read carries no source, so it comes from the caller's discovery
  // list, then the registry. A name that is in neither is gone; "ensemble" is
  // the app-managed bucket it most likely came from.
  const sourceOf = (name: string): SkillSource =>
    byName.get(name)?.source ?? findSkill(name, workspaces)?.source ?? "ensemble";

  // null budget = no budget established, so nothing can be "too big".
  let remaining = opts.tokenBudget;
  let estimated = false;
  let counted = false;

  /** Token cost of a piece of prompt text — the SAME helper `readSkillByName`
   *  refuses with, so the number a skill is loaded under and the number it is
   *  refused under are one arithmetic.
   *
   *  A measurer that returns null or 0 for a NON-empty string has not measured
   *  anything — treating that as "0 tokens" is how a budget silently
   *  over-fills. UTF-8 byte length is a conservative upper bound (every
   *  tokenizer we target emits at most one token per byte) and it is labelled
   *  as an estimate in `counting` + diagnostics, never passed off as exact. */
  const costOf = (text: string): number => {
    const cost = costOfSkillText(text, opts.measure);
    if (text.length > 0) {
      counted = true;
      if (cost.estimated && !estimated) {
        estimated = true;
        diagnostics.push(
          "token measurer returned no count (null/0) for a non-empty skill body — falling back to UTF-8 byte length as a conservative upper bound (counting: estimated)",
        );
      }
    }
    return cost.tokens;
  };

  /** What is left of the section budget right now. Never negative: an exhausted
   *  budget is 0 available, not a negative allowance that a "cost > allowance"
   *  check would silently pass. */
  const availableNow = (): number | null => (remaining === null ? null : Math.max(0, remaining));

  /** Read a skill body through the one read path.
   *
   *  `budget` is passed only where an over-budget body must be REFUSED (the
   *  explicit/forced path). The auto path passes nothing on purpose: there, a
   *  body that does not fit is DEFERRED with a handle, and deferral is decided
   *  here by the same `costOf` arithmetic — two different outcomes, one cost. */
  const readOne = (name: string, budget: number | null = null) =>
    readSkillByName(name, {
      runtimeKind: opts.runtimeKind,
      workspaces,
      measure: opts.measure,
      tokenBudget: budget,
    });

  // 1) Forced skills. Explicit naming wins over the score threshold and the
  //    disabledSkills list — but NOT over the assembly budget. A user who names
  //    a skill that cannot fit gets a structured refusal naming the cost and the
  //    allowance, because the alternative (loading it anyway) is the one thing
  //    that makes the plan's own budget a lie.
  for (const name of opts.forced) {
    if (opts.blocked.has(name)) {
      diagnostics.push(`skill "${name}" is both forced and disabled — forced wins (explicit naming), loading in full`);
    }
    const res = readOne(name, availableNow());
    if (!res.ok) {
      unavailable.push({
        name,
        source: sourceOf(name),
        code: res.code,
        reason: res.message,
        ...(res.tokenCost === undefined ? {} : { tokenCost: res.tokenCost }),
        ...(res.availableBudget === undefined ? {} : { availableBudget: res.availableBudget }),
      });
      continue;
    }
    const cost = costOf(res.text);
    loaded.push({ name: res.name, source: res.source, text: res.text, tokens: cost });
    if (remaining !== null) remaining -= cost;
  }
  if (remaining !== null && remaining <= 0 && loaded.length > 0) {
    diagnostics.push(
      `the ${opts.tokenBudget}-token skill budget is fully consumed by explicit skills (${loaded.length} loaded), ` +
        "so no automatic selection can fit this turn",
    );
  }

  // 2) Auto-activation candidates, best score first.
  const candidates = opts.all.filter((s) => !opts.forced.has(s.name) && !opts.blocked.has(s.name));
  const messageTokens = tokenize(opts.userInput);
  if (opts.autoActivation === false) {
    diagnostics.push(
      "automatic skill activation is off for this agent (metadata.skillsAutoActivation=false): " +
        "no skill was scored for this turn; explicit skill_invoke and forcedSkills are unaffected",
    );
  } else if (messageTokens.size < MIN_MESSAGE_TOKENS) {
    diagnostics.push(
      `user message produced ${messageTokens.size} usable token(s) (< ${MIN_MESSAGE_TOKENS}) — auto-activation skipped (chit-chat guard)`,
    );
  } else {
    // Every discovered, non-forced, non-disabled skill is SCORED. There is no
    // pre-scoring candidate cap: a cap applied before the score cannot know
    // whether it dropped a match, which is precisely how a matched skill used to
    // vanish without appearing in `deferred` or in any diagnostic.
    const scored = candidates
      .map((skill) => ({ skill, ...skillMatchScore(messageTokens, skill) }))
      .filter((c) => c.score >= DEFAULT_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    for (const cand of scored) {
      const res = readOne(cand.skill.name);
      if (!res.ok) {
        unavailable.push({
          name: cand.skill.name,
          source: cand.skill.source,
          code: res.code,
          reason: res.message,
          ...(res.tokenCost === undefined ? {} : { tokenCost: res.tokenCost }),
          ...(res.availableBudget === undefined ? {} : { availableBudget: res.availableBudget }),
        });
        continue;
      }
      const cost = costOf(res.text);
      if (remaining !== null && cost > remaining) {
        deferred.push({
          name: res.name,
          source: res.source,
          reason: deferredReason(cand.skill, cost, remaining, opts.tokenBudget ?? remaining),
          tokenCost: cost,
        });
        // The budget is NOT charged for a deferred skill, and the loop keeps
        // going: a smaller candidate further down the ranking can still fit,
        // and dropping it because a big one missed would be a silent loss.
        continue;
      }
      loaded.push({ name: res.name, source: res.source, text: res.text, tokens: cost });
      if (remaining !== null) remaining -= cost;
    }
    if (deferred.length > 0) {
      diagnostics.push(
        `deferred ${deferred.length} matched skill(s) that did not fit the remaining token budget — they are listed by name + description and loadable with skill_invoke`,
      );
    }
  }

  return {
    loaded,
    deferred,
    unavailable,
    discovered: opts.all.length,
    // "selected" counts what is actually in the prompt; deferred skills were
    // matched but not selected, and reporting them as selected would make the
    // number disagree with the token total below.
    selected: loaded.length,
    tokens: loaded.reduce((n, l) => n + (l.tokens ?? 0), 0),
    counting: !counted ? "unmeasured" : estimated ? "estimated" : "exact",
    diagnostics,
  };
}

/** The deferred handle: description + cost + remaining budget + how to load. */
function deferredReason(skill: SkillEntry, cost: number, remaining: number, budget: number): string {
  return (
    `${skill.description} — its ${cost}-token body does not fit the ${budget}-token budget ` +
    `(${remaining} remaining), so it was NOT loaded; call skill_invoke ${skill.name} to load it in full`
  );
}

/** The prompt section: full bodies for loaded, a short handle for deferred.
 *  Never a truncated body — a partly-injected procedure reads as a complete
 *  one and the model has no way to notice the missing tail. */
export function renderSkillSelection(sel: SkillSelection, runtimeKind: string): string {
  void runtimeKind; // bodies are rendered (with their runtime-specific tool note) at select time
  if (sel.loaded.length === 0 && sel.deferred.length === 0 && sel.unavailable.length === 0) return "";
  const lines: string[] = [];
  if (sel.loaded.length > 0) {
    lines.push(
      "ACTIVE SKILLS (auto-selected based on the user's message — treat their",
      "instructions as part of your system prompt):",
      "",
      "--- skill bodies ---",
    );
    for (const l of sel.loaded) {
      lines.push("");
      lines.push(l.text);
    }
  }
  if (sel.deferred.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      "DEFERRED SKILLS (matched this turn but NOT loaded — their full bodies did",
      "not fit the token budget; call skill_invoke <name> to load one in full):",
    );
    for (const d of sel.deferred) lines.push(`- ${d.name} [${d.source}]: ${d.reason}`);
  }
  if (sel.unavailable.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      "UNAVAILABLE SKILLS (explicitly requested or matched, but not loaded —",
      "read the code and say so instead of guessing at their contents):",
    );
    for (const u of sel.unavailable) lines.push(`- ${u.name} [${u.source}]: ${u.code} — ${u.reason}`);
  }
  return lines.join("\n");
}
