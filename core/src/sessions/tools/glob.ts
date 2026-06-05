// Slice 3.3: Glob tool. Pure Node implementation — file count expected is
// small enough that bringing in fast-glob's worker-thread machinery isn't
// worth the SEA bundling complexity.
//
// Supports `*`, `**`, `?` and a few character classes. Skips node_modules
// and .git by default (same as Claude SDK Glob).

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { NormalizedTool } from "./types.js";

const GLOB_SCHEMA = z.object({
  pattern: z.string().min(1).describe("Glob pattern (e.g. 'src/**/*.ts')."),
  path: z.string().optional().describe("Root directory; defaults to cwd."),
});

function globToRegex(g: string): RegExp {
  // Same converter shape as grep.ts; kept local to avoid cross-file coupling
  // since the glob tool may grow path-specific behavior the grep filter doesn't need.
  let re = "";
  let i = 0;
  while (i < g.length) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (g[i] === "/" || g[i] === "\\") i++;
      } else {
        re += "[^/\\\\]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/\\\\]";
      i++;
    } else if ("/\\.+^${}()|[]".includes(c)) {
      if (c === "/" || c === "\\") re += "[/\\\\]";
      else re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

export const globTool: NormalizedTool<typeof GLOB_SCHEMA> = {
  name: "Glob",
  description:
    "Find files matching a glob pattern. Returns absolute paths, sorted. Skips node_modules / .git. " +
    "Supports *, **, ? wildcards.",
  parameters: GLOB_SCHEMA,
  async execute({ pattern, path }) {
    const root = resolve(path ?? ".");
    const re = globToRegex(pattern);
    const results: string[] = [];
    for await (const f of walk(root)) {
      // Compare both against the absolute path and against the path relative
      // to the root, since users often write patterns relative to the root.
      const rel = f.slice(root.length + 1);
      if (re.test(rel) || re.test(f)) results.push(f);
    }
    results.sort();
    return results.join("\n");
  },
};
