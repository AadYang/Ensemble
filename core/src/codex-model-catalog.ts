import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getCodexCliPath, toSpawnableCliPath } from "./cli-config.js";

const execFileAsync = promisify(execFile);
const DISCOVER_TIMEOUT_MS = 15_000;
const FRESH_DISCOVER_TIMEOUT_MS = 30_000;
const DISCOVER_MAX_BUFFER = 16 * 1024 * 1024;

export type CodexModelDiscovery =
  | { ok: true; models: string[]; source: string }
  | { ok: false; error: string };

export interface DiscoverCodexModelsOpts {
  /** Refresh button: wait for the CLI's live catalog fetch. Do not succeed
   *  from `models_cache.json` — that file is yesterday's list. */
  fresh?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function slugOf(model: Record<string, unknown>): string | null {
  const slug = model.slug ?? model.id ?? model.model;
  return typeof slug === "string" && slug.trim() ? slug : null;
}

function listedForApi(model: Record<string, unknown>): boolean {
  if (model.visibility === "hide") return false;
  if (model.supported_in_api === false) return false;
  return true;
}

function preferredForApi(model: Record<string, unknown>): boolean {
  return model.visibility === "list" && model.supported_in_api === true;
}

/** Same catalog `codex debug models` prints. Leading log noise is skipped.
 *  Empty / all-hidden catalogs return null so a refresh cannot wipe models. */
export function parseCodexModelCatalog(raw: string): string[] | null {
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  const rows = Array.isArray(parsed.models)
    ? parsed.models
    : Array.isArray(parsed.data)
      ? parsed.data
      : null;
  if (!rows) return null;
  const usable = rows.filter((row): row is Record<string, unknown> => isRecord(row) && slugOf(row) !== null && listedForApi(row));
  const preferred = usable.filter(preferredForApi);
  const chosen = preferred.length > 0 ? preferred : usable;
  if (chosen.length === 0) return null;
  return [...chosen]
    .sort((a, b) => (typeof a.priority === "number" ? a.priority : 999) - (typeof b.priority === "number" ? b.priority : 999))
    .map((row) => slugOf(row)!);
}

export function readCodexModelCache(codexHome = join(homedir(), ".codex")): string[] | null {
  const path = join(codexHome, "models_cache.json");
  if (!existsSync(path)) return null;
  try {
    return parseCodexModelCatalog(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function userCodexHome(): string {
  return join(homedir(), ".codex");
}

function discoverErrorMessage(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { code?: unknown; killed?: unknown; message?: unknown };
  if (e.killed || e.code === "ETIMEDOUT") return "timed out running `codex debug models`.";
  if (e.code === "ENOENT") return "could not spawn the Codex CLI executable.";
  const msg = typeof e.message === "string" ? e.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 240);
}

export async function discoverCodexModels(
  opts: DiscoverCodexModelsOpts = {},
): Promise<CodexModelDiscovery> {
  const fresh = opts.fresh === true;
  const rawPath = await getCodexCliPath();
  const codexPath = toSpawnableCliPath("codex", rawPath);

  if (codexPath) {
    try {
      // Default `codex debug models` refreshes the remote catalog. `--bundled`
      // would skip that and dump the binary's stale table — never pass it on
      // a user refresh.
      const { stdout } = await execFileAsync(codexPath, ["debug", "models"], {
        encoding: "utf8",
        timeout: fresh ? FRESH_DISCOVER_TIMEOUT_MS : DISCOVER_TIMEOUT_MS,
        maxBuffer: DISCOVER_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, CODEX_HOME: userCodexHome() },
      });
      const models = parseCodexModelCatalog(String(stdout ?? ""));
      if (models && models.length > 0) {
        return { ok: true, models, source: "codex debug models" };
      }
      if (fresh) {
        return { ok: false, error: "`codex debug models` returned no usable catalog." };
      }
    } catch (err) {
      if (fresh) return { ok: false, error: discoverErrorMessage(err) };
      const fromCache = readCodexModelCache(userCodexHome());
      if (fromCache) return { ok: true, models: fromCache, source: "~/.codex/models_cache.json" };
      return { ok: false, error: discoverErrorMessage(err) };
    }
  }

  if (fresh) {
    return {
      ok: false,
      error: codexPath
        ? "`codex debug models` returned no usable catalog."
        : "codex CLI not found — install it and run `codex login`.",
    };
  }

  const fromCache = readCodexModelCache(userCodexHome());
  if (fromCache) return { ok: true, models: fromCache, source: "~/.codex/models_cache.json" };
  if (!codexPath) {
    return { ok: false, error: "codex CLI not found — install it and run `codex login`." };
  }
  return { ok: false, error: "`codex debug models` returned no usable catalog." };
}
