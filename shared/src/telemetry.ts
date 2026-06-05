// Wire types for telemetry. Both ensemble_server (write) and the sidecar
// (post) import this so the contract is enforced at compile time on both
// sides. Keep these dumb structs — no helpers, no validation here (zod
// validation lives on the server route since the client is in the trust
// boundary).

export type Platform = "windows" | "macos" | "linux";
export type Arch = "x64" | "arm64";

/** Posted on app launch and every 30 min while the app is running. Also
 *  posted with `endingSession=true` on graceful shutdown so the server
 *  can stamp `ended_at` and compute final duration_ms. */
export interface HeartbeatBody {
  deviceId: string;
  sessionId: string;
  platform: Platform;
  arch: Arch;
  appVersion: string;
  uptimeMs: number;
  endingSession?: boolean;
}

/** Posted once per app launch when there's at least one local day whose
 *  totals haven't been uploaded yet. Multiple days bundled in one POST. */
export interface UsageReportEntry {
  date: string; // "YYYY-MM-DD" in user's local tz
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface UsageReportBody {
  deviceId: string;
  entries: UsageReportEntry[];
}

/** Admin stats response shape. */
export type StatsPeriod = "today" | "7d" | "30d" | "all";
export interface StatsResponse {
  period: StatsPeriod;
  totals: {
    devices: number;
    windows: number;
    macos: number;
    linux: number;
    activeDevices7d: number;
    sessions: number;
    tokens: number;
  };
  daily: Array<{
    date: string; // "YYYY-MM-DD"
    devices: number;
    sessions: number;
    tokens: number;
    durationHours: number;
  }>;
}
