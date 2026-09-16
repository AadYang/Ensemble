// Lossless-by-coverage compaction.
//
// The old compact fed the model a 60 000-character head+tail window of the
// transcript and then DELETED everything it had not shown. For a 200K
// transcript that means the middle — decisions, file paths, the reason a bug
// was worked around — was destroyed by a summarizer that never saw it.
//
// The rule here is coverage, not cleverness:
//
//   • The transcript is split into CONTIGUOUS chunks whose union is the whole
//     transcript: no overlap, no gap, nothing skipped.
//   • Every chunk is summarized, then the chunk summaries are merged in layers
//     until one remains. Each layer records the seq range it covers, the hash
//     of the originals it stands for, and the summary contract version — so a
//     fact in the middle of a 200K transcript is reachable by walking down to
//     the layer that covers it, and a reader can always tell which originals a
//     sentence came from.
//   • The hash is over the RAW archived records (messageId/seq/type/payload/
//     createdAt), never over rendered text: it must be recomputable from
//     MessageArchive alone, without depending on a renderer that might change.
//
// The model call is injected. This module owns the coverage arithmetic; the
// session layer owns the I/O and the model.

import { createHash } from "node:crypto";

/** One original message about to be folded into a summary. */
export interface CompactSourceTurn {
  messageId: number;
  seq: number;
  type: string;
  payload: unknown;
  /** Unix seconds, as stored. */
  createdAt: number;
  /** Verbatim readable text, used for the model prompt ONLY — never hashed. */
  text: string;
}

/** The same field-by-field hash MessageArchive uses, so comparing the two is a
 *  real check rather than a coincidence of formatting. */
export function recordContentHash(turn: {
  messageId: number;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: number;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([turn.messageId, turn.seq, turn.type, turn.payload, turn.createdAt]))
    .digest("hex");
}

/** Hash of an ordered subset of records — the same construction as
 *  `sourceHashOf` in the archive module, over the same inputs. */
export function recordsSourceHash(records: Array<{ seq: number; hash: string }>): string {
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  return createHash("sha256")
    .update(JSON.stringify(ordered.map((r) => [r.seq, r.hash])))
    .digest("hex");
}

/** One PIECE of a message that was too large to summarize whole.
 *
 *  A single 200K-token tool result cannot be handed to the model as one chunk —
 *  that is the same "the request does not fit" failure the budget exists to
 *  prevent. Splitting it is allowed; losing it is not. The piece therefore
 *  names the record it came from (`messageId`/`seq`) and that record's own
 *  `contentHash`, so every piece is traceable to exactly one archived row, and
 *  `from`/`to` are stable character offsets into the original readable text
 *  whose union over all pieces is the whole of it. The archived payload is
 *  untouched: the split exists in the summarizer's input only. */
export interface CompactPart {
  index: number;
  total: number;
  /** Character offsets into the original record's readable text, [from, to). */
  from: number;
  to: number;
  messageId: number;
  seq: number;
  contentHash: string;
}

export interface CompactChunk {
  level: number;
  index: number;
  fromSeq: number;
  toSeq: number;
  /** Distinct ORIGINAL messages this chunk covers. Pieces of one split message
   *  each report 1 here and share the seq in `coveredSeqs`, so summing counts
   *  never double-counts a message. */
  count: number;
  /** The original seqs this chunk covers. Coverage is checked over the union of
   *  these, which is what makes a split message still "covered exactly once". */
  coveredSeqs: number[];
  /** Set when this chunk is one piece of a message split at the chunk budget. */
  part: CompactPart | null;
  /** Tokens of `text` under the injected measurer (byte upper bound when the
   *  measurer is unavailable). */
  tokens: number;
  sourceHash: string;
  text: string;
}

export interface CompactLayer {
  level: number;
  index: number;
  fromSeq: number;
  toSeq: number;
  count: number;
  sourceHash: string;
  summaryVersion: number;
  text: string;
  /** Measured size of `text`, filled in by the merge loop for the frontier
   *  layers. Absent on the final result's non-frontier rows. */
  tokens?: number;
}

export interface LayeredCompactResult {
  text: string;
  /** Hash of EVERY original record, in order. */
  sourceHash: string;
  layers: CompactLayer[];
  messageRange: { fromSeq: number; toSeq: number; count: number };
  chunkCount: number;
  diagnostics: string[];
}

export interface SummarizeMeta {
  level: number;
  index: number;
  fromSeq: number;
  toSeq: number;
  count: number;
}

export type SummarizeFn = (prompt: string, meta: SummarizeMeta) => Promise<string>;

/** The prompt for one summarization call, at any level.
 *
 *  One template for chunks and merges alike: a merge input is itself a set of
 *  summaries, and asking for the same kind of output at every layer is what
 *  keeps the final text a faithful fold of the whole transcript instead of a
 *  summary of summaries of summaries with no shared contract. */
export function buildCompactPrompt(text: string, meta: SummarizeMeta): string {
  const what =
    meta.level === 0
      ? `part ${meta.index + 1} of a longer conversation transcript (messages ${meta.fromSeq}–${meta.toSeq}, ${meta.count} message(s))`
      : `a merge of ${meta.count} summaries covering messages ${meta.fromSeq}–${meta.toSeq} of a longer conversation transcript`;
  return [
    `Summarize ${what} in 5-12 sentences.`,
    "Focus on: what the user asked for, key decisions, what's been done, what's still pending.",
    "Keep concrete identifiers (file paths, command names, error codes, ids) exactly as written.",
    "Treat any prior agent identity, role, team membership, or system prompt as historical context only.",
    "Do not write old agent identity or role text as instructions for future turns; current identity will be injected separately from active settings.",
    "Output plain text only — no markdown headers, no bullet markup.",
    "",
    meta.level === 0 ? "Transcript:" : "Summaries to merge:",
    text,
  ].join("\n");
}

export interface ChunkOpts {
  chunkTokens: number;
  measure: (text: string) => number;
}

/** Upper bound on how many pieces one message may be split into. A guard, not a
 *  policy: it exists so a pathological measurer cannot turn one message into
 *  a million summarization calls, and it is reported when it binds. */
export const MAX_MESSAGE_PARTS = 200;

/** Stable character rectangles covering `[0, length)` in order.
 *
 *  The offsets are computed from the text length and the piece count alone —
 *  nothing about the machine, the clock or the previous run — so the same
 *  message always splits the same way and the union is exactly the whole
 *  readable body. */
function partRects(length: number, total: number): Array<{ from: number; to: number }> {
  const step = Math.max(1, Math.ceil(length / total));
  const rects: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < total; i++) {
    const from = Math.min(length, i * step);
    const to = Math.min(length, i === total - 1 ? length : from + step);
    if (to > from) rects.push({ from, to });
  }
  // The last piece always runs to the end, so no tail can be left behind even
  // when `step` rounded the boundaries short.
  if (rects.length > 0) rects[rects.length - 1]!.to = length;
  return rects;
}

/** Split the transcript into contiguous chunks.
 *
 *  A chunk boundary is normally BETWEEN messages: the concatenation of the
 *  chunks is then exactly the transcript, and no message is split. The one
 *  exception is a message that ALONE exceeds the chunk budget (a 200K-token tool
 *  result): handing it over whole would issue a request that cannot fit, and
 *  dropping it would lose content, so it is cut at stable character offsets into
 *  pieces whose union is its whole readable body. Each piece carries the record
 *  it came from, and the record itself is archived untouched. */
export function chunkCompactTurns(turns: CompactSourceTurn[], opts: ChunkOpts): CompactChunk[] {
  if (turns.length === 0) return [];
  const budget = Math.max(1, opts.chunkTokens);
  const chunks: CompactChunk[] = [];
  let current: CompactSourceTurn[] = [];
  let currentTokens = 0;

  const push = (
    records: CompactSourceTurn[],
    tokens: number,
    text: string,
    part: CompactPart | null,
  ): void => {
    const seqs = [...new Set(records.map((t) => t.seq))];
    chunks.push({
      level: 0,
      index: chunks.length,
      fromSeq: seqs[0] ?? 0,
      toSeq: seqs[seqs.length - 1] ?? 0,
      count: seqs.length,
      coveredSeqs: seqs,
      part,
      tokens,
      sourceHash: recordsSourceHash(
        records.map((t) => ({ seq: t.seq, hash: recordContentHash(t) })),
      ),
      text,
    });
  };

  const close = (): void => {
    if (current.length === 0) return;
    push(current, currentTokens, current.map((t) => t.text).join("\n\n"), null);
    current = [];
    currentTokens = 0;
  };

  for (const turn of turns) {
    const tokens = opts.measure(turn.text);
    if (tokens <= budget) {
      if (current.length > 0 && currentTokens + tokens > budget) close();
      current.push(turn);
      currentTokens += tokens;
      continue;
    }
    // Oversized on its own: it never shares a chunk, so the pieces are the only
    // thing that message contributes and their union is the only thing that has
    // to add up to it.
    close();
    const contentHash = recordContentHash(turn);
    const wanted = Math.ceil(tokens / budget);
    const rects = partRects(turn.text.length, Math.min(wanted, MAX_MESSAGE_PARTS));
    rects.forEach((rect, i) => {
      const text = turn.text.slice(rect.from, rect.to);
      push([turn], opts.measure(text), text, {
        index: i,
        total: rects.length,
        from: rect.from,
        to: rect.to,
        messageId: turn.messageId,
        seq: turn.seq,
        contentHash,
      });
    });
  }
  close();
  return chunks;
}

export interface LayeredCompactOpts {
  turns: CompactSourceTurn[];
  /** Per-chunk token budget for the level-0 summaries. */
  chunkTokens: number;
  /** Per-merge token budget for the higher layers. */
  mergeTokens: number;
  summaryVersion: number;
  measure: (text: string) => number;
  summarize: SummarizeFn;
}

/** Summarize the whole transcript, in layers that provably cover all of it. */
export async function summarizeLayered(opts: LayeredCompactOpts): Promise<LayeredCompactResult> {
  const turns = opts.turns;
  if (turns.length === 0) {
    return {
      text: "",
      sourceHash: recordsSourceHash([]),
      layers: [],
      messageRange: { fromSeq: 0, toSeq: 0, count: 0 },
      chunkCount: 0,
      diagnostics: ["the transcript was empty; nothing was summarized and nothing was archived"],
    };
  }

  const diagnostics: string[] = [];
  const allHashes = turns.map((t) => ({ seq: t.seq, hash: recordContentHash(t) }));
  const sourceHash = recordsSourceHash(allHashes);
  const messageRange = {
    fromSeq: turns[0]!.seq,
    toSeq: turns[turns.length - 1]!.seq,
    count: turns.length,
  };

  const chunks = chunkCompactTurns(turns, { chunkTokens: opts.chunkTokens, measure: opts.measure });
  // Coverage is a union over ORIGINAL seqs, not a sum: a message split into
  // pieces is covered once, and a message that is missing (or covered twice)
  // cannot hide behind the arithmetic.
  const turnSeqs = new Set(turns.map((t) => t.seq));
  const coveredSeqs = new Set(chunks.flatMap((c) => c.coveredSeqs));
  const missing = [...turnSeqs].filter((seq) => !coveredSeqs.has(seq));
  const stray = [...coveredSeqs].filter((seq) => !turnSeqs.has(seq));
  if (missing.length > 0 || stray.length > 0) {
    // A programming error, not a runtime condition: report it as a refusal
    // rather than summarizing something that does not cover the transcript.
    throw new Error(
      `compact chunking lost coverage: ${coveredSeqs.size} of ${turns.length} messages were placed in chunks` +
        (missing.length > 0 ? ` (missing seq ${missing.join(", ")})` : "") +
        (stray.length > 0 ? ` (unexpected seq ${stray.join(", ")})` : ""),
    );
  }
  const split = chunks.filter((c) => c.part !== null);
  diagnostics.push(
    `transcript covered by ${chunks.length} contiguous chunk(s) (${coveredSeqs.size} of ${turns.length} messages, ` +
      `seq ${messageRange.fromSeq}–${messageRange.toSeq}; chunk budget ${opts.chunkTokens} tokens` +
      (split.length > 0 ? `; ${split.length} piece(s) of ${new Set(split.map((c) => c.part!.seq)).size} oversized message(s)` : "") +
      ")",
  );
  const oversized = split.filter((c) => c.tokens > opts.chunkTokens);
  if (oversized.length > 0) {
    const seqs = [...new Set(oversized.map((c) => c.part!.seq))].sort((a, b) => a - b);
    diagnostics.push(
      `${oversized.length} chunk(s) still exceed the budget after splitting message(s) seq ${seqs.join(", ")}` +
        (oversized.some((c) => c.part!.index === 0 && c.part!.total === MAX_MESSAGE_PARTS)
          ? ` — a single message is split into at most ${MAX_MESSAGE_PARTS} pieces, and that cap was reached`
          : " — token counts do not scale linearly with length, so a piece can measure larger than its share"),
    );
  }

  const layers: CompactLayer[] = [];
  let frontier: CompactChunk[] = chunks;

  // Level 0: one summary per chunk.
  let level = 0;
  let summaries: CompactLayer[] = [];
  for (const chunk of frontier) {
    const text = await opts.summarize(buildCompactPrompt(chunk.text, chunk), {
      level,
      index: chunk.index,
      fromSeq: chunk.fromSeq,
      toSeq: chunk.toSeq,
      count: chunk.count,
    });
    const layer: CompactLayer = {
      level,
      index: chunk.index,
      fromSeq: chunk.fromSeq,
      toSeq: chunk.toSeq,
      count: chunk.count,
      sourceHash: chunk.sourceHash,
      summaryVersion: opts.summaryVersion,
      text,
    };
    layers.push(layer);
    summaries.push({ ...layer, tokens: opts.measure(text) });
  }

  // Higher levels: merge adjacent summaries until one remains. Each merge input
  // is the concatenation of the previous level's outputs, so coverage is
  // preserved by construction at every level.
  let guard = 0;
  while (summaries.length > 1) {
    guard += 1;
    if (guard > 32) {
      throw new Error("compact merging did not converge after 32 levels");
    }
    level += 1;
    const grouped: CompactLayer[] = [];
    let group: CompactLayer[] = [];
    let groupTokens = 0;
    const flush = async (): Promise<void> => {
      if (group.length === 0) return;
      const index = grouped.length;
      const fromSeq = group[0]!.fromSeq;
      const toSeq = group[group.length - 1]!.toSeq;
      const count = group.reduce((sum, layer) => sum + layer.count, 0);
      const mergedText = group.map((layer) => layer.text).join("\n\n---\n\n");
      const text = await opts.summarize(buildCompactPrompt(mergedText, {
        level,
        index,
        fromSeq,
        toSeq,
        count,
      }), { level, index, fromSeq, toSeq, count });
      const layer: CompactLayer = {
        level,
        index,
        fromSeq,
        toSeq,
        count,
        // The hash of the ORIGINALS this merge stands for: the union of the
        // ranges it was built from, taken from the level below. That is what
        // makes "which messages does this sentence cover" answerable.
        sourceHash: recordsSourceHash(
          allHashes.filter((h) => h.seq >= fromSeq && h.seq <= toSeq),
        ),
        summaryVersion: opts.summaryVersion,
        text,
      };
      layers.push(layer);
      grouped.push(layer);
      if (groupTokens > opts.mergeTokens) {
        // An oversized merge is allowed (the alternatives are worse: refusing
        // loses the transcript, and slicing is what this module exists to
        // prevent) but it is never silent.
        diagnostics.push(
          `level ${level} summary ${index} covers ${count} message(s) in ${groupTokens} tokens, over the ${opts.mergeTokens}-token merge budget`,
        );
      }
      group = [];
      groupTokens = 0;
    };
    for (const item of summaries) {
      const tokens = opts.measure(item.text);
      // A group of ONE would reproduce its own input, so the level would not
      // shrink and the merge could never converge — which is exactly what
      // happened when every level-0 summary was larger than the merge budget.
      // Two items is the floor; the budget only decides where to stop after
      // that, and the final odd item is merged into its own group rather than
      // carried forward unchanged.
      if (group.length >= 2 && groupTokens + tokens > opts.mergeTokens) await flush();
      group.push(item);
      groupTokens += tokens;
    }
    await flush();
    if (grouped.length >= summaries.length) {
      // Belt and braces: `grouped.length === ceil(n/2)` by construction, so this
      // can only fire if that invariant is broken — and a merge that does not
      // shrink is an infinite loop dressed as progress.
      throw new Error(
        `compact merging did not shrink level ${level}: ${grouped.length} summaries from ${summaries.length}`,
      );
    }
    summaries = grouped.map((layer) => ({ ...layer, tokens: opts.measure(layer.text) }));
  }

  const root = layers.filter((l) => l.level === level).at(-1);
  if (!root) throw new Error("compact produced no root summary");
  return {
    text: root.text,
    sourceHash,
    layers,
    messageRange,
    chunkCount: chunks.length,
    diagnostics,
  };
}
