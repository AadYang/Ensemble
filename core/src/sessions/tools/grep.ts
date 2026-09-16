// Slice 3.3: Grep tool. Prefer ripgrep on PATH; fall back to pure Node when
// rg isn't installed (per user decision in Slice 3 kickoff). Output mirrors
// Claude SDK's Grep modes: content / files_with_matches / count.
//
// Phase 4: a result that does not fit the turn's tool-result budget is stored
// WHOLE as a `tool-output` artifact before the model sees any of it (see
// tool-output.ts). The bytes are collected by streaming, never through
// execFile's `maxBuffer`, because that cap turned a big search into `ENOBUFS` —
// a raw Node error that discarded the matches already found.

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { NormalizedTool } from "./types.js";
import { finalizeLineSearch, lineList, openToolOutputSpool } from "./tool-output.js";

const GREP_SCHEMA = z.object({
  pattern: z.string().min(1).describe("Regex pattern to search for."),
  path: z.string().optional().describe("File or directory to search (defaults to the agent's project root)."),
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

/** Feed decoded text in, get complete lines out — CRLF normalized to LF and
 *  empty lines dropped, which is exactly what `split(/\r?\n/).filter(Boolean)`
 *  produced for the same stream. The carry is what makes it streaming: a line
 *  split across two chunks is held until its other half arrives, instead of
 *  becoming two matches. */
export function makeLineSink(onLine: (line: string) => void): {
  push: (text: string) => void;
  flush: () => void;
} {
  let carry = "";
  const emit = (raw: string): void => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length > 0) onLine(line);
  };
  return {
    push(text: string): void {
      carry += text;
      let nl = carry.indexOf("\n");
      while (nl >= 0) {
        emit(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
        nl = carry.indexOf("\n");
      }
    },
    flush(): void {
      if (carry.length > 0) emit(carry);
      carry = "";
    },
  };
}

/** Run ripgrep and STREAM its stdout into complete lines.
 *
 *  `execFile(..., { maxBuffer })` was the bug this replaces: past the cap, Node
 *  rejects the call with `ENOBUFS` and disposes of everything already read, so a
 *  large search reached the agent as a Node internal instead of as matches.
 *  Streaming has no such cliff.
 *
 *  Nothing accumulates here either: each complete line is handed to `onLine`
 *  (which writes it into a bounded spool) and then dropped. Decoding per chunk
 *  is safe because the decoder carries a partial character across the boundary —
 *  without that, a multi-byte character split by the pipe would become U+FFFD in
 *  the artifact, whose sha256 is a claim about the bytes actually produced. */
function streamRipgrep(rgArgs: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(RG_PATH!, rgArgs, { windowsHide: true });
    const decoder = new StringDecoder("utf8");
    const lines = makeLineSink(onLine);
    let stderr = "";
    child.stdout.on("data", (buf: Buffer) => lines.push(decoder.write(buf)));
    // Enough stderr to explain a failure, bounded so a flood of it cannot take
    // the memory the stdout stream is meant to have.
    child.stderr.on("data", (buf: Buffer) => {
      if (stderr.length < 2_000) stderr += buf.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      // rg exit code 1 = no matches, an empty result rather than an error.
      if (code === 0 || code === 1) {
        lines.push(decoder.end());
        lines.flush();
        resolve();
        return;
      }
      reject(new Error(`ripgrep exited with code ${code}: ${stderr.trim() || "(no stderr output)"}`));
    });
  });
}

async function runRipgrep(
  args: z.infer<typeof GREP_SCHEMA>,
  root: string,
  onLine: (line: string) => void,
): Promise<void> {
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
  // The search root comes from the agent's project root: rg resolves a bare
  // "." against ITS OWN cwd, which is the sidecar's, not the agent's.
  rgArgs.push(args.path ? resolve(root, args.path) : root);
  // Complete, one match per line, streamed. head_limit is deliberately NOT
  // applied here: both backends go through the same finalizer, so they honour it
  // identically and the same result shape reports what was left out.
  await streamRipgrep(rgArgs, onLine);
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

async function runNodeFallback(
  args: z.infer<typeof GREP_SCHEMA>,
  projectRoot: string,
  onLine: (line: string) => void,
): Promise<void> {
  const root = args.path ? resolve(projectRoot, args.path) : projectRoot;
  const stats = await stat(root).catch(() => null);
  if (!stats) throw new Error(`path does not exist: ${root}`);
  const flags = args["-i"] ? "i" : "";
  const re = new RegExp(args.pattern, flags);
  const globRe = args.glob ? globToRegex(args.glob) : undefined;
  const files = stats.isDirectory() ? walk(root, globRe) : (async function* () { yield root; })();

  // Each line is emitted the moment it is known and then dropped, in the order
  // the old arrays preserved (file by file, line by line within a file): a
  // result that does not fit must not first be built in memory to be measured.
  for await (const f of files) {
    const text = await readFile(f, "utf8").catch(() => null);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    let count = 0;
    lines.forEach((line, i) => {
      if (re.test(line)) {
        count++;
        if (args.output_mode === "content") onLine(args["-n"] ? `${f}:${i + 1}:${line}` : `${f}:${line}`);
      }
    });
    if (count > 0) {
      if (args.output_mode === "count") onLine(`${f}:${count}`);
      else if (args.output_mode !== "content") onLine(f);
    }
  }
}

export const grepTool: NormalizedTool<typeof GREP_SCHEMA> = {
  name: "Grep",
  description:
    "Search for a regex pattern across files. Prefers ripgrep on PATH; falls back to a slower " +
    "pure-Node implementation when rg is absent. Output modes: files_with_matches (default), " +
    "content (line-level), count (per-file totals). A result too large to hand over whole is " +
    "stored as an artifact and returned as a preview plus its id/sha256/byte size.",
  parameters: GREP_SCHEMA,
  async execute(args, ctx) {
    // The matches go into a bounded spool as they are found, so the memory this
    // holds is the turn's result budget and not the size of the search result —
    // the case that used to be an `ENOBUFS` and then a whole result in memory.
    const spool = openToolOutputSpool(ctx, "grep");
    try {
      let matched = 0;
      const push = lineList(spool);
      // `matched` is counted HERE rather than by splitting the finished body: a
      // body that spilled is not a string and never will be.
      const onLine = (line: string): void => {
        matched++;
        push(line);
      };
      if (RG_PATH) await runRipgrep(args, ctx.projectRoot, onLine);
      else await runNodeFallback(args, ctx.projectRoot, onLine);
      return finalizeLineSearch({
        ctx,
        tool: "Grep",
        source: spool,
        matched,
        headLimit: args.head_limit ?? null,
        narrowing:
          'narrow the search: tighten the pattern, add glob= (e.g. "*.ts"), search a subdirectory with path=, ' +
          'or use output_mode="files_with_matches" for paths instead of every matching line',
      });
    } finally {
      // Also when the search threw: the spill file is cleaned up on every path.
      spool.dispose();
    }
  },
};
