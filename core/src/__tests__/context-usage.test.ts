import { describe, expect, it } from "vitest";
import {
  contextUsageFromTranscript,
  contextUsageFromUsedTokens,
  LIVE_CONTEXT_MIN_EMIT_MS,
  liveOccupancy,
  occupancyDeltaFromStreamEvent,
  occupancyTokensFromLastCall,
  occupancyTokensFromResultContextUsage,
  promptTextFromMessage,
  promptTokensFromLastCall,
  promptTokensFromResultContextUsage,
  reportedContextWindowFromResult,
  shouldEncodeLiveStreamOccupancy,
  shouldPublishLiveContext,
} from "../context-usage.js";
import { snapshotContextWindow } from "../context-window.js";

describe("reportedContextWindowFromResult", () => {
  it("returns the positive SDK-reported window for the model", () => {
    expect(
      reportedContextWindowFromResult(
        { type: "result", modelUsage: { "claude-sonnet-4-6": { contextWindow: 200_000 } } },
        "claude-sonnet-4-6",
      ),
    ).toBe(200_000);
  });

  // The runtime keys modelUsage by the id IT saw, so an alias must not make the
  // session value disappear and silently demote the bar to the static profile.
  it("falls back to the result's own biggest window on an exact-key miss", () => {
    expect(
      reportedContextWindowFromResult(
        { type: "result", modelUsage: { "gpt-5.6-sol-2026-01": { contextWindow: 828_400 } } },
        "gpt-5.6-sol",
      ),
    ).toBe(828_400);
  });

  it("prefers the exact key when several models reported a window", () => {
    expect(
      reportedContextWindowFromResult(
        {
          type: "result",
          modelUsage: {
            "gpt-5.6-sol": { contextWindow: 700_000 },
            "gpt-5.6-terra": { contextWindow: 900_000 },
          },
        },
        "gpt-5.6-sol",
      ),
    ).toBe(700_000);
  });

  // A result can legitimately carry several models (the billing path writes a
  // row per model). Attributing the biggest of them to this model would be a
  // silent, wrong ceiling — so ambiguity must resolve to "unknown".
  it("returns undefined rather than guessing when the candidates disagree", () => {
    expect(
      reportedContextWindowFromResult(
        {
          type: "result",
          modelUsage: {
            "gpt-5.6-sol-2026-01": { contextWindow: 700_000 },
            "gpt-5.6-terra": { contextWindow: 900_000 },
          },
        },
        "gpt-5.6-sol",
      ),
    ).toBeUndefined();
  });

  it("still accepts the fallback when every candidate agrees", () => {
    expect(
      reportedContextWindowFromResult(
        {
          type: "result",
          modelUsage: {
            "gpt-5.6-sol-2026-01": { contextWindow: 828_400 },
            "gpt-5.6-sol-2026-02": { contextWindow: 828_400 },
          },
        },
        "gpt-5.6-sol",
      ),
    ).toBe(828_400);
  });

  it("still returns undefined when nothing reported a window", () => {
    expect(
      reportedContextWindowFromResult(
        { type: "result", modelUsage: { "gpt-5.6-sol": { contextWindow: 0 } } },
        "gpt-5.6-sol",
      ),
    ).toBeUndefined();
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
    const usage = contextUsageFromTranscript(
      "some-unknown-model",
      { runtime: "claude", vendor: "unknown", sessionObserved: 100 },
      [longText],
    );
    expect(usage).not.toBeNull();
    expect(usage!.contextWindow).toBe(100);
    expect(usage!.usedTokens).toBeGreaterThan(100);
    expect(usage!.percent).toBe(100);
  });

  it("follows the runtime's own window, and shows the advertised one beside it", () => {
    // Claude Code reports its effective window for this session. When that is
    // SMALLER than what the model documents, the bar follows the runtime (it is
    // the number being enforced) and the catalog value is carried alongside for
    // the tooltip — it is never substituted for the denominator.
    const usage = contextUsageFromTranscript(
      "deepseek-v4-pro",
      { runtime: "claude", vendor: "deepseek", sessionObserved: 200_000, requested: 1_000_000 },
      ["hello"],
    );
    expect(usage).not.toBeNull();
    expect(usage!.contextWindow).toBe(200_000);
    expect(usage!.advertisedContextWindow).toBe(1_000_000);
    expect(usage!.windowOrigin).toBe("session-observed");
    expect(usage!.windowClamped).toBe(true); // we asked for 1M, got 200K
    expect(usage!.usedTokens).toBeGreaterThan(0);
    expect(usage!.percent).toBe(0);
  });

  it("uses the runtime window for a smaller documented provider limit too", () => {
    const glm = contextUsageFromUsedTokens(
      "glm-4.5",
      { runtime: "claude", vendor: "zhipu", sessionObserved: 128_000 },
      10,
    )!;
    expect(glm.contextWindow).toBe(128_000);
    expect(glm.advertisedContextWindow).toBe(128_000);
  });

  // The behaviour this whole refactor was for: no live ceiling ⇒ report the
  // count and say the ceiling is unknown, rather than letting the advertised
  // capacity masquerade as available headroom.
  it("does NOT fall back to the catalog when no live window is known", () => {
    for (const ctx of [
      { runtime: "claude", vendor: "deepseek" },
      { runtime: "claude", vendor: "deepseek", runtimeVersion: "1.0.0" },
    ]) {
      const usage = contextUsageFromUsedTokens("deepseek-v4-pro", ctx, 10)!;
      expect(usage.usedTokens).toBe(10);
      expect(usage.contextWindow).toBeUndefined();
      expect(usage.percent).toBeUndefined();
      expect(usage.windowOrigin).toBeUndefined();
      // The official figure is still available for the tooltip — but only there.
      expect(usage.advertisedContextWindow).toBe(1_000_000);
    }
  });

  it("uses the SDK-reported window when there is no catalog entry (Claude)", () => {
    const usage = contextUsageFromTranscript(
      "claude-sonnet-4-6",
      { runtime: "claude", vendor: "anthropic", sessionObserved: 200_000 },
      ["hello"],
    );
    expect(usage).not.toBeNull();
    expect(usage!.contextWindow).toBe(200_000);
    expect(usage!.windowOrigin).toBe("session-observed");
    // We declare nothing for a Claude-native id, so nothing is "clamped".
    expect(usage!.windowClamped).toBeUndefined();
    // The advertised figure comes from the unverified LiteLLM snapshot for this
    // id — display only, and never the denominator.
    expect(usage!.advertisedContextWindow).toBe(snapshotContextWindow("claude-sonnet-4-6"));
  });

  it("reports the count with no ceiling for an unknown model", () => {
    const usage = contextUsageFromTranscript(
      "not-a-real-model-12345",
      { runtime: "claude", vendor: "unknown" },
      ["hello"],
    );
    expect(usage).not.toBeNull();
    expect(usage!.usedTokens).toBeGreaterThan(0);
    expect(usage!.contextWindow).toBeUndefined();
    expect(usage!.advertisedContextWindow).toBeUndefined();
  });

  it("returns null when the transcript has no countable text", () => {
    expect(contextUsageFromTranscript("gpt-4o", { runtime: "claude", vendor: "openai" }, []))
      .toBeNull();
  });
});

// The data path item 1 was about: codex parses `model_context_window` out of
// its rollout, the runtime publishes it on the result's modelUsage, and the bar
// must use that session value ahead of the static profile — the profile is only
// a version-matched fallback.
describe("session-observed window from the Codex result payload", () => {
  const codexResult = (contextWindow: number) => ({
    type: "result",
    modelUsage: { "gpt-5.6-sol": { contextWindow } },
  });

  it("is read back from the runtime's own result payload", () => {
    expect(reportedContextWindowFromResult(codexResult(700_000), "gpt-5.6-sol")).toBe(700_000);
  });

  it("outranks the static profile", () => {
    const ctx = {
      runtime: "codex",
      vendor: "openai",
      runtimeVersion: "0.154.0",
      sessionObserved: reportedContextWindowFromResult(codexResult(700_000), "gpt-5.6-sol") ?? null,
      requested: 1_050_000,
    };
    const usage = contextUsageFromUsedTokens("gpt-5.6-sol", ctx, 100_000)!;
    expect(usage.contextWindow).toBe(700_000); // not the profile's 828,400
    expect(usage.windowOrigin).toBe("session-observed");
    expect(usage.advertisedContextWindow).toBe(1_050_000);
    expect(usage.windowClamped).toBe(true);
  });

  // A live observation does not depend on matching a CLI version — that is the
  // point of preferring it. (Only the *profile* fallback is version-gated.)
  it("applies even when no profile matches the runtime version", () => {
    const usage = contextUsageFromUsedTokens(
      "gpt-5.6-sol",
      {
        runtime: "codex",
        vendor: "openai",
        runtimeVersion: "0.199.0",
        sessionObserved: reportedContextWindowFromResult(codexResult(700_000), "gpt-5.6-sol") ?? null,
      },
      100_000,
    )!;
    expect(usage.contextWindow).toBe(700_000);
    expect(usage.windowOrigin).toBe("session-observed");
  });

  it("falls back to null (not to advertised) when the result carries no window", () => {
    const usage = contextUsageFromUsedTokens(
      "gpt-5.6-sol",
      {
        runtime: "codex",
        vendor: "openai",
        runtimeVersion: "0.199.0",
        sessionObserved: reportedContextWindowFromResult({ type: "result" }, "gpt-5.6-sol") ?? null,
      },
      100_000,
    )!;
    expect(usage.contextWindow).toBeUndefined();
    expect(usage.percent).toBeUndefined();
    expect(usage.advertisedContextWindow).toBe(1_050_000);
  });
});

// Provider scope: one model id can be served by several routes, and the
// catalog facts for those routes must not be shared.
describe("provider scope normalization", () => {
  it("resolves the advertised value per vendor scope", () => {
    const openai = contextUsageFromUsedTokens(
      "gpt-5.6-sol",
      { runtime: "codex", vendor: "openai" },
      1,
    )!;
    expect(openai.advertisedContextWindow).toBe(1_050_000);
  });

  it("does not answer one vendor's id from another vendor's catalog row", () => {
    const unknownScope = contextUsageFromUsedTokens(
      "gpt-5.6-sol",
      { runtime: "codex", vendor: "unknown" },
      1,
    )!;
    expect(unknownScope.advertisedContextWindow).not.toBe(1_050_000);
  });
});

const assistantWithUsage = (usage: Record<string, unknown>) => ({
  type: "assistant",
  payload: { type: "assistant", message: { content: [{ type: "text", text: "hi" }], usage } },
});
const userRow = (content: unknown) => ({ type: "user", message: { role: "user", content } });
// promptTokensFromLastCall takes DB rows; promptTextFromMessage takes the SDK
// messages the runtime replays, which is why the shapes differ.
const rowFor = (msg: Record<string, unknown>) => ({ type: msg.type as string, payload: msg });

describe("promptTokensFromLastCall", () => {
  it("sums the anthropic per-call usage (input excludes the cached prefix)", () => {
    // Mirrors the real rows on the dev agent, where this sum reproduced Claude
    // Code's own compact_boundary.pre_tokens within 2-5%.
    const rows = [
      assistantWithUsage({ input_tokens: 209, cache_read_input_tokens: 165_632, output_tokens: 0 }),
    ];
    expect(promptTokensFromLastCall(rows)).toBe(165_841);
  });

  it("reads the last call, not the aggregated result usage", () => {
    const rows = [
      assistantWithUsage({ input_tokens: 100, cache_read_input_tokens: 1000 }),
      rowFor(userRow([{ type: "tool_result", tool_use_id: "t1", content: "output" }])),
      assistantWithUsage({ input_tokens: 1818, cache_read_input_tokens: 159_616 }),
    ];
    expect(promptTokensFromLastCall(rows)).toBe(161_434);
  });

  it("uses prompt_tokens as-is for the chat-completions shape", () => {
    const rows = [assistantWithUsage({ prompt_tokens: 50_000, completion_tokens: 12 })];
    expect(promptTokensFromLastCall(rows)).toBe(50_000);
  });

  it("skips rows without usage so a half-written row cannot hide the last call", () => {
    const rows = [
      assistantWithUsage({ input_tokens: 10, cache_read_input_tokens: 20 }),
      { type: "assistant", payload: { type: "assistant", message: { content: [] } } },
    ];
    expect(promptTokensFromLastCall(rows)).toBe(30);
  });

  it("returns null when no row carries usage (OpenAI / Codex runtimes)", () => {
    expect(
      promptTokensFromLastCall([
        { type: "assistant", payload: { type: "assistant", message: { content: [] } } },
        rowFor(userRow("hello")),
      ]),
    ).toBeNull();
    expect(promptTokensFromLastCall([])).toBeNull();
  });
});

describe("promptTokensFromResultContextUsage", () => {
  it("adds the cached prefix back (readResponseUsage reports it separately)", () => {
    // The OpenAI runtime's shape: inputTokens is NET of the cache, because the
    // billing path prices cache reads at a different rate. The prompt the model
    // actually received is the sum.
    expect(
      promptTokensFromResultContextUsage({
        type: "result",
        contextUsage: {
          model: "deepseek-chat",
          inputTokens: 1_818,
          cacheReadInputTokens: 159_616,
          cacheCreationInputTokens: 0,
        },
      }),
    ).toBe(161_434);
  });

  it("treats a response with no cache read as the whole prompt", () => {
    expect(
      promptTokensFromResultContextUsage({
        type: "result",
        contextUsage: { inputTokens: 4_120, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
    ).toBe(4_120);
  });

  it("returns null when the runtime reported nothing (Codex, failed turn)", () => {
    expect(promptTokensFromResultContextUsage({ type: "result", modelUsage: {} })).toBeNull();
    expect(
      promptTokensFromResultContextUsage({ type: "result", contextUsage: undefined }),
    ).toBeNull();
    expect(
      promptTokensFromResultContextUsage({ type: "result", contextUsage: { outputTokens: 12 } }),
    ).toBeNull();
    expect(promptTokensFromResultContextUsage({ type: "assistant" })).toBeNull();
  });
});

describe("occupancyTokensFromLastCall", () => {
  it("adds output to the anthropic prompt (input + cache)", () => {
    const rows = [
      assistantWithUsage({
        input_tokens: 209,
        cache_read_input_tokens: 165_632,
        output_tokens: 40,
      }),
    ];
    expect(occupancyTokensFromLastCall(rows)).toBe(165_881);
  });

  it("adds completion_tokens to the chat-completions prompt", () => {
    const rows = [assistantWithUsage({ prompt_tokens: 50_000, completion_tokens: 12 })];
    expect(occupancyTokensFromLastCall(rows)).toBe(50_012);
  });
});

describe("occupancyTokensFromResultContextUsage", () => {
  it("adds outputTokens to the last-response prompt", () => {
    expect(
      occupancyTokensFromResultContextUsage({
        type: "result",
        contextUsage: {
          inputTokens: 4_120,
          outputTokens: 88,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ).toBe(4_208);
  });

  it("returns null when there is no prompt size", () => {
    expect(
      occupancyTokensFromResultContextUsage({ type: "result", contextUsage: { outputTokens: 12 } }),
    ).toBeNull();
  });
});

describe("live occupancy helpers", () => {
  it("sums prompt and streamed output", () => {
    expect(liveOccupancy(100, 7)).toBe(107);
    expect(liveOccupancy(-1, 5)).toBe(5);
  });

  it("throttles unchanged or too-frequent live publishes", () => {
    expect(
      shouldPublishLiveContext({
        force: true,
        now: 1_000,
        lastEmitAt: 0,
        lastUsed: 0,
        nextUsed: 40,
      }),
    ).toBe(true);
    expect(
      shouldPublishLiveContext({
        force: false,
        now: 1_000 + LIVE_CONTEXT_MIN_EMIT_MS - 1,
        lastEmitAt: 1_000,
        lastUsed: 40,
        nextUsed: 41,
      }),
    ).toBe(false);
    expect(
      shouldPublishLiveContext({
        force: false,
        now: 1_000 + LIVE_CONTEXT_MIN_EMIT_MS,
        lastEmitAt: 1_000,
        lastUsed: 40,
        nextUsed: 41,
      }),
    ).toBe(true);
    expect(
      shouldPublishLiveContext({
        force: true,
        now: 1_001,
        lastEmitAt: 1_000,
        lastUsed: 40,
        nextUsed: 40,
      }),
    ).toBe(false);
  });

  it("does not re-encode the live stream buffer on every delta", () => {
    expect(
      shouldEncodeLiveStreamOccupancy({ force: true, now: 1_000, lastEmitAt: 0 }),
    ).toBe(true);
    expect(
      shouldEncodeLiveStreamOccupancy({
        force: false,
        now: 1_000 + LIVE_CONTEXT_MIN_EMIT_MS - 1,
        lastEmitAt: 1_000,
      }),
    ).toBe(false);
    expect(
      shouldEncodeLiveStreamOccupancy({
        force: false,
        now: 1_000 + LIVE_CONTEXT_MIN_EMIT_MS,
        lastEmitAt: 1_000,
      }),
    ).toBe(true);
  });

  it("reads text, thinking, and partial tool JSON from stream events", () => {
    expect(
      occupancyDeltaFromStreamEvent({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      }),
    ).toBe("hi");
    expect(
      occupancyDeltaFromStreamEvent({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      }),
    ).toBe("hmm");
    expect(
      occupancyDeltaFromStreamEvent({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{\"q\":" },
        },
      }),
    ).toBe("{\"q\":");
    expect(occupancyDeltaFromStreamEvent({ type: "assistant" })).toBeNull();
  });
});

describe("contextUsageFromUsedTokens", () => {
  it("reports the provider number against the runtime's effective window", () => {
    // Live reading from the agent that started this fix: the runtime reported
    // 49,588 prompt tokens where the local prose count said ~4,400.
    const usage = contextUsageFromUsedTokens(
      "deepseek-flash",
      { runtime: "claude", vendor: "deepseek", sessionObserved: 1_000_000 },
      49_588,
    );
    expect(usage).toEqual({
      usedTokens: 49_588,
      contextWindow: 1_000_000,
      percent: 5,
      advertisedContextWindow: 1_000_000,
      advertisedWindowConfidence: "confirmed",
      advertisedWindowSource:
        "https://api-docs.deepseek.com/quick_start/pricing (owner-confirmed 2026-09-15)",
      windowOrigin: "session-observed",
    });
  });

  it("uses the runtime profile for a Codex model, flagged as clamped", () => {
    // 1.05M advertised, 828.4K effective on CLI 0.154.0 — the bar shows what is
    // actually usable and the tooltip keeps the official figure.
    const usage = contextUsageFromUsedTokens(
      "gpt-5.6-sol",
      {
        runtime: "codex",
        vendor: "openai",
        runtimeVersion: "0.154.0",
        requested: 1_050_000,
      },
      100_000,
    )!;
    expect(usage.contextWindow).toBe(828_400);
    expect(usage.advertisedContextWindow).toBe(1_050_000);
    expect(usage.windowOrigin).toBe("runtime-profile");
    expect(usage.windowObservedAt).toBe("2026-09-15");
    expect(usage.windowClamped).toBe(true);
    expect(usage.percent).toBe(12);
  });

  it("returns null when nothing is countable, but still reports a count with no ceiling", () => {
    expect(contextUsageFromUsedTokens("gpt-4o", { runtime: "claude", vendor: "openai" }, 0))
      .toBeNull();
    const usage = contextUsageFromUsedTokens(
      "not-a-real-model-12345",
      { runtime: "claude", vendor: "unknown" },
      100,
    )!;
    expect(usage).toEqual({ usedTokens: 100 });
  });
});

describe("promptTextFromMessage", () => {
  it("counts tool_result content on user rows (the bulk of a coding prompt)", () => {
    const text = promptTextFromMessage(
      userRow([
        { type: "tool_result", tool_use_id: "t1", content: "file contents here" },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "nested output" }] },
      ]),
    );
    expect(text).toContain("file contents here");
    expect(text).toContain("nested output");
  });

  it("counts tool_use arguments on assistant rows", () => {
    const text = promptTextFromMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }] },
    });
    expect(text).toContain("Edit");
    expect(text).toContain("a.ts");
  });

  it("handles string content and ignores empty messages", () => {
    expect(promptTextFromMessage(userRow("plain prompt"))).toBe("plain prompt");
    expect(promptTextFromMessage(userRow([{ type: "text", text: "blocks" }]))).toBe("blocks");
    expect(promptTextFromMessage(userRow([]))).toBe("");
    expect(promptTextFromMessage({ type: "system", payload: { type: "system" } })).toBe("");
    expect(promptTextFromMessage(null)).toBe("");
  });
});
