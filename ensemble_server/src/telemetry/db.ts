// mysql2 connection pool + one-shot schema migration. The pool is created
// lazily — if no MySQL is configured (dev runs, sanity checks) we still let
// the rest of the server boot, the telemetry routes will fail their own
// requests rather than crashing the process.

import { createPool, type Pool } from "mysql2/promise";

// Schema inlined as a constant rather than read from schema.sql at runtime
// because tsc doesn't copy .sql alongside .js into dist/, and we don't want
// a build step. schema.sql still exists in the repo as the canonical source;
// keep both in sync when DDL changes.
const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS device (
     id            VARCHAR(36)   NOT NULL,
     platform      VARCHAR(16)   NOT NULL,
     arch          VARCHAR(16)   NOT NULL,
     last_version  VARCHAR(32)   NOT NULL,
     first_seen_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
     last_seen_at  DATETIME      NOT NULL,
     PRIMARY KEY (id),
     INDEX idx_platform (platform),
     INDEX idx_last_seen (last_seen_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS session (
     id            VARCHAR(36)   NOT NULL,
     device_id     VARCHAR(36)   NOT NULL,
     started_at    DATETIME      NOT NULL,
     last_beat_at  DATETIME      NOT NULL,
     ended_at      DATETIME      NULL,
     duration_ms   BIGINT        NOT NULL DEFAULT 0,
     PRIMARY KEY (id),
     INDEX idx_device (device_id),
     INDEX idx_started (started_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS usage_daily (
     device_id          VARCHAR(36) NOT NULL,
     date               DATE        NOT NULL,
     input_tokens       BIGINT      NOT NULL DEFAULT 0,
     output_tokens      BIGINT      NOT NULL DEFAULT 0,
     cache_read_tokens  BIGINT      NOT NULL DEFAULT 0,
     cache_write_tokens BIGINT      NOT NULL DEFAULT 0,
     updated_at         DATETIME    NOT NULL,
     PRIMARY KEY (device_id, date),
     INDEX idx_date (date)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export interface TelemetryDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function readDbConfig(): TelemetryDbConfig | null {
  const host = process.env.ENSEMBLE_MYSQL_HOST;
  const user = process.env.ENSEMBLE_MYSQL_USER;
  const password = process.env.ENSEMBLE_MYSQL_PASSWORD;
  const database = process.env.ENSEMBLE_MYSQL_DATABASE;
  // Any one missing → telemetry is intentionally off (dev environment).
  if (!host || !user || password == null || !database) return null;
  const port = Number(process.env.ENSEMBLE_MYSQL_PORT ?? 3306);
  return { host, port, user, password, database };
}

export class TelemetryDb {
  readonly pool: Pool;

  constructor(cfg: TelemetryDbConfig) {
    this.pool = createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      // Modest pool — telemetry traffic is small and bursty (one heartbeat
      // per device every 30 min). 8 connections handles thousands of devs.
      connectionLimit: 8,
      // Strict types so DATE columns come back as "YYYY-MM-DD" strings,
      // not Date objects which would need extra formatting on the wire.
      dateStrings: ["DATE"],
      // utf8mb4 to cover any release-notes emojis some day.
      charset: "utf8mb4",
    });
  }

  /** Run CREATE TABLE IF NOT EXISTS for all telemetry tables. Idempotent —
   *  safe to call on every server boot. Throws on connection failure so the
   *  server logs the cause prominently rather than silently degrading. */
  async migrate(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      for (const stmt of SCHEMA_STATEMENTS) {
        await conn.query(stmt);
      }
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
