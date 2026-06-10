import { describe, expect, it } from "vitest";
import {
  codexUsageSnapshotToDelta,
  normalizeCodexUsageSnapshot,
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
