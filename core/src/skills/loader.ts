// Skill loader: discover SKILL.md files from 4 source dirs, parse the YAML
// frontmatter + body, and merge by name with source-priority dedup.
//
// Sources, highest priority first:
//   1. project        → <workspace>/.claude/skills/          (per-agent codexWorkspace)
//   2. ensemble       → <DATA_DIR>/skills/                   (app-managed)
//   3. claude-user    → ~/.claude/skills/                    (Claude Code compat)
//   4. codex-user     → ~/.codex/skills/                     (Codex CLI compat)
//
// SKILL.md format (Anthropic-compatible — Claude Code & Codex use the same):
//   ---
//   name: short-slug
//   description: When to use this skill (used by auto-activation matching).
//   tools: [Read, Grep, Glob]     # optional advisory tool list
//   model: claude-opus-4-7        # optional preferred model (not enforced v2)
//   ---
//   <markdown body>
//
// Directory layout: a skill can be either a single file or a directory:
//   ~/.claude/skills/code-reviewer/SKILL.md      ← canonical (allows companion files)
//   ~/.claude/skills/code-reviewer.md            ← flat (also accepted)
//
// Bundled with a 30s cache; explicit `reload()` invalidates.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, extname, delimiter, resolve } from "node:path";
import { DATA_DIR } from "../paths.js";

export type SkillSource = "project" | "ensemble" | "claude-user" | "codex-user" | "system";

export interface SkillEntry {
  /** Skill identifier from frontmatter. Slug-style; case-sensitive. */
  name: string;
  /** When-to-use sentence; consumed by auto-activation. */
  description: string;
  /** Advisory tool allow-list. Claude/OpenAI runtimes can honor as soft
   *  guidance; Codex runtime ignores (it has no per-call tool gate). */
  tools?: string[];
  /** Preferred model from frontmatter. v2 NOT enforced — informational only. */
  model?: string;
  /** Markdown body of the skill, sans frontmatter. */
  body: string;
  /** Which source dir this came from (for UI badges + writability gating). */
  source: SkillSource;
  /** Absolute path to the SKILL.md file (or flat .md). */
  path: string;
}

// System skills are built-in fallbacks only. User/project skills must be able
// to override them by name so local behavior and precise memory stay in control.
const SOURCE_PRIORITY: SkillSource[] = ["project", "ensemble", "claude-user", "codex-user", "system"];

interface SkillRootOverrides {
  ensemble?: string;
  claudeUser?: string;
  codexUser?: string;
  systemDirs?: string[];
  disableProject?: boolean;
}

let rootOverrides: SkillRootOverrides | null = null;

function ensembleSkillsDir(): string {
  return join(DATA_DIR, "skills");
}
function claudeUserSkillsDir(): string {
  return join(homedir(), ".claude", "skills");
}
function codexUserSkillsDir(): string {
  return join(homedir(), ".codex", "skills");
}
function projectSkillsDir(workspace: string): string | null {
  if (rootOverrides?.disableProject) return null;
  return join(workspace, ".claude", "skills");
}

function splitEnvPathList(value: string | undefined): string[] {
  return (value ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
}

function uniqueExistingDirs(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const full = resolve(p);
    if (seen.has(full) || !existsSync(full)) continue;
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(full);
    out.push(full);
  }
  return out;
}

function runtimeSystemSkillsDirs(): string[] {
  const runtimeRoot = join(DATA_DIR, "codex-runtime");
  if (!existsSync(runtimeRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(runtimeRoot).sort();
  } catch {
    return [];
  }
  return entries.map((name) => join(runtimeRoot, name, "skills", ".system"));
}

function systemSkillsDirs(): string[] {
  if (rootOverrides?.systemDirs) return uniqueExistingDirs(rootOverrides.systemDirs);
  return uniqueExistingDirs([
    ...splitEnvPathList(process.env.ENSEMBLE_SYSTEM_SKILLS_DIR),
    ...splitEnvPathList(process.env.CODEX_SYSTEM_SKILLS_DIR),
    ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, "skills", ".system")] : []),
    join(homedir(), ".codex", "skills", ".system"),
    join(homedir(), ".claude", "skills", ".system"),
    ...runtimeSystemSkillsDirs(),
  ]);
}

/** Walk a single skills root dir and return SKILL.md (or flat *.md) paths. */
function discoverInDir(root: string): string[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const skillMd = join(full, "SKILL.md");
      if (existsSync(skillMd)) out.push(skillMd);
    } else if (st.isFile() && extname(name).toLowerCase() === ".md") {
      // flat-style skill: <root>/<slug>.md  (Anthropic also supports this)
      out.push(full);
    }
  }
  return out;
}

/** Parse the YAML frontmatter block (between leading `---` lines). Naive
 *  parser: handles `key: value`, `key: [a, b, c]`, `key: "quoted value"`. We
 *  do NOT pull a full YAML lib — the SKILL.md frontmatter convention is
 *  flat by design and a full parser is overkill. */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  // Accept both \n and \r\n line endings (Windows authoring).
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { meta: {}, body: normalized };
  const [, header, body] = match;
  const meta: Record<string, unknown> = {};
  for (const line of (header ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }
  }
  return { meta, body: (body ?? "").trim() };
}

function loadOneSkill(path: string, source: SkillSource): SkillEntry | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  // Derive name: frontmatter > parent dir name (for SKILL.md inside dir) > basename
  let name = typeof meta.name === "string" ? (meta.name as string).trim() : "";
  if (!name) {
    const parent = basename(path) === "SKILL.md" ? basename(join(path, "..")) : basename(path, ".md");
    name = parent;
  }
  if (!name) return null;
  const description = typeof meta.description === "string" ? (meta.description as string).trim() : "";
  if (!description) {
    // Skip skills with no description — auto-activation has nothing to match.
    console.warn(`[skills] skipped ${path}: missing "description" in frontmatter`);
    return null;
  }
  const tools = Array.isArray(meta.tools)
    ? (meta.tools as unknown[]).filter((x) => typeof x === "string").map((x) => x as string)
    : undefined;
  const model = typeof meta.model === "string" ? (meta.model as string) : undefined;
  return {
    name,
    description,
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(model ? { model } : {}),
    body,
    source,
    path,
  };
}

interface CacheState {
  loadedAt: number;
  workspaceCacheKey: string;
  byName: Map<string, SkillEntry>;
}

let cache: CacheState | null = null;
const CACHE_TTL_MS = 30_000;

function cacheKeyFor(workspaces: string[] = []): string {
  const systemKey = systemSkillsDirs().slice().sort().join("|");
  return `${workspaces.slice().sort().join("|")}::system=${systemKey}`;
}

/** Merge skills from all four source dirs, dedup by name with priority. The
 *  optional `workspaces` set lets project-source contribute the .claude/skills
 *  dirs from any codex-workspace-using agent — but for v2 we keep things simple
 *  and ONLY include the project sources passed in. SessionManager calls this
 *  with the active agent's workspace (if any) per-turn. */
function buildRegistry(workspaces: string[] = []): Map<string, SkillEntry> {
  // Collect candidates grouped by source.
  const projectPaths = rootOverrides?.disableProject
    ? []
    : workspaces.flatMap((w) => {
        const dir = projectSkillsDir(w);
        return dir ? discoverInDir(dir) : [];
      });
  const grouped: Array<{ source: SkillSource; paths: string[] }> = [
    { source: "project", paths: projectPaths },
    { source: "ensemble", paths: discoverInDir(rootOverrides?.ensemble ?? ensembleSkillsDir()) },
    { source: "claude-user", paths: discoverInDir(rootOverrides?.claudeUser ?? claudeUserSkillsDir()) },
    { source: "codex-user", paths: discoverInDir(rootOverrides?.codexUser ?? codexUserSkillsDir()) },
    { source: "system", paths: systemSkillsDirs().flatMap((dir) => discoverInDir(dir)) },
  ];
  const byName = new Map<string, SkillEntry>();
  // Walk in priority order; first writer wins.
  for (const src of SOURCE_PRIORITY) {
    const bucket = grouped.find((g) => g.source === src);
    if (!bucket) continue;
    for (const p of bucket.paths) {
      const entry = loadOneSkill(p, src);
      if (!entry) continue;
      if (byName.has(entry.name)) {
        // Lower-priority duplicate — skip but log so user knows
        const existing = byName.get(entry.name)!;
        if (existing.source !== "system" || entry.source !== "system") {
          console.warn(
            `[skills] duplicate name "${entry.name}": keeping ${existing.source} (${existing.path}), shadowed ${entry.source} (${entry.path})`,
          );
        }
        continue;
      }
      byName.set(entry.name, entry);
    }
  }
  return byName;
}

export function loadSkills(workspaces: string[] = []): SkillEntry[] {
  const key = cacheKeyFor(workspaces);
  const now = Date.now();
  if (cache && cache.workspaceCacheKey === key && now - cache.loadedAt < CACHE_TTL_MS) {
    return Array.from(cache.byName.values());
  }
  const byName = buildRegistry(workspaces);
  cache = { loadedAt: now, workspaceCacheKey: key, byName };
  return Array.from(byName.values());
}

export function findSkill(name: string, workspaces: string[] = []): SkillEntry | undefined {
  loadSkills(workspaces);
  return cache?.byName.get(name);
}

export function reloadSkills(): void {
  cache = null;
}

/** Test-only seam: swap out the registry directly (used by activate tests).
 *  Uses cacheKey="" so the default `loadSkills()` (no workspace arg) hits cache. */
export function __setSkillsForTest(entries: SkillEntry[]): void {
  const byName = new Map<string, SkillEntry>();
  for (const e of entries) byName.set(e.name, e);
  cache = { loadedAt: Date.now(), workspaceCacheKey: cacheKeyFor(), byName };
}

export function __setSkillRootOverridesForTest(overrides: SkillRootOverrides | null): void {
  rootOverrides = overrides;
  reloadSkills();
}
