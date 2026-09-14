import { describe, expect, it } from "vitest";
import { contextUsageFromResult } from "../context-usage.js";

describe("contextUsageFromResult", () => {
  it("sums input + output + cache read + cache creation for the current model", () => {
    const usage = contextUsageFromResult(
      {
        type: "result",
        modelUsage: {
          "test-model": {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 100,
            contextWindow: 100_000,
          },
        },
      },
      "test-model",
    );

    expect(usage).toEqual({
      usedTokens: 1600,
      contextWindow: 100_000,
      percent: 2,
    });
  });

  it("prefers the SDK-reported contextWindow over the static table", () => {
    const usage = contextUsageFromResult(
      {
        type: "result",
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 150_000,
            outputTokens: 0,
            contextWindow: 200_000,
          },
        },
      },
      "claude-sonnet-4-6",
    );

    expect(usage).toEqual({ usedTokens: 150_000, contextWindow: 200_000, percent: 75 });
  });

  it("falls back to the static table when reported window is missing", () => {
    const usage = contextUsageFromResult(
      {
        type: "result",
        modelUsage: {
          "gpt-4o": { inputTokens: 64_000, outputTokens: 0, contextWindow: 0 },
        },
      },
      "gpt-4o",
    );

    expect(usage).toEqual({ usedTokens: 64_000, contextWindow: 128_000, percent: 50 });
  });

  it("returns null for an unknown model with no reported window", () => {
    const usage = contextUsageFromResult(
      {
        type: "result",
        modelUsage: {
          "some-unknown-model": { inputTokens: 100, outputTokens: 0, contextWindow: 0 },
        },
      },
      "some-unknown-model",
    );

    expect(usage).toBeNull();
  });

  it("resolves the static table case-insensitively (1M DeepSeek window)", () => {
    const usage = contextUsageFromResult(
      {
        type: "result",
        modelUsage: {
          "deepseek-flash": { inputTokens: 500_000, outputTokens: 0, contextWindow: 0 },
        },
      },
      "deepseek-flash",
    );

    expect(usage).toEqual({ usedTokens: 500_000, contextWindow: 1_000_000, percent: 50 });
  });

  it("returns null for non-result messages or empty modelUsage", () => {
    expect(contextUsageFromResult({ type: "assistant" }, "test-model")).toBeNull();
    expect(
      contextUsageFromResult({ type: "result", modelUsage: {} }, "test-model"),
    ).toBeNull();
  });

  it("picks the largest-footprint entry on a multi-model turn", () => {
    const usage = contextUsageFromResult(
      {
        type: "result",
        modelUsage: {
          "model-a": { inputTokens: 10, outputTokens: 5, contextWindow: 50_000 },
          "model-b": { inputTokens: 900, outputTokens: 100, contextWindow: 100_000 },
        },
      },
      "requested-model",
    );

    expect(usage).toEqual({ usedTokens: 1000, contextWindow: 100_000, percent: 1 });
  });

  it("returns null when the turn produced no tokens", () => {
    const usage = contextUsageFromResult(
      {
        type: "result",
        modelUsage: {
          "gpt-4o": { inputTokens: 0, outputTokens: 0, contextWindow: 0 },
        },
      },
      "gpt-4o",
    );

    expect(usage).toBeNull();
  });
});
