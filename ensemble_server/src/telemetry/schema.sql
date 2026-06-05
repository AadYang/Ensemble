-- Minimal telemetry schema. Three tables, no FKs across them — we keep
-- writes cheap and let the stats endpoint do the join math.
--
-- Idempotent: each CREATE is "IF NOT EXISTS" so reapplying on every server
-- boot is safe.

CREATE TABLE IF NOT EXISTS device (
  id            VARCHAR(36)   NOT NULL,
  platform      VARCHAR(16)   NOT NULL,
  arch          VARCHAR(16)   NOT NULL,
  last_version  VARCHAR(32)   NOT NULL,
  first_seen_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME      NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_platform (platform),
  INDEX idx_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS session (
  id            VARCHAR(36)   NOT NULL,
  device_id     VARCHAR(36)   NOT NULL,
  started_at    DATETIME      NOT NULL,
  last_beat_at  DATETIME      NOT NULL,
  ended_at      DATETIME      NULL,
  duration_ms   BIGINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  INDEX idx_device (device_id),
  INDEX idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_daily (
  device_id          VARCHAR(36) NOT NULL,
  date               DATE        NOT NULL,
  input_tokens       BIGINT      NOT NULL DEFAULT 0,
  output_tokens      BIGINT      NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT      NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT      NOT NULL DEFAULT 0,
  updated_at         DATETIME    NOT NULL,
  PRIMARY KEY (device_id, date),
  INDEX idx_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
