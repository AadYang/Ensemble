// The recoverable half of /compact.
//
// Compaction used to DELETE the messages it summarized. That is an irreversible
// edit to the user's own record, and it was made on the strength of a model
// call: if the summary was thin, the original was simply gone. From here on the
// originals move into MessageArchive inside the same transaction that writes
// the summary and removes the active rows, so a compact is either complete or
// it did not happen at all.
//
// Why a table of its own rather than a `deletedAt` column on Message: a soft
// delete is only correct if EVERY existing reader is taught to filter for it.
// The readers here are runtime history, /status counts, conversation search,
// the cloud mirror and the message HTTP route — a missed filter would silently
// resurrect archived rows into a live prompt. A separate table cannot be read
// by accident.
//
// The archive is self-describing on purpose: an agent + generation, plus a
// contentHash per record, so the summary's `sourceHash` can be RECOMPUTED from
// the archived originals (see sourceHashOf) instead of being trusted. That is
// the same rule `capability/marks.ts` follows for artifacts: a claim about what
// was read has to be checkable against the thing itself.

import { createHash } from "node:crypto";
import { sqliteDb, transaction } from "./db.js";

/** Bumped when the summary payload's shape changes. Stored with every compact
 *  so a reader can tell which contract produced the text it is holding. */
export const SUMMARY_VERSION = 1;

/** The one row shape this module moves around: a Message as it was ACTIVE. */
export interface ArchivedMessage {
  originalMessageId: number;
  agentId: string;
  generation: number;
  originalSeq: number;
  type: string;
  payload: unknown;
  /** Unix SECONDS, as stored. Kept as the raw column value so the hash is over
   *  the bytes that were written, not over a Date round-trip. */
  createdAt: number;
  /** Unix seconds. */
  archivedAt: number;
  contentHash: string;
}

/** A row read back out of MessageArchive. */
export interface ArchivedRecord {
  originalMessageId: number;
  generation: number;
  originalSeq: number;
  type: string;
  payload: unknown;
  createdAt: number;
  archivedAt: number;
  contentHash: string;
}

/** The subset of a Message row the archive needs. */
export interface ArchivableRow {
  id: number;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date | number;
}

/** Hash of ONE archived record's full content.
 *
 *  Field by field, including the boundaries (which message, which seq) — so two
 *  rows with identical payloads at different positions still hash differently,
 *  and a restored record can be proven byte-identical to what was archived. */
export function contentHashOf(record: {
  originalMessageId: number;
  originalSeq: number;
  type: string;
  payload: unknown;
  createdAt: number;
}): string {
  const canonical = JSON.stringify([
    record.originalMessageId,
    record.originalSeq,
    record.type,
    record.payload,
    record.createdAt,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** The source hash of a generation's ordered originals.
 *
 *  Recomputed — never remembered — from the archive rows, which is what makes
 *  the summary's claim ("this covers exactly these messages") falsifiable. */
export function sourceHashOf(records: Array<{ originalSeq: number; contentHash: string }>): string {
  const ordered = [...records].sort((a, b) => a.originalSeq - b.originalSeq);
  const canonical = JSON.stringify(ordered.map((r) => [r.originalSeq, r.contentHash]));
  return createHash("sha256").update(canonical).digest("hex");
}

/** The next compact generation for an agent. Generations are monotonic per
 *  agent and never reused, so a retried compact lands on the same number and
 *  the same rows — which is what makes the retry idempotent. */
export function nextGeneration(agentId: string): number {
  const row = sqliteDb
    .prepare("SELECT MAX(generation) AS g FROM MessageArchive WHERE agentId = ?")
    .get(agentId) as { g: number | null } | undefined;
  return (row?.g ?? 0) + 1;
}

function secondsOf(value: Date | number): number {
  return value instanceof Date ? Math.floor(value.getTime() / 1000) : Math.floor(value);
}

/** Move `rows` into the archive as `generation`, verbatim.
 *
 *  INSERT OR IGNORE against the (agentId, generation, originalSeq) unique index
 *  is the idempotence: a retry that re-archives the same generation inserts
 *  nothing, and the returned records are read back from the table, so the
 *  caller sees what is actually stored rather than what it hoped to store.
 *  Must be called inside `transaction()`. */
export function archiveRows(
  agentId: string,
  generation: number,
  rows: ArchivableRow[],
  archivedAtSeconds: number,
): ArchivedRecord[] {
  const insert = sqliteDb.prepare(
    `INSERT OR IGNORE INTO MessageArchive
       (originalMessageId, agentId, generation, originalSeq, type, payload, createdAt, archivedAt, contentHash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const createdAt = secondsOf(row.createdAt);
    const hash = contentHashOf({
      originalMessageId: row.id,
      originalSeq: row.seq,
      type: row.type,
      payload: row.payload,
      createdAt,
    });
    insert.run(
      row.id,
      agentId,
      generation,
      row.seq,
      row.type,
      JSON.stringify(row.payload ?? null),
      createdAt,
      archivedAtSeconds,
      hash,
    );
  }
  return readGeneration(agentId, generation);
}

function mapArchiveRow(r: Record<string, unknown>): ArchivedRecord {
  let payload: unknown = null;
  try {
    payload = JSON.parse(String(r.payload));
  } catch {
    payload = null;
  }
  return {
    originalMessageId: Number(r.originalMessageId),
    generation: Number(r.generation),
    originalSeq: Number(r.originalSeq),
    type: String(r.type),
    payload,
    createdAt: Number(r.createdAt),
    archivedAt: Number(r.archivedAt),
    contentHash: String(r.contentHash),
  };
}

/** Every archived record of a generation, in original order. */
export function readGeneration(agentId: string, generation: number): ArchivedRecord[] {
  const rows = sqliteDb
    .prepare(
      `SELECT originalMessageId, generation, originalSeq, type, payload, createdAt, archivedAt, contentHash
         FROM MessageArchive WHERE agentId = ? AND generation = ? ORDER BY originalSeq ASC`,
    )
    .all(agentId, generation) as Record<string, unknown>[];
  return rows.map(mapArchiveRow);
}

/** A seq range inside one generation — both ends inclusive. */
/** The archived records of one generation within a seq range. An omitted bound
 *  means "from the start" / "to the end" of that generation — a half-specified
 *  range is still a range, not a different query. */
export function readGenerationRange(
  agentId: string,
  generation: number,
  fromSeq?: number | null,
  toSeq?: number | null,
): ArchivedRecord[] {
  const clauses = ["agentId = ?", "generation = ?"];
  const params: Array<string | number> = [agentId, generation];
  if (fromSeq !== undefined && fromSeq !== null) {
    clauses.push("originalSeq >= ?");
    params.push(fromSeq);
  }
  if (toSeq !== undefined && toSeq !== null) {
    clauses.push("originalSeq <= ?");
    params.push(toSeq);
  }
  const rows = sqliteDb
    .prepare(
      `SELECT originalMessageId, generation, originalSeq, type, payload, createdAt, archivedAt, contentHash
         FROM MessageArchive WHERE ${clauses.join(" AND ")}
         ORDER BY originalSeq ASC`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(mapArchiveRow);
}

export interface GenerationInfo {
  generation: number;
  count: number;
  fromSeq: number;
  toSeq: number;
  archivedAt: number;
  sourceHash: string;
}

/** Which generations exist for an agent, with the range each one covers and the
 *  source hash recomputed from its own rows. */
export function listGenerations(agentId: string): GenerationInfo[] {
  const rows = sqliteDb
    .prepare(
      `SELECT generation, COUNT(*) AS count, MIN(originalSeq) AS fromSeq, MAX(originalSeq) AS toSeq,
              MAX(archivedAt) AS archivedAt
         FROM MessageArchive WHERE agentId = ? GROUP BY generation ORDER BY generation ASC`,
    )
    .all(agentId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    generation: Number(r.generation),
    count: Number(r.count),
    fromSeq: Number(r.fromSeq),
    toSeq: Number(r.toSeq),
    archivedAt: Number(r.archivedAt),
    sourceHash: sourceHashOf(readGeneration(agentId, Number(r.generation))),
  }));
}

function textOfBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const parts: string[] = [];
  for (const raw of content) {
    const block = raw as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      name?: unknown;
      input?: unknown;
      content?: unknown;
      tool_use_id?: unknown;
    };
    if (!block || typeof block !== "object") {
      parts.push(String(raw));
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "tool_use") {
      parts.push(`[tool_use ${String(block.name)}] ${JSON.stringify(block.input ?? null)}`);
      continue;
    }
    if (block.type === "tool_result") {
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "?";
      parts.push(`[tool_result ${id}] ${textOfBlocks(block.content)}`);
      continue;
    }
    if (block.type === "thinking" || block.type === "reasoning") {
      const body =
        typeof block.thinking === "string"
          ? block.thinking
          : typeof block.text === "string"
            ? block.text
            : "";
      if (body) parts.push(`[thinking] ${body}`);
      continue;
    }
    parts.push(JSON.stringify(raw));
  }
  return parts.join("\n");
}

/** The readable body of ONE message row, for the summarizer.
 *
 *  The compact prompt is built from this, and unlike `messageRowText` it renders
 *  tool calls and their results in full: a transcript summarized without them
 *  drops precisely the concrete facts (paths, commands, error codes) a summary
 *  is supposed to preserve. Returns "" for a row that carries no readable
 *  content at all, which is a real answer — such a row still has a position and
 *  a hash, and the compact covers it either way. */
export function summarizerTextOf(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as { message?: { content?: unknown }; text?: unknown };
  if (p.message) return textOfBlocks(p.message.content);
  // A system notice (`text`) or an interrupted turn: the text is the content.
  if (typeof p.text === "string") return p.text;
  return "";
}

/** The verbatim readable transcript of archived records.
 *
 *  Nothing is elided: tool_use inputs and tool_result bodies are rendered in
 *  full, which is exactly what the summarizer used to fold into one sentence and
 *  what a restore has to be able to show. */
export function renderArchivedTranscript(records: ArchivedRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    const payload = record.payload as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
    if (payload && typeof payload === "object" && payload.message) {
      const role = typeof payload.message.role === "string" ? payload.message.role : record.type;
      lines.push(`### ${role} (seq ${record.originalSeq})`);
      lines.push(textOfBlocks(payload.message.content));
      lines.push("");
      continue;
    }
    const body = JSON.stringify(record.payload ?? null);
    lines.push(`### ${record.type} (seq ${record.originalSeq})`);
    lines.push(textOfBlocks(payload && typeof payload === "object" ? (payload as { text?: unknown }).text : body));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** The outcome of a restore. A discriminated union rather than a nullable
 *  object: "there is nothing to restore", "it is already live" and "it was
 *  restored" are three different facts, and a caller that cannot tell them
 *  apart will report a no-op as a restore. */
export type RestoreOutcome =
  | {
      status: "restored";
      generation: number;
      restored: number;
      fromSeq: number;
      toSeq: number;
      /** Seq of the compact summary this restore removed. */
      summarySeq: number;
    }
  | {
      status: "already-restored";
      generation: number;
      restored: number;
      fromSeq: number;
      toSeq: number;
      reason: string;
    }
  | {
      status: "no-active-summary";
      generation: number;
      restored: number;
      fromSeq: number;
      toSeq: number;
      reason: string;
    };

/** The active compact summary row for one generation, if it is still there.
 *
 *  A restore is defined against the summary: the summary IS the placeholder that
 *  took the seqs the originals used to occupy, so removing it in the same
 *  transaction as re-inserting the originals is what makes the operation
 *  in-place instead of additive. */
function activeSummarySeq(agentId: string, generation: number): number | null {
  const rows = sqliteDb
    .prepare("SELECT seq, payload FROM Message WHERE agentId = ? AND type = 'system'")
    .all(agentId) as Array<{ seq: number; payload: string }>;
  for (const row of rows) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const p = payload as { subtype?: unknown; generation?: unknown };
    if (p && p.subtype === "compact" && Number(p.generation) === generation) return Number(row.seq);
  }
  return null;
}

/** Put an archived generation back into the agent's active history.
 *
 *  A REAL restore, in place: the generation's active compact summary is removed
 *  and the originals are re-inserted at their ORIGINAL seqs — the positions the
 *  compact freed — inside one transaction. Messages that came after the summary
 *  keep their (higher) seqs and are therefore still after the restored block, so
 *  the conversation reads in the order it happened and no later row is
 *  renumbered.
 *
 *  Idempotent by evidence, not by hope: a second call sees every original seq
 *  already occupied by a row byte-identical to the archived record and returns
 *  `already-restored` without inserting anything. Appending a second copy would
 *  be the opposite of restoring, and a caller could not tell the difference. */
export function restoreGenerationToActive(
  agentId: string,
  generation: number,
): RestoreOutcome | null {
  const records = readGeneration(agentId, generation);
  if (records.length === 0) return null;
  const fromSeq = records[0]!.originalSeq;
  const toSeq = records[records.length - 1]!.originalSeq;
  return transaction(() => {
    // The generation's own summary is the placeholder this restore replaces, so
    // it is NOT occupancy: counting it would make the record whose originalSeq it
    // took look like a foreign message and refuse every legitimate restore.
    const summarySeq = activeSummarySeq(agentId, generation);
    const live = sqliteDb
      .prepare("SELECT seq, type, payload, createdAt FROM Message WHERE agentId = ? AND seq >= ? AND seq <= ?")
      .all(agentId, fromSeq, toSeq) as Array<{ seq: number; type: string; payload: string; createdAt: number }>;
    const liveBySeq = new Map(
      live.filter((r) => Number(r.seq) !== summarySeq).map((r) => [Number(r.seq), r]),
    );
    const alreadyLive = records.every((record) => {
      const row = liveBySeq.get(record.originalSeq);
      if (!row) return false;
      return (
        row.type === record.type &&
        row.payload === JSON.stringify(record.payload ?? null) &&
        secondsOf(row.createdAt) === record.createdAt
      );
    });
    if (alreadyLive) {
      return {
        status: "already-restored" as const,
        generation,
        restored: records.length,
        fromSeq,
        toSeq,
        reason:
          `generation ${generation} is already live: all ${records.length} record(s) occupy their original ` +
          `seqs (${fromSeq}–${toSeq}) with identical payloads. Nothing was inserted.`,
      };
    }

    if (summarySeq === null) {
      return {
        status: "no-active-summary" as const,
        generation,
        restored: records.length,
        fromSeq,
        toSeq,
        reason:
          `no active compact summary for generation ${generation} exists, so there is no placeholder to replace: ` +
          "a later compact owns those seqs, or the generation was already restored and compacted again. " +
          "Read it with the archive route; it is not re-appended to the live history.",
      };
    }

    const insert = sqliteDb.prepare(
      "INSERT INTO Message (agentId, seq, type, payload, createdAt) VALUES (?, ?, ?, ?, ?)",
    );
    const deleteSummary = sqliteDb.prepare("DELETE FROM Message WHERE agentId = ? AND seq = ?");
    // The summary goes first: it occupies exactly the highest seq in the range,
    // so removing it frees the one position a record might otherwise collide
    // with. Everything else in the range was freed by the compact itself.
    deleteSummary.run(agentId, summarySeq);
    for (const record of records) {
      if (liveBySeq.has(record.originalSeq)) {
        throw new Error(
          `restore refused: seq ${record.originalSeq} is occupied by a live message that is not this generation's ` +
            `record (generation ${generation}); the archive is intact and nothing was changed`,
        );
      }
      insert.run(
        agentId,
        record.originalSeq,
        record.type,
        JSON.stringify(record.payload ?? null),
        record.createdAt,
      );
    }
    return { status: "restored" as const, generation, restored: records.length, fromSeq, toSeq, summarySeq };
  });
}
