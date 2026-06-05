// W16 Slice 3.1: NormalizedTool abstraction.
//
// Per the question answered in Slice 3 kickoff, NormalizedTool only feeds
// OpenAIAgentRuntime — Claude side keeps using the CLI's native tools so we
// don't break hooks / settingSources / CLAUDE.md injection. This file is the
// stable contract; per-tool implementations live in sibling files.
//
// Two notes on shape:
//   • `parameters` is a Zod object schema, not a plain object — gives runtime
//     validation + automatic OpenAI strict-mode JSON-schema derivation.
//   • `execute` returns string-or-object. The OpenAI adapter JSON-stringifies
//     when non-string so the SDK passes a clean tool_result content payload.

import { z } from "zod";

export interface NormalizedTool<
  Schema extends z.ZodObject = z.ZodObject,
> {
  /** Canonical tool name. Matches Claude SDK's built-in tool names where
   *  possible (Read / Edit / Write / Bash / Grep / Glob) so prompts that
   *  reference them by name work across runtimes. */
  name: string;
  /** One-paragraph human description shown to the model. */
  description: string;
  /** Zod object schema; OpenAI SDK's `tool()` requires an object shape. */
  parameters: Schema;
  /** Tool body. Throw to signal error; OpenAI adapter catches and converts. */
  execute: (args: z.infer<Schema>) => Promise<string | Record<string, unknown>>;
}

/** Helper alias so callers can write `NormalizedTool[]` without spelling the
 *  generic — runtime types are validated by zod before execute is invoked. */
export type AnyNormalizedTool = NormalizedTool<z.ZodObject>;
