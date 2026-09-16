// The tool-result budget: a result that does not fit is stored WHOLE before any
// of it is shown.
//
// Two losses this replaces, both of them invisible to the agent:
//   • `execFile(rg, …, { maxBuffer: 16 MiB })` turned a large search into
//     `ENOBUFS: … maxBuffer length exceeded` — a raw Node error naming an
//     internal buffer size, with the matches ripgrep had already found thrown
//     away. Neither the agent nor a human could act on it.
//   • a large result was otherwise handed over as one string with no ceiling at
//     all, so "the tool result" was whatever the search happened to produce: a
//     million-line Grep is not context, and a result that DID get cut below the
//     session layer left no copy anywhere to read the rest from.
//
// The order is the whole design, and it is the same order artifacts.ts uses for
// peer / subagent results: complete bytes → `tool-output` artifact → what the
// model sees (the whole text when it fits, otherwise a preview plus the
// artifact's id / sha256 / byte size). Nothing is clipped before it is stored.
//
// Phase 4 rework: the bytes arrive through an OutputSpool, so the size decision
// is enforced WHILE they are produced rather than after they have all been
// collected. Every function here takes a spooled source, never a string that
// already exists — a tool handed a `body: string` has, by definition, already
// spent the memory this module is supposed to bound.
//
// The budget itself is NOT invented here. A tool knows the bytes it produced and
// nothing about the route's window, so the number comes from the caller that
// owns the run plan (ToolOutputSink.budgetBytes); this module only applies it,
// plus one last-resort ceiling for the case where no sink was handed over at
// all — there, refusing structurally is the only honest answer, because there is
// nowhere to put the bytes.

import { ARTIFACT_CHUNK_BYTES, sha256OfText, utf8SafeEnd } from "../../artifacts.js";
import type { ArtifactBodySource, ArtifactHandle } from "../../artifacts.js";
import { OutputSpool } from "./spool.js";
import type { ToolContext, ToolOutputPresentation } from "./types.js";

/** The ceiling a tool result may not cross as a raw string when nobody handed
 *  the tool a sink.
 *
 *  Deliberately NOT a claim about any model's window — "does this fit this
 *  route" is the run plan's question, answered once by decideArtifactInline and
 *  delivered as ToolOutputSink.budgetBytes. This is the fallback for the case
 *  where there is no way to store the full bytes: past it, the result is refused
 *  with an actionable narrowing suggestion instead of being clipped or handed
 *  over as-is. */
export const TOOL_OUTPUT_LIMIT_BYTES = 1_048_576;

/** Bytes of a body a `head_limit` prefix is taken from. A prefix past this is a
 *  page, not a prefix, and the result says which one it is. */
const PREFIX_SCAN_BYTES = 262_144;

/** A refusal, not a result: the tool produced more than it can hand over and had
 *  nowhere to store it. Structured (code + the numbers behind it + what to do
 *  about it) so the agent can act without parsing prose, and so nothing about
 *  Node's internals leaks into the conversation. */
export interface ToolResultTooLarge {
  ok: false;
  code: "RESULT_TOO_LARGE";
  tool: string;
  byteSize: number;
  limitBytes: number;
  /** Matches the search produced, when the tool counted them. */
  matched?: number;
  message: string;
  suggestion: string;
}

/** One line-per-match search result (`Grep`, `Glob`) that is not the whole
 *  story: either an explicit `head_limit` took a prefix, or the result did not
 *  fit and its complete bytes live in an artifact.
 *
 *  `truncated` / `endReached` are the vocabulary artifacts.ts already uses for
 *  "is this everything?", so a reader that knows one knows the other. */
export interface LineSearchResult {
  ok: true;
  tool: string;
  /** Matches the search produced, before head_limit. */
  matched: number;
  /** Matches this result is allowed to return: `matched` unless head_limit took
   *  a prefix. When `artifact` is present the model is reading a byte preview of
   *  the stored list, and the rest is one artifact_read away. */
  returned: number;
  head_limit: number | null;
  truncated: boolean;
  endReached: boolean;
  /** Present only when the result did not fit: the durable copy of ALL matches. */
  artifact?: ArtifactHandle;
  /** What the model reads: the matches themselves, or a preview plus the
   *  artifact's handle / sha256 / byte size. */
  result: string;
}

export type ToolOutputOutcome =
  | { kind: "plain"; text: string }
  | { kind: "artifact"; presentation: ToolOutputPresentation }
  | { kind: "too_large"; error: ToolResultTooLarge };

/** The memory a spool for this turn may hold before it spills: the turn's own
 *  tool-result budget, so a result that fits is still kept whole in memory (the
 *  cheap path) and one that does not has already left memory before the size
 *  check happens. Without a sink the last-resort ceiling is the bound. */
export function spoolLimitBytes(ctx: ToolContext): number {
  return ctx.toolOutput?.budgetBytes ?? TOOL_OUTPUT_LIMIT_BYTES;
}

/** A spool bounded by this turn's tool-result budget. Tools write into it as
 *  their output arrives; nothing here knows how large the result will be. */
export function openToolOutputSpool(ctx: ToolContext, label: string): OutputSpool {
  return new OutputSpool({ memoryLimitBytes: spoolLimitBytes(ctx), label });
}

function tooLarge(args: {
  tool: string;
  byteSize: number;
  limitBytes: number;
  narrowing: string;
  matched?: number;
}): ToolResultTooLarge {
  const error: ToolResultTooLarge = {
    ok: false,
    code: "RESULT_TOO_LARGE",
    tool: args.tool,
    byteSize: args.byteSize,
    limitBytes: args.limitBytes,
    message:
      `${args.tool} produced ${args.byteSize} bytes, past the ${args.limitBytes}-byte ceiling for a tool result ` +
      "handed to the model whole, and this call has no session behind it to store the bytes in. The result was " +
      "NOT clipped: nothing was returned rather than a prefix that would read as the whole thing.",
    suggestion: `${args.narrowing}, or pass head_limit to take a bounded prefix`,
  };
  if (args.matched !== undefined) error.matched = args.matched;
  return error;
}

/** The one size decision for a finished tool result.
 *
 *  Three answers, and no fourth: hand the text over whole, store it whole and
 *  hand over a preview, or refuse because there is nowhere to store it.
 *
 *  A source that SPILLED is over budget by construction (the spool's limit IS the
 *  budget), and is treated as over budget even if some caller passes a spool
 *  bounded more tightly than the budget: `text()` cannot answer for a spilled
 *  body, so the honest outcomes are "store it" or "refuse". */
export function finalizeToolOutput(args: {
  ctx: ToolContext;
  tool: string;
  /** The COMPLETE output, spooled as it was produced. */
  source: ArtifactBodySource;
  narrowing: string;
  headerLines?: string[];
  matched?: number;
}): ToolOutputOutcome {
  const byteSize = args.source.byteSize;
  const sink = args.ctx.toolOutput;
  if (sink !== undefined) {
    // With a sink, "does it fit" is the run plan's call. A null budget means no
    // window was established, so the artifact is written past the ceiling
    // rather than the text being dropped on a guess — the same rule the history
    // budget follows for an unknown ceiling.
    const budget = sink.budgetBytes ?? TOOL_OUTPUT_LIMIT_BYTES;
    if (byteSize > budget || args.source.spilled) {
      return {
        kind: "artifact",
        presentation: sink.present({
          source: args.source,
          ...(args.headerLines ? { headerLines: args.headerLines } : {}),
        }),
      };
    }
    return { kind: "plain", text: args.source.text() };
  }
  if (byteSize > TOOL_OUTPUT_LIMIT_BYTES || args.source.spilled) {
    const error = tooLarge({
      tool: args.tool,
      byteSize,
      limitBytes: TOOL_OUTPUT_LIMIT_BYTES,
      narrowing: args.narrowing,
      ...(args.matched !== undefined ? { matched: args.matched } : {}),
    });
    return { kind: "too_large", error };
  }
  return { kind: "plain", text: args.source.text() };
}

/** A source over a string a tool produced whole — Read's page, Write's
 *  confirmation, or a tool whose result was already finalized once.
 *
 *  Such a string is already in memory, so nothing here is bounded by this
 *  wrapper: it exists so the ONE size decision (`finalizeToolOutput`) can be
 *  applied uniformly at the adapter, where the turn's budget is known, without
 *  every caller having to know about spools. Tools that stream use a real
 *  `OutputSpool` and never build the string in the first place. */
export function stringSource(text: string): ArtifactBodySource {
  const buf = Buffer.from(text, "utf8");
  const sliceChunks = (chunkBytes: number = ARTIFACT_CHUNK_BYTES): Buffer[] => {
    const step = Math.max(1, Math.floor(chunkBytes));
    const out: Buffer[] = [];
    for (let at = 0; at < buf.length; at += step) out.push(buf.subarray(at, Math.min(buf.length, at + step)));
    return out;
  };
  return {
    byteSize: buf.length,
    sha256: sha256OfText(text),
    spilled: false,
    text: () => text,
    preview: (maxBytes) => {
      const want = Math.max(1, Math.floor(maxBytes));
      const head = buf.subarray(0, Math.min(buf.length, want + 4));
      return head.subarray(0, utf8SafeEnd(head, 0, want)).toString("utf8");
    },
    chunks: sliceChunks,
    dispose: () => {},
  };
}

/** What a tool returns for a finalized result: the text the model reads (the
 *  result itself, or a preview plus the artifact's handle), or the structured
 *  refusal. One place, so all three tools answer in the same shape. */
export function toolOutputResult(outcome: ToolOutputOutcome): string | ToolResultTooLarge {
  if (outcome.kind === "plain") return outcome.text;
  if (outcome.kind === "artifact") return outcome.presentation.text;
  return outcome.error;
}

/** A writer for a one-match-per-line body: `\n` BETWEEN entries, never after the
 *  last. Byte-identical to the `lines.join("\n")` these tools used to build, so
 *  nothing downstream has to change — and it never holds the array. */
export function lineList(source: OutputSpool): (line: string) => void {
  let first = true;
  return (line: string): void => {
    source.write(first ? line : `\n${line}`);
    first = false;
  };
}

/** The first `n` lines of a spooled body, from one bounded prefix read.
 *
 *  `complete` is false when the prefix ran out before `n` lines — then the text
 *  is the whole prefix and the caller must say so, because a prefix presented as
 *  "the first n matches" when it is fewer is the silent truncation this module
 *  exists to prevent. */
function firstLines(source: ArtifactBodySource, n: number): { text: string; complete: boolean } {
  const prefix = source.preview(PREFIX_SCAN_BYTES);
  const lines = prefix.split("\n");
  // A trailing "\n" makes the split produce a final empty element that is not a
  // match; it is only present when the prefix was not cut mid-line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length >= n) return { text: lines.slice(0, n).join("\n"), complete: true };
  return { text: prefix.replace(/\n$/, ""), complete: false };
}

/** Grep / Glob share this because they share the failure: both produce one match
 *  per line, both take a caller-supplied `head_limit`, and both used to answer
 *  with a bare string that could not say whether it was everything.
 *
 *  Returns a plain string whenever the answer really is the whole match list —
 *  the common case, and the shape every existing caller already expects — and a
 *  structured result the moment anything was left out, so `truncated` /
 *  `endReached` are only ever asserted about a result that needs them. */
export function finalizeLineSearch(args: {
  ctx: ToolContext;
  tool: string;
  /** The COMPLETE output, one match per line, spooled as it was produced. The
   *  count is passed alongside because a spilled body cannot be counted by
   *  splitting a string it never became. */
  source: ArtifactBodySource;
  matched: number;
  headLimit: number | null;
  narrowing: string;
}): string | LineSearchResult | ToolResultTooLarge {
  const matched = args.matched;
  if (matched === 0) return "";

  const limit = args.headLimit;
  // head_limit is the CALLER's own bound, so it is honoured exactly — and it is
  // reported, because a prefix that does not say it is a prefix is the silent
  // truncation this whole module exists to stop.
  const clipped = limit !== null && limit < matched;
  const cut = clipped ? firstLines(args.source, limit) : null;
  const visible = clipped ? (cut!.complete ? limit : cut!.text.split("\n").length) : matched;

  const outcome = finalizeToolOutput({
    ctx: args.ctx,
    tool: args.tool,
    source: args.source,
    narrowing: args.narrowing,
    matched,
    ...(clipped
      ? {
          headerLines: [
            `head_limit=${limit} was requested and ${matched} matches exist; the artifact holds ALL of them, ` +
              "not just the ones shown.",
          ],
        }
      : {}),
  });

  if (outcome.kind === "too_large") return outcome.error;
  if (outcome.kind === "plain") {
    if (!clipped) return outcome.text;
    const shown = cut!.text;
    return {
      ok: true,
      tool: args.tool,
      matched,
      returned: visible,
      head_limit: limit,
      truncated: true,
      // More matches exist and nothing holds them: the honest answer is that
      // this is a prefix, plus how to get the rest.
      endReached: false,
      result:
        `${shown}\n[head_limit=${limit}: showing ${visible} of ${matched} matches` +
        `${cut!.complete ? "" : ` (a ${PREFIX_SCAN_BYTES}-byte prefix was read and it ran out first)`}; ` +
        "raise head_limit or narrow the search to see the rest]",
    };
  }
  const p = outcome.presentation;
  return {
    ok: true,
    tool: args.tool,
    matched,
    returned: visible,
    head_limit: limit,
    truncated: clipped || !p.inlined,
    endReached: !clipped && p.inlined,
    artifact: p.handle,
    result: p.text,
  };
}
