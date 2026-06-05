// Auto-activation scoring for skills. Cheap tokenized overlap — no embeddings,
// no external deps. Goal: pick top-N skills whose description best matches
// the user's incoming message. Skills with no description (filtered at load
// time) can never activate; explicit /skill enable bypasses this entirely.
//
// Tuning knobs are intentionally conservative — false-positive auto-activation
// is more annoying than false-negative (a missed skill that the user can still
// invoke explicitly).

import type { SkillEntry } from "./loader.js";

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

function tokenize(s: string): Set<string> {
  // Lowercase, strip URL-ish chars, split on whitespace + punctuation. Keeps
  // CJK clusters as single tokens (rough but functional — CJK skill matching
  // works better at the multichar level for v2 simplicity).
  const cleaned = s.toLowerCase().replace(/[^\p{Letter}\p{Number}_\-/]+/gu, " ");
  const tokens = new Set<string>();
  for (const t of cleaned.split(/\s+/)) {
    if (!t || t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    tokens.add(t);
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

const DEFAULT_THRESHOLD = 0.18;
const DEFAULT_MAX_ACTIVE = 3;
const MIN_MESSAGE_TOKENS = 3; // skip auto-activation on tiny messages (chit-chat / confirmations)

export interface ActivateOpts {
  /** override default 0.18 */
  threshold?: number;
  /** override default 3 */
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
  const maxActive = opts.maxActive ?? DEFAULT_MAX_ACTIVE;
  const scored = skills
    .map((s) => ({ skill: s, score: scoreSkillMatch(tokens, s.description) }))
    .filter((x) => x.score >= threshold);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxActive).map((x) => x.skill);
}

/** Format the active-skill bodies for injection at the end of the systemPrompt.
 *  Each skill clearly delimited; tool-restriction note attached for runtimes
 *  that ignore it (Codex). */
const PER_SKILL_BODY_CAP = 4000;

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
    lines.push(`[skill: ${s.name}]`);
    if (s.tools && s.tools.length > 0) {
      if (runtimeKind === "openai-codex") {
        lines.push(
          `(skill specifies tool restriction: ${s.tools.join(", ")} — note: Codex runtime has no per-call tool gate; sandboxMode applies instead)`,
        );
      } else {
        lines.push(`(skill recommends restricting to: ${s.tools.join(", ")})`);
      }
    }
    lines.push("");
    let body = s.body;
    if (body.length > PER_SKILL_BODY_CAP) {
      body = `${body.slice(0, PER_SKILL_BODY_CAP)}\n\n[...skill body truncated at ${PER_SKILL_BODY_CAP} chars...]`;
    }
    lines.push(body);
  }
  return lines.join("\n");
}

/** Format the body of a single explicitly-invoked skill (skill_invoke MCP). */
export function formatSkillBody(skill: SkillEntry, runtimeKind: string): string {
  const lines = [`[skill: ${skill.name}]`, `[description: ${skill.description}]`];
  if (skill.tools && skill.tools.length > 0) {
    if (runtimeKind === "openai-codex") {
      lines.push(
        `[tool restrictions: ${skill.tools.join(", ")} — note: Codex runtime ignores this; sandboxMode is the gate]`,
      );
    } else {
      lines.push(`[recommended tools: ${skill.tools.join(", ")}]`);
    }
  }
  lines.push("", skill.body);
  return lines.join("\n");
}
