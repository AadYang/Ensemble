// Sidecar telemetry: per-launch heartbeat + once-per-day token roll-up.
//
// Reads four env vars set by the Tauri shell (src-tauri/src/lib.rs):
//   ENSEMBLE_DEVICE_ID      anonymous UUIDv4 generated on first launch
//   ENSEMBLE_PLATFORM       "windows" | "macos" | "linux"
//   ENSEMBLE_ARCH           "x64" | "arm64"
//   ENSEMBLE_APP_VERSION    semver of the running Tauri binary
//
// If any of those are missing (e.g. `tsx watch` dev run with no shell)
// telemetry is a no-op — the sidecar starts cleanly, just doesn't phone home.

import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";
import type {
  HeartbeatBody,
  UsageReportBody,
  UsageReportEntry,
  Platform,
  Arch,
} from "@agentorch/shared";

const TELEMETRY_BASE =
  process.env.ENSEMBLE_TELEMETRY_URL ?? "https://ensemble-ai.cn/v1/telemetry";
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const LAST_UPLOAD_KEY = "telemetry.lastDailyUpload";

let started = false;

function bucketDateKey(date: Date, tz: string): string {
  // Same shape as core/src/usage-aggregate.ts:61-80. Re-implemented locally
  // rather than exported across modules to keep usage-aggregate's surface
  // minimal — they don't have to evolve together.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
}

function detectTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Post helper that never throws — telemetry must NEVER take down the
 *  sidecar. All errors are logged and swallowed. Returns true on 2xx. */
async function postJson(path: string, body: unknown, timeoutMs = 4000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${TELEMETRY_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      credentials: "omit",
    });
    if (!res.ok) {
      console.warn(`[telemetry] ${path} returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[telemetry] ${path} failed:`, (err as Error).message ?? err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface Env {
  deviceId: string;
  platform: Platform;
  arch: Arch;
  appVersion: string;
}

function readEnv(): Env | null {
  const deviceId = process.env.ENSEMBLE_DEVICE_ID;
  const platform = process.env.ENSEMBLE_PLATFORM as Platform | undefined;
  const arch = process.env.ENSEMBLE_ARCH as Arch | undefined;
  const appVersion = process.env.ENSEMBLE_APP_VERSION;
  if (!deviceId || !platform || !arch || !appVersion) return null;
  return { deviceId, platform, arch, appVersion };
}

/** Read/write the date watermark via the AppSetting table (same pattern as
 *  cli-config.ts:25-46). The watermark is the last date INCLUDED in a
 *  successful upload — partial-day "today" is never reported until it ends. */
async function getLastUploadDate(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: LAST_UPLOAD_KEY } });
  return typeof row?.value === "string" ? row.value : null;
}
async function setLastUploadDate(date: string): Promise<void> {
  const existing = await prisma.appSetting.findUnique({ where: { key: LAST_UPLOAD_KEY } });
  if (existing) {
    await prisma.appSetting.update({ where: { key: LAST_UPLOAD_KEY }, data: { value: date } });
  } else {
    await prisma.appSetting.create({ data: { key: LAST_UPLOAD_KEY, value: date } });
  }
}

/** Bucket UsageEvent rows into daily totals in the user's local tz, then
 *  produce only entries for dates strictly newer than `since` and strictly
 *  older than today (today is never sent — it may still receive more rows). */
export function buildPendingDailyEntries(
  rows: ReadonlyArray<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    createdAt: Date;
  }>,
  tz: string,
  since: string | null,
  today: string,
): UsageReportEntry[] {
  const byDate = new Map<string, UsageReportEntry>();
  for (const r of rows) {
    const date = bucketDateKey(r.createdAt, tz);
    if (date >= today) continue; // skip incomplete current day
    if (since && date <= since) continue; // already uploaded
    let entry = byDate.get(date);
    if (!entry) {
      entry = {
        date,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      byDate.set(date, entry);
    }
    entry.inputTokens += r.inputTokens;
    entry.outputTokens += r.outputTokens;
    entry.cacheReadTokens += r.cacheReadTokens;
    // Map: client's cacheCreationTokens (Anthropic name) → server's
    // cacheWriteTokens (provider-agnostic name).
    entry.cacheWriteTokens += r.cacheCreationTokens;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function attemptDailyRollup(env: Env): Promise<void> {
  const tz = detectTz();
  const today = bucketDateKey(new Date(), tz);
  const since = await getLastUploadDate();

  const rows = await prisma.usageEvent.findMany({});
  const entries = buildPendingDailyEntries(rows, tz, since, today);
  if (entries.length === 0) return;

  const body: UsageReportBody = { deviceId: env.deviceId, entries };
  const ok = await postJson("/usage", body);
  if (!ok) return;
  // Advance the watermark to the most recent included date.
  const newest = entries[entries.length - 1]!.date;
  await setLastUploadDate(newest);
  console.log(`[telemetry] uploaded ${entries.length} daily roll-up(s) through ${newest}`);
}

/** Mount the telemetry loop. Called once from index.ts after fastify.listen.
 *  Idempotent: subsequent calls in the same process are no-ops. */
export function startTelemetry(): void {
  if (started) return;
  const env = readEnv();
  if (!env) {
    console.log("[telemetry] disabled (missing env vars — dev run?)");
    return;
  }
  started = true;
  const sessionId = randomUUID();
  const launchedAt = Date.now();

  const buildHeartbeat = (endingSession?: boolean): HeartbeatBody => ({
    deviceId: env.deviceId,
    sessionId,
    platform: env.platform,
    arch: env.arch,
    appVersion: env.appVersion,
    uptimeMs: Date.now() - launchedAt,
    ...(endingSession ? { endingSession: true } : {}),
  });

  // Fire-and-forget first heartbeat + daily rollup. We don't block startup.
  void (async () => {
    await postJson("/heartbeat", buildHeartbeat());
    try {
      await attemptDailyRollup(env);
    } catch (err) {
      console.warn("[telemetry] daily rollup failed:", err);
    }
  })();

  const intervalId = setInterval(() => {
    void postJson("/heartbeat", buildHeartbeat());
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for telemetry.
  intervalId.unref();

  let exitBeatSent = false;
  const flushExitBeat = (signal: string) => {
    if (exitBeatSent) return;
    exitBeatSent = true;
    console.log(`[telemetry] flushing exit heartbeat (${signal})`);
    // Best-effort, very short timeout — exit can't wait forever.
    void postJson("/heartbeat", buildHeartbeat(true), 1500);
  };
  process.once("SIGTERM", () => flushExitBeat("SIGTERM"));
  process.once("SIGINT", () => flushExitBeat("SIGINT"));
  process.once("beforeExit", () => flushExitBeat("beforeExit"));

  console.log(
    `[telemetry] enabled — device=${env.deviceId.slice(0, 8)} platform=${env.platform} version=${env.appVersion}`,
  );
}
