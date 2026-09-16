// Phase 3 skill tests: the one read/render path, structured failures and
// budget-aware auto-activation. Fixtures are REAL temp-dir SKILL.md files so
// the read path (re-read from disk) is genuinely exercised — a registry-seam
// fixture would fake away exactly the behaviour under test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { makeSkillMcpServer } from "../skill-mcp.js";
import {
  __setSkillRootOverridesForTest,
  loadSkills,
  readSkillByName,
  selectSkills,
  renderSkillSelection,
  pickActiveSkills,
  formatActiveSkills,
  skillMatchScore,
  type SkillEntry,
} from "../skills/index.js";
// The tokenizer is shared with select.ts; the test reaches for it directly to
// assert what it does and does not emit.
import { tokenize } from "../skills/activate.js";

const MARKER_A = "MARKER_ALPHA_PAST_4000";
const MARKER_B = "MARKER_BETA_PAST_8000";

/** >9000 chars, with the two markers well past the old 4000-char truncation
 *  point and past 8000 respectively. */
function bigBody(): string {
  return [
    "STEP 1: read the diff",
    "x".repeat(4500),
    MARKER_A,
    "y".repeat(4000),
    MARKER_B,
    "z".repeat(500),
  ].join("\n");
}

const countByChars = (text: string): number => Math.ceil(text.length / 4);

let temp: string;
let ensembleRoot: string;

function writeSkillFile(root: string, name: string, frontmatter: string, body: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\n${frontmatter}---\n\n${body}\n`, "utf8");
  return path;
}

const mk = (
  name: string,
  description: string,
  body = "body of " + name,
  extra: Partial<SkillEntry> = {},
): SkillEntry => ({
  name,
  description,
  body,
  source: "ensemble",
  path: `/tmp/${name}/SKILL.md`,
  ...extra,
});

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ensemble-skills-p3-"));
  ensembleRoot = join(temp, "ensemble");
  __setSkillRootOverridesForTest({
    ensemble: ensembleRoot,
    claudeUser: join(temp, "claude-user"),
    codexUser: join(temp, "codex-user"),
    systemDirs: [join(temp, "system")],
    disableProject: true,
  });
});

afterEach(() => {
  __setSkillRootOverridesForTest(null);
  rmSync(temp, { recursive: true, force: true });
});

describe("no truncation anywhere on the read path", () => {
  it("auto-activates a >9000 char body WHOLE when the budget allows", () => {
    writeSkillFile(ensembleRoot, "big-skill", "description: Use when reviewing code for bugs\n", bigBody());
    const all = loadSkills();
    const sel = selectSkills({
      userInput: "please review my code and look for bugs",
      all,
      blocked: new Set(),
      forced: new Set(),
      runtimeKind: "anthropic-local",
      tokenBudget: 1_000_000,
      measure: countByChars,
    });

    expect(sel.loaded.map((l) => l.name)).toEqual(["big-skill"]);
    expect(sel.deferred).toEqual([]);
    const rendered = renderSkillSelection(sel, "anthropic-local");
    expect(rendered).toContain(MARKER_A);
    expect(rendered).toContain(MARKER_B);
    // The legacy auto-activation entry point renders through the same shared
    // renderer, so it cannot truncate either.
    const active = formatActiveSkills(all, "anthropic-local");
    expect(active).toContain(MARKER_A);
    expect(active).toContain(MARKER_B);
  });

  it("defers (never slices) the same body under a tiny budget, and it stays fully readable", () => {
    writeSkillFile(ensembleRoot, "big-skill", "description: Use when reviewing code for bugs\n", bigBody());
    const all = loadSkills();
    const sel = selectSkills({
      userInput: "please review my code and look for bugs",
      all,
      blocked: new Set(),
      forced: new Set(),
      runtimeKind: "anthropic-local",
      tokenBudget: 12,
      measure: countByChars,
    });

    expect(sel.loaded).toEqual([]);
    expect(sel.deferred.map((d) => d.name)).toEqual(["big-skill"]);
    const deferred = sel.deferred[0]!;
    expect(deferred.tokenCost).toBeGreaterThan(1000);
    expect(deferred.reason).toContain("12-token budget");
    expect(sel.counting).toBe("exact");

    const rendered = renderSkillSelection(sel, "anthropic-local");
    expect(rendered).not.toContain(MARKER_A);
    expect(rendered).not.toContain(MARKER_B);
    expect(rendered).toContain("DEFERRED SKILLS");
    // The handle names the skill, its description, and how to load it whole.
    expect(rendered).toContain("big-skill");
    expect(rendered).toContain("Use when reviewing code for bugs");
    expect(rendered).toContain("skill_invoke big-skill");

    const full = readSkillByName("big-skill", { runtimeKind: "anthropic-local", measure: countByChars });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.text).toContain(MARKER_A);
      expect(full.text).toContain(MARKER_B);
      expect(full.tokens).toBe(countByChars(full.text));
    }
  });
});

describe("structured read failures", () => {
  it("reports SKILL_NOT_FOUND with the available names", () => {
    writeSkillFile(ensembleRoot, "alpha", "description: first\n", "body a");
    writeSkillFile(ensembleRoot, "beta", "description: second\n", "body b");
    const res = readSkillByName("does-not-exist", { runtimeKind: "anthropic-local" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("SKILL_NOT_FOUND");
      expect(res.name).toBe("does-not-exist");
      expect(res.message).toContain("does-not-exist");
      expect(res.available).toEqual(["alpha", "beta"]);
    }
  });

  it("reports SKILL_UNREADABLE when the file disappears after discovery", () => {
    const path = writeSkillFile(ensembleRoot, "gone", "description: will vanish\n", "cached body");
    loadSkills(); // populate the registry cache, as a real session would
    rmSync(path);

    const res = readSkillByName("gone", { runtimeKind: "anthropic-local" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("SKILL_UNREADABLE");
      // The errno string is in the message — and the cached body is NOT used
      // as a silent fallback.
      expect(res.message).toContain("ENOENT");
      expect(res.message).not.toContain("cached body");
    }
  });

  it("reports SKILL_INCOMPLETE_BODY for an empty body", () => {
    writeSkillFile(ensembleRoot, "empty", "description: no body here\n", "");
    loadSkills();

    const res = readSkillByName("empty", { runtimeKind: "anthropic-local" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("SKILL_INCOMPLETE_BODY");
      expect(res.available).toContain("empty");
    }
  });

  it("keeps an unreadable skill out of `loaded` during selection", () => {
    const path = writeSkillFile(ensembleRoot, "flakey", "description: Use when reviewing code bugs\n", "old body");
    const all = loadSkills();
    rmSync(path);

    const sel = selectSkills({
      userInput: "please review my code for bugs",
      all,
      blocked: new Set(),
      forced: new Set(),
      runtimeKind: "anthropic-local",
      tokenBudget: 1_000_000,
      measure: countByChars,
    });
    expect(sel.loaded).toEqual([]);
    expect(sel.unavailable.map((u) => `${u.name}:${u.code}`)).toEqual(["flakey:SKILL_UNREADABLE"]);
  });
});

describe("token counting degradation", () => {
  it("falls back to labelled byte-length when the measurer reports nothing", () => {
    writeSkillFile(ensembleRoot, "tiny", "description: Use when reviewing code for bugs\n", "short but real body");
    const sel = selectSkills({
      userInput: "please review my code and look for bugs",
      all: loadSkills(),
      blocked: new Set(),
      forced: new Set(),
      runtimeKind: "anthropic-local",
      tokenBudget: 1_000_000,
      measure: () => 0,
    });

    expect(sel.counting).toBe("estimated");
    expect(sel.diagnostics.join("\n")).toMatch(/byte length/i);
    expect(sel.diagnostics.join("\n")).toMatch(/conservative upper bound/i);
    expect(sel.loaded).toHaveLength(1);
    const loaded = sel.loaded[0]!;
    expect(loaded.tokens).toBe(Buffer.byteLength(loaded.text, "utf8"));
    expect(sel.tokens).toBe(loaded.tokens);
  });
});

describe("CJK + NFKC matching", () => {
  it("activates on a Chinese message and keeps stopword-only messages under the guard", () => {
    const zh = mk("zh-reviewer", "用于中文技能评审");
    expect(pickActiveSkills("帮我做中文技能评审", [zh]).map((s) => s.name)).toEqual(["zh-reviewer"]);
    // Segmented: 请/把/我们/的/东西/给/他 → only 东西 survives as a content
    // token, so the chit-chat guard (min 3 tokens) suppresses activation.
    expect(pickActiveSkills("请把我们的东西给他", [zh])).toEqual([]);
  });

  it("segments CJK runs instead of keeping them whole, and keeps 1-char CJK tokens", () => {
    const tokens = tokenize("帮我做中文技能评审");
    expect(tokens.has("帮我做中文技能评审")).toBe(false);
    expect(tokens.has("中文")).toBe(true);
    // single CJK character survives; single ASCII character does not
    expect(tokenize("q 中").has("中")).toBe(true);
    expect(tokenize("q 中").has("q")).toBe(false);
  });

  it("matches full-width text against an ASCII description (NFKC)", () => {
    const s = mk("card-reviewer", "Review skill definitions and instructions");
    const out = pickActiveSkills("ｐｌｅａｓｅ　ＳＫＩＬＬ　ｒｅｖｉｅｗ　ｄｅｆｉｎｉｔｉｏｎｓ", [s]);
    expect(out.map((x) => x.name)).toEqual(["card-reviewer"]);
  });

  it("still activates Chinese when Intl.Segmenter is unavailable", () => {
    const intl = Intl as unknown as Record<string, unknown>;
    const saved = intl.Segmenter;
    try {
      delete intl.Segmenter;
      const zh = mk("zh-reviewer", "用于中文技能评审");
      expect(pickActiveSkills("帮我做中文技能评审", [zh]).map((s) => s.name)).toEqual(["zh-reviewer"]);
    } finally {
      intl.Segmenter = saved;
    }
  });
});

describe("triggers and examples", () => {
  it("parses all three frontmatter spellings, including a repeated key", () => {
    writeSkillFile(
      ensembleRoot,
      "triggered",
      [
        "description: Totally unrelated words",
        "triggers: code review",
        "triggers: 评审, deep dive",
        "examples:",
        "  - fix the bug in my parser",
        "  - sort the parser bug",
        "",
      ].join("\n"),
      "body here",
    );
    const skill = loadSkills().find((s) => s.name === "triggered")!;
    expect(skill.triggers).toEqual(["code review", "评审", "deep dive"]);
    expect(skill.examples).toEqual(["fix the bug in my parser", "sort the parser bug"]);
  });

  it("boosts a skill into activation on a trigger hit alone", () => {
    const s = mk("triggered", "Totally unrelated words", "body", { triggers: ["code review"] });
    const scored = skillMatchScore(tokenize("please do a code review of my work"), s);
    expect(scored.reason).toContain("triggers");
    expect(pickActiveSkills("please do a code review of my work", [s]).map((x) => x.name)).toEqual(["triggered"]);
  });

  it("boosts on example hits without a description match", () => {
    // Two example hits (0.15 each) are what it takes to clear the 0.18
    // threshold from a zero description score — one example alone cannot.
    const s = mk("ex", "Totally unrelated words", "body", {
      examples: ["fix the bug in my parser", "fix my parser bug now"],
    });
    expect(pickActiveSkills("please fix the bug in my parser now", [s]).map((x) => x.name)).toEqual(["ex"]);
    const oneOnly = mk("ex-one", "Totally unrelated words", "body", {
      examples: ["fix the bug in my parser"],
    });
    expect(pickActiveSkills("please fix the bug in my parser now", [oneOnly])).toEqual([]);
  });

  it("does not boost on a partial trigger match", () => {
    const s = mk("triggered", "Totally unrelated words", "body", { triggers: ["code review"] });
    // "code" alone must not count as the trigger "code review"
    expect(skillMatchScore(tokenize("please write code"), s).score).toBe(0);
  });
});

describe("explicit beats auto", () => {
  it("loads a forced skill in full even when its score is 0", () => {
    writeSkillFile(ensembleRoot, "irrelevant", "description: Completely unrelated topic\n", "forced body content");
    const all = loadSkills();
    const base = {
      userInput: "please review my code and look for bugs",
      all,
      blocked: new Set<string>(),
      runtimeKind: "anthropic-local",
      tokenBudget: 1_000_000,
      measure: countByChars,
    };

    expect(selectSkills({ ...base, forced: new Set<string>() }).loaded).toEqual([]);

    const sel = selectSkills({ ...base, forced: new Set(["irrelevant"]) });
    expect(sel.loaded.map((l) => l.name)).toEqual(["irrelevant"]);
    expect(sel.loaded[0]!.text).toContain("forced body content");
  });

  it("REFUSES a forced skill that overruns the budget, with the numbers", () => {
    // Explicit naming is not a licence to blow the assembly budget: the body is
    // neither sliced nor loaded-as-if-it-fit. It is a structured
    // SKILL_BUDGET_EXCEEDED carrying what it would have cost and what was
    // available, so the caller can say the numbers out loud.
    writeSkillFile(ensembleRoot, "forced", "description: Completely unrelated topic\n", "forced body content");
    const sel = selectSkills({
      userInput: "please review my code and look for bugs",
      all: loadSkills(),
      blocked: new Set(),
      forced: new Set(["forced"]),
      runtimeKind: "anthropic-local",
      tokenBudget: 1,
      measure: countByChars,
    });
    expect(sel.loaded).toEqual([]);
    expect(sel.unavailable).toHaveLength(1);
    const refused = sel.unavailable[0]!;
    expect(refused.code).toBe("SKILL_BUDGET_EXCEEDED");
    expect(refused.name).toBe("forced");
    expect(refused.tokenCost).toBeGreaterThan(1);
    expect(refused.availableBudget).toBe(1);
    // No truncation: nothing of the body is in the prompt, and the handle says
    // why in the model's own copy of the section.
    expect(renderSkillSelection(sel, "anthropic-local")).not.toContain("forced body content");
    expect(renderSkillSelection(sel, "anthropic-local")).toContain("SKILL_BUDGET_EXCEEDED");
  });
});

describe("no count cap on auto-activation", () => {
  it("loads every match the budget affords, and a forced skill is unaffected by any cap", () => {
    for (let i = 0; i < 5; i++) {
      writeSkillFile(ensembleRoot, `cand-${i}`, "description: Use when reviewing code for bugs\n", `body ${i}`);
    }
    writeSkillFile(ensembleRoot, "forced-one", "description: Completely unrelated topic\n", "forced body");
    const all = loadSkills().sort((a, b) => a.name.localeCompare(b.name));

    const sel = selectSkills({
      userInput: "please review my code and look for bugs",
      all,
      blocked: new Set(),
      forced: new Set(["forced-one"]),
      runtimeKind: "anthropic-local",
      tokenBudget: 1_000_000,
      measure: countByChars,
    });

    // Five matched candidates and a budget that affords all of them: all five
    // are loaded. A "top 3" rule would have dropped two of them with nothing in
    // `deferred` to show for it.
    expect(sel.loaded.map((l) => l.name)).toEqual(["forced-one", ...all.filter((s) => s.name.startsWith("cand-")).map((s) => s.name)]);
    expect(sel.deferred).toEqual([]);
  });
});

describe("skill MCP tool", () => {
  // callTool's result type is a union (the compat shape carries `toolResult`
  // instead of `content`), so narrow rather than declare.
  const textOf = (res: unknown): string => {
    const content = (res as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content.map((c) => (c as { text?: string }).text ?? "").join("");
  };

  async function connectClient(
    tokenBudget?: number | null,
  ): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = makeSkillMcpServer({
      workspace: temp,
      runtimeKind: "anthropic-local",
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      measure: countByChars,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    const client = new Client({ name: "skills-phase3-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    return { client, close: () => client.close() };
  }

  it("returns isError + parseable JSON for a missing skill, and the body for a good one", async () => {
    writeSkillFile(ensembleRoot, "good-skill", "description: fine\n", "good body text");
    const { client, close } = await connectClient();
    try {
      const bad = await client.callTool({ name: "skill_invoke", arguments: { name: "nope" } });
      expect(bad.isError).toBe(true);
      const payload = JSON.parse(textOf(bad)) as { code: string; name: string; message: string; available: string[] };
      expect(payload.code).toBe("SKILL_NOT_FOUND");
      expect(payload.name).toBe("nope");
      expect(payload.available).toContain("good-skill");

      const good = await client.callTool({ name: "skill_invoke", arguments: { name: "good-skill" } });
      expect(good.isError).toBeFalsy();
      expect(textOf(good)).toContain("[skill: good-skill]");
      expect(textOf(good)).toContain("good body text");
    } finally {
      await close();
    }
  });

  it("is bounded by the plan's skill budget, and says so with numbers", async () => {
    // The tool path used to be unbounded: an explicit invoke injected whatever
    // it found, however large, into a turn whose budget had already been spent.
    // It now reads the same budget the auto-selection does, and an over-budget
    // body is a structured refusal — never a slice, never a success.
    const body = bigBody();
    writeSkillFile(ensembleRoot, "huge-skill", "description: fine\n", body);
    const { client, close } = await connectClient(10);
    try {
      const res = await client.callTool({ name: "skill_invoke", arguments: { name: "huge-skill" } });
      expect(res.isError).toBe(true);
      const payload = JSON.parse(textOf(res)) as {
        code: string;
        name: string;
        tokenCost: number;
        availableBudget: number;
      };
      expect(payload.code).toBe("SKILL_BUDGET_EXCEEDED");
      expect(payload.name).toBe("huge-skill");
      expect(payload.tokenCost).toBeGreaterThan(10);
      expect(payload.availableBudget).toBe(10);
      // Not one character of the body reached the caller.
      expect(textOf(res)).not.toContain(MARKER_A);
      expect(textOf(res)).not.toContain(MARKER_B);
    } finally {
      await close();
    }
  });

  it("reports an empty registry as an error, not as a successful empty list", async () => {
    const { client, close } = await connectClient();
    try {
      const res = await client.callTool({ name: "skill_list", arguments: {} });
      expect(res.isError).toBe(true);
      const payload = JSON.parse(textOf(res)) as { code: string; message: string; available: string[] };
      expect(payload.code).toBe("SKILL_NOT_FOUND");
      expect(payload.message).toContain("No skills loaded");
      expect(payload.available).toEqual([]);
    } finally {
      await close();
    }
  });
});
