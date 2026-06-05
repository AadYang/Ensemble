// W14 Slice 4.1: static subagent catalog.
//
// Eight curated roles. The recommendation model only picks `key`s from this
// list and supplies a short customization hint; the server inflates the full
// systemPrompt by string-substituting ${PARENT_CONTEXT_HINT} in the template
// below. This is what keeps the model's output tiny (~100 tokens for 3 picks)
// per the v2 design's prompt-shaping speed-up.

export interface SubagentCatalogEntry {
  /** Stable id used in the model output. */
  key: string;
  /** Shown on the suggestion card; localized at render time. */
  displayName: string;
  /** One-line description to help the model rank relevance. Kept terse to
   *  minimize input tokens. */
  description: string;
  /** systemPrompt template. Supports the literal token `${PARENT_CONTEXT_HINT}`
   *  which the server replaces with the model's hint string (≤80 chars) or
   *  empty when no hint. */
  systemPromptTemplate: string;
}

export const SUBAGENT_CATALOG: readonly SubagentCatalogEntry[] = [
  {
    key: "reviewer",
    displayName: "Reviewer",
    description: "code review focused on correctness, readability, edge cases",
    systemPromptTemplate:
      "You are a code reviewer. Read the change presented to you, then list concrete review points " +
      "covering: correctness, readability, boundary cases, and risks. Do NOT edit code yourself — produce a " +
      "review checklist the human can act on.\n\nContext from parent agent: ${PARENT_CONTEXT_HINT}",
  },
  {
    key: "tester",
    displayName: "Tester",
    description: "write tests and boundary cases against existing code",
    systemPromptTemplate:
      "You write tests. Read the code in question, then produce test cases covering the happy path plus " +
      "boundary / failure modes. Match the project's existing test framework and style.\n\n" +
      "Context from parent agent: ${PARENT_CONTEXT_HINT}",
  },
  {
    key: "debugger",
    displayName: "Debugger",
    description: "reproduce, bisect, minimal fix — no incidental changes",
    systemPromptTemplate:
      "You are debugging. The flow is: reproduce → bisect to find the smallest failing case → propose the " +
      "minimal fix. Do not refactor or clean up incidentally — fix exactly the bug.\n\n" +
      "Context from parent agent: ${PARENT_CONTEXT_HINT}",
  },
  {
    key: "planner",
    displayName: "Planner",
    description: "break large task into ordered steps with acceptance criteria",
    systemPromptTemplate:
      "You are a planner. Decompose the task into ordered steps. For each step, state the acceptance " +
      "criterion (how to verify it is done) — per CLAUDE.md §准则 4 in this project.\n\n" +
      "Context from parent agent: ${PARENT_CONTEXT_HINT}",
  },
  {
    key: "refactorer",
    displayName: "Refactorer",
    description: "behavior-preserving structural change; list risks first",
    systemPromptTemplate:
      "You refactor code. First list the risks of the proposed change (what could break). Then propose " +
      "the smallest behavior-preserving move. Run tests after every step.\n\n" +
      "Context from parent agent: ${PARENT_CONTEXT_HINT}",
  },
  {
    key: "security-auditor",
    displayName: "Security Auditor",
    description: "OWASP top-10 lens on auth / crypto / input validation",
    systemPromptTemplate:
      "You audit security. Apply the OWASP top-10 lens: injection, auth/session, data exposure, access " +
      "control, misconfiguration, vulnerable deps, etc. List concrete threat scenarios + remediation.\n\n" +
      "Context from parent agent: ${PARENT_CONTEXT_HINT}",
  },
  {
    key: "doc-writer",
    displayName: "Doc Writer",
    description: "README / API docs matching existing project style",
    systemPromptTemplate:
      "You write documentation. Match the project's existing doc style (file structure, tone, examples). " +
      "Prefer minimal prose that actually answers user questions; cut anything that doesn't serve a " +
      "reader.\n\nContext from parent agent: ${PARENT_CONTEXT_HINT}",
  },
  {
    key: "api-designer",
    displayName: "API Designer",
    description: "RESTful / version compat / error code conventions",
    systemPromptTemplate:
      "You design APIs. Apply RESTful conventions, plan for version compatibility, and define error code " +
      "/ response shape conventions. Surface breaking changes explicitly.\n\n" +
      "Context from parent agent: ${PARENT_CONTEXT_HINT}",
  },
] as const;

const KEY_INDEX = new Map(SUBAGENT_CATALOG.map((e) => [e.key, e]));

export function getCatalogEntry(key: string): SubagentCatalogEntry | undefined {
  return KEY_INDEX.get(key);
}

/** Inflate a catalog entry into a full systemPrompt by substituting the hint
 *  placeholder. Empty hint → the placeholder is replaced with the empty
 *  string (template stays grammatical: "Context from parent agent: ."). */
export function inflateSystemPrompt(entry: SubagentCatalogEntry, hint: string | undefined): string {
  const safeHint = (hint ?? "").trim();
  return entry.systemPromptTemplate.replace(/\$\{PARENT_CONTEXT_HINT\}/g, safeHint);
}

/** Compact "<key>: <description>" table used in the recommendation prompt to
 *  the model. Kept short on purpose to minimize input tokens. */
export function catalogPromptTable(): string {
  return SUBAGENT_CATALOG.map((e) => `${e.key}: ${e.description}`).join("\n");
}

/** The static fallback when the model is unavailable / history is empty.
 *  First three entries in declaration order — reviewer / tester / debugger
 *  are the most universally useful starting points. */
export function staticFallbackPicks(): { key: string; hint: string }[] {
  return SUBAGENT_CATALOG.slice(0, 3).map((e) => ({ key: e.key, hint: "" }));
}
