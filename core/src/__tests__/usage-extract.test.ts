import { describe, it, expect } from "vitest";
import { extractUsageEvents, buildMetaUsageEvent } from "../usage-extract.js";

const CTX = {
  agentId: "a1",
  agentName: "main",
  parentId: null,
  providerId: "p1",
  providerName: "anthropic-default",
  providerKind: "anthropic-local",
};

describe("extractUsageEvents", () => {
  it("returns [] for non-result messages", () => {
    expect(extractUsageEvents(CTX, { type: "assistant" })).toEqual([]);
    expect(extractUsageEvents(CTX, { type: "stream_event" })).toEqual([]);
    expect(extractUsageEvents(CTX, null)).toEqual([]);
  });

  it("returns [] when result has no modelUsage", () => {
    expect(extractUsageEvents(CTX, { type: "result", subtype: "success" })).toEqual([]);
  });

  it("produces one event per model in modelUsage", () => {
    const events = extractUsageEvents(CTX, {
      type: "result",
      modelUsage: {
        "claude-opus-4-7": {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.model).toBe("claude-opus-4-7");
    expect(events[0]!.inputTokens).toBe(1000);
    expect(events[0]!.outputTokens).toBe(500);
    expect(events[0]!.cacheReadTokens).toBe(200);
    expect(events[0]!.cacheCreationTokens).toBe(100);
    expect(events[0]!.costKnown).toBe(true);
    expect(events[0]!.costUSD).toBeGreaterThan(0);
  });

  it("snapshots context fields verbatim", () => {
    const events = extractUsageEvents(CTX, {
      type: "result",
      modelUsage: { "gpt-4o-mini": { inputTokens: 100, outputTokens: 50 } },
    });
    expect(events[0]!.agentId).toBe("a1");
    expect(events[0]!.agentName).toBe("main");
    expect(events[0]!.providerId).toBe("p1");
    expect(events[0]!.providerKind).toBe("anthropic-local");
  });

  it("marks costKnown=false for an unknown model", () => {
    const events = extractUsageEvents(CTX, {
      type: "result",
      modelUsage: { "totally-fake-model": { inputTokens: 100, outputTokens: 50 } },
    });
    expect(events[0]!.costKnown).toBe(false);
    expect(events[0]!.costUSD).toBe(0);
  });

  it("skips zero-usage entries to avoid polluting the table", () => {
    const events = extractUsageEvents(CTX, {
      type: "result",
      modelUsage: {
        "gpt-4o-mini": { inputTokens: 0, outputTokens: 0 },
        "claude-opus-4-7": { inputTokens: 100, outputTokens: 50 },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.model).toBe("claude-opus-4-7");
  });

  it("treats missing cache fields as 0", () => {
    const events = extractUsageEvents(CTX, {
      type: "result",
      modelUsage: { "gpt-4o-mini": { inputTokens: 100, outputTokens: 50 } },
    });
    expect(events[0]!.cacheReadTokens).toBe(0);
    expect(events[0]!.cacheCreationTokens).toBe(0);
  });

  it("threads local token counts through to the row when present", () => {
    const events = extractUsageEvents(CTX, {
      type: "result",
      modelUsage: {
        "gpt-4o-mini": {
          inputTokens: 1000,
          outputTokens: 500,
          inputTokensLocal: 820,
          outputTokensLocal: 480,
        },
      },
    });
    expect(events[0]!.inputTokensLocal).toBe(820);
    expect(events[0]!.outputTokensLocal).toBe(480);
  });

  it("defaults local token counts to 0 when runtime didn't supply them", () => {
    const events = extractUsageEvents(CTX, {
      type: "result",
      modelUsage: { "claude-opus-4-7": { inputTokens: 100, outputTokens: 50 } },
    });
    expect(events[0]!.inputTokensLocal).toBe(0);
    expect(events[0]!.outputTokensLocal).toBe(0);
  });

  it("emits source='result' by default and respects the override", () => {
    const r = extractUsageEvents(CTX, {
      type: "result",
      modelUsage: { "gpt-4o-mini": { inputTokens: 100, outputTokens: 50 } },
    });
    expect(r[0]!.source).toBe("result");

    const m = extractUsageEvents(
      CTX,
      { type: "result", modelUsage: { "gpt-4o-mini": { inputTokens: 100, outputTokens: 50 } } },
      "meta",
    );
    expect(m[0]!.source).toBe("meta");
  });
});

describe("buildMetaUsageEvent", () => {
  it("produces a meta-source row with computed cost", () => {
    const ev = buildMetaUsageEvent(CTX, "gpt-4o-mini", {
      inputTokens: 600,
      outputTokens: 100,
    });
    expect(ev.source).toBe("meta");
    expect(ev.model).toBe("gpt-4o-mini");
    expect(ev.inputTokens).toBe(600);
    expect(ev.outputTokens).toBe(100);
    expect(ev.costKnown).toBe(true);
    expect(ev.costUSD).toBeGreaterThan(0);
  });
});

// W20 Slice 5.6: codex turns are billed against the ChatGPT subscription,
// not pay-per-token. The extractor must stamp billingModel='subscription'
// and zero out costUSD regardless of model pricing, otherwise the stats
// rollup would double-bill a user who already paid via the ChatGPT plan.
describe("extractUsageEvents — openai-codex (subscription billing)", () => {
  const CODEX_CTX = { ...CTX, providerKind: "openai-codex", providerName: "codex-default" };

  it("stamps billingModel='subscription' and costUSD=0 for codex rows", () => {
    const events = extractUsageEvents(CODEX_CTX, {
      type: "result",
      modelUsage: {
        "gpt-5": {
          inputTokens: 5000,
          outputTokens: 2000,
          cacheReadInputTokens: 1000,
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.billingModel).toBe("subscription");
    expect(events[0]!.costUSD).toBe(0);
    expect(events[0]!.costKnown).toBe(true);
    // Tokens still recorded — only $ is suppressed.
    expect(events[0]!.inputTokens).toBe(5000);
    expect(events[0]!.outputTokens).toBe(2000);
    expect(events[0]!.cacheReadTokens).toBe(1000);
  });

  it("leaves non-codex providers on 'usage' billing", () => {
    const events = extractUsageEvents(CTX, {
      type: "result",
      modelUsage: { "claude-opus-4-7": { inputTokens: 100, outputTokens: 50 } },
    });
    expect(events[0]!.billingModel).toBe("usage");
  });

  it("buildMetaUsageEvent honors subscription billing for codex", () => {
    const ev = buildMetaUsageEvent(CODEX_CTX, "gpt-5", {
      inputTokens: 500,
      outputTokens: 50,
    });
    expect(ev.billingModel).toBe("subscription");
    expect(ev.costUSD).toBe(0);
    expect(ev.costKnown).toBe(true);
  });
});
