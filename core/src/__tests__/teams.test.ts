import { describe, it, expect, beforeAll } from "vitest";
import { formatEnsembleHelp } from "../help/index.js";

describe("ensemble_help teams topic", () => {
  it("teams topic exists", () => {
    const out = formatEnsembleHelp("teams");
    expect(out).toContain("[ensemble_help: teams]");
  });

  it("describes the UI flow and the HTTP API", () => {
    const out = formatEnsembleHelp("teams");
    expect(out).toContain("+ 团队");
    expect(out).toContain("POST   /api/teams");
    expect(out).toContain("DELETE /api/teams/:id");
  });

  it("explicitly says deletion does NOT delete the agents", () => {
    const out = formatEnsembleHelp("teams");
    expect(out).toMatch(/become ungrouped|revert to ungrouped/);
    expect(out).toContain("NOT");
  });

  it("includes non-coding example sparks (not just dev workflows)", () => {
    const out = formatEnsembleHelp("teams");
    // We want the help to read as content-agnostic. At least one of these
    // non-coding example domains must be mentioned.
    const nonCodingHints = ["Debate", "Translation", "Story", "Study", "Customer"];
    const hits = nonCodingHints.filter((h) => out.includes(h));
    expect(hits.length).toBeGreaterThan(2);
  });

  it("does not advertise built-in templates (templates are user-generated)", () => {
    const out = formatEnsembleHelp("teams");
    expect(out).not.toMatch(/built-in template/i);
    expect(out).not.toMatch(/builtin template/i);
  });

  it("frames cross-model as the headline use", () => {
    const out = formatEnsembleHelp("teams");
    expect(out).toMatch(/different providers\/models|cross-model is a first-class/i);
  });
});
