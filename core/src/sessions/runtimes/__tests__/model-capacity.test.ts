import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capacityRetryDelayMs,
  isModelAtCapacity,
  MODEL_CAPACITY_MAX_ATTEMPTS,
  shouldRetryModelCapacity,
  waitForCapacityRetry,
} from "../model-capacity.js";

describe("isModelAtCapacity", () => {
  it("matches the ChatGPT / Codex exec sentence", () => {
    expect(
      isModelAtCapacity("Selected model is at capacity. Please try a different model."),
    ).toBe(true);
  });

  it("matches model overloaded and Claude overloaded_error", () => {
    expect(isModelAtCapacity("model overloaded")).toBe(true);
    expect(isModelAtCapacity("API Error: overloaded_error (529)")).toBe(true);
  });

  it("does not match context-window or a bare overloaded", () => {
    expect(isModelAtCapacity("context window at 80% capacity")).toBe(false);
    expect(isModelAtCapacity("overloaded")).toBe(false);
    expect(isModelAtCapacity("QUERY_FAILED")).toBe(false);
    expect(isModelAtCapacity("stream disconnected before completion")).toBe(false);
  });
});

describe("shouldRetryModelCapacity", () => {
  const base = {
    message: "Selected model is at capacity. Please try a different model.",
    attempt: 1,
    yieldedVisible: false,
    aborted: false,
  };

  it("retries the first two failures and stops at the third", () => {
    expect(shouldRetryModelCapacity({ ...base, attempt: 1 })).toBe(true);
    expect(shouldRetryModelCapacity({ ...base, attempt: 2 })).toBe(true);
    expect(shouldRetryModelCapacity({ ...base, attempt: 3 })).toBe(false);
    expect(MODEL_CAPACITY_MAX_ATTEMPTS).toBe(3);
  });

  it("does not retry after the user has already seen output", () => {
    expect(shouldRetryModelCapacity({ ...base, yieldedVisible: true })).toBe(false);
  });

  it("does not retry after abort", () => {
    expect(shouldRetryModelCapacity({ ...base, aborted: true })).toBe(false);
  });

  it("does not retry unrelated errors", () => {
    expect(shouldRetryModelCapacity({ ...base, message: "codex turn ended before turn.completed" })).toBe(
      false,
    );
  });

  it("retries an HTTP 429 even when the body has no capacity sentence", () => {
    expect(
      shouldRetryModelCapacity({
        ...base,
        message: "Too Many Requests",
        rateLimited: true,
      }),
    ).toBe(true);
  });
});

describe("capacityRetryDelayMs", () => {
  it("backs off 2s then 4s", () => {
    expect(capacityRetryDelayMs(1)).toBe(2000);
    expect(capacityRetryDelayMs(2)).toBe(4000);
  });
});

describe("waitForCapacityRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true after the delay", async () => {
    vi.useFakeTimers();
    const p = waitForCapacityRetry(new AbortController().signal, 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe(true);
  });

  it("returns false immediately when already aborted", async () => {
    const c = new AbortController();
    c.abort();
    expect(await waitForCapacityRetry(c.signal, 1)).toBe(false);
  });

  it("returns false if aborted during the wait", async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const p = waitForCapacityRetry(c.signal, 1);
    c.abort();
    expect(await p).toBe(false);
  });
});
