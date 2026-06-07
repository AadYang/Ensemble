import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { prisma } from "./db.js";
import { currentPlatformKey } from "./platform-key.js";
import type { PlatformKey } from "@agentorch/shared";

export type CliKind = "claude" | "codex";
export type CliSource = "manual" | "env" | "path" | "common-location" | "vendor" | "missing";

export const MIN_CODEX_VERSION = "0.132.0";

export interface CliHealth {
  platformKey: PlatformKey;
  found: boolean;
  path: string | null;
  source: CliSource;
  manualPath: string | null;
  version?: string;
  versionTooOld?: boolean;
  minSupportedVersion?: string;
  authPresent?: boolean;
  authPath?: string;
  error?: string;
}

export interface CliSettingsHealth {
  claude: CliHealth;
  codex: CliHealth;
}

const SETTING_CLAUDE_PATH = "cli.claudePath";
const SETTING_CODEX_PATH = "cli.codexPath";

function settingKey(kind: CliKind): string {
  return kind === "claude" ? SETTING_CLAUDE_PATH : SETTING_CODEX_PATH;
}

async function getManualPath(kind: CliKind): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: settingKey(kind) } });
  return typeof row?.value === "string" && row.value.trim() ? row.value.trim() : null;
}

export async function setManualCliPath(kind: CliKind, value: string | null): Promise<void> {
  const key = settingKey(kind);
  const normalized = value?.trim() ? resolveManualCliInput(kind, value.trim()) : null;
  const existing = await prisma.appSetting.findUnique({ where: { key } });
  if (existing) {
    await prisma.appSetting.update({ where: { key }, data: { value: normalized } });
  } else {
    await prisma.appSetting.create({ data: { key, value: normalized } });
  }
}

export async function getCliSettingsHealth(): Promise<CliSettingsHealth> {
  const [claudeManual, codexManual] = await Promise.all([
    getManualPath("claude"),
    getManualPath("codex"),
  ]);
  return {
    claude: detectCli("claude", claudeManual),
    codex: detectCli("codex", codexManual),
  };
}

export async function getClaudeCliPath(): Promise<string | null> {
  return (await getCliSettingsHealth()).claude.path;
}

export async function getCodexCliPath(): Promise<string | null> {
  return (await getCliSettingsHealth()).codex.path;
}

function validateExecutablePath(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  if (!statSync(path).isFile()) throw new Error(`${label} must be a file: ${path}`);
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const split = (v: string) => {
    const [main, pre] = v.split("-", 2);
    const segs = (main ?? "").split(".").map((s) => parseInt(s, 10));
    return { segs, pre: pre ?? null };
  };
  const A = split(a);
  const B = split(b);
  const len = Math.max(A.segs.length, B.segs.length);
  for (let i = 0; i < len; i++) {
    const ai = A.segs[i] ?? 0;
    const bi = B.segs[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) continue;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  if (A.pre && B.pre) {
    if (A.pre < B.pre) return -1;
    if (A.pre > B.pre) return 1;
  }
  return 0;
}

export function probeCodexVersion(codexPath: string): string | null {
  try {
    const out = execFileSync(codexPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      windowsHide: true,
    });
    const m = String(out).match(/\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/);
    return m && m[1] ? m[1] : null;
  } catch {
    return null;
  }
}

function resolveManualCliInput(kind: CliKind, input: string): string {
  const expanded = expandHome(input);
  if (isBareCommand(expanded)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(expanded)) {
      throw new Error(`${kind}Path command must be a simple executable name or a full path: ${input}`);
    }
    const found = findExecutableByName(expanded);
    if (!found) {
      throw new Error(`${kind}Path command not found: ${input}`);
    }
    return found;
  }

  const normalized = isAbsolute(expanded) ? expanded : resolve(expanded);
  validateExecutablePath(normalized, `${kind}Path`);
  return normalized;
}

function detectCli(kind: CliKind, manualPath: string | null): CliHealth {
  const platformKey = currentPlatformKey();
  const auth =
    kind === "codex"
      ? {
          authPath: join(homedir(), ".codex", "auth.json"),
          authPresent: existsSync(join(homedir(), ".codex", "auth.json")),
        }
      : {};

  const decorateCodex = (h: CliHealth): CliHealth => {
    if (kind !== "codex" || !h.found || !h.path) return h;
    const version = probeCodexVersion(h.path);
    if (!version) return { ...h, minSupportedVersion: MIN_CODEX_VERSION };
    return {
      ...h,
      version,
      versionTooOld: compareSemver(version, MIN_CODEX_VERSION) < 0,
      minSupportedVersion: MIN_CODEX_VERSION,
    };
  };

  if (manualPath) {
    if (existsSync(manualPath) && statSync(manualPath).isFile()) {
      const resolved = resolveCliExecutable(kind, manualPath) ?? manualPath;
      return decorateCodex({ platformKey, found: true, path: resolved, source: resolved === manualPath ? "manual" : "vendor", manualPath, ...auth });
    }
    return { platformKey, found: false, path: null, source: "missing", manualPath, error: `manual path not found: ${manualPath}`, ...auth };
  }

  const envPath = kind === "codex" ? process.env.CODEX_PATH : process.env.CLAUDE_PATH;
  if (envPath && existsSync(envPath) && statSync(envPath).isFile()) {
    const resolved = resolveCliExecutable(kind, envPath) ?? envPath;
    return decorateCodex({ platformKey, found: true, path: resolved, source: resolved === envPath ? "env" : "vendor", manualPath, ...auth });
  }

  const fromPath = findOnPath(kind);
  if (fromPath) {
    const resolved = resolveCliExecutable(kind, fromPath) ?? fromPath;
    return decorateCodex({ platformKey, found: true, path: resolved, source: resolved === fromPath ? "path" : "vendor", manualPath, ...auth });
  }

  const common = findCommonLocation(kind);
  if (common) {
    const resolved = resolveCliExecutable(kind, common) ?? common;
    return decorateCodex({ platformKey, found: true, path: resolved, source: resolved === common ? "common-location" : "vendor", manualPath, ...auth });
  }

  return { platformKey, found: false, path: null, source: "missing", manualPath, ...auth };
}

function findOnPath(kind: CliKind): string | null {
  try {
    const cmd = process.platform === "win32" ? `where.exe ${kind}` : `command -v ${kind}`;
    const env = { ...process.env, PATH: mergedCliSearchPath() };
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, env });
    return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l)) ?? null;
  } catch {
    return null;
  }
}

function findExecutableByName(name: string): string | null {
  const names = candidateNames(name);
  if (process.platform === "win32") {
    for (const candidate of names) {
      try {
        const out = execFileSync("where.exe", [candidate], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
          env: { ...process.env, PATH: mergedCliSearchPath() },
        });
        const found = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l));
        if (found) return found;
      } catch {
        // fall through to common locations
      }
    }
  } else {
    for (const root of cliSearchRoots()) {
      for (const candidate of names) {
        const direct = join(root, candidate);
        if (existsSync(direct) && statSync(direct).isFile()) return direct;
      }
    }
  }

  for (const root of commonCliRoots()) {
    for (const candidate of names) {
      const direct = join(root, candidate);
      if (existsSync(direct) && statSync(direct).isFile()) return direct;
    }
  }
  if (process.platform !== "win32") {
    for (const root of nestedNodeCliRoots()) {
      for (const candidate of names) {
        const found = findFileUnder(root, candidate);
        if (found) return found;
      }
    }
  }
  return null;
}

function findCommonLocation(kind: CliKind): string | null {
  const names = candidateNames(kind);
  const roots = commonCliRoots();

  for (const root of roots) {
    for (const name of names) {
      const direct = join(root, name);
      if (existsSync(direct) && statSync(direct).isFile()) return direct;
    }
  }
  if (process.platform !== "win32") {
    for (const root of nestedNodeCliRoots()) {
      for (const name of names) {
        const found = findFileUnder(root, name);
        if (found) return found;
      }
    }
  }
  return null;
}

function candidateNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const lower = name.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) return [name];
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

function commonCliRoots(): string[] {
  const home = homedir();
  const roots =
    process.platform === "win32"
      ? [
          process.env.APPDATA ? join(process.env.APPDATA, "npm") : null,
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : null,
          process.env.ProgramFiles ?? null,
          process.env["ProgramFiles(x86)"] ?? null,
        ]
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/opt/local/bin",
          "/Applications/Claude.app/Contents/Resources/app/bin",
          "/Applications/Codex.app/Contents/MacOS",
          join(home, ".local", "bin"),
          join(home, ".npm-global", "bin"),
          join(home, ".npm-packages", "bin"),
          join(home, ".yarn", "bin"),
          join(home, ".bun", "bin"),
          join(home, ".volta", "bin"),
          join(home, ".asdf", "shims"),
          join(home, ".local", "share", "mise", "shims"),
          join(home, ".fnm", "current", "bin"),
        ];
  return roots.filter((p): p is string => Boolean(p));
}

function nestedNodeCliRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".nvm", "versions", "node"),
    join(home, ".fnm", "node-versions"),
    join(home, ".asdf", "installs", "nodejs"),
    join(home, "Library", "pnpm"),
  ].filter((p) => existsSync(p));
}

function cliSearchRoots(): string[] {
  const roots = [
    ...(process.env.PATH ?? "").split(delimiter),
    ...commonCliRoots(),
  ].filter(Boolean);
  return [...new Set(roots)];
}

function mergedCliSearchPath(): string {
  return cliSearchRoots().join(delimiter);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function isBareCommand(value: string): boolean {
  return !value.includes("/") && !value.includes("\\") && !isAbsolute(value);
}

function platformCodexPackageName(): string | null {
  const p = process.platform, a = process.arch;
  if (p === "win32" && a === "x64") return "codex-win32-x64";
  if (p === "win32" && a === "arm64") return "codex-win32-arm64";
  if (p === "darwin" && a === "x64") return "codex-darwin-x64";
  if (p === "darwin" && a === "arm64") return "codex-darwin-arm64";
  if (p === "linux" && a === "x64") return "codex-linux-x64";
  if (p === "linux" && a === "arm64") return "codex-linux-arm64";
  return null;
}

function resolveCliExecutable(kind: CliKind, candidate: string): string | null {
  return kind === "codex" ? resolveCodexExecutable(candidate) : resolveClaudeExecutable(candidate);
}

export function resolveClaudeExecutable(candidate: string): string | null {
  const exeFileName = process.platform === "win32" ? "claude.exe" : "claude";
  if (candidate.toLowerCase().endsWith(exeFileName) && existsSync(candidate)) return candidate;

  let dir = dirname(candidate);
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const roots = [
      join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin"),
      join(dir, "node_modules", "@anthropic-ai", "claude-code", "vendor"),
      join(dir, "node_modules", "@anthropic-ai", "claude-code"),
    ];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      const found = findFileUnder(root, exeFileName);
      if (found) return found;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findFileUnder(root: string, fileName: string): string | null {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > 5) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return full;
      if (e.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

export function resolveCodexExecutable(candidate: string): string | null {
  const exeFileName = process.platform === "win32" ? "codex.exe" : "codex";
  if (candidate.toLowerCase().endsWith(exeFileName) && existsSync(candidate)) return candidate;

  const platformPkg = platformCodexPackageName();
  if (!platformPkg) return null;
  let dir = dirname(candidate);
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const roots = [
      join(dir, "node_modules", "@openai", platformPkg, "vendor"),
      join(dir, "node_modules", "@openai", "codex", "node_modules", "@openai", platformPkg, "vendor"),
    ];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      const found = findFileUnder(root, exeFileName);
      if (found) return found;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
