import { describe, it, expect } from "vitest";
import {
  SUBAGENT_CATALOG,
  catalogPromptTable,
  getCatalogEntry,
  inflateSystemPrompt,
  staticFallbackPicks,
} from "../subagent-catalog.js";

// W14 v2: pins the catalog contract that the prompt + endpoint depend on.

describe("subagent catalog", () => {
  it("each entry has the four required fields", () => {
    for (const entry of SUBAGENT_CATALOG) {
      expect(entry.key).toBeTruthy();
      expect(entry.displayName).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.systemPromptTemplate).toContain("${PARENT_CONTEXT_HINT}");
    }
  });

  it("keys are unique", () => {
    const keys = SUBAGENT_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("getCatalogEntry returns the entry by key, or undefined for unknown", () => {
    expect(getCatalogEntry("reviewer")?.key).toBe("reviewer");
    expect(getCatalogEntry("not-a-role")).toBeUndefined();
  });
});

describe("inflateSystemPrompt", () => {
  const reviewer = getCatalogEntry("reviewer")!;

  it("substitutes the hint placeholder", () => {
    const out = inflateSystemPrompt(reviewer, "user is writing a fastify handler");
    expect(out).toContain("user is writing a fastify handler");
    expect(out).not.toContain("${PARENT_CONTEXT_HINT}");
  });

  it("tolerates empty/missing hint by substituting an empty string", () => {
    const out = inflateSystemPrompt(reviewer, "");
    expect(out).not.toContain("${PARENT_CONTEXT_HINT}");
    const out2 = inflateSystemPrompt(reviewer, undefined);
    expect(out2).not.toContain("${PARENT_CONTEXT_HINT}");
  });

  it("trims whitespace from the hint", () => {
    const out = inflateSystemPrompt(reviewer, "   extra space   ");
    expect(out).toContain("extra space");
    expect(out).not.toContain("   extra space   ");
  });
});

describe("catalogPromptTable", () => {
  it("is a newline-separated `key: description` table", () => {
    const table = catalogPromptTable();
    const lines = table.split("\n");
    expect(lines.length).toBe(SUBAGENT_CATALOG.length);
    for (const entry of SUBAGENT_CATALOG) {
      expect(table).toContain(`${entry.key}: ${entry.description}`);
    }
  });
});

describe("staticFallbackPicks", () => {
  it("returns the first three catalog entries", () => {
    const picks = staticFallbackPicks();
    expect(picks).toHaveLength(3);
    expect(picks[0]!.key).toBe(SUBAGENT_CATALOG[0]!.key);
    expect(picks[1]!.key).toBe(SUBAGENT_CATALOG[1]!.key);
    expect(picks[2]!.key).toBe(SUBAGENT_CATALOG[2]!.key);
  });

  it("each pick has an empty hint", () => {
    for (const p of staticFallbackPicks()) {
      expect(p.hint).toBe("");
    }
  });
});
