import { homedir } from "node:os";
import { join } from "node:path";

export const PORT = Number(process.env.PORT ?? 8790);
export const INVITE_CODE = process.env.INVITE_CODE ?? "redtea-yzr";
export const PUBLIC_BASE =
  process.env.PUBLIC_BASE ?? `http://127.0.0.1:${PORT}`;
export const DATA_DIR =
  process.env.DATA_DIR ?? join(homedir(), ".ensemble-postoffice");
export const SESSION_DAYS = 30;
export const BIND_STALE_MS = 90_000;
export const MAX_MAILBOXES = 20;
export const MAX_BODY_CHARS = 32_000;
export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WAIT_DEFAULT_SEC = 600;
export const WAIT_MAX_SEC = 900;
export const VERSION = "0.1.12";
