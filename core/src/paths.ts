import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createRequire } from "node:module";

declare const require: NodeJS.Require | undefined;

// In tsx-run dev / `node` ESM mode `import.meta.url` is the source URL; in
// esbuild CJS bundle (SEA path) it's undefined and we fall back to cwd().
// REPO_ROOT is only consulted for dev paths; in PACKAGED mode every path is
// re-derived from process.execPath / env vars, so the fallback value never matters.
const here =
  typeof import.meta?.url === "string"
    ? dirname(fileURLToPath(import.meta.url))
    : process.cwd();

/** True when running inside a packaged single-file EXE. Detected via Node's
 * built-in SEA runtime check; env vars kept as manual overrides
 * (AGENTORCH_PACKAGED preserved for cherry-pick compatibility with AgentUI). */
export const PACKAGED = (() => {
  if (process.env.ENSEMBLE_PACKAGED === "1") return true;
  if (process.env.AGENTORCH_PACKAGED === "1") return true;
  try {
    const req =
      typeof require === "function"
        ? require
        : typeof import.meta?.url === "string"
          ? createRequire(import.meta.url)
          : null;
    if (!req) return false;
    const sea = req("node:sea") as { isSea?: () => boolean };
    return typeof sea.isSea === "function" && sea.isSea();
  } catch {
    return false;
  }
})();

/** Repo root in dev mode. Stable from `core/src/` upward. */
export const REPO_ROOT = resolve(here, "../..");

/** User-facing data dir. Packaged EXE → AGENTORCH_DATA_DIR (Tauri injects
 * appDataDir()) or fallback ~/.ensemble/. Dev → repo-local _data/.
 * SQLite filename stays `agentorch.db` so AgentUI ↔ Ensemble db files are
 * binary-compatible — easier user migration / cherry-pick of schema work. */
export const DATA_DIR = (() => {
  if (process.env.AGENTORCH_DATA_DIR) return resolve(process.env.AGENTORCH_DATA_DIR);
  return PACKAGED ? join(homedir(), ".ensemble") : join(REPO_ROOT, "_data");
})();

/** Static frontend root. Packaged → adjacent to exe (or sidecar binary).
 * Dev → desktop-ui/static-out/. */
export const WEB_ROOT = (() => {
  if (process.env.AGENTORCH_WEB_ROOT) return resolve(process.env.AGENTORCH_WEB_ROOT);
  if (PACKAGED) return join(dirname(process.execPath), "web");
  return join(REPO_ROOT, "desktop-ui", "static-out");
})();

/** Tokenizer vocab dir. Files (cl100k_base.json / o200k_base.json) are
 *  intentionally NOT bundled into the SEA EXE — they live as separate
 *  resources to keep the executable signature-clean and the embedded blob
 *  entropy low. Tauri Rust injects AGENTORCH_TOKENIZER_DIR pointing at
 *  resource_dir/tokenizer-data; standalone EXE looks adjacent to the
 *  executable; dev mode falls back to core/dist/tokenizer-data. */
export const TOKENIZER_DATA_DIR = (() => {
  if (process.env.AGENTORCH_TOKENIZER_DIR) return resolve(process.env.AGENTORCH_TOKENIZER_DIR);
  if (PACKAGED) return join(dirname(process.execPath), "tokenizer-data");
  return join(REPO_ROOT, "core", "dist", "tokenizer-data");
})();

export function ensureDataDir(): string {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export function webRootExists(): boolean {
  return existsSync(WEB_ROOT) && existsSync(join(WEB_ROOT, "index.html"));
}
