import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  HeartbeatBody,
  UsageReportBody,
  StatsPeriod,
  StatsResponse,
} from "@agentorch/shared";
import { TelemetryDb } from "./db.js";

// ─── zod schemas ─────────────────────────────────────────────────────────
// Lenient on extras (z.object strict-mode off) so future client fields don't
// break old servers. Restrictive on what we DO accept.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_VALUES = ["windows", "macos", "linux"] as const;
const ARCH_VALUES = ["x64", "arm64"] as const;

export const heartbeatSchema = z.object({
  deviceId: z.string().regex(UUID_RE),
  sessionId: z.string().regex(UUID_RE),
  platform: z.enum(PLATFORM_VALUES),
  arch: z.enum(ARCH_VALUES),
  // semver-ish: digits and dots, no enforcement of pre-release segments
  appVersion: z.string().min(1).max(32),
  // 30-day cap: anything beyond suggests a clock-skew or a forged payload
  uptimeMs: z.number().int().min(0).max(30 * 24 * 60 * 60 * 1000),
  endingSession: z.boolean().optional(),
});

const usageEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
});

export const usageBodySchema = z.object({
  deviceId: z.string().regex(UUID_RE),
  // Cap one POST at a year — defends against accidental floods if a client
  // bug pumps thousands of empty entries.
  entries: z.array(usageEntrySchema).min(1).max(366),
});

const statsPeriodSchema = z.enum(["today", "7d", "30d", "all"]);

// ─── admin bearer guard ──────────────────────────────────────────────────
export function bearerOk(headerVal: string | undefined, expected: string): boolean {
  if (!headerVal) return false;
  const m = /^Bearer\s+(.+)$/.exec(headerVal);
  if (!m) return false;
  const got = Buffer.from(m[1]!.trim(), "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

// ─── route registration ──────────────────────────────────────────────────
export function registerTelemetryRoutes(app: FastifyInstance, db: TelemetryDb): void {
  const adminToken = process.env.ENSEMBLE_ADMIN_TOKEN ?? "";

  // POST /v1/telemetry/heartbeat — upsert device, upsert session.
  app.post("/v1/telemetry/heartbeat", async (req, reply) => {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", detail: parsed.error.issues };
    }
    const body = parsed.data as HeartbeatBody;
    const now = new Date();

    const conn = await db.pool.getConnection();
    try {
      // Upsert device: fresh first_seen on insert, refresh last_seen +
      // last_version on update. platform/arch should be stable per id,
      // but we still overwrite — costs nothing and self-heals if a user
      // restored their app data dir onto a different OS.
      await conn.query(
        `INSERT INTO device (id, platform, arch, last_version, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           platform = VALUES(platform),
           arch = VALUES(arch),
           last_version = VALUES(last_version),
           last_seen_at = VALUES(last_seen_at)`,
        [body.deviceId, body.platform, body.arch, body.appVersion, now, now],
      );

      // Session: derived started_at = now - uptime so reconnecting heartbeats
      // don't reset the start anchor. duration_ms is uptimeMs from the client.
      const startedAt = new Date(now.getTime() - body.uptimeMs);
      const endedAt = body.endingSession ? now : null;
      await conn.query(
        `INSERT INTO session
           (id, device_id, started_at, last_beat_at, ended_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           last_beat_at = VALUES(last_beat_at),
           ended_at = COALESCE(ended_at, VALUES(ended_at)),
           duration_ms = GREATEST(duration_ms, VALUES(duration_ms))`,
        [body.sessionId, body.deviceId, startedAt, now, endedAt, body.uptimeMs],
      );
      return { ok: true };
    } finally {
      conn.release();
    }
  });

  // POST /v1/telemetry/usage — bulk upsert per-day token totals.
  app.post("/v1/telemetry/usage", async (req, reply) => {
    const parsed = usageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", detail: parsed.error.issues };
    }
    const body = parsed.data as UsageReportBody;
    const now = new Date();

    const conn = await db.pool.getConnection();
    try {
      // One INSERT … VALUES … per row. Could batch with VALUES(...),(...)
      // for many-day backfill but client never sends more than ~30 entries
      // (one per local day since lastDailyUpload) — clarity wins.
      for (const e of body.entries) {
        await conn.query(
          `INSERT INTO usage_daily
             (device_id, date, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             input_tokens = VALUES(input_tokens),
             output_tokens = VALUES(output_tokens),
             cache_read_tokens = VALUES(cache_read_tokens),
             cache_write_tokens = VALUES(cache_write_tokens),
             updated_at = VALUES(updated_at)`,
          [
            body.deviceId,
            e.date,
            e.inputTokens,
            e.outputTokens,
            e.cacheReadTokens,
            e.cacheWriteTokens,
            now,
          ],
        );
      }
      return { ok: true, accepted: body.entries.length };
    } finally {
      conn.release();
    }
  });

  // GET /v1/telemetry/stats — admin-only.
  app.get<{ Querystring: { period?: string } }>("/v1/telemetry/stats", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!adminToken || !bearerOk(auth, adminToken)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const pp = statsPeriodSchema.safeParse(req.query.period ?? "30d");
    const period: StatsPeriod = pp.success ? pp.data : "30d";

    const days = period === "today" ? 0 : period === "7d" ? 7 : period === "30d" ? 30 : 36500;
    const sinceCutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const conn = await db.pool.getConnection();
    try {
      // Totals: count distinct devices in window, split by platform; active
      // last-7d uses a fixed look-back regardless of `period` so the
      // headline "currently engaged users" number stays meaningful.
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [devRows] = await conn.query(
        `SELECT
           COUNT(*)                                                  AS devices,
           SUM(platform='windows')                                   AS windows,
           SUM(platform='macos')                                     AS macos,
           SUM(platform='linux')                                     AS linux,
           SUM(last_seen_at >= ?)                                    AS active7d
         FROM device
         WHERE first_seen_at >= ?`,
        [sevenDaysAgo, sinceCutoff],
      );
      const dev = (devRows as Array<Record<string, number | null>>)[0] ?? {};

      const [sessRows] = await conn.query(
        `SELECT COUNT(*) AS sessions FROM session WHERE started_at >= ?`,
        [sinceCutoff],
      );
      const sess = (sessRows as Array<Record<string, number>>)[0]?.sessions ?? 0;

      const [tokRows] = await conn.query(
        `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens
         FROM usage_daily WHERE date >= DATE(?)`,
        [sinceCutoff],
      );
      const tokens = Number((tokRows as Array<Record<string, number | string>>)[0]?.tokens ?? 0);

      const [dailyRows] = await conn.query(
        `SELECT
           u.date                                                                    AS date,
           COUNT(DISTINCT u.device_id)                                               AS devices,
           IFNULL(s.sessions, 0)                                                     AS sessions,
           SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) AS tokens,
           IFNULL(s.duration_hours, 0)                                               AS duration_hours
         FROM usage_daily u
         LEFT JOIN (
           SELECT DATE(started_at) AS date,
                  COUNT(*) AS sessions,
                  SUM(duration_ms) / 3600000 AS duration_hours
           FROM session
           WHERE started_at >= ?
           GROUP BY DATE(started_at)
         ) s ON s.date = u.date
         WHERE u.date >= DATE(?)
         GROUP BY u.date, s.sessions, s.duration_hours
         ORDER BY u.date ASC`,
        [sinceCutoff, sinceCutoff],
      );

      const resp: StatsResponse = {
        period,
        totals: {
          devices: Number(dev.devices ?? 0),
          windows: Number(dev.windows ?? 0),
          macos: Number(dev.macos ?? 0),
          linux: Number(dev.linux ?? 0),
          activeDevices7d: Number(dev.active7d ?? 0),
          sessions: Number(sess),
          tokens,
        },
        daily: (dailyRows as Array<Record<string, string | number>>).map((r) => ({
          date: String(r.date),
          devices: Number(r.devices),
          sessions: Number(r.sessions),
          tokens: Number(r.tokens),
          durationHours: Number(r.duration_hours),
        })),
      };
      return resp;
    } finally {
      conn.release();
    }
  });
}
