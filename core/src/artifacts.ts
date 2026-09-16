// Result artifacts: the durable, verifiable copy of a result too large to hand
// to a model whole.
//
// The problem this replaces is not "the text was long". It is that the long
// text did not exist anywhere: peer review/continue/fork source output, a
// peer_query transcript and a subagent's final answer were each cut by one or
// more character constants (1 600 / 4 000 / 5 000 / 8 000 / 12 000) BEFORE they
// were stored, and the tool result then told the model it could read the result
// in full. A reader had no way to discover that the second half was gone.
//
// The order of operations is therefore the whole design:
//
//   result text (complete) → Artifact row (complete, hashed) → digest handed to
//   the model, with the artifact's id / sha256 / byte size and how to read it
//
// Nothing is truncated first and stored second. A digest is a VIEW of a stored
// artifact, and every digest says what it left out and where to get it.
//
// Three properties the tools depend on, and where each is enforced:
//   1. IMMUTABLE — append-only triggers in db.ts; this module exposes no update
//      and no delete. The sha256 is worth something only because of this.
//   2. VERIFIABLE — every read and every search recomputes sha256 from the
//      stored body and refuses on mismatch (never "here is the text anyway").
//   3. BYTE-EXACT PAGING — cursors are BYTE offsets snapped to UTF-8 character
//      boundaries, so concatenating every page reproduces the original bytes
//      exactly. Decoding a partial code point would produce U+FFFD, which is
//      not the original text, so the boundary rule is not a nicety.
//
// A note on the honest "unknown": when no context window was established for a
// route, there is no result budget, and this module does NOT invent one. The
// result is inlined whole and labelled as such — the same rule the history
// budget follows (`tokenBudget === null` includes everything and says so). The
// artifact is still written, so "no budget" never means "no durable copy".

import { createHash, randomUUID } from "node:crypto";
import type { RunPlanContext } from "@agentorch/shared";
import { sqliteDb, transaction } from "./db.js";
import { makeTokenMeasurer, windowFractionBudget } from "./capability/history-budget.js";

/** What share of the usable window a single result may inline before it becomes
 *  a digest + handle. A share of the REAL window, not a character constant:
 *  4 000 characters is nothing on a 200K model and a fifth of the context on a
 *  16K one. */
export const ARTIFACT_INLINE_FRACTION = 0.25;

/** One page of an artifact read. 16 KiB is ~4K tokens of English prose — a
 *  real read that a caller can afford, and a caller that wants more passes
 *  `pageBytes` (up to the cap) or continues with the cursor. */
export const ARTIFACT_DEFAULT_PAGE_BYTES = 16_384;
export const ARTIFACT_MAX_PAGE_BYTES = 262_144;
export const ARTIFACT_DEFAULT_SNIPPET_BYTES = 160;
export const ARTIFACT_MAX_SNIPPET_BYTES = 4_096;
export const ARTIFACT_DEFAULT_MAX_HITS = 20;
export const ARTIFACT_MAX_HITS = 200;

export const ARTIFACT_TEXT_MEDIA_TYPE = "text/plain; charset=utf-8";

/** Bytes of text per `ArtifactChunk` row.
 *
 *  1 MiB is the unit a streamed body is cut into: large enough that a 100 MB
 *  artifact is ~100 rows instead of 100 000 (the row overhead matters more than
 *  the read amplification), small enough that a read never holds more than a
 *  couple of them. A chunk is cut FORWARD to a UTF-8 character boundary, so a
 *  chunk may exceed this by up to three bytes and concatenating the chunks
 *  reproduces the original text exactly. */
export const ARTIFACT_CHUNK_BYTES = 1_048_576;

/** Bytes read at a time when a whole body has to be walked (hashing it, or
 *  searching it). Bounded so "verify this artifact" is O(1) memory. */
const ARTIFACT_WINDOW_BYTES = 1_048_576;

/** What produced the artifact. Kept as a plain string column so a new producer
 *  does not need a schema change, with the known values named here for the
 *  readers that already exist. */
export type ArtifactKind =
  | "peer-source"
  | "peer-history"
  | "conversation-search"
  | "subagent-final";

export interface ArtifactRow {
  id: string;
  agentId: string;
  runId: string | null;
  turnSeq: number | null;
  kind: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  /** Unix seconds. */
  createdAt: number;
  /** The stored text — EMPTY when the body was streamed in and lives in
   *  `ArtifactChunk` rows instead (`chunkCount > 0`). Nothing may assume this
   *  string is the body: read it through `readArtifactPage` / `storedBody`,
   *  which answer a BYTE RANGE from either storage shape. It is kept on the row
   *  because every existing reader selects the column, and because an artifact
   *  written from a string that fits memory still stores it here. */
  body: string;
  /** How many `ArtifactChunk` rows hold the body. 0 = it is in `body`. */
  chunkCount: number;
}

/** Everything a reader needs to fetch the artifact — and nothing that requires
 *  the body to be in hand. This is what a chat message or tool result carries. */
export interface ArtifactHandle {
  id: string;
  kind: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  createdAt: number;
}

export function handleOf(row: ArtifactRow): ArtifactHandle {
  return {
    id: row.id,
    kind: row.kind,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    createdAt: row.createdAt,
  };
}

// ── errors ───────────────────────────────────────────────────────────────────
// Structured, never success-shaped. A code + the numbers behind it, so a caller
// can act (or a human can see what to fix) without parsing prose.

export type ArtifactFailureCode =
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_CURSOR_INVALID"
  | "ARTIFACT_HASH_MISMATCH"
  | "ARTIFACT_UNREADABLE"
  | "ARTIFACT_QUERY_EMPTY";

export interface ArtifactError {
  ok: false;
  code: ArtifactFailureCode;
  message: string;
  id?: string;
  /** The hash RECORDED on the row, when the failure is about hashing. */
  sha256?: string;
  /** The hash COMPUTED from the stored body, when the two disagree. */
  recomputedSha256?: string;
  cursor?: string;
  byteSize?: number;
  mediaType?: string;
}

export interface ArtifactReadOk {
  ok: true;
  id: string;
  kind: string;
  mediaType: string;
  sha256: string;
  byteSize: number;
  /** Byte range of THIS page, half-open [byteFrom, byteTo). */
  byteFrom: number;
  byteTo: number;
  endReached: boolean;
  /** Cursor for the next page, or null at the end. Stable: the same offset
   *  always encodes to the same string. */
  nextCursor: string | null;
  /** The page text. Decoded from a byte range that starts and ends on a
   *  character boundary, so concatenating pages reproduces the original bytes. */
  text: string;
  /** True when sha256 was recomputed from the stored body and matched. */
  verified: true;
}

export type ArtifactReadResult = ArtifactReadOk | ArtifactError;

export interface ArtifactSearchHit {
  /** Byte offset of the match inside the whole artifact body. */
  byteOffset: number;
  /** Byte range of the snippet, half-open. */
  snippetFrom: number;
  snippetTo: number;
  snippet: string;
}

export interface ArtifactSearchOk {
  ok: true;
  id: string;
  kind: string;
  mediaType: string;
  sha256: string;
  byteSize: number;
  query: string;
  caseSensitive: boolean;
  hits: ArtifactSearchHit[];
  /** Byte range this call actually scanned, half-open. The next cursor resumes
   *  at `scannedToByte`, so a caller can walk the whole body without ever
   *  holding it, and a caller reading a partial scan can see what it covered. */
  scannedFromByte: number;
  scannedToByte: number;
  endReached: boolean;
  nextCursor: string | null;
  verified: true;
}

export type ArtifactSearchResult = ArtifactSearchOk | ArtifactError;

// ── hashing ──────────────────────────────────────────────────────────────────

/** sha256 of the UTF-8 BYTES of `text`. Bytes, not UTF-16 code units: the
 *  artifact is a byte string, and that is what "read it back and check" means. */
export function sha256OfText(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export function byteSizeOfText(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// ── writing (append-only) ────────────────────────────────────────────────────

export interface CreateArtifactInput {
  agentId: string;
  runId?: string | null;
  turnSeq?: number | null;
  kind: ArtifactKind | string;
  body: string;
  mediaType?: string;
  /** Injected for tests; defaults to the wall clock. */
  now?: number;
}

/** Store `body` verbatim and prove it landed.
 *
 *  The row is read back and re-hashed before it is returned: the caller is
 *  about to hand a model an id and a sha256 and claim they identify the whole
 *  text, and that claim is checked against the bytes in storage rather than
 *  against the string we still have in memory. A mismatch throws — there is no
 *  useful degraded mode for "the durable copy is not what I wrote". */
export function createArtifact(input: CreateArtifactInput): ArtifactRow {
  const body = String(input.body ?? "");
  const mediaType = input.mediaType ?? ARTIFACT_TEXT_MEDIA_TYPE;
  const sha256 = sha256OfText(body);
  const byteSize = byteSizeOfText(body);
  const id = randomUUID();
  sqliteDb
    .prepare(
      `INSERT INTO ResultArtifact (id, agentId, runId, turnSeq, kind, mediaType, byteSize, sha256, createdAt, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.agentId,
      input.runId ?? null,
      input.turnSeq ?? null,
      input.kind,
      mediaType,
      byteSize,
      sha256,
      input.now ?? Math.floor(Date.now() / 1000),
      body,
    );
  const row = getArtifact(id);
  if (!row) throw new Error(`artifact ${id} was not readable immediately after it was written`);
  const recomputed = sha256OfText(row.body);
  if (recomputed !== row.sha256) {
    throw new Error(
      `artifact ${id} failed write verification: recorded sha256 ${row.sha256} but the stored body hashes to ` +
        `${recomputed}`,
    );
  }
  return row;
}

/** The complete bytes of a result that was SPOOLED as it was produced, for a
 *  producer that never had them in one piece.
 *
 *  A tool that streams a command's output, or walks a tree, cannot first build
 *  the string and then decide it is too big: peak memory would already be the
 *  size of the result, which for a runaway command is the whole problem. It
 *  writes into a spool instead, and the spool hands the storage layer exactly
 *  what it needs — the size, the digest of everything written, and the bytes in
 *  bounded chunks. `spilled` is the honest self-report that lets the small case
 *  keep the simple storage shape.
 *
 *  The digest is over the CANONICAL UTF-8 bytes the spool holds (invalid input
 *  sequences become U+FFFD as they arrive, exactly as decoding a whole buffer
 *  would do), so it is the same number the stored text hashes to. */
export interface ArtifactBodySource {
  byteSize: number;
  sha256: string;
  /** True once the bytes outgrew the source's memory limit and live in a
   *  temporary file. Only a source that never spilled can hand over `text()`. */
  spilled: boolean;
  /** The whole body as one string. Throws when the body was spilled — the
   *  caller asked for something it already decided not to keep. */
  text(): string;
  /** The first `maxBytes` bytes as text, cut on a character boundary. This is
   *  what a preview or a head_limit prefix is built from, and it costs the
   *  bytes it returns however large the body is. */
  preview(maxBytes: number): string;
  /** The body in chunks of at most `chunkBytes` BYTES, cut on character
   *  boundaries. Synchronous: it is read while the artifact row is written. */
  chunks(chunkBytes?: number): Iterable<Buffer>;
  /** Release anything held outside memory (the spill file). Idempotent. */
  dispose(): void;
}

export interface CreateArtifactFromSpoolInput {
  agentId: string;
  runId?: string | null;
  turnSeq?: number | null;
  kind: ArtifactKind | string;
  source: ArtifactBodySource;
  mediaType?: string;
  now?: number;
}

/** Store a spooled body and prove it landed — the spooled twin of
 *  `createArtifact`, with the same contract: the row is read back and re-hashed
 *  before it is returned, and a mismatch throws.
 *
 *  A body that never spilled takes the plain path (`createArtifact`), because
 *  the string is bounded by the spool's own memory limit — that IS the size
 *  decision, made once. A body that did spill is written as chunk rows, which is
 *  what keeps the write, and every later read, from needing the whole thing. */
export function createArtifactFromSpool(input: CreateArtifactFromSpoolInput): ArtifactRow {
  const source = input.source;
  const mediaType = input.mediaType ?? ARTIFACT_TEXT_MEDIA_TYPE;
  if (!source.spilled) {
    return createArtifact({
      agentId: input.agentId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.turnSeq !== undefined ? { turnSeq: input.turnSeq } : {}),
      kind: input.kind,
      body: source.text(),
      mediaType,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
  }

  const id = randomUUID();
  const createdAt = input.now ?? Math.floor(Date.now() / 1000);
  // The row is inserted once and never updated — that is what the Artifact
  // triggers enforce and what makes its sha256 mean something — so the chunk
  // count has to be known BEFORE the insert. Counting is a bounded pre-pass over
  // the same source: the chunks are re-READ, never re-buffered, and nothing
  // between the two passes can modify them (the source is frozen, and the only
  // writer is this call).
  let chunkCount = 0;
  for (const chunk of source.chunks(ARTIFACT_CHUNK_BYTES)) if (chunk.length > 0) chunkCount++;

  const write = (): void => {
    sqliteDb
      .prepare(
        `INSERT INTO ResultArtifact (id, agentId, runId, turnSeq, kind, mediaType, byteSize, sha256, createdAt, body, chunkCount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
      )
      .run(
        id,
        input.agentId,
        input.runId ?? null,
        input.turnSeq ?? null,
        input.kind,
        mediaType,
        source.byteSize,
        source.sha256,
        createdAt,
        chunkCount,
      );
    const insertChunk = sqliteDb.prepare(
      `INSERT INTO ResultArtifactChunk (artifactId, seq, byteFrom, bytes, body) VALUES (?, ?, ?, ?, ?)`,
    );
    let seq = 0;
    let byteFrom = 0;
    for (const chunk of source.chunks(ARTIFACT_CHUNK_BYTES)) {
      if (chunk.length === 0) continue;
      insertChunk.run(id, seq++, byteFrom, chunk.length, chunk.toString("utf8"));
      byteFrom += chunk.length;
    }
  };
  // One transaction, because a row claiming N bytes with half its chunks written
  // is a corrupt artifact and the append-only triggers make that unrecoverable by
  // design. Nesting is impossible on the paths that get here (tools run outside
  // any transaction) but is checked rather than assumed.
  if (sqliteDb.isTransaction) write();
  else transaction(write);

  const row = getArtifact(id);
  if (!row) throw new Error(`artifact ${id} was not readable immediately after it was written`);
  const verified = verifyArtifact(row);
  if (!verified.ok) {
    throw new Error(`artifact ${id} failed write verification: ${verified.message}`);
  }
  return row;
}

export function getArtifact(id: string): ArtifactRow | null {
  const row = sqliteDb.prepare("SELECT * FROM ResultArtifact WHERE id = ? LIMIT 1").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapArtifact(row) : null;
}

function mapArtifact(row: Record<string, unknown>): ArtifactRow {
  return {
    id: String(row.id),
    agentId: String(row.agentId),
    runId: row.runId == null ? null : String(row.runId),
    turnSeq: row.turnSeq == null ? null : Number(row.turnSeq),
    kind: String(row.kind),
    mediaType: String(row.mediaType),
    byteSize: Number(row.byteSize),
    sha256: String(row.sha256),
    createdAt: Number(row.createdAt),
    body: String(row.body),
    // `?? 0` covers a row read before the column existed (an in-flight ALTER):
    // "no chunks" is the truth for every artifact written from a string.
    chunkCount: Number(row.chunkCount ?? 0),
  };
}

// ── the stored bytes, addressed by range ─────────────────────────────────────
//
// Two storage shapes exist (see ArtifactRow.body) and NOTHING above this line
// may care which one it is looking at. Every reader used to start with
// `Buffer.from(row.body, "utf8")`, which materializes the whole artifact to
// answer a 16 KiB page — fine while every body had to fit memory anyway, and
// exactly the thing that has to stop now that a body can be streamed in. A
// reader asks for the range it needs and the shape answers it.

interface StoredBody {
  /** Bytes, always the authoritative size (verified against the row). */
  byteSize: number;
  /** Bytes [from, to). Callers pass offsets snapped to character boundaries;
   *  chunk boundaries are already boundaries, so the concatenation is exact. */
  slice(from: number, to: number): Buffer;
  /** Every byte, in windows of at most `size` — for a whole-body walk that must
   *  not become a whole-body allocation (hashing). */
  windows(size: number): Generator<Buffer>;
}

function storedBody(row: ArtifactRow): StoredBody {
  if (row.chunkCount <= 0) {
    const buf = Buffer.from(row.body, "utf8");
    return {
      byteSize: buf.length,
      slice: (from, to) => buf.subarray(clampRange(from, buf.length), clampRange(to, buf.length)),
      *windows(size) {
        const step = Math.max(1, Math.floor(size));
        for (let at = 0; at < buf.length; at += step) {
          yield buf.subarray(at, Math.min(buf.length, at + step));
        }
      },
    };
  }
  const id = row.id;
  const size = row.byteSize;
  const slice = (from: number, to: number): Buffer => {
    const lo = clampRange(from, size);
    const hi = clampRange(to, size);
    if (hi <= lo) return Buffer.alloc(0);
    // Only the chunks that OVERLAP the range are read: byteFrom/bytes make that
    // a WHERE clause rather than a scan from byte 0, which is what keeps a page
    // read of a 100 MB artifact from reading the 100 MB in front of it.
    const rows = sqliteDb
      .prepare(
        `SELECT byteFrom, body FROM ResultArtifactChunk
         WHERE artifactId = ? AND byteFrom < ? AND byteFrom + bytes > ?
         ORDER BY seq`,
      )
      .all(id, hi, lo) as { byteFrom: number; body: string }[];
    const parts: Buffer[] = [];
    for (const c of rows) {
      const chunk = Buffer.from(String(c.body), "utf8");
      const localFrom = Math.max(0, lo - c.byteFrom);
      const localTo = Math.min(chunk.length, hi - c.byteFrom);
      if (localTo > localFrom) parts.push(chunk.subarray(localFrom, localTo));
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  };
  return {
    byteSize: size,
    slice,
    *windows(step) {
      const s = Math.max(1, Math.floor(step));
      for (let at = 0; at < size; at += s) yield slice(at, Math.min(size, at + s));
    },
  };
}

function clampRange(i: number, size: number): number {
  if (!Number.isFinite(i)) return 0;
  return Math.max(0, Math.min(size, Math.floor(i)));
}

/** sha256 of the STORED bytes, computed a window at a time — the same digest
 *  `sha256OfText` produces for the same text, without ever holding it. */
function hashStored(body: StoredBody): string {
  const hash = createHash("sha256");
  let seen = 0;
  for (const window of body.windows(ARTIFACT_WINDOW_BYTES)) {
    hash.update(window);
    seen += window.length;
  }
  if (seen !== body.byteSize) {
    // The walk did not cover what the row claims — a hash of a truncated walk
    // would be a number that verifies nothing, so say so instead of returning
    // one. Both callers turn this into a structured failure.
    throw new Error(`stored body walked ${seen} bytes but the row records ${body.byteSize}`);
  }
  return hash.digest("hex");
}

/** Recompute the hash of the stored bytes and say whether the row is what it
 *  claims. Anything that hands out artifact text checks this first: "here is the
 *  text, and by the way the hash does not match" is the failure mode this exists
 *  to prevent.
 *
 *  The walk is windowed, so this is O(1) memory whether the body is a string on
 *  the row or a hundred chunk rows: verifying an artifact must not be as
 *  expensive as the artifact. */
export function verifyArtifact(row: ArtifactRow): { ok: true } | ArtifactError {
  const body = storedBody(row);
  let recomputed: string;
  try {
    recomputed = hashStored(body);
  } catch (err) {
    return {
      ok: false,
      code: "ARTIFACT_HASH_MISMATCH",
      id: row.id,
      sha256: row.sha256,
      byteSize: row.byteSize,
      message:
        `artifact ${row.id} could not be read back for verification (${(err as Error).message}). The stored ` +
        "text is NOT returned; treat this artifact as corrupt.",
    };
  }
  if (recomputed !== row.sha256) {
    return {
      ok: false,
      code: "ARTIFACT_HASH_MISMATCH",
      id: row.id,
      sha256: row.sha256,
      recomputedSha256: recomputed,
      byteSize: row.byteSize,
      message:
        `artifact ${row.id} does not match its recorded sha256: the row claims ${row.sha256} but the stored ` +
        `body hashes to ${recomputed}. The stored text is NOT returned; treat this artifact as corrupt and ` +
        "report it rather than working from unverified content.",
    };
  }
  // The bytes hash correctly but the row says they are a different length: the
  // metadata disagrees with content that is otherwise intact (a truncated
  // chunked body whose chunks still hash to what was recorded was impossible
  // before, and is a corrupt row now).
  if (body.byteSize !== row.byteSize) {
    return {
      ok: false,
      code: "ARTIFACT_HASH_MISMATCH",
      id: row.id,
      sha256: row.sha256,
      recomputedSha256: recomputed,
      byteSize: row.byteSize,
      message:
        `artifact ${row.id} records ${row.byteSize} bytes but its stored body is ${body.byteSize} bytes: the ` +
        "row's own metadata disagrees with its content. The stored text is NOT returned; treat this artifact " +
        "as corrupt and report it rather than working from unverified content.",
    };
  }
  return { ok: true };
}

/** Everything a read/search does before it touches the body: exists, is text,
 *  hashes correctly. Returns either the row or the structured refusal. */
function loadReadable(id: string): { row: ArtifactRow } | { error: ArtifactError } {
  const row = getArtifact(id);
  if (!row) {
    return {
      error: {
        ok: false,
        code: "ARTIFACT_NOT_FOUND",
        id,
        message: `no artifact with id "${id}" exists. Artifact ids come from the tool result or chat message that produced one.`,
      },
    };
  }
  if (!isTextualMediaType(row.mediaType)) {
    return {
      error: {
        ok: false,
        code: "ARTIFACT_UNREADABLE",
        id: row.id,
        mediaType: row.mediaType,
        byteSize: row.byteSize,
        message:
          `artifact ${row.id} is ${row.mediaType}, which this reader cannot decode as text. Its sha256 ` +
          `(${row.sha256}) and size are still authoritative.`,
      },
    };
  }
  const verified = verifyArtifact(row);
  if (!verified.ok) return { error: verified };
  return { row };
}

/** Is byte `at` a character boundary in the stored body? Only the byte AT that
 *  offset has to be read — a continuation byte (0b10xxxxxx) cannot start a code
 *  point — so the check costs one byte whatever the artifact weighs. */
function isStoredBoundary(body: StoredBody, at: number): boolean {
  if (at <= 0 || at >= body.byteSize) return true;
  const byte = body.slice(at, at + 1)[0];
  return byte === undefined || (byte & 0xc0) !== 0x80;
}

function isTextualMediaType(mediaType: string): boolean {
  const type = mediaType.toLowerCase();
  return type.startsWith("text/") || type.includes("json") || type.includes("xml") || type.includes("yaml");
}

// ── listing ──────────────────────────────────────────────────────────────────
//
// Handles only, never bodies: the list answers "which artifacts exist" for a
// reader that has to pick one, and returning N bodies to answer that would make
// listing as expensive as reading everything. The body is what
// `readArtifactPage` is for, and the handle is what every producer already hands
// a reader.

export const ARTIFACT_DEFAULT_LIST_LIMIT = 50;
export const ARTIFACT_MAX_LIST_LIMIT = 200;

export interface ListArtifactsOpts {
  agentId?: string | null;
  kind?: string | null;
  /** Clamped to [1, ARTIFACT_MAX_LIST_LIMIT]; a non-number falls back to the
   *  default, the same way a page size does. */
  limit?: number | null;
}

export interface ArtifactListResult {
  artifacts: ArtifactHandle[];
  /** The cap that was actually applied, after the default and the clamp. */
  limit: number;
  /** True when the store holds more rows than `limit` returned, so a caller
   *  never reads a capped list as the whole store. */
  truncated: boolean;
}

/** Newest first. Ordered by createdAt AND id because two artifacts written in
 *  the same second must still come back in a stable order — a list that
 *  reshuffles between calls reads as "rows appeared and vanished". */
export function listArtifacts(opts: ListArtifactsOpts = {}): ArtifactListResult {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.agentId) {
    where.push("agentId = ?");
    params.push(opts.agentId);
  }
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  const limit = clampListLimit(opts.limit);
  // limit + 1 rows: the extra row is how `truncated` is answered without a
  // second COUNT over the table, and it is dropped before the result is built.
  const rows = sqliteDb
    .prepare(
      `SELECT id, kind, mediaType, byteSize, sha256, createdAt FROM ResultArtifact
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY createdAt DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as Record<string, unknown>[];
  return {
    artifacts: rows.slice(0, limit).map(toHandle),
    limit,
    truncated: rows.length > limit,
  };
}

function clampListLimit(limit: number | null | undefined): number {
  const n = Math.floor(Number(limit ?? ARTIFACT_DEFAULT_LIST_LIMIT));
  if (!Number.isFinite(n) || n <= 0) return ARTIFACT_DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(ARTIFACT_MAX_LIST_LIMIT, n));
}

/** A row selected WITHOUT its body, mapped to the handle a reader carries. The
 *  body is deliberately absent from the SELECT above: a list of 200 rows must
 *  not read 200 bodies to say which ids exist. */
function toHandle(row: Record<string, unknown>): ArtifactHandle {
  return {
    id: String(row.id),
    kind: String(row.kind),
    mediaType: String(row.mediaType),
    byteSize: Number(row.byteSize),
    sha256: String(row.sha256),
    createdAt: Number(row.createdAt),
  };
}

// ── cursors ──────────────────────────────────────────────────────────────────

/** A cursor is a byte offset, base64url-encoded so it reads as an opaque
 *  handle. It carries no state of its own — the offset IS the cursor, which is
 *  what makes it stable across calls and processes. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    const offset = parsed?.o;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return null;
    return offset;
  } catch {
    return null;
  }
}

function cursorError(id: string, cursor: string, byteSize: number, detail: string): ArtifactError {
  return {
    ok: false,
    code: "ARTIFACT_CURSOR_INVALID",
    id,
    cursor,
    byteSize,
    message:
      `cursor "${cursor}" is not usable for artifact ${id} (${detail}). Cursors come from a previous ` +
      "artifact_read/artifact_search result on the SAME artifact; re-read it without a cursor to start over.",
  };
}

// ── UTF-8 safe byte ranges ───────────────────────────────────────────────────

/** Is byte index `i` a character boundary? A continuation byte (0b10xxxxxx)
 *  cannot start a code point, so a range may not begin or end there. */
export function isUtf8Boundary(buf: Buffer, i: number): boolean {
  if (i <= 0 || i >= buf.length) return true;
  return (buf[i]! & 0xc0) !== 0x80;
}

/** The largest end offset <= `start + maxBytes` that is a character boundary.
 *
 *  Always makes progress: a `maxBytes` smaller than one code point (or one that
 *  lands mid-code-point) advances to the next boundary rather than returning an
 *  empty page, because a pagination loop that can return zero bytes forever is
 *  a loop the caller cannot escape. */
export function utf8SafeEnd(buf: Buffer, start: number, maxBytes: number): number {
  const wanted = start + Math.max(1, Math.floor(maxBytes));
  if (wanted >= buf.length) return buf.length;
  let end = wanted;
  while (end > start && !isUtf8Boundary(buf, end)) end--;
  if (end > start) return end;
  // The whole window was inside one code point: take the next boundary after
  // `start` instead, so the page still advances.
  let next = start + 1;
  while (next < buf.length && !isUtf8Boundary(buf, next)) next++;
  return Math.min(next, buf.length);
}

// ── reading ──────────────────────────────────────────────────────────────────

export interface ReadArtifactOpts {
  cursor?: string | null;
  /** Bytes to return. Clamped to [1, ARTIFACT_MAX_PAGE_BYTES]; snapped to a
   *  character boundary. */
  pageBytes?: number | null;
}

export function readArtifactPage(id: string, opts: ReadArtifactOpts = {}): ArtifactReadResult {
  const loaded = loadReadable(id);
  if ("error" in loaded) return loaded.error;
  const row = loaded.row;
  const body = storedBody(row);
  // The stored byteSize is verified above, so this IS row.byteSize.
  const total = body.byteSize;

  let start = 0;
  const cursor = opts.cursor ?? null;
  if (cursor !== null && cursor !== undefined && cursor !== "") {
    const decoded = decodeCursor(cursor);
    if (decoded === null) return cursorError(id, cursor, total, "it does not decode to a byte offset");
    if (decoded > total) {
      return cursorError(id, cursor, total, `it points at byte ${decoded}, past the end of a ${total}-byte artifact`);
    }
    if (!isStoredBoundary(body, decoded)) {
      return cursorError(id, cursor, total, `byte ${decoded} is in the middle of a UTF-8 character`);
    }
    start = decoded;
  }

  const pageBytes = clampPageBytes(opts.pageBytes);
  // Read the page plus four bytes of slack, and cut the page inside that window.
  // A code point is at most four bytes, so every boundary decision utf8SafeEnd
  // makes (it looks at the byte AT the candidate end) is answered by this window
  // — the rest of the artifact is never touched.
  const end0 = Math.min(total, start + pageBytes + 4);
  const head = body.slice(start, end0);
  const end = start + utf8SafeEnd(head, 0, pageBytes);
  const text = head.subarray(0, Math.max(0, end - start)).toString("utf8");
  const endReached = end >= total;
  return {
    ok: true,
    id: row.id,
    kind: row.kind,
    mediaType: row.mediaType,
    sha256: row.sha256,
    byteSize: total,
    byteFrom: start,
    byteTo: end,
    endReached,
    nextCursor: endReached ? null : encodeCursor(end),
    text,
    verified: true,
  };
}

function clampPageBytes(pageBytes: number | null | undefined): number {
  const n = Math.floor(Number(pageBytes ?? ARTIFACT_DEFAULT_PAGE_BYTES));
  if (!Number.isFinite(n) || n <= 0) return ARTIFACT_DEFAULT_PAGE_BYTES;
  return Math.max(1, Math.min(ARTIFACT_MAX_PAGE_BYTES, n));
}

// ── searching ────────────────────────────────────────────────────────────────

export interface SearchArtifactOpts {
  query: string;
  caseSensitive?: boolean;
  maxHits?: number | null;
  /** Bytes of context around each hit. A snippet is a POINTER to where to read,
   *  never a substitute for the artifact — the caller still has the artifact's
   *  id and can read the exact bytes. */
  snippetBytes?: number | null;
  cursor?: string | null;
}

export function searchArtifact(id: string, opts: SearchArtifactOpts): ArtifactSearchResult {
  const query = String(opts.query ?? "");
  if (query.length === 0) {
    return {
      ok: false,
      code: "ARTIFACT_QUERY_EMPTY",
      id,
      message:
        "artifact_search needs a non-empty query. To read the artifact without searching, use artifact_read.",
    };
  }
  const loaded = loadReadable(id);
  if ("error" in loaded) return loaded.error;
  const row = loaded.row;
  const body = storedBody(row);
  const total = body.byteSize;

  const caseSensitive = opts.caseSensitive === true;
  const maxHits = clampHits(opts.maxHits);
  const snippetBytes = clampSnippetBytes(opts.snippetBytes);

  let start = 0;
  const cursor = opts.cursor ?? null;
  if (cursor !== null && cursor !== undefined && cursor !== "") {
    const decoded = decodeCursor(cursor);
    if (decoded === null) return cursorError(id, cursor, total, "it does not decode to a byte offset");
    if (decoded > total) {
      return cursorError(id, cursor, total, `it points at byte ${decoded}, past the end of a ${total}-byte artifact`);
    }
    if (!isStoredBoundary(body, decoded)) {
      return cursorError(id, cursor, total, `byte ${decoded} is in the middle of a UTF-8 character`);
    }
    start = decoded;
  }

  // Scan the text from `start`, then convert each match's character index back
  // to a BYTE offset (Buffer.byteLength of the prefix). Byte offsets are what a
  // later read takes, so this is the conversion that makes search → read exact.
  //
  // Matching is done with an escaped-literal regex over the ORIGINAL text rather
  // than over a lowercased copy: `toLowerCase` can change a string's length
  // ("İ" folds to two code units), which would shift every later match index and
  // hand back a byte offset that does not point at the hit — and a search result
  // whose offsets are wrong is worse than no search.
  //
  // The scan is WINDOWED: an artifact can be larger than memory now, so the body
  // is read a window at a time and decoded window by window. Two things make the
  // windowed answer identical to the whole-body one:
  //   • a window is read up to `overlapBytes` PAST its scan end, so a match that
  //     straddles the boundary is complete in hand. A match that begins at or
  //     after the window's end is left to the next window, which starts exactly
  //     there — so nothing is found twice and nothing falls between them;
  //   • the window starts and ends on character boundaries, so decoding it is
  //     the same text the whole-body decode would have produced at that offset.
  // `overlapBytes` is sized from the query's own byte length with room for case
  // folding (which can make the MATCHED text longer than the query: "ß" matches
  // "ss"), because a straddling match must fit inside the overlap.
  const overlapBytes = Math.max(64, Buffer.byteLength(query, "utf8") * 4 + 8);
  const windowBytes = Math.max(ARTIFACT_WINDOW_BYTES, overlapBytes * 2);

  const hits: ArtifactSearchHit[] = [];
  let matchedToByte = start;
  let scanFrom = start;
  const matcher = new RegExp(escapeRegExp(query), caseSensitive ? "g" : "gi");
  while (hits.length < maxHits && scanFrom < total) {
    const windowEnd0 = Math.min(total, scanFrom + windowBytes);
    const readTo = Math.min(total, windowEnd0 + overlapBytes);
    const raw = body.slice(scanFrom, readTo);
    // Never decode a partial code point: the window's end is snapped down to a
    // character boundary, and the overlap is what guarantees a match that is cut
    // here is still complete before the NEXT window's scan end.
    const decodedEnd = utf8SnapDown(raw, raw.length);
    const haystack = raw.subarray(0, decodedEnd).toString("utf8");
    const windowEnd = scanFrom + utf8SnapDown(raw, Math.max(0, windowEnd0 - scanFrom));

    let match: RegExpExecArray | null;
    matcher.lastIndex = 0;
    while (hits.length < maxHits && (match = matcher.exec(haystack)) !== null) {
      const found = match.index;
      const hitByte = scanFrom + Buffer.byteLength(haystack.slice(0, found), "utf8");
      // A match at or past the window's end belongs to the next window, and a
      // match that runs past what this window decoded is not complete here.
      if (hitByte >= windowEnd) break;
      if (found + match[0].length > haystack.length) break;
      // End of the MATCHED text, not of the query: under case folding the two can
      // differ in byte length, and this is the resume point.
      const hitEndByte = scanFrom + Buffer.byteLength(haystack.slice(0, found + match[0].length), "utf8");
      // The snippet is read by RANGE (never from the window, which ends at the
      // overlap) and snapped out to character boundaries: decoding from the
      // middle of a code point would put a U+FFFD in the snippet, which is a
      // character the artifact does not contain.
      const from0 = Math.max(start, hitByte - snippetBytes);
      const to0 = Math.min(total, hitEndByte + snippetBytes);
      const edge = body.slice(Math.max(0, from0 - 3), Math.min(total, to0 + 3));
      const base = Math.max(0, from0 - 3);
      const from = base + utf8SnapDown(edge, from0 - base);
      const to = base + utf8SnapUp(edge, to0 - base);
      hits.push({
        byteOffset: hitByte,
        snippetFrom: from,
        snippetTo: to,
        snippet: `${from > 0 ? "…" : ""}${body.slice(from, to).toString("utf8")}${to < total ? "…" : ""}`,
      });
      matchedToByte = hitEndByte;
      // Non-overlapping scan; the regex `g` flag already advanced lastIndex past
      // the match, and a zero-length match is impossible (query is non-empty).
      if (matcher.lastIndex === found) matcher.lastIndex = found + 1;
    }
    // Resume after the last hit that was inside this window, or at the window's
    // end — never before where the scan already got to, or the loop would spin.
    const next = Math.max(windowEnd, matchedToByte);
    if (next <= scanFrom) {
      // Cannot happen with the bounds above (the window is wider than the
      // overlap, so windowEnd is always past scanFrom); a byte of progress is the
      // floor rather than an infinite loop if this arithmetic is ever changed.
      scanFrom += 1;
      continue;
    }
    // Snapped UP so the next window starts on a character boundary, which is what
    // lets its text be decoded without a leading U+FFFD.
    scanFrom = scanFrom + utf8SnapUp(raw, Math.min(next, windowEnd0) - scanFrom);
  }

  // Two ways to stop: the hit budget ran out (resume right after the last hit)
  // or the body ended. Either way the cursor is a real byte offset, so a caller
  // can keep calling until endReached is true and see every match.
  const exhaustedBody = hits.length < maxHits;
  const scannedToByte = exhaustedBody ? total : Math.min(total, Math.max(start, matchedToByte));
  const endReached = exhaustedBody || scannedToByte >= total;
  return {
    ok: true,
    id: row.id,
    kind: row.kind,
    mediaType: row.mediaType,
    sha256: row.sha256,
    byteSize: total,
    query,
    caseSensitive,
    hits,
    scannedFromByte: start,
    scannedToByte,
    endReached,
    nextCursor: endReached ? null : encodeCursor(scannedToByte),
    verified: true,
  };
}

/** Literal-string → regex source. The query is a literal by contract, so every
 *  metacharacter is neutralized; a query containing `.*` searches for those two
 *  characters and not for everything. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function utf8SnapDown(buf: Buffer, i: number): number {
  let at = Math.min(i, buf.length);
  while (at > 0 && !isUtf8Boundary(buf, at)) at--;
  return at;
}

function utf8SnapUp(buf: Buffer, i: number): number {
  let at = Math.min(i, buf.length);
  while (at < buf.length && !isUtf8Boundary(buf, at)) at++;
  return at;
}

function clampHits(maxHits: number | null | undefined): number {
  const n = Math.floor(Number(maxHits ?? ARTIFACT_DEFAULT_MAX_HITS));
  if (!Number.isFinite(n) || n <= 0) return ARTIFACT_DEFAULT_MAX_HITS;
  return Math.max(1, Math.min(ARTIFACT_MAX_HITS, n));
}

function clampSnippetBytes(snippetBytes: number | null | undefined): number {
  const n = Math.floor(Number(snippetBytes ?? ARTIFACT_DEFAULT_SNIPPET_BYTES));
  if (!Number.isFinite(n) || n < 0) return ARTIFACT_DEFAULT_SNIPPET_BYTES;
  return Math.min(ARTIFACT_MAX_SNIPPET_BYTES, n);
}

// ── rendering ────────────────────────────────────────────────────────────────

export interface ArtifactBudgetDecision {
  /** true → the whole result travels inline; false → a bounded preview travels
   *  and the reader continues through artifact_read. */
  inline: boolean;
  /** Why, in the terms of the plan that produced it. Printed verbatim. */
  reason: string;
  /** Token count of the result under the injected measurer (the byte upper
   *  bound when nothing could be measured). */
  tokens: number;
  /** null when no window was established for this route. */
  budgetTokens: number | null;
  /** The measurer could not produce a real count, so `tokens` is the UTF-8
   *  byte upper bound. */
  estimated: boolean;
}

/** The one size decision for an inline-able result.
 *
 *  `budgetTokens === null` means no window was established, and the answer is
 *  to inline everything — dropping content against an unknown ceiling is a
 *  guess dressed as a limit (see capability/history-budget.ts, same rule).
 *  `measure` returning 0/null for non-empty text is NOT a small result: it is
 *  an unmeasured one, and it is compared as the conservative byte upper bound. */
export function decideArtifactInline(args: {
  text: string;
  context: RunPlanContext | null | undefined;
  measure: (text: string) => number | null;
}): ArtifactBudgetDecision {
  const measurer = makeTokenMeasurer(args.measure);
  const tokens = measurer.count(args.text);
  const estimated = measurer.counting() === "estimated";
  const budgetTokens = windowFractionBudget(args.context ?? null, ARTIFACT_INLINE_FRACTION);
  const suffix = estimated
    ? " (the tokenizer could not measure it, so UTF-8 bytes are used as the conservative upper bound)"
    : "";
  if (budgetTokens === null) {
    return {
      inline: true,
      reason:
        "no context window was established for this route, so no result budget exists and nothing was dropped on a guess" +
        suffix,
      tokens,
      budgetTokens,
      estimated,
    };
  }
  if (tokens <= budgetTokens) {
    return {
      inline: true,
      reason: `${tokens} tokens fits the ${budgetTokens}-token result budget${suffix}`,
      tokens,
      budgetTokens,
      estimated,
    };
  }
  return {
    inline: false,
    reason:
      `${tokens} tokens exceeds the ${budgetTokens}-token result budget for this route${suffix}; ` +
      "the artifact holds every byte and artifact_read continues from this preview",
    tokens,
    budgetTokens,
    estimated,
  };
}

/** How many bytes a preview may carry when the result is not inlined.
 *
 *  A token budget is at most that many BYTES (no tokenizer in use here emits
 *  fewer than one token per byte), so using the token number as a byte count
 *  cannot overshoot the budget. It is the same "conservative direction" rule
 *  the byte upper bound uses. */
export function previewBytesFor(decision: ArtifactBudgetDecision): number {
  if (decision.budgetTokens === null) return ARTIFACT_DEFAULT_PAGE_BYTES;
  const byTokens = Math.max(1, decision.budgetTokens);
  return Math.max(1, Math.min(ARTIFACT_MAX_PAGE_BYTES, byTokens));
}

/** Page one of an artifact, plus the cursor that continues after it.
 *
 *  A preview is not a truncation: it is the first page of the paged read, cut
 *  on a character boundary, and the cursor joins it to the rest byte-exactly.
 *  That is why a reader that continues from `cursor` never sees a gap or a
 *  duplicated character. */
export function artifactPreview(
  row: ArtifactRow,
  byteBudget: number,
): { text: string; cursor: string | null; bytes: number } {
  const body = storedBody(row);
  // Only the preview plus the four bytes a boundary decision needs. A preview of
  // a 100 MB artifact costs the preview.
  const head = body.slice(0, Math.min(body.byteSize, Math.max(1, Math.floor(byteBudget)) + 4));
  const end = utf8SafeEnd(head, 0, Math.max(1, Math.floor(byteBudget)));
  return {
    text: head.subarray(0, end).toString("utf8"),
    cursor: end >= body.byteSize ? null : encodeCursor(end),
    bytes: end,
  };
}

/** The block that accompanies every stored result — the model's handle on it.
 *
 *  Always present, even when the text is inlined: the artifact is the copy that
 *  outlives the transcript (a compact may summarize or drop this message), and
 *  a reader that has the id + sha256 can always get back to the bytes. */
export function artifactHandleBlock(handle: ArtifactHandle): string {
  const lines = [
    `<<<artifact id=${handle.id} kind=${handle.kind} bytes=${handle.byteSize} sha256=${handle.sha256} mediaType="${handle.mediaType}"`,
    `read: artifact_read(id="${handle.id}") — byte-paged and UTF-8 safe; every page reports endReached + nextCursor, and the sha256 above verifies the whole body.`,
    `search: artifact_search(id="${handle.id}", query="…") — hit byte offsets + snippets + a resumable cursor.`,
  ];
  return lines.join("\n");
}

/** Render a stored result as what the model or the chat actually carries:
 *  the handle, a line saying whether this is the whole thing or a preview, and
 *  the text itself. `previewCursor` is only meaningful when `inline` is false —
 *  it continues EXACTLY where the preview stops. */
export function renderArtifactResult(args: {
  handle: ArtifactHandle;
  text: string;
  inline: boolean;
  reason: string;
  previewBytes?: number;
  previewCursor?: string | null;
  /** Optional producer header (e.g. the peer_query "last N turns" line). */
  headerLines?: string[];
}): string {
  // `.split("\n")`, NOT `[...artifactHandleBlock(...)]`: spreading a STRING
  // yields its characters, so the handle block arrived here as one element per
  // character and the join below put every character of the header on its own
  // line. The model read
  //   < / < / < / a / r / t ...
  // where the artifact id should have been — a corruption of exactly the handle
  // the reader needs, in the one message that carries it.
  const lines: string[] = artifactHandleBlock(args.handle).split("\n");
  if (args.headerLines && args.headerLines.length > 0) lines.push("", ...args.headerLines);
  lines.push("");
  if (args.inline) {
    lines.push(`inlined: the whole ${args.handle.byteSize} bytes (${args.reason}).`, "--- begin artifact ---");
    lines.push(args.text, "--- end artifact ---");
  } else {
    const shown = byteSizeOfText(args.text);
    lines.push(
      // Deliberately NOT called "inlined": a preview is a page of the artifact,
      // and calling it inline is how a reader concludes it has the whole thing.
      `preview: the first ${shown} bytes of ${args.handle.byteSize} — ${args.reason}.`,
      "--- begin preview ---",
      args.text,
      "--- end preview ---",
      args.previewCursor
        ? `continue: artifact_read(id="${args.handle.id}", cursor="${args.previewCursor}") returns the next page from exactly this point.`
        : `read the rest: artifact_read(id="${args.handle.id}").`,
    );
  }
  lines.push(`artifact>>>`);
  return lines.join("\n");
}

/** The one-line form, for places that only need to point at the artifact. */
export function artifactReference(handle: ArtifactHandle, purpose: string): string {
  return (
    `${purpose}: artifact id=${handle.id} kind=${handle.kind} bytes=${handle.byteSize} sha256=${handle.sha256} ` +
    `— read it whole with artifact_read(id="${handle.id}").`
  );
}

export function renderArtifactError(err: ArtifactError): string {
  return JSON.stringify(err);
}

// ── the tool surface, described once ─────────────────────────────────────────
//
// The tool descriptions and the page rendering live here, next to the paging
// contract they describe, and are imported by all three runtime surfaces
// (Claude MCP, OpenAI NormalizedTool, Codex bridge). Three copies of "what does
// endReached mean" is how two runtimes end up promising different things.

export const ARTIFACT_READ_DESCRIPTION = [
  "Read a stored result artifact — a large peer / subagent / search result that was saved whole",
  "instead of being truncated. Byte-paged and UTF-8 safe: every page reports its byte range,",
  "endReached and a stable cursor, plus the sha256 of the whole body; concatenating the pages",
  "reproduces the original text exactly. Nothing here is a summary: this IS the stored content.",
  "",
  "Pass pageBytes to take more per call (default 16384, max 262144), and the nextCursor from the",
  "previous page to continue. Reading without a cursor starts at byte 0.",
  "",
  "Artifacts are kept PERMANENTLY — append-only, with no delete, no TTL and no purge — and an",
  "artifact deliberately outlives the agent that produced it, so a handle from an old transcript",
  "still reads back in full.",
].join("\n");

export const ARTIFACT_SEARCH_DESCRIPTION = [
  "Find where a string occurs inside a stored result artifact. Returns each hit's BYTE offset, a",
  "bounded snippet around it, and a cursor that resumes the scan after the last hit — call it again",
  "with that cursor to walk the whole body.",
  "",
  "Snippets are pointers, not content: they are cut to `snippetBytes` around the match. Use",
  "artifact_read with the hit's byteOffset as its cursor to read the original bytes.",
  "caseSensitive defaults to false; maxHits defaults to 20 (max 200).",
].join("\n");

export function renderArtifactRead(result: ArtifactReadResult): string {
  if (!result.ok) return JSON.stringify(result);
  const head =
    `artifact-read id=${result.id} kind=${result.kind} sha256=${result.sha256} totalBytes=${result.byteSize} ` +
    `byteFrom=${result.byteFrom} byteTo=${result.byteTo} endReached=${result.endReached} ` +
    `nextCursor=${result.nextCursor === null ? "none" : `"${result.nextCursor}"`} verified=sha256`;
  const tail = result.endReached
    ? `--- end of artifact (byte ${result.byteTo} of ${result.byteSize}) ---`
    : `--- end of page (bytes ${result.byteFrom}-${result.byteTo} of ${result.byteSize}; ` +
      `continue with artifact_read(id="${result.id}", cursor="${result.nextCursor}")) ---`;
  return [head, "--- begin page ---", result.text, tail].join("\n");
}

export function renderArtifactSearch(result: ArtifactSearchResult): string {
  if (!result.ok) return JSON.stringify(result);
  const head =
    `artifact-search id=${result.id} kind=${result.kind} sha256=${result.sha256} totalBytes=${result.byteSize} ` +
    `query="${result.query}" caseSensitive=${result.caseSensitive} hits=${result.hits.length} ` +
    `scannedFromByte=${result.scannedFromByte} scannedToByte=${result.scannedToByte} endReached=${result.endReached} ` +
    `nextCursor=${result.nextCursor === null ? "none" : `"${result.nextCursor}"`}`;
  const lines = [
    head,
    `snippets below are excerpts, not the artifact: read the exact bytes with artifact_read(id="${result.id}") ` +
      "(a hit's byteOffset can be used as the cursor).",
  ];
  if (result.hits.length === 0) {
    lines.push(
      result.endReached
        ? `no match for "${result.query}" anywhere in this artifact (all ${result.byteSize} bytes scanned).`
        : `no match for "${result.query}" in bytes ${result.scannedFromByte}-${result.scannedToByte} of ` +
          `${result.byteSize}; continue with artifact_search(id="${result.id}", query="${result.query}", ` +
          `cursor="${result.nextCursor}").`,
    );
    return lines.join("\n");
  }
  result.hits.forEach((hit, i) => {
    lines.push(
      `${i + 1}. byteOffset=${hit.byteOffset} (snippet bytes ${hit.snippetFrom}-${hit.snippetTo})`,
      `   ${hit.snippet.replace(/\n/g, " ⏎ ")}`,
    );
  });
  if (!result.endReached && result.nextCursor) {
    lines.push(
      `continue: artifact_search(id="${result.id}", query="${result.query}", cursor="${result.nextCursor}") ` +
        "resumes the scan after the last hit shown.",
    );
  }
  return lines.join("\n");
}
