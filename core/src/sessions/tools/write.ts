// Slice 3.2: Write tool. Overwrites the file at `file_path` with `content`.
// Creates parent directories as needed. Mirrors Claude SDK's Write.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { NormalizedTool } from "./types.js";
import { resolveSafe } from "./pathSafety.js";

const WRITE_SCHEMA = z.object({
  file_path: z.string().describe("Absolute path to the file to write (overwrite if exists)."),
  content: z.string().describe("Full file contents to write."),
});

export const writeTool: NormalizedTool<typeof WRITE_SCHEMA> = {
  name: "Write",
  description:
    "Write (overwrite) the file at `file_path` with `content`. Creates parent directories as needed.",
  parameters: WRITE_SCHEMA,
  async execute({ file_path, content }) {
    const abs = resolveSafe(file_path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return `Wrote ${content.length} bytes to ${abs}`;
  },
};
