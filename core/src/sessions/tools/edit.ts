// Slice 3.2: Edit tool. Single-occurrence string replacement (use replace_all
// for all occurrences). Errors if old_string is not found or if it occurs
// multiple times without replace_all. Mirrors Claude SDK's Edit.

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { NormalizedTool } from "./types.js";
import { resolveSafe } from "./pathSafety.js";

const EDIT_SCHEMA = z.object({
  file_path: z.string().describe("Absolute path to the file to modify."),
  old_string: z.string().describe("Text to replace. Must match exactly."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z
    .boolean()
    .optional()
    .describe("If true, replace every occurrence; otherwise require exactly one match."),
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const editTool: NormalizedTool<typeof EDIT_SCHEMA> = {
  name: "Edit",
  description:
    "Perform an in-place text replacement. By default `old_string` must match exactly once; set " +
    "`replace_all: true` to replace every occurrence. The file must exist (use Write to create).",
  parameters: EDIT_SCHEMA,
  async execute({ file_path, old_string, new_string, replace_all = false }) {
    const abs = resolveSafe(file_path);
    const original = await readFile(abs, "utf8");
    if (!original.includes(old_string)) {
      throw new Error(`old_string not found in ${abs}`);
    }
    let updated: string;
    if (replace_all) {
      updated = original.split(old_string).join(new_string);
    } else {
      const first = original.indexOf(old_string);
      const next = original.indexOf(old_string, first + old_string.length);
      if (next !== -1) {
        throw new Error(
          `old_string occurs multiple times in ${abs}. Pass replace_all:true to replace all, or expand the snippet to be unique.`,
        );
      }
      updated = original.replace(old_string, () => new_string);
      // .replace with a function avoids regex semantics for `new_string`.
      // (We re-derived the no-op via escapeRegex elsewhere if needed.)
    }
    await writeFile(abs, updated, "utf8");
    const occurrences = replace_all ? original.split(old_string).length - 1 : 1;
    return `Replaced ${occurrences} occurrence(s) in ${abs}`;
  },
};

// re-export to silence "declared but unused" if escapeRegex moves into a
// future regex-based variant.
export const _internal = { escapeRegex };
