import { describe, it, expect } from "vitest";
import { buildPendingDailyEntries } from "../telemetry.js";

// Constructs the minimal UsageEvent-shaped record the function reads.
function row(date: string, fields: {
  input?: number; output?: number; cacheR?: number; cacheC?: number;
}) {
  return {
    inputTokens: fields.input ?? 0,
    outputTokens: fields.output ?? 0,
    cacheReadTokens: fields.cacheR ?? 0,
    cacheCreationTokens: fields.cacheC ?? 0,
    // UTC midnight on the named day so the en-CA bucket falls on that date
    // regardless of which timezone we feed in (we use UTC in tests).
    createdAt: new Date(`${date}T12:00:00Z`),
  };
}

const TZ = "UTC";

describe("buildPendingDailyEntries", () => {
  it("excludes today (partial day, may still receive rows)", () => {
    const today = "2026-05-15";
    const rows = [row(today, { input: 100, output: 50 })];
    expect(buildPendingDailyEntries(rows, TZ, null, today)).toEqual([]);
  });

  it("includes dates strictly newer than the watermark", () => {
    const entries = buildPendingDailyEntries(
      [
        row("2026-05-10", { input: 100 }),
        row("2026-05-13", { input: 200 }),
        row("2026-05-14", { input: 300 }),
      ],
      TZ,
      "2026-05-12", // last upload was through May 12
      "2026-05-15", // today
    );
    expect(entries.map((e) => e.date)).toEqual(["2026-05-13", "2026-05-14"]);
    expect(entries[0]!.inputTokens).toBe(200);
    expect(entries[1]!.inputTokens).toBe(300);
  });

  it("returns nothing when watermark is at-or-after newest available day", () => {
    const entries = buildPendingDailyEntries(
      [row("2026-05-13", { input: 100 })],
      TZ,
      "2026-05-13",
      "2026-05-15",
    );
    expect(entries).toEqual([]);
  });

  it("buckets multiple rows on the same day into one entry", () => {
    const entries = buildPendingDailyEntries(
      [
        row("2026-05-14", { input: 100, output: 10, cacheR: 5, cacheC: 0 }),
        row("2026-05-14", { input: 200, output: 20, cacheR: 0, cacheC: 7 }),
      ],
      TZ,
      null,
      "2026-05-15",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      date: "2026-05-14",
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 7, // cacheCreationTokens → cacheWriteTokens rename verified
    });
  });

  it("returns entries sorted oldest to newest", () => {
    const entries = buildPendingDailyEntries(
      [
        row("2026-05-14", { input: 1 }),
        row("2026-05-12", { input: 2 }),
        row("2026-05-13", { input: 3 }),
      ],
      TZ,
      null,
      "2026-05-15",
    );
    expect(entries.map((e) => e.date)).toEqual([
      "2026-05-12",
      "2026-05-13",
      "2026-05-14",
    ]);
  });

  it("watermark advance: returns nothing on second call once consumed", () => {
    const day = "2026-05-13";
    const today = "2026-05-15";
    const rows = [row(day, { input: 100 })];

    // First call — fresh, no watermark.
    const first = buildPendingDailyEntries(rows, TZ, null, today);
    expect(first.map((e) => e.date)).toEqual([day]);

    // Simulate caller storing the newest date as the new watermark, then
    // re-querying the same rows: nothing should come back.
    const second = buildPendingDailyEntries(rows, TZ, day, today);
    expect(second).toEqual([]);
  });
});
