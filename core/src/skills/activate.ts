// Auto-activation scoring for skills. Cheap tokenized overlap — no embeddings,
// no external deps. Goal: pick top-N skills whose description best matches
// the user's incoming message. Skills with no description (filtered at load
// time) can never activate; explicit /skill enable bypasses this entirely.
//
// Tuning knobs are intentionally conservative — false-positive auto-activation
// is more annoying than false-negative (a missed skill that the user can still
// invoke explicitly).

import type { SkillEntry } from "./loader.js";
import { renderSkill } from "./read.js";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "by", "is", "are", "was", "were", "be", "been", "being", "this", "that",
  "these", "those", "it", "its", "as", "at", "from", "i", "you", "he", "she",
  "we", "they", "me", "him", "her", "us", "them", "my", "your", "his", "our",
  "their", "do", "does", "did", "have", "has", "had", "can", "could", "would",
  "should", "may", "might", "will", "shall", "if", "when", "while", "use",
  "used", "using", "so", "not", "no", "yes", "than", "then", "what", "how",
  "why", "where", "which", "who", "whom",
  "一", "了", "的", "是", "在", "和", "我", "你", "他", "她", "它", "我们",
  "你们", "他们", "什么", "怎么", "为什么", "如何", "请", "把", "给",
]);

/** Scripts handled by word segmentation rather than by the whitespace split.
 *  Han covers Chinese + Japanese kanji; kana and Hangul behave the same way
 *  (no inter-word spaces), so they take the same path. */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Word-segment a CJK-bearing run.
 *
 *  `Intl.Segmenter` is the real dictionary-based cutter (V8 ships one), which
 *  is what makes 2-character words like 我们 / 技能 one token instead of three
 *  arbitrary fragments. It is read off `Intl` at call time — never captured in
 *  a module constant — so environments without it (older Node, some SEA
 *  builds, tests that delete it) fall through to the n-gram path instead of
 *  throwing at import time. */
function segmentCjkRun(run: string): string[] {
  try {
    const Segmenter = (Intl as { Segmenter?: new (locale: string, opts: { granularity: "word" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    if (Segmenter) {
      const seg = new Segmenter("zh", { granularity: "word" });
      const out: string[] = [];
      for (const part of seg.segment(run)) {
        const t = part.segment.trim();
        if (t) out.push(t);
      }
      if (out.length > 0) return out;
    }
  } catch {
    // Fall through — a broken segmenter must not disable matching entirely.
  }
  // Fallback: 1-grams + 2-grams. Noisy (2-grams of unrelated characters like
  // 文技 never match anything), but it keeps recall for the CJK case, and the
  // description-size normalization means the noise dilutes both sides equally.
  const chars = [...run];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    out.push(chars[i]!);
    if (i + 1 < chars.length) out.push(chars[i]! + chars[i + 1]!);
  }
  return out;
}

/** Split one whitespace-delimited run into match tokens.
 *
 *  A CJK-bearing run yields its segments ONLY — never the whole run. Keeping
 *  the whole run as a token (the old behaviour) meant a long Chinese sentence
 *  was matched as one giant string, which nothing could ever equal. */
function tokenizeRun(run: string): string[] {
  if (!CJK_RE.test(run)) return [run];
  return segmentCjkRun(run);
}

/** Tokenize free text for skill matching. Exported because select.ts scores
 *  with the same tokenizer — two tokenizers would drift and the auto-activated
 *  set would stop agreeing with the score pickActiveSkills computes. */
export function tokenize(s: string): Set<string> {
  // NFKC first: full-width Latin (ＳＫＩＬＬ) is the same word as ASCII to a
  // human, so it has to be the same token to the matcher. Lowercase after,
  // because NFKC can produce new case pairs.
  const cleaned = s.normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Number}_\-/]+/gu, " ");
  const tokens = new Set<string>();
  for (const run of cleaned.split(/\s+/)) {
    if (!run) continue;
    for (const t of tokenizeRun(run)) {
      // Length filter is CJK-aware: a single CJK character carries meaning AND
      // is the only way the one-character Chinese stopwords below can ever be
      // seen (they are dropped by the stopword list, not by a length rule). A
      // single ASCII character is still noise.
      if (t.length < 2 && !CJK_RE.test(t)) continue;
      // Stopwords are applied AFTER segmentation so 我们 / 请 are matched as
      // the words they are.
      if (STOPWORDS.has(t)) continue;
      tokens.add(t);
    }
  }
  return tokens;
}

/** 0..1 score: fraction of description-tokens that appear in message-tokens. */
export function scoreSkillMatch(messageTokens: Set<string>, description: string): number {
  const desc = tokenize(description);
  if (desc.size === 0) return 0;
  let hits = 0;
  for (const t of desc) {
    if (messageTokens.has(t)) hits++;
  }
  return hits / desc.size;
}

// Trigger/example weights. A trigger is an author's explicit "this skill is
// for this wording" statement, so one hit is worth more than a perfect
// description score's worth of overlap; examples are illustrative and worth
// less. Both are capped so an over-eager `examples:` block cannot carry a
// skill past a genuinely better description match.
const TRIGGER_WEIGHT = 0.35;
const TRIGGER_BOOST_CAP = 1;
const EXAMPLE_WEIGHT = 0.15;
const EXAMPLE_BOOST_CAP = 0.45;

/** Whole-phrase match: EVERY token of the phrase must be in the message.
 *
 *  Deliberately not "any token overlaps" — a partial trigger hit ("code" for
 *  the trigger "code review") would boost exactly the false positives the
 *  description score already produces, which is the opposite of what a trigger
 *  is for. */
function phraseHits(messageTokens: Set<string>, phrase: string): boolean {
  const toks = tokenize(phrase);
  if (toks.size === 0) return false;
  for (const t of toks) {
    if (!messageTokens.has(t)) return false;
  }
  return true;
}

function matchedPhrases(messageTokens: Set<string>, phrases: string[] | undefined): string[] {
  if (!phrases || phrases.length === 0) return [];
  return phrases.filter((p) => phraseHits(messageTokens, p));
}

/** Description overlap (the primary score) plus trigger/example boosts.
 *
 *  The primary term is exactly `scoreSkillMatch(messageTokens, skill.description)`:
 *  a skill with no triggers/examples scores identically to before, so adding
 *  frontmatter keys can only ever ADD activation, never take it away. */
export function skillMatchScore(
  messageTokens: Set<string>,
  skill: SkillEntry,
): { score: number; reason: string } {
  const base = scoreSkillMatch(messageTokens, skill.description);
  const triggerHits = matchedPhrases(messageTokens, skill.triggers);
  const exampleHits = matchedPhrases(messageTokens, skill.examples);
  const triggerBoost = Math.min(TRIGGER_BOOST_CAP, triggerHits.length * TRIGGER_WEIGHT);
  const exampleBoost = Math.min(EXAMPLE_BOOST_CAP, exampleHits.length * EXAMPLE_WEIGHT);
  const parts = [`description ${base.toFixed(2)}`];
  if (triggerHits.length > 0) parts.push(`triggers +${triggerBoost.toFixed(2)} (${triggerHits.join(", ")})`);
  if (exampleHits.length > 0) parts.push(`examples +${exampleBoost.toFixed(2)} (${exampleHits.join(", ")})`);
  return { score: base + triggerBoost + exampleBoost, reason: parts.join("; ") };
}

// Exported for select.ts: the auto-activation tuning must be one definition,
// or the two paths disagree about which skills are "active" for the same turn.
export const DEFAULT_THRESHOLD = 0.18;
// There is deliberately NO default count cap. A fixed "3 auto skills" silently
// dropped every match past the third, and the number had nothing to do with the
// model, the window or the skill sizes: two 50-token skills and two 4 000-token
// ones were capped identically. How many auto-activate is decided by the turn's
// TOKEN budget in select.ts, which can both load a fitting skill and defer the
// ones that do not fit — a count cap can only drop them.
// skip auto-activation on tiny messages (chit-chat / confirmations)
export const MIN_MESSAGE_TOKENS = 3;

export interface ActivateOpts {
  /** override default 0.18 */
  threshold?: number;
  /** An EXPLICIT cap, with no default. Only a caller that has a reason to bound
   *  the count passes one; when it is absent every match that clears the
   *  threshold is returned. */
  maxActive?: number;
}

/** Given the user's incoming message + the eligible skill list, return the
 *  subset that should auto-activate this turn, in score-desc order. */
export function pickActiveSkills(
  message: string,
  skills: SkillEntry[],
  opts: ActivateOpts = {},
): SkillEntry[] {
  if (!message || skills.length === 0) return [];
  const tokens = tokenize(message);
  if (tokens.size < MIN_MESSAGE_TOKENS) return [];
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const scored = skills
    .map((s) => ({ skill: s, score: skillMatchScore(tokens, s).score }))
    .filter((x) => x.score >= threshold);
  scored.sort((a, b) => b.score - a.score);
  // No cap unless the caller asked for one: the budget (select.ts) decides how
  // many bodies actually fit, and a match that does not fit is DEFERRED with a
  // handle rather than dropped here where nothing can report it.
  const matched = opts.maxActive === undefined ? scored : scored.slice(0, Math.max(0, opts.maxActive));
  return matched.map((x) => x.skill);
}

/** Format the active-skill bodies for injection at the end of the systemPrompt.
 *  Each skill clearly delimited; tool-restriction note attached for runtimes
 *  that ignore it (Codex).
 *
 *  Bodies are injected WHOLE. There is deliberately no per-skill cap here: a
 *  skill that does not fit the turn's token budget is handled upstream by
 *  selectSkills, which defers it with a handle instead of slicing it. A
 *  half-injected skill is worse than no skill — the model cannot tell that the
 *  rest of the procedure exists, and the truncation marker reads as an
 *  instruction to continue. */
export function formatActiveSkills(skills: SkillEntry[], runtimeKind: string): string {
  if (skills.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    "ACTIVE SKILLS (auto-selected based on the user's message — treat their",
    "instructions as part of your system prompt):",
    "",
  );
  for (const s of skills) {
    lines.push(`- ${s.name}: ${s.description}`);
  }
  lines.push("");
  lines.push("--- skill bodies ---");
  for (const s of skills) {
    lines.push("");
    // The shared renderer from read.ts — same header, same tool note, same
    // body as skill_invoke emits, so a skill cannot look different depending
    // on how it got into the prompt.
    lines.push(renderSkill(s, runtimeKind).text);
  }
  return lines.join("\n");
}

/** Format the body of a single explicitly-invoked skill (skill_invoke MCP).
 *  Thin wrapper over the one renderer in read.ts. */
export function formatSkillBody(skill: SkillEntry, runtimeKind: string): string {
  return renderSkill(skill, runtimeKind).text;
}
