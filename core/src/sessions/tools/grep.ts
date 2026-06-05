// Slice 3.3: Grep tool. Prefer ripgrep on PATH; fall back to pure Node when
// rg isn't installed (per user decision in Slice 3 kickoff). Output mirrors
// Claude SDK's Grep modes: content / files_with_matches / count.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { NormalizedTool } from "./types.js";

const execFileP = promisify(execFile);

const GREP_SCHEMA = z.object({
  pattern: z.string().min(1).describe("Regex pattern to search for."),
  path: z.string().optional().describe("File or directory to search (default cwd)."),
  glob: z.string().optional().describe("Filter files by glob (e.g. '*.ts')."),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe("Output style; default files_with_matches."),
  "-i": z.boolean().optional().describe("Case-insensitive."),
  "-n": z.boolean().optional().describe("Show line numbers (content mode)."),
  head_limit: z.number().int().min(1).optional().describe("Limit lines/files returned."),
});

const RG_PATH: string | null = (() => {
  try {
    const cmd = process.platform === "win32" ? "where.exe rg" : "which rg";
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (first && existsSync(first)) return first;
  } catch {
    // not on PATH
  }
  return null;
})();

async function runRipgrep(args: z.infer<typeof GREP_SCHEMA>): Promise<string> {
  const rgArgs: string[] = [];
  if (args["-i"]) rgArgs.push("-i");
  if (args.output_mode === "files_with_matches" || args.output_mode === undefined) {
    rgArgs.push("-l");
  } else if (args.output_mode === "count") {
    rgArgs.push("-c");
  } else if (args["-n"]) {
    rgArgs.push("-n");
  }
  if (args.glob) rgArgs.push("--glob", args.glob);
  rgArgs.push(args.pattern);
  rgArgs.push(args.path ?? ".");
  try {
    const { stdout } = await execFileP(RG_PATH!, rgArgs, { maxBuffer: 16 * 1024 * 1024 });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    return (args.head_limit ? lines.slice(0, args.head_limit) : lines).join("\n");
  } catch (err) {
    // rg exit code 1 = no matches, treat as empty result rather than error.
    const e = err as { code?: number; stdout?: string };
    if (e && typeof e.code === "number" && e.code === 1) return "";
    throw err;
  }
}

async function* walk(dir: string, glob?: RegExp): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full, glob);
    } else if (e.isFile()) {
      if (!glob || glob.test(e.name)) yield full;
    }
  }
}

function globToRegex(g: string): RegExp {
  // Tiny converter: *.ts → /^[^/]*\.ts$/. Sufficient for the common cases;
  // fancier patterns belong to ripgrep, which is the preferred backend anyway.
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

async function runNodeFallback(args: z.infer<typeof GREP_SCHEMA>): Promise<string> {
  const root = resolve(args.path ?? ".");
  const stats = await stat(root).catch(() => null);
  if (!stats) throw new Error(`path does not exist: ${root}`);
  const flags = args["-i"] ? "i" : "";
  const re = new RegExp(args.pattern, flags);
  const globRe = args.glob ? globToRegex(args.glob) : undefined;
  const files = stats.isDirectory() ? walk(root, globRe) : (async function* () { yield root; })();

  const matchedFiles: string[] = [];
  const counts: Record<string, number> = {};
  const contentLines: string[] = [];

  for await (const f of files) {
    const text = await readFile(f, "utf8").catch(() => null);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    let count = 0;
    lines.forEach((line, i) => {
      if (re.test(line)) {
        count++;
        if (args.output_mode === "content") {
          contentLines.push(args["-n"] ? `${f}:${i + 1}:${line}` : `${f}:${line}`);
        }
      }
    });
    if (count > 0) {
      matchedFiles.push(f);
      counts[f] = count;
    }
  }

  let result: string[];
  if (args.output_mode === "count") result = matchedFiles.map((f) => `${f}:${counts[f]}`);
  else if (args.output_mode === "content") result = contentLines;
  else result = matchedFiles;
  return (args.head_limit ? result.slice(0, args.head_limit) : result).join("\n");
}

export const grepTool: NormalizedTool<typeof GREP_SCHEMA> = {
  name: "Grep",
  description:
    "Search for a regex pattern across files. Prefers ripgrep on PATH; falls back to a slower " +
    "pure-Node implementation when rg is absent. Output modes: files_with_matches (default), " +
    "content (line-level), count (per-file totals).",
  parameters: GREP_SCHEMA,
  async execute(args) {
    return RG_PATH ? runRipgrep(args) : runNodeFallback(args);
  },
};
