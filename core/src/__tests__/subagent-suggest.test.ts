import { describe, it, expect } from "vitest";
import { buildSuggestPrompt, extractJsonPicks } from "../subagent-suggest.js";

// W14 v2 §5: the prompt + parser are the speed-critical pieces and the parts
// most likely to drift when the prompt is tweaked. Pin both behaviors.

describe("extractJsonPicks", () => {
  it("parses the clean happy path", () => {
    const raw = '{"picks":[{"key":"reviewer","hint":"focus on edge cases"},{"key":"tester","hint":""}]}';
    const out = extractJsonPicks(raw);
    expect(out).toEqual([
      { key: "reviewer", hint: "focus on edge cases" },
      { key: "tester", hint: "" },
    ]);
  });

  it("survives surrounding prose / explanations", () => {
    const raw = "Sure! Here are the picks:\n\n```json\n" +
      '{"picks":[{"key":"debugger","hint":"reproduce the 502 first"}]}' +
      "\n```\n\nLet me know if you want others.";
    const out = extractJsonPicks(raw);
    expect(out).toEqual([{ key: "debugger", hint: "reproduce the 502 first" }]);
  });

  it("returns null when there is no JSON object", () => {
    expect(extractJsonPicks("")).toBeNull();
    expect(extractJsonPicks("no JSON here at all")).toBeNull();
  });

  it("returns null when picks is not an array", () => {
    expect(extractJsonPicks('{"picks": "reviewer"}')).toBeNull();
    expect(extractJsonPicks('{"other": []}')).toBeNull();
  });

  it("filters out entries without a string key", () => {
    const raw = '{"picks":[{"key":"reviewer"},{"hint":"orphan"},{"key":42}]}';
    const out = extractJsonPicks(raw);
    expect(out).toEqual([{ key: "reviewer", hint: undefined }]);
  });

  it("treats non-string hint as undefined", () => {
    const raw = '{"picks":[{"key":"reviewer","hint":null},{"key":"tester","hint":123}]}';
    const out = extractJsonPicks(raw);
    expect(out).toEqual([
      { key: "reviewer", hint: undefined },
      { key: "tester", hint: undefined },
    ]);
  });
});

describe("buildSuggestPrompt", () => {
  it("includes the history when non-empty", () => {
    const prompt = buildSuggestPrompt(["[user] hi", "[assistant] hello"]);
    expect(prompt).toContain("[user] hi");
    expect(prompt).toContain("[assistant] hello");
    expect(prompt).toContain("仅输出 JSON");
  });

  it("uses a clear placeholder when history is empty", () => {
    const prompt = buildSuggestPrompt([]);
    expect(prompt).toContain("(no prior messages)");
  });

  it("includes the catalog table so the model can pick from valid keys", () => {
    const prompt = buildSuggestPrompt(["[user] hi"]);
    // Should mention at least one well-known key.
    expect(prompt).toContain("reviewer:");
    expect(prompt).toContain("tester:");
  });
});
