import { describe, expect, it } from "vitest";
import {
  _accumulateUsageForTest,
  extractToolCallFromItem,
  openaiResultContextWindow,
} from "../openai.js";
import type { ResolvedRunPlan } from "@agentorch/shared";

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

describe("extractToolCallFromItem", () => {
  it("reads a function_call wrapped in rawItem", () => {
    expect(
      extractToolCallFromItem({
        rawItem: {
          type: "function_call",
          callId: "c1",
          name: "Bash",
          arguments: JSON.stringify({ command: "pwd" }),
        },
      }),
    ).toEqual({ id: "c1", name: "Bash", input: { command: "pwd" } });
  });

  it("keeps unparseable arguments instead of dropping the card", () => {
    expect(
      extractToolCallFromItem({
        rawItem: { callId: "c2", name: "Edit", arguments: "not-json" },
      }),
    ).toEqual({ id: "c2", name: "Edit", input: { _raw: "not-json" } });
  });

  it("returns null when the item has no tool name", () => {
    expect(extractToolCallFromItem({ rawItem: { callId: "c3" } })).toBeNull();
    expect(extractToolCallFromItem(null)).toBeNull();
  });
});

function stubPlan(over: {
  effective?: number | null;
  requested?: number | null;
  advertised?: number | null;
  confidence?: "confirmed" | "unverified" | "unknown";
}): ResolvedRunPlan {
  return {
    context: {
      effectiveWindow: over.effective ?? null,
      requestedRuntimeWindow: over.requested ?? null,
      advertisedContextWindow: over.advertised ?? null,
    },
    facts: {
      advertisedContextWindow: {
        value: over.advertised ?? undefined,
        confidence: over.confidence ?? "unknown",
      },
    },
  } as unknown as ResolvedRunPlan;
}

describe("openaiResultContextWindow", () => {
  it("prefers the plan's effective window", () => {
    expect(openaiResultContextWindow(stubPlan({ effective: 700_000, advertised: 1_000_000, confidence: "confirmed" })))
      .toBe(700_000);
  });

  it("uses a confirmed advertised window when the SDK and plan have no live ceiling", () => {
    expect(openaiResultContextWindow(stubPlan({ advertised: 1_000_000, confidence: "confirmed" })))
      .toBe(1_000_000);
  });

  it("does not promote an unverified advertised figure to the denominator", () => {
    expect(openaiResultContextWindow(stubPlan({ advertised: 64_000, confidence: "unverified" })))
      .toBe(0);
  });
});

