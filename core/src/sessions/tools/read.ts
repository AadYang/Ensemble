// Slice 3.2: Read tool. Mirror of Claude SDK's Read.
// Reads up to `limit` lines starting at `offset` (1-indexed). Returns text
// with cat -n style line-number prefixes so the model can reference exact
// lines back to the user.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { NormalizedTool } from "./types.js";
import { resolveSafe } from "./pathSafety.js";

const READ_SCHEMA = z.object({
  file_path: z.string().describe("Absolute path to the file to read."),
  offset: z.number().int().min(1).optional().describe("1-indexed start line (default 1)."),
  limit: z.number().int().min(1).max(2000).optional().describe("Max number of lines to read (default 2000)."),
});

const DEFAULT_LIMIT = 2000;

export const readTool: NormalizedTool<typeof READ_SCHEMA> = {
  name: "Read",
  description:
    "Read the contents of a file from disk. Returns text with line-number prefixes (cat -n style). " +
    "Use `offset` (1-indexed) and `limit` for partial reads of large files.",
  parameters: READ_SCHEMA,
  async execute({ file_path, offset = 1, limit = DEFAULT_LIMIT }) {
    const abs = resolveSafe(file_path);
    const raw = await readFile(abs, "utf8");
    const allLines = raw.split(/\r?\n/);
    const start = offset - 1; // convert to 0-indexed
    const slice = allLines.slice(start, start + limit);
    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(6, " ")}\t${line}`)
      .join("\n");
    return numbered;
  },
};
