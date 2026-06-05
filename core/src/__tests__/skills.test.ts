import { describe, it, expect, beforeEach } from "vitest";
import {
  __setSkillsForTest,
  pickActiveSkills,
  formatActiveSkills,
  formatSkillBody,
  scoreSkillMatch,
  type SkillEntry,
} from "../skills/index.js";

const mk = (
  name: string,
  description: string,
  body = "body of " + name,
  tools?: string[],
): SkillEntry => ({
  name,
  description,
  body,
  source: "ensemble",
  path: `/tmp/${name}/SKILL.md`,
  ...(tools ? { tools } : {}),
});

describe("scoreSkillMatch", () => {
  it("returns 0 for empty description", () => {
    expect(scoreSkillMatch(new Set(["foo", "bar"]), "")).toBe(0);
  });
  it("scores token overlap normalized by description size", () => {
    const tokens = new Set(["review", "code", "diff"]);
    // description has 3 useful tokens, 2 hit → 2/3
    const s = scoreSkillMatch(tokens, "Use when reviewing code or auditing a diff");
    expect(s).toBeGreaterThan(0.4);
  });
  it("0 hits → 0", () => {
    expect(scoreSkillMatch(new Set(["nothing", "relevant"]), "Use for security review")).toBe(0);
  });
});

describe("pickActiveSkills", () => {
  const reviewer = mk("code-reviewer", "Use when reviewing code or auditing a diff for bugs");
  const planner = mk("planner", "Use when planning a complex multi-step task before coding");
  const seoBoss = mk("seo-expert", "Use for SEO audits and keyword research on web content");

  it("returns [] when no skill scores above threshold", () => {
    const out = pickActiveSkills("hello there friend", [reviewer, planner, seoBoss]);
    expect(out).toEqual([]);
  });

  it("activates the matching skill", () => {
    const out = pickActiveSkills(
      "please review my code and look for bugs in the diff",
      [reviewer, planner, seoBoss],
    );
    expect(out.map((s) => s.name)).toContain("code-reviewer");
  });

  it("scores multiple matches in descending order", () => {
    // Tokens are exact-match (no stemming), so use surface forms that occur
    // literally in the descriptions: "reviewing", "code", "diff", "planning",
    // "complex", "task".
    const out = pickActiveSkills(
      "reviewing diff before planning the complex task ahead",
      [reviewer, planner, seoBoss],
    );
    const names = out.map((s) => s.name);
    expect(names).toContain("code-reviewer");
    expect(names).toContain("planner");
  });

  it("skips activation for very short messages (chit-chat guard)", () => {
    expect(pickActiveSkills("ok", [reviewer])).toEqual([]);
    expect(pickActiveSkills("yes", [reviewer])).toEqual([]);
  });

  it("respects maxActive cap", () => {
    const skills = [
      mk("a", "review code bug audit"),
      mk("b", "review bug code diff"),
      mk("c", "review bugs code commits"),
      mk("d", "review code bugs patches"),
    ];
    const out = pickActiveSkills(
      "please review my code for bugs",
      skills,
      { maxActive: 2 },
    );
    expect(out.length).toBe(2);
  });
});

describe("formatActiveSkills", () => {
  it("returns empty string when no skills", () => {
    expect(formatActiveSkills([], "anthropic-local")).toBe("");
  });
  it("includes name + description + body for each active skill", () => {
    const out = formatActiveSkills(
      [mk("reviewer", "audit code", "Be careful. Quote line numbers.")],
      "anthropic-local",
    );
    expect(out).toContain("ACTIVE SKILLS");
    expect(out).toContain("reviewer: audit code");
    expect(out).toContain("[skill: reviewer]");
    expect(out).toContain("Be careful");
  });
  it("on codex, marks tool restrictions as ignored", () => {
    const out = formatActiveSkills(
      [mk("reviewer", "x", "y", ["Read", "Grep"])],
      "openai-codex",
    );
    expect(out).toMatch(/Codex runtime has no per-call tool gate/);
  });
  it("on non-codex, marks tools as advisory", () => {
    const out = formatActiveSkills(
      [mk("reviewer", "x", "y", ["Read", "Grep"])],
      "anthropic-local",
    );
    expect(out).toMatch(/recommends restricting/);
    expect(out).not.toMatch(/Codex runtime has no per-call/);
  });
});

describe("formatSkillBody", () => {
  it("renders single-skill header + body", () => {
    const out = formatSkillBody(mk("planner", "use for planning"), "anthropic-local");
    expect(out).toContain("[skill: planner]");
    expect(out).toContain("[description: use for planning]");
    expect(out).toContain("body of planner");
  });
  it("marks codex tool restrictions as ignored", () => {
    const out = formatSkillBody(mk("x", "y", "z", ["Read"]), "openai-codex");
    expect(out).toMatch(/Codex runtime ignores this/);
  });
});

describe("registry test seam", () => {
  beforeEach(() => __setSkillsForTest([]));
  it("allows tests to swap the registry", async () => {
    const { findSkill, loadSkills } = await import("../skills/index.js");
    __setSkillsForTest([mk("seeded", "test desc")]);
    expect(loadSkills().map((s) => s.name)).toEqual(["seeded"]);
    expect(findSkill("seeded")?.description).toBe("test desc");
  });
});
