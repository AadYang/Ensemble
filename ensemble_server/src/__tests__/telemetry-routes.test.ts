import { describe, it, expect } from "vitest";
import {
  bearerOk,
  heartbeatSchema,
  usageBodySchema,
} from "../telemetry/routes.js";

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

describe("heartbeatSchema", () => {
  it("accepts a clean payload", () => {
    const ok = heartbeatSchema.safeParse({
      deviceId: VALID_UUID,
      sessionId: VALID_UUID,
      platform: "windows",
      arch: "x64",
      appVersion: "0.0.3",
      uptimeMs: 1234,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects malformed UUIDs", () => {
    const bad = heartbeatSchema.safeParse({
      deviceId: "not-a-uuid",
      sessionId: VALID_UUID,
      platform: "windows",
      arch: "x64",
      appVersion: "0.0.3",
      uptimeMs: 0,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects unknown platform", () => {
    const bad = heartbeatSchema.safeParse({
      deviceId: VALID_UUID,
      sessionId: VALID_UUID,
      platform: "haiku",
      arch: "x64",
      appVersion: "0.0.3",
      uptimeMs: 0,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects unreasonably large uptimeMs (clock skew / spoof)", () => {
    const bad = heartbeatSchema.safeParse({
      deviceId: VALID_UUID,
      sessionId: VALID_UUID,
      platform: "linux",
      arch: "arm64",
      appVersion: "9.9.9",
      uptimeMs: 365 * 24 * 60 * 60 * 1000, // 1 year
    });
    expect(bad.success).toBe(false);
  });

  it("optional endingSession round-trips", () => {
    const ok = heartbeatSchema.safeParse({
      deviceId: VALID_UUID,
      sessionId: VALID_UUID,
      platform: "macos",
      arch: "arm64",
      appVersion: "0.1.0",
      uptimeMs: 7200000,
      endingSession: true,
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.endingSession).toBe(true);
  });
});

describe("usageBodySchema", () => {
  it("accepts a typical single-day report", () => {
    const ok = usageBodySchema.safeParse({
      deviceId: VALID_UUID,
      entries: [
        {
          date: "2026-05-14",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects empty entries array (nothing to report)", () => {
    const bad = usageBodySchema.safeParse({ deviceId: VALID_UUID, entries: [] });
    expect(bad.success).toBe(false);
  });

  it("rejects malformed date string", () => {
    const bad = usageBodySchema.safeParse({
      deviceId: VALID_UUID,
      entries: [
        {
          date: "May 14",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects negative token counts", () => {
    const bad = usageBodySchema.safeParse({
      deviceId: VALID_UUID,
      entries: [
        {
          date: "2026-05-14",
          inputTokens: -1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it("caps entries at 366 to defend against flooding", () => {
    const entries = Array.from({ length: 367 }, (_, i) => ({
      date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }));
    const bad = usageBodySchema.safeParse({ deviceId: VALID_UUID, entries });
    expect(bad.success).toBe(false);
  });
});

describe("bearerOk", () => {
  const SECRET = "abc123def456";

  it("accepts the exact secret with Bearer prefix", () => {
    expect(bearerOk(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects missing header", () => {
    expect(bearerOk(undefined, SECRET)).toBe(false);
  });

  it("rejects no Bearer prefix", () => {
    expect(bearerOk(SECRET, SECRET)).toBe(false);
  });

  it("rejects wrong secret with same length", () => {
    expect(bearerOk(`Bearer xyz123def456`, SECRET)).toBe(false);
  });

  it("rejects wrong-length secret (no timingSafeEqual crash)", () => {
    expect(bearerOk(`Bearer short`, SECRET)).toBe(false);
    expect(bearerOk(`Bearer ${SECRET}extra`, SECRET)).toBe(false);
  });
});
