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
import type { ArtifactBodySource, ArtifactHandle } from "../../artifacts.js";

/** What a tool gets back for output it could not hand over whole. Deliberately
 *  the shape `createArtifact` + `renderArtifactResult` already produce: the
 *  artifact is the durable copy, `text` is the only thing that reaches the
 *  model, and `inlined` says whether `text` IS the whole body or a preview of
 *  it (a preview that claims to be the whole is the failure this prevents). */
export interface ToolOutputPresentation {
  text: string;
  handle: ArtifactHandle;
  inlined: boolean;
  /** Why this was inlined or previewed, in the terms of the run plan. */
  reason: string;
}

/** How a tool hands back a result that does not fit the turn's tool-result
 *  budget.
 *
 *  A tool knows the bytes it produced; it knows nothing about which agent / run
 *  / turn it ran for, which window the result has to fit, or how to write
 *  durable storage. All three belong to the caller that is about to turn this
 *  result into model input, so they arrive as ONE capability — the same shape
 *  as peer_send / Task, where capability == "the session handed us a closure".
 *  A tool handed no sink cannot preserve an over-budget result, and refuses
 *  structurally (RESULT_TOO_LARGE) rather than clipping. */
export interface ToolOutputSink {
  /** The turn's tool-result budget in BYTES, from the run plan the turn is
   *  actually running (`previewBytesFor(decideArtifactInline(...))`), so this is
   *  the same number the rest of the turn measures against. `null` = the route
   *  established no window; nothing is dropped on a guess, and the artifact is
   *  still written so "no budget" never means "no durable copy". */
  budgetBytes: number | null;
  /** Store the COMPLETE result as a tool-output artifact and return what the
   *  model should see for it. MUST store before it shows: a preview that exists
   *  without the artifact behind it is the silent truncation this contract
   *  exists to prevent. Agent / run / turn correlation is the caller's existing
   *  createArtifact association — not a second mechanism.
   *
   *  The bytes arrive as a SOURCE, not a string: the result may be far larger
   *  than memory, and the sink is the thing that knows how to commit it in
   *  chunks. It must consume the source synchronously — the tool disposes the
   *  spool as soon as this returns. */
  present: (args: { source: ArtifactBodySource; headerLines?: string[] }) => ToolOutputPresentation;
}

/** What every tool needs to know about the turn it is running in.
 *
 *  Exactly one field is required, and it is not optional: a tool that does not
 *  know where the project is either refuses a relative path or falls back to
 *  the process's own working directory, and the second one silently edits the
 *  wrong tree. */
export interface ToolContext {
  /** `runPlan.execution.projectRoot.value` — the same directory the runtime
   *  spawned in and `/status` reports. */
  projectRoot: string;
  /** Absent when nothing behind the tool can store an over-budget result (a
   *  caller with no session, e.g. a direct unit test or a bare runtime). */
  toolOutput?: ToolOutputSink;
}

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
  /** A string is returned verbatim; any other object is JSON-serialized. The
   *  union is `object`, not `Record<string, unknown>`, so a result declared as a
   *  named interface (the structured skill read result, with its `code` /
   *  `available` fields) can be returned as itself instead of being flattened
   *  into an index-signature shape at every boundary. */
  execute: (args: z.infer<Schema>, ctx: ToolContext) => Promise<string | object>;
}

/** Helper alias so callers can write `NormalizedTool[]` without spelling the
 *  generic — runtime types are validated by zod before execute is invoked. */
export type AnyNormalizedTool = NormalizedTool<z.ZodObject>;
