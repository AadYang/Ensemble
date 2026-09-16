import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexUsageSnapshotToDelta,
  normalizeCodexUsageSnapshot,
  parseCodexTurnContextTail,
  readCodexTurnContext,
  readCodexUsageSnapshot,
} from "../codex-usage.js";

describe("Codex usage accounting", () => {
  it("normalizes usage snapshots defensively", () => {
    expect(normalizeCodexUsageSnapshot({
      input_tokens: 10.9,
      cached_input_tokens: -5,
      output_tokens: Number.NaN,
      reasoning_output_tokens: 4,
    })).toEqual({
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 4,
    });
    expect(normalizeCodexUsageSnapshot(null)).toBeNull();
  });

  it("reads the prior snapshot from agent metadata", () => {
    expect(readCodexUsageSnapshot({
      codexUsageSnapshot: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 30,
        reasoning_output_tokens: 5,
      },
    })).toEqual({
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 30,
      reasoning_output_tokens: 5,
    });
  });

  it("turns cumulative snapshots into per-turn deltas", () => {
    const delta = codexUsageSnapshotToDelta(
      {
        input_tokens: 1500,
        cached_input_tokens: 400,
        output_tokens: 250,
        reasoning_output_tokens: 50,
      },
      {
        input_tokens: 1000,
        cached_input_tokens: 300,
        output_tokens: 100,
        reasoning_output_tokens: 20,
      },
    );
    expect(delta).toEqual({
      regularInputTokens: 400,
      cacheReadInputTokens: 100,
      outputTokens: 180,
      cacheCreationInputTokens: 0,
    });
  });

  it("keeps cache reads out of ordinary input tokens", () => {
    expect(codexUsageSnapshotToDelta({
      input_tokens: 1000,
      cached_input_tokens: 600,
      output_tokens: 100,
      reasoning_output_tokens: 0,
    }, null)).toEqual({
      regularInputTokens: 400,
      cacheReadInputTokens: 600,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
    });
  });

  it("takes the LAST token_count event from a rollout tail", () => {
    // Verbatim shape from a live rollout (gpt-5.6-sol): the trailing event wins,
    // and `last_token_usage.input_tokens` includes the cached subset.
    const tail = [
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", text: "hi" } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 474_284, cached_input_tokens: 392_064 },
            last_token_usage: { input_tokens: 24_601, cached_input_tokens: 21_000 },
            model_context_window: 258_400,
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 561_616, cached_input_tokens: 473_856 },
            last_token_usage: { input_tokens: 81_990, cached_input_tokens: 77_568 },
            model_context_window: 258_400,
          },
        },
      }),
    ].join("\n");

    expect(parseCodexTurnContextTail(tail)).toEqual({
      promptTokens: 81_990,
      cachedInputTokens: 77_568,
      contextWindow: 258_400,
    });
  });

  it("skips an unparseable partial first line (tail reads start mid-line)", () => {
    const tail = [
      '"input_tokens":99999,"cached_input_tokens":0}},"model_context_window":100000}}}',
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 4_120 },
            model_context_window: 258_400,
          },
        },
      }),
    ].join("\n");

    expect(parseCodexTurnContextTail(tail)).toEqual({
      promptTokens: 4_120,
      cachedInputTokens: 0,
      contextWindow: 258_400,
    });
  });

  it("returns null when the tail has no usable token_count event", () => {
    expect(parseCodexTurnContextTail("")).toBeNull();
    expect(parseCodexTurnContextTail('{"type":"event_msg","payload":{"type":"agent_message"}}')).toBeNull();
    // A token_count without last_token_usage can't size a prompt.
    expect(
      parseCodexTurnContextTail(
        JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {} } }),
      ),
    ).toBeNull();
    expect(
      parseCodexTurnContextTail(
        JSON.stringify({
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { input_tokens: 0 } } },
        }),
      ),
    ).toBeNull();
  });

  it("reads the newest event off disk through a bounded tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "ensemble-codex-rollout-"));
    try {
      const path = join(dir, "rollout.jsonl");
      // ~440KB of conversation history, so the 256KB tail read is guaranteed to
      // start mid-line (the real shape of a long thread's rollout).
      const filler = Array.from({ length: 2000 }, (_, i) =>
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", text: "x".repeat(200), i } }),
      );
      writeFileSync(
        path,
        [
          ...filler,
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { input_tokens: 87_332, cached_input_tokens: 81_792 },
                model_context_window: 258_400,
              },
            },
          }),
        ].join("\n"),
        "utf8",
      );

      expect(readCodexTurnContext(path)).toEqual({
        promptTokens: 87_332,
        cachedInputTokens: 81_792,
        contextWindow: 258_400,
      });
      // Missing / empty paths must not throw — the caller falls back to a local
      // count rather than showing a fabricated bar.
      expect(readCodexTurnContext(join(dir, "nope.jsonl"))).toBeNull();
      expect(readCodexTurnContext("")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats counter resets as a fresh snapshot instead of producing negative deltas", () => {
    expect(codexUsageSnapshotToDelta(
      {
        input_tokens: 200,
        cached_input_tokens: 25,
        output_tokens: 10,
        reasoning_output_tokens: 2,
      },
      {
        input_tokens: 1000,
        cached_input_tokens: 100,
        output_tokens: 50,
        reasoning_output_tokens: 20,
      },
    )).toEqual({
      regularInputTokens: 175,
      cacheReadInputTokens: 25,
      outputTokens: 12,
      cacheCreationInputTokens: 0,
    });
  });
});
