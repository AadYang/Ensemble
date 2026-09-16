import { describe, it, expect } from "vitest";
import { reportedContextWindow } from "../reported-window.js";

const result = (modelUsage: Record<string, { contextWindow?: number }>) => ({ modelUsage });

describe("reportedContextWindow", () => {
  it("uses the exact model key", () => {
    const r = reportedContextWindow(
      result({ "gpt-5.6-sol": { contextWindow: 828_400 }, "gpt-5.6-terra": { contextWindow: 900_000 } }),
      "gpt-5.6-sol",
    );
    expect(r.value).toBe(828_400);
    expect(r.origin).toBe("runtime-observed");
    expect(r.confidence).toBe("observed");
  });

  it("falls back to the single entry when the runtime renamed the model", () => {
    const r = reportedContextWindow(
      result({ "gpt-5.6-sol-2026-01": { contextWindow: 828_400 } }),
      "gpt-5.6-sol",
    );
    expect(r.value).toBe(828_400);
    expect(r.source).toContain("gpt-5.6-sol-2026-01");
  });

  // THE case this module exists for. The shipped implementation collects the
  // distinct windows and accepts a single-element set — but two DIFFERENT models
  // reporting the SAME number collapse to one element too, so model B's window
  // gets attributed to model A.
  it("refuses when two different models report the same window", () => {
    const r = reportedContextWindow(
      result({
        "gpt-5.6-sol-2026-01": { contextWindow: 200_000 },
        "gpt-5.6-terra": { contextWindow: 200_000 },
      }),
      "gpt-5.6-sol",
    );
    expect(r.value).toBeUndefined();
    expect(r.origin).toBe("unknown");
    expect(r.source).toContain("without guessing");
    expect(r.considered.some((c) => /2 models reported/.test(c.reason))).toBe(true);
  });

  it("refuses when two models report different windows", () => {
    const r = reportedContextWindow(
      result({
        "gpt-5.6-sol-2026-01": { contextWindow: 700_000 },
        "gpt-5.6-terra": { contextWindow: 900_000 },
      }),
      "gpt-5.6-sol",
    );
    expect(r.value).toBeUndefined();
  });

  it("uses an explicitly configured alias", () => {
    const r = reportedContextWindow(
      result({ "gpt-5.6-sol-2026-01": { contextWindow: 828_400 } }),
      "gpt-5.6-sol",
      { aliases: { "gpt-5.6-sol": "gpt-5.6-sol-2026-01" } },
    );
    expect(r.value).toBe(828_400);
    expect(r.source).toContain("aliased key");
  });

  // An alias is a statement about which id belongs to which model. If the
  // payload contradicts it, believing an unrelated entry instead would be
  // exactly the silent misattribution this avoids.
  it("does not silently use an unrelated entry when the configured alias is missing", () => {
    const r = reportedContextWindow(
      result({ "some-other-model": { contextWindow: 128_000 } }),
      "gpt-5.6-sol",
      { aliases: { "gpt-5.6-sol": "gpt-5.6-sol-2026-01" } },
    );
    expect(r.value).toBeUndefined();
    expect(r.source).toContain("alias");
  });

  it("returns unknown rather than guessing at nothing", () => {
    for (const payload of [
      result({}),
      result({ "gpt-5.6-sol": { contextWindow: 0 } }),
      result({ "gpt-5.6-sol": {} }),
      { modelUsage: null },
      null,
      undefined,
    ]) {
      const r = reportedContextWindow(payload, "gpt-5.6-sol");
      expect(r.value).toBeUndefined();
      expect(r.confidence).toBe("unknown");
    }
  });

  // `origin` is documented as identifying the result the reading came from. A
  // resolver that drops it leaves "we could not attribute a window" with no way
  // to say WHICH result we could not attribute it from.
  it("carries the caller's origin into the source it reports", () => {
    const hit = reportedContextWindow(
      result({ "gpt-5.6-sol": { contextWindow: 828_400 } }),
      "gpt-5.6-sol",
      { origin: "codex-turn-result" },
    );
    expect(hit.source).toContain("codex-turn-result");
    const miss = reportedContextWindow(
      result({ "a-model": { contextWindow: 1 }, "b-model": { contextWindow: 2 } }),
      "gpt-5.6-sol",
      { origin: "codex-turn-result" },
    );
    expect(miss.value).toBeUndefined();
    expect(miss.source).toContain("codex-turn-result");
  });

  it("never returns a non-positive window", () => {
    expect(reportedContextWindow(result({ m: { contextWindow: -1 } }), "m").value).toBeUndefined();
    expect(reportedContextWindow(result({ m: { contextWindow: Number.NaN } }), "m").value).toBeUndefined();
  });
});
