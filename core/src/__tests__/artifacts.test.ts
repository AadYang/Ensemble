// The artifact store's contract, tested against the real SQLite-backed path.
//
// What this file is for: every promise the store makes is a BYTE-EXACTNESS
// promise — "concatenating the pages reproduces the original bytes", "a hit's
// byteOffset can be read directly", "a corrupt row is refused rather than
// served". Those are the claims that read as obviously true and then quietly
// stop being true when a boundary rule is relaxed or a hash check is skipped, so
// each one is asserted against a fixture built to break it: CJK, emoji, a ZWJ
// family sequence, CRLF, and a multi-byte character placed so that offset 16 384
// — the default page size — lands in the MIDDLE of it.
//
// The reader re-verifies the whole body's sha256 on every call (that is the
// point of it), so a full sweep at pageBytes=1 costs one whole-body hash per
// code point. That is why each page size is walked ONCE and the walk is reused,
// and why the single-byte sweeps carry an explicit long timeout: a timeout here
// would mean "the contract test did not finish", not "the store is broken".
//
// In-memory DB, like every other core test that touches a table. This must never
// read or write the user's real store.

import { beforeAll, describe, expect, it } from "vitest";
import type { ArtifactReadOk, ArtifactSearchHit } from "../artifacts.js";

// Read at import time by db.ts, so it has to be set before the dynamic imports
// below (the same order the other core tests use).
process.env.AGENTORCH_DB_PATH = ":memory:";

let a: typeof import("../artifacts.js");
let db: typeof import("../db.js");

/** The ZWJ family sequence: 4+3+4+3+4+3+4 = 25 bytes, six code points. Its first
 *  code point is 4 bytes wide, which is what makes it a useful straddler — a
 *  reader that cuts at the requested byte instead of at a boundary turns it into
 *  U+FFFD. */
const FAMILY_ZWJ = "👨👩👧👦";

/** Byte offset the ZWJ sequence starts at. 16 383 = one byte before the default
 *  page size, so the sequence's first code point covers byte 16 384 — exactly
 *  where a `pageBytes = 16384` page would want to cut. */
const STRADDLE_AT = 16_383;

/** Page sizes the contract is asserted at. The first four take a page per code
 *  point or two and are the expensive ones; the last three are the sizes a real
 *  caller uses. */
const PAGE_SIZES = [1, 2, 3, 7, 1_024, 16_384, 99_999] as const;

/** Ceiling on pages per walk. `utf8SafeEnd` is written to always advance; a
 *  regression that stopped it would loop here forever rather than fail, so the
 *  loop is bounded and running out of pages is itself an assertion. */
const MAX_PAGES = 200_000;
const MAX_SEARCH_CALLS = 10_000;

/** A single-byte sweep re-hashes the whole fixture once per code point (~66k
 *  full-body hashes), so it needs more than the default 5s. This is a budget,
 *  not a target: a healthy run is far below it. */
const FULL_SWEEP_TIMEOUT_MS = 300_000;

let FIXTURE: Buffer;
let FULL_TEXT: string;
let ARTIFACT_ID: string;
/** sha256 recomputed from the STORED row, not from the string that was written
 *  — that is what "agrees with a fresh recomputation" has to mean. */
let STORED_SHA256: string;

/** Build the adversarial fixture.
 *
 *  Deterministic by construction, because the interesting assertions are about
 *  specific offsets: `"a".repeat(16_383)` puts the ZWJ sequence at byte 16 383
 *  and therefore a continuation byte at 16 384, and the repeated 17-byte unit
 *  (CJK + ASCII + 4-byte emoji + CRLF) keeps every later boundary collision
 *  possible rather than theoretical. */
function makeFixture(): Buffer {
  const head = "a".repeat(STRADDLE_AT);
  const unit = "中文 abc 😀\r\n";
  const tail = [
    unit.repeat(2_500),
    "ARTIFACT_MARKER 2\r\n",
    unit.repeat(2_500),
    "ARTIFACT_MARKER 3\r\n",
  ].join("");
  return Buffer.from(
    [
      head,
      FAMILY_ZWJ,
      "\r\n",
      "中文测试文本，包含标点符号。",
      "😀🎉🚀",
      "\r\n",
      "ARTIFACT_MARKER 1\r\n",
      tail,
    ].join(""),
    "utf8",
  );
}

beforeAll(async () => {
  a = await import("../artifacts.js");
  db = await import("../db.js");
  FIXTURE = makeFixture();
  FULL_TEXT = FIXTURE.toString("utf8");
  const row = a.createArtifact({ agentId: "fixture-agent", kind: "peer-source", body: FULL_TEXT });
  ARTIFACT_ID = row.id;
  STORED_SHA256 = a.sha256OfText(a.getArtifact(ARTIFACT_ID)!.body);
});

interface PageWalk {
  pages: ArtifactReadOk[];
  /** The concatenation of every page's BYTES. */
  bytes: Buffer;
}

/** Read every page of `ARTIFACT_ID` at `pageBytes` and concatenate the bytes.
 *  `label` is carried into every failure message, so a broken pager names the
 *  page size that broke it instead of reporting "a Buffer differed". */
function walkPages(pageBytes: number, label: string): PageWalk {
  const pages: ArtifactReadOk[] = [];
  const chunks: Buffer[] = [];
  let cursor: string | null = null;
  let consumed = 0;
  let endReached = false;
  for (let i = 0; i < MAX_PAGES && !endReached; i++) {
    const page = a.readArtifactPage(ARTIFACT_ID, { cursor, pageBytes });
    if (!page.ok) throw new Error(`${label}: page ${i} failed (${page.code}): ${page.message}`);
    expect(page.byteFrom, `${label}: page ${i} does not start where page ${i - 1} ended`).toBe(consumed);
    expect(page.byteTo, `${label}: page ${i} is empty (byteFrom ${page.byteFrom} === byteTo ${page.byteTo})`).toBeGreaterThan(
      page.byteFrom,
    );
    pages.push(page);
    chunks.push(Buffer.from(page.text, "utf8"));
    consumed = page.byteTo;
    endReached = page.endReached;
    if (endReached) {
      expect(page.nextCursor, `${label}: the final page still offers a cursor`).toBeNull();
    } else {
      expect(page.nextCursor, `${label}: page ${i} is not the end but carries no cursor`).not.toBeNull();
      cursor = page.nextCursor;
    }
  }
  if (!endReached) throw new Error(`${label}: paging never reached endReached within ${MAX_PAGES} pages`);
  return { pages, bytes: Buffer.concat(chunks) };
}

/** Walks are cached: each one re-verifies the whole body once per page, so the
 *  pageBytes=1 sweep alone is ~66k full-body hashes. Walking a size twice would
 *  double a suite that is already the slowest thing here. */
const walkCache = new Map<number, PageWalk>();
function walk(pageBytes: number): PageWalk {
  let cached = walkCache.get(pageBytes);
  if (!cached) {
    cached = walkPages(pageBytes, `pageBytes=${pageBytes}`);
    walkCache.set(pageBytes, cached);
  }
  return cached;
}

/** The full per-page contract at one page size. Every failure names `label`. */
function expectByteExact(pageBytes: number): PageWalk {
  const label = `pageBytes=${pageBytes}`;
  const result = walk(pageBytes);

  // A single page would make everything below true for the wrong reason: the
  // boundary rule would never have been consulted.
  expect(result.pages.length, `${label}: the whole artifact came back in one page`).toBeGreaterThan(1);
  expect(
    result.bytes.length,
    `${label}: the pages total ${result.bytes.length} bytes, the artifact is ${FIXTURE.length}`,
  ).toBe(FIXTURE.length);
  expect(
    Buffer.compare(result.bytes, FIXTURE),
    `${label}: concatenating every page did NOT reproduce the artifact's bytes`,
  ).toBe(0);

  for (const page of result.pages) {
    const where = `bytes ${page.byteFrom}-${page.byteTo}`;
    // The page's own range has to be a whole number of code points, or the
    // concatenation above succeeding would be a coincidence of this fixture.
    expect(
      page.byteFrom === 0 || a.isUtf8Boundary(FIXTURE, page.byteFrom),
      `${label}: page starts inside a character at byte ${page.byteFrom}`,
    ).toBe(true);
    expect(
      a.isUtf8Boundary(FIXTURE, page.byteTo),
      `${label}: page ends inside a character at byte ${page.byteTo}`,
    ).toBe(true);
    expect(
      page.text.includes("�"),
      `${label}: page ${where} contains U+FFFD — a split code point was decoded and silently replaced`,
    ).toBe(false);
    expect(
      Buffer.byteLength(page.text, "utf8"),
      `${label}: page ${where} reports that range but carries ${Buffer.byteLength(page.text, "utf8")} bytes`,
    ).toBe(page.byteTo - page.byteFrom);
    expect(page.sha256, `${label}: page ${where} reports a sha256 that is not the stored body's`).toBe(STORED_SHA256);
    expect(page.byteSize, `${label}: page ${where} reports a different artifact size`).toBe(FIXTURE.length);
    expect(page.verified, `${label}: page ${where} is not marked as hash-verified`).toBe(true);
  }
  return result;
}

describe("byte-exact paging", () => {
  for (const pageBytes of PAGE_SIZES) {
    it(
      `pageBytes=${pageBytes}: every page is a whole number of characters and re-hashes to the stored body`,
      () => {
        const result = expectByteExact(pageBytes);
        if (pageBytes !== 1) return;
        // pageBytes=1 is the case a pagination loop cannot be allowed to get
        // wrong: one page must be exactly one code point, never zero bytes, and
        // the walk above must have reached endReached.
        for (const page of result.pages) {
          const width = page.byteTo - page.byteFrom;
          expect(width, `pageBytes=1: page ${page.byteFrom}-${page.byteTo} did not advance`).toBeGreaterThan(0);
          expect(
            width,
            `pageBytes=1: page ${page.byteFrom}-${page.byteTo} spans ${width} bytes, past a single code point`,
          ).toBeLessThanOrEqual(4);
        }
        const last = result.pages.at(-1)!;
        expect(last.endReached, `pageBytes=1: the last page (${last.byteFrom}-${last.byteTo}) is not the end`).toBe(true);
        expect(last.byteTo, `pageBytes=1: paging stopped at byte ${last.byteTo} of ${FIXTURE.length}`).toBe(FIXTURE.length);
      },
      FULL_SWEEP_TIMEOUT_MS,
    );
  }

  // The straddler is the whole reason the fixture is shaped the way it is: the
  // default page size wants to cut at 16 384, which is inside the ZWJ sequence's
  // first code point. A reader that honours the byte count emits U+FFFD here.
  it("snaps the default page to the character boundary it lands inside", () => {
    const page = a.readArtifactPage(ARTIFACT_ID, { pageBytes: a.ARTIFACT_DEFAULT_PAGE_BYTES });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(a.isUtf8Boundary(FIXTURE, a.ARTIFACT_DEFAULT_PAGE_BYTES)).toBe(false);
    expect(page.byteFrom).toBe(0);
    expect(page.byteTo).toBe(STRADDLE_AT);
    expect(page.text.includes("�")).toBe(false);
  });
});

describe("cursors", () => {
  it("refuses a cursor that points inside a multi-byte character instead of decoding it", () => {
    const midChar = a.encodeCursor(STRADDLE_AT + 1);
    // Sanity check on the fixture itself: if this byte stopped being a
    // continuation byte, the refusal below would be proving nothing.
    expect(a.isUtf8Boundary(FIXTURE, STRADDLE_AT + 1)).toBe(false);

    const read = a.readArtifactPage(ARTIFACT_ID, { cursor: midChar });
    expect(read.ok, "a cursor into the middle of a character was accepted").toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ARTIFACT_CURSOR_INVALID");
    expect(read.cursor).toBe(midChar);
    expect(read.message).toContain("middle of a UTF-8 character");
    // Not "here is the text anyway": the refusal carries no page.
    expect("text" in read).toBe(false);

    const searched = a.searchArtifact(ARTIFACT_ID, { query: "a", cursor: midChar });
    expect(searched.ok, "search accepted a cursor into the middle of a character").toBe(false);
    if (searched.ok) return;
    expect(searched.code).toBe("ARTIFACT_CURSOR_INVALID");

    // The boundary immediately before it IS usable, so the refusal is about the
    // byte and not about the cursor format.
    const atBoundary = a.readArtifactPage(ARTIFACT_ID, { cursor: a.encodeCursor(STRADDLE_AT) });
    expect(atBoundary.ok).toBe(true);
    if (atBoundary.ok) {
      expect(atBoundary.byteFrom).toBe(STRADDLE_AT);
      expect(atBoundary.text.startsWith(FAMILY_ZWJ)).toBe(true);
    }
  });

  it("refuses a cursor that is not an offset, and one past the end of this artifact", () => {
    const garbage = [
      "not-a-cursor",
      Buffer.from("{\"o\":\"twelve\"}", "utf8").toString("base64url"),
      Buffer.from("[1,2,3]", "utf8").toString("base64url"),
      // encodeCursor({o:-1}) is legal base64url of a legal JSON object; the
      // offset itself is what is refused.
      a.encodeCursor(-1),
      a.encodeCursor(1.5),
      a.encodeCursor(FIXTURE.length + 1),
    ];
    for (const cursor of garbage) {
      const read = a.readArtifactPage(ARTIFACT_ID, { cursor });
      expect(read.ok, `cursor "${cursor}" was accepted`).toBe(false);
      if (read.ok) continue;
      expect(read.code, `cursor "${cursor}" failed with ${read.code} instead of ARTIFACT_CURSOR_INVALID`).toBe(
        "ARTIFACT_CURSOR_INVALID",
      );
    }
    // A cursor from another artifact is only ever an offset, so an offset that
    // is past THIS artifact's end is the refusal — never "read from there".
    const pastEnd = a.readArtifactPage(ARTIFACT_ID, { cursor: a.encodeCursor(FIXTURE.length + 1) });
    expect(pastEnd.ok).toBe(false);
    if (!pastEnd.ok) expect(pastEnd.message).toContain("past the end");
  });
});

describe("page size", () => {
  it("falls back to the documented default for a page size that cannot be one", () => {
    const reference = a.readArtifactPage(ARTIFACT_ID, {});
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(reference.byteTo - reference.byteFrom).toBeLessThanOrEqual(a.ARTIFACT_DEFAULT_PAGE_BYTES);
    for (const pageBytes of [0, -1, -16_384, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const page = a.readArtifactPage(ARTIFACT_ID, { pageBytes });
      expect(page.ok, `pageBytes=${String(pageBytes)} was refused instead of defaulted`).toBe(true);
      if (!page.ok) continue;
      expect(
        { from: page.byteFrom, to: page.byteTo, next: page.nextCursor },
        `pageBytes=${String(pageBytes)} did not fall back to the default page`,
      ).toEqual({ from: reference.byteFrom, to: reference.byteTo, next: reference.nextCursor });
    }
  });

  it("clamps an absurd page size to ARTIFACT_MAX_PAGE_BYTES instead of refusing or allocating it", () => {
    // The fixture fits inside the cap, so "clamped" is observable only against
    // something larger than the cap; a body past it is the honest witness.
    const oversized = a.createArtifact({
      agentId: "fixture-agent",
      kind: "subagent-final",
      body: "b".repeat(a.ARTIFACT_MAX_PAGE_BYTES + 40_000),
    });
    const page = a.readArtifactPage(oversized.id, { pageBytes: 1_000_000_000 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.byteFrom).toBe(0);
    expect(page.byteTo).toBe(a.ARTIFACT_MAX_PAGE_BYTES);
    expect(page.endReached).toBe(false);
    expect(page.nextCursor).not.toBeNull();

    // And on an artifact that fits, an absurd size is simply the whole body.
    const whole = a.readArtifactPage(ARTIFACT_ID, { pageBytes: 1_000_000_000 });
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(whole.byteTo).toBe(FIXTURE.length);
    expect(whole.text).toBe(FULL_TEXT);
    expect(whole.endReached).toBe(true);
    expect(whole.nextCursor).toBeNull();
  });
});

/** Walk a search to its end, asserting the scan only ever moves forward. */
function walkSearch(query: string, maxHits: number): ArtifactSearchHit[] {
  const hits: ArtifactSearchHit[] = [];
  let cursor: string | null = null;
  let scannedTo = 0;
  for (let call = 0; call < MAX_SEARCH_CALLS; call++) {
    const result = a.searchArtifact(ARTIFACT_ID, { query, cursor, maxHits });
    if (!result.ok) throw new Error(`search call ${call} for "${query}" failed (${result.code}): ${result.message}`);
    expect(result.scannedFromByte, `search call ${call} did not resume at the previous cursor`).toBe(
      cursor === null ? 0 : scannedTo,
    );
    for (const hit of result.hits) {
      expect(hit.byteOffset, `search call ${call} returned a hit outside the scanned range`).toBeGreaterThanOrEqual(
        result.scannedFromByte,
      );
      expect(hit.byteOffset, `search call ${call} returned a hit past scannedToByte`).toBeLessThanOrEqual(
        result.scannedToByte,
      );
      hits.push(hit);
    }
    if (result.endReached) {
      expect(result.nextCursor, "the final search page still offers a cursor").toBeNull();
      expect(result.scannedToByte, "endReached did not cover the whole artifact").toBe(FIXTURE.length);
      return hits;
    }
    expect(
      result.scannedToByte,
      `search call ${call} did not move past the previous scan (${scannedTo})`,
    ).toBeGreaterThan(scannedTo);
    expect(result.nextCursor, `search call ${call} is not the end but carries no cursor`).not.toBeNull();
    expect(a.decodeCursor(result.nextCursor!), `the cursor from call ${call} is not the byte it reported`).toBe(
      result.scannedToByte,
    );
    scannedTo = result.scannedToByte;
    cursor = result.nextCursor;
  }
  throw new Error(`search for "${query}" still had not reached endReached after ${MAX_SEARCH_CALLS} calls`);
}

/** Independent occurrence count: a plain byte scan of the fixture, so the
 *  search's own idea of "every hit" is checked against something that is not the
 *  search. */
function countOccurrences(needle: string): number {
  const bytes = Buffer.from(needle, "utf8");
  let at = 0;
  let found = 0;
  while ((at = FIXTURE.indexOf(bytes, at)) !== -1) {
    found++;
    at += bytes.length;
  }
  return found;
}

describe("search", () => {
  it("walks a scan that takes many calls, and the cursor only ever moves forward", () => {
    // A query with more hits than one call returns is the only way the resume
    // path is exercised at all: the cursor is a byte offset, so a scan that
    // re-read a byte or skipped one would show up as a missing or duplicated
    // hit here, not as an error.
    const expected = countOccurrences("中文");
    expect(expected, "the fixture should repeat 中文 in every unit").toBeGreaterThan(1_000);
    const hits = walkSearch("中文", 50);
    expect(hits.length, "the cursor walk did not surface every occurrence").toBe(expected);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.byteOffset, `hit ${i} is not after hit ${i - 1}`).toBeGreaterThan(hits[i - 1]!.byteOffset);
    }
  });

  it("finds every occurrence of a literal, and every hit offset reads back at that exact byte", () => {
    const hits = walkSearch("ARTIFACT_MARKER", 20);
    expect(hits.length, "the fixture carries exactly three ARTIFACT_MARKER lines").toBe(3);
    for (const hit of hits) {
      // This is the promise the tool description makes: a hit's byteOffset can
      // be handed straight to artifact_read.
      const page = a.readArtifactPage(ARTIFACT_ID, { cursor: a.encodeCursor(hit.byteOffset) });
      expect(page.ok, `hit byteOffset ${hit.byteOffset} is not a readable cursor`).toBe(true);
      if (!page.ok) continue;
      expect(page.byteFrom).toBe(hit.byteOffset);
      expect(page.text.startsWith("ARTIFACT_MARKER"), `hit offset ${hit.byteOffset} does not start at the match`).toBe(
        true,
      );
      expect(
        Buffer.compare(Buffer.from(page.text, "utf8"), FIXTURE.subarray(hit.byteOffset, page.byteTo)),
        `the page at byte ${hit.byteOffset} is not the artifact's bytes`,
      ).toBe(0);
    }
    // A snippet is a pointer, not content: it is cut around the match and has to
    // contain it.
    for (const hit of hits) expect(hit.snippet).toContain("ARTIFACT_MARKER");
  });

  it("reports a multi-byte match at its byte offset, ZWJ sequence included", () => {
    for (const needle of ["标点符号", "🚀", FAMILY_ZWJ]) {
      const hits = walkSearch(needle, 20);
      expect(hits.length, `"${needle}" should occur exactly once in the fixture`).toBe(1);
      expect(hits[0]!.byteOffset, `"${needle}" is reported at the wrong byte`).toBe(
        FIXTURE.indexOf(Buffer.from(needle, "utf8")),
      );
      expect(hits[0]!.snippet).toContain(needle);
    }
  });

  it("returns no hits for a literal that is absent, and still reaches the end", () => {
    const hits = walkSearch("NOT_IN_THIS_ARTIFACT", 20);
    expect(hits).toEqual([]);
  });
});

describe("the store's failures are structured and carry no content", () => {
  it("reports an unknown id as ARTIFACT_NOT_FOUND", () => {
    const read = a.readArtifactPage("00000000-0000-4000-8000-000000000000");
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ARTIFACT_NOT_FOUND");
    expect("text" in read).toBe(false);
    const searched = a.searchArtifact("00000000-0000-4000-8000-000000000000", { query: "anything" });
    expect(searched.ok).toBe(false);
    if (searched.ok) return;
    expect(searched.code).toBe("ARTIFACT_NOT_FOUND");
  });

  it("refuses a media type it cannot decode as text rather than guessing", () => {
    const binary = a.createArtifact({
      agentId: "fixture-agent",
      kind: "subagent-final",
      mediaType: "image/png",
      body: "not really a png",
    });
    const read = a.readArtifactPage(binary.id);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ARTIFACT_UNREADABLE");
    expect(read.mediaType).toBe("image/png");
    expect("text" in read).toBe(false);
  });

  it("refuses an empty search query instead of matching everything", () => {
    const searched = a.searchArtifact(ARTIFACT_ID, { query: "" });
    expect(searched.ok).toBe(false);
    if (searched.ok) return;
    expect(searched.code).toBe("ARTIFACT_QUERY_EMPTY");
  });
});

describe("an artifact outlives its agent, and is never editable", () => {
  it("keeps the artifact when the agent that produced it is deleted", () => {
    // Deliberately no foreign key from ResultArtifact to Agent: the record of what an
    // agent produced must not disappear with the agent, so this is a design
    // assertion and not an accident of the schema.
    const agentId = "agent-that-will-be-deleted";
    db.sqliteDb.prepare("INSERT INTO Agent (id, name) VALUES (?, ?)").run(agentId, "doomed");
    const row = a.createArtifact({ agentId, kind: "subagent-final", body: "原文\r\nsurvives 😀" });
    db.sqliteDb.prepare("DELETE FROM Agent WHERE id = ?").run(agentId);
    expect(a.getArtifact(row.id)?.sha256, "the artifact did not survive its agent").toBe(row.sha256);
  });

  it("refuses an UPDATE and a DELETE through the store's own triggers", () => {
    const row = a.createArtifact({ agentId: "fixture-agent", kind: "peer-history", body: "immutable" });
    expect(() => db.sqliteDb.prepare("UPDATE ResultArtifact SET body = ? WHERE id = ?").run("rewritten", row.id)).toThrow(
      /immutable/i,
    );
    expect(() => db.sqliteDb.prepare("DELETE FROM ResultArtifact WHERE id = ?").run(row.id)).toThrow(/append-only/i);
    expect(a.getArtifact(row.id)?.body).toBe("immutable");
  });

  it("refuses a tampered row and leaks none of the text that is now stored in it", () => {
    const row = a.createArtifact({
      agentId: "fixture-agent",
      kind: "conversation-search",
      body: "ORIGINAL\r\n原文\r\n😀\r\n",
    });
    const tampered = "TAMPERED_PAYLOAD_SECRET";
    // The append-only trigger is the subject of the test above; corruption is
    // what this one is about (a restore from a partial backup, a bad page on
    // disk), so the trigger is lifted for exactly this statement and put back.
    db.sqliteDb.exec("DROP TRIGGER IF EXISTS result_artifact_immutable_update");
    try {
      db.sqliteDb.prepare("UPDATE ResultArtifact SET body = ? WHERE id = ?").run(tampered, row.id);
    } finally {
      db.sqliteDb.exec(
        `CREATE TRIGGER IF NOT EXISTS result_artifact_immutable_update BEFORE UPDATE ON ResultArtifact
         BEGIN
           SELECT RAISE(ABORT, 'Artifact rows are immutable: write a new artifact instead of rewriting one');
         END`,
      );
    }

    const read = a.readArtifactPage(row.id, { cursor: a.encodeCursor(0) });
    expect(read.ok, "a tampered artifact was served as if it were verified").toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ARTIFACT_HASH_MISMATCH");
    expect(read.sha256, "the refusal does not name the hash the row claims").toBe(row.sha256);
    expect(read.recomputedSha256, "the refusal does not name the hash the body actually has").toBe(
      a.sha256OfText(tampered),
    );

    const searched = a.searchArtifact(row.id, { query: "原文" });
    expect(searched.ok, "search served a tampered artifact").toBe(false);
    if (searched.ok) return;
    expect(searched.code).toBe("ARTIFACT_HASH_MISMATCH");

    // "Here is the text, and by the way the hash does not match" is the failure
    // mode the hash check exists to prevent, so the tampered bytes must not
    // appear in either refusal.
    for (const [what, result] of [
      ["read", read],
      ["search", searched],
    ] as const) {
      const serialized = JSON.stringify(result);
      expect(serialized.includes("TAMPERED"), `the ${what} refusal echoed the tampered body`).toBe(false);
      expect(serialized.includes("�"), `the ${what} refusal contains U+FFFD`).toBe(false);
    }
  });
});
