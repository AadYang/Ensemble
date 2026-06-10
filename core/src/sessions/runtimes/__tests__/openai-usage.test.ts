import { describe, expect, it } from "vitest";
import { _accumulateUsageForTest } from "../openai.js";

describe("OpenAI runtime usage accounting", () => {
  it("keeps cached input out of ordinary input tokens", () => {
    const accum: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }> = {};

    _accumulateUsageForTest(
      accum,
      {
        model: "gpt-4o-mini",
        usage: {
          inputTokens: 1000,
          outputTokens: 120,
          inputTokensDetails: { cachedTokens: 750 },
        },
      },
      "fallback-model",
    );

    expect(accum["gpt-4o-mini"]).toEqual({
      inputTokens: 250,
      outputTokens: 120,
      cacheReadInputTokens: 750,
      cacheCreationInputTokens: 0,
    });
  });

  it("accumulates multiple response snapshots per model", () => {
    const accum: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }> = {};

    _accumulateUsageForTest(
      accum,
      { model: "gpt-4o-mini", usage: { input_tokens: 400, output_tokens: 30 } },
      "fallback-model",
    );
    _accumulateUsageForTest(
      accum,
      {
        model: "gpt-4o-mini",
        usage: {
          input_tokens: 500,
          output_tokens: 40,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      },
      "fallback-model",
    );

    expect(accum["gpt-4o-mini"]).toEqual({
      inputTokens: 800,
      outputTokens: 70,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 0,
    });
  });
});
