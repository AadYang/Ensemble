import { describe, expect, it } from "vitest";
import { createEventLoopYielder } from "../event-loop-yield.js";

describe("createEventLoopYielder", () => {
  it("does not yield on every 1-char delta after a slow poll", async () => {
    let flushes = 0;
    let t = 1_000;
    const yieldEventLoop = createEventLoopYielder({
      everyN: 8,
      minMs: 16,
      now: () => t,
      flush: async () => {
        flushes++;
        t += 50;
      },
    });
    for (let i = 0; i < 80; i++) {
      t += 1;
      await yieldEventLoop();
    }
    expect(flushes).toBeLessThanOrEqual(12);
    expect(flushes).toBeGreaterThanOrEqual(10);
  });

  it("still yields often enough that a 16ms gap is honoured", async () => {
    let flushes = 0;
    let t = 1_000;
    const yieldEventLoop = createEventLoopYielder({
      everyN: 8,
      minMs: 16,
      now: () => t,
      flush: async () => {
        flushes++;
      },
    });
    await yieldEventLoop();
    t += 20;
    await yieldEventLoop();
    expect(flushes).toBe(2);
  });
});
