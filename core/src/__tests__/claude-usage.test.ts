import { describe, expect, it } from "vitest";
import {
  billableResultForUsageAccounting,
  claudeModelUsageForBilling,
  isClaudeUsageRuntime,
  readClaudeUsageSnapshot,
  resultWithBillableClaudeUsage,
  type ClaudeUsageCounters,
  type ClaudeUsageSnapshot,
} from "../claude-usage.js";

const DEEPSEEK: ClaudeUsageCounters = {
  inputTokens: 12_000,
  outputTokens: 786_030,
  cacheReadInputTokens: 351_489_920,
  cacheCreationInputTokens: 0,
};

const DEEPSEEK_PREV: ClaudeUsageCounters = {
  inputTokens: 10_000,
  outputTokens: 700_000,
  cacheReadInputTokens: 340_000_000,
  cacheCreationInputTokens: 0,
};

const snapshot = (
  sessionId: string,
  models: Record<string, ClaudeUsageCounters>,
): ClaudeUsageSnapshot => ({ sessionId, models });

describe("isClaudeUsageRuntime", () => {
  it("covers Claude CLI paths only", () => {
    expect(isClaudeUsageRuntime("anthropic-local")).toBe(true);
    expect(isClaudeUsageRuntime("anthropic")).toBe(true);
    expect(isClaudeUsageRuntime("openai-compat")).toBe(false);
    expect(isClaudeUsageRuntime("openai-local")).toBe(false);
    expect(isClaudeUsageRuntime("openai-codex")).toBe(false);
  });
});

describe("readClaudeUsageSnapshot", () => {
  it("reads a defensive snapshot from agent metadata", () => {
    expect(readClaudeUsageSnapshot({
      claudeUsageSnapshot: {
        sessionId: "sid-1",
        models: {
          "deepseek-chat": {
            inputTokens: 10.9,
            outputTokens: -5,
            cacheReadInputTokens: Number.NaN,
            cacheCreationInputTokens: 4,
          },
        },
      },
    })).toEqual({
      sessionId: "sid-1",
      models: {
        "deepseek-chat": {
          inputTokens: 10,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 4,
        },
      },
    });
    expect(readClaudeUsageSnapshot(null)).toBeNull();
    expect(readClaudeUsageSnapshot({ lastSessionId: "x" })).toBeNull();
  });
});

describe("claudeModelUsageForBilling", () => {
  it("uses the first report as-is", () => {
    expect(claudeModelUsageForBilling({ "deepseek-chat": DEEPSEEK }, null, "sid-1")).toEqual({
      "deepseek-chat": DEEPSEEK,
    });
  });

  it("deltas a same-session cumulative DeepSeek resume dump", () => {
    expect(claudeModelUsageForBilling(
      { "deepseek-chat": DEEPSEEK },
      snapshot("sid-1", { "deepseek-chat": DEEPSEEK_PREV }),
      "sid-1",
    )).toEqual({
      "deepseek-chat": {
        inputTokens: 2_000,
        outputTokens: 86_030,
        cacheReadInputTokens: 11_489_920,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it("keeps official Claude per-query reports when any counter drops", () => {
    const previous = snapshot("sid-1", {
      "claude-opus-4-7": {
        inputTokens: 8_000,
        outputTokens: 4_000,
        cacheReadInputTokens: 20_000,
        cacheCreationInputTokens: 500,
      },
    });
    const current: ClaudeUsageCounters = {
      inputTokens: 12_000,
      outputTokens: 900,
      cacheReadInputTokens: 15_000,
      cacheCreationInputTokens: 800,
    };
    expect(claudeModelUsageForBilling({ "claude-opus-4-7": current }, previous, "sid-1")).toEqual({
      "claude-opus-4-7": current,
    });
  });

  it("does not delta across a new CLI session", () => {
    expect(claudeModelUsageForBilling(
      { "deepseek-chat": DEEPSEEK },
      snapshot("old-sid", { "deepseek-chat": DEEPSEEK_PREV }),
      "new-sid",
    )).toEqual({ "deepseek-chat": DEEPSEEK });
  });

  it("emits zeros when the CLI repeats the same cumulative totals", () => {
    expect(claudeModelUsageForBilling(
      { "deepseek-chat": DEEPSEEK },
      snapshot("sid-1", { "deepseek-chat": DEEPSEEK }),
      "sid-1",
    )).toEqual({
      "deepseek-chat": {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it("deltas known models and takes a newly reported model as-is", () => {
    expect(claudeModelUsageForBilling(
      {
        "deepseek-chat": DEEPSEEK,
        "deepseek-reasoner": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 20,
        },
      },
      snapshot("sid-1", { "deepseek-chat": DEEPSEEK_PREV }),
      "sid-1",
    )).toEqual({
      "deepseek-chat": {
        inputTokens: 2_000,
        outputTokens: 86_030,
        cacheReadInputTokens: 11_489_920,
        cacheCreationInputTokens: 0,
      },
      "deepseek-reasoner": {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 20,
      },
    });
  });
});

describe("resultWithBillableClaudeUsage", () => {
  it("rewrites modelUsage and keeps local counters from the raw payload", () => {
    const previous = snapshot("sid-1", { "deepseek-chat": DEEPSEEK_PREV });
    const { message, snapshot: next } = resultWithBillableClaudeUsage(
      {
        type: "result",
        session_id: "sid-1",
        modelUsage: {
          "deepseek-chat": {
            ...DEEPSEEK,
            inputTokensLocal: 99,
            outputTokensLocal: 7,
          },
        },
      },
      previous,
    );
    expect(next).toEqual(snapshot("sid-1", { "deepseek-chat": DEEPSEEK }));
    expect(message).toMatchObject({
      type: "result",
      session_id: "sid-1",
      modelUsage: {
        "deepseek-chat": {
          inputTokens: 2_000,
          outputTokens: 86_030,
          cacheReadInputTokens: 11_489_920,
          cacheCreationInputTokens: 0,
          inputTokensLocal: 99,
          outputTokensLocal: 7,
        },
      },
    });
  });

  it("leaves non-result messages alone", () => {
    const assistant = { type: "assistant", message: { content: [] } };
    expect(resultWithBillableClaudeUsage(assistant, null)).toEqual({
      message: assistant,
      snapshot: null,
    });
  });
});

describe("billableResultForUsageAccounting", () => {
  it("skips OpenAI / Codex results so in-process usage stays per-turn", () => {
    const msg = {
      type: "result",
      session_id: "sid-1",
      modelUsage: { "gpt-5.4": DEEPSEEK },
    };
    expect(billableResultForUsageAccounting(
      msg,
      { claudeUsageSnapshot: snapshot("sid-1", { "gpt-5.4": DEEPSEEK_PREV }) },
      "openai-compat",
    )).toEqual({ message: msg, snapshot: null });
  });
});
