import { describe, expect, it } from "vitest";
import {
  contextUsageFromTranscript,
  reportedContextWindowFromResult,
} from "../context-usage.js";

describe("reportedContextWindowFromResult", () => {
  it("returns the positive SDK-reported window for the model", () => {
    expect(
      reportedContextWindowFromResult(
        { type: "result", modelUsage: { "claude-sonnet-4-6": { contextWindow: 200_000 } } },
        "claude-sonnet-4-6",
      ),
    ).toBe(200_000);
  });

  it("returns undefined when the window is missing or zero", () => {
    expect(
      reportedContextWindowFromResult(
        { type: "result", modelUsage: { "gpt-4o": { contextWindow: 0 } } },
        "gpt-4o",
      ),
    ).toBeUndefined();
    expect(
      reportedContextWindowFromResult({ type: "result", modelUsage: {} }, "gpt-4o"),
    ).toBeUndefined();
    expect(
      reportedContextWindowFromResult({ type: "assistant" }, "gpt-4o"),
    ).toBeUndefined();
  });
});

describe("contextUsageFromTranscript", () => {
  it("counts transcript tokens and caps the percentage at 100", () => {
    // A tiny synthetic window so a real transcript exceeds it.
    const longText = Array.from({ length: 400 }, () => "hello world").join(" ");
    const usage = contextUsageFromTranscript("some-unknown-model", 100, [longText]);
    expect(usage).not.toBeNull();
    expect(usage!.contextWindow).toBe(100);
    expect(usage!.usedTokens).toBeGreaterThan(100);
    expect(usage!.percent).toBe(100);
  });

  it("prefers the curated 1M window over the SDK 200K fallback for DeepSeek", () => {
    const usage = contextUsageFromTranscript("deepseek-v4-pro", 200_000, ["hello"]);
    expect(usage).not.toBeNull();
    expect(usage!.contextWindow).toBe(1_000_000);
    expect(usage!.usedTokens).toBeGreaterThan(0);
    expect(usage!.percent).toBe(0);
  });

  it("uses the SDK-reported window when there is no curated entry (Claude)", () => {
    const usage = contextUsageFromTranscript("claude-sonnet-4-6", 200_000, ["hello"]);
    expect(usage).not.toBeNull();
    expect(usage!.contextWindow).toBe(200_000);
  });

  it("returns null for an unknown window", () => {
    expect(contextUsageFromTranscript("not-a-real-model-12345", undefined, ["hello"])).toBeNull();
  });

  it("returns null when the transcript has no countable text", () => {
    expect(contextUsageFromTranscript("gpt-4o", undefined, [])).toBeNull();
  });
});
