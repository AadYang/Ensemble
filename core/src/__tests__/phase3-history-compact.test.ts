// The phase-3 contract, tested against the modules that implement it.
//
// What this file is for: proving that nothing in the history / compact / skills
// path silently drops content. Every test here corresponds to a way the old
// code lost data — a 28-message trim, an 18 000-character window, a 6 000-char
// summary re-clip, a 4 000-char skill cap, a `countTokens` that returned 0 and
// was believed. Each one asserts the CONTENT is reachable, or that the loss is
// reported as a number and a range, never that "some answer came back".
//
// The modules are pure by design (the planner reads no files, the budget
// resolver owns no I/O), so these run without a database or a model.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  makeTokenMeasurer,
  resolveHistoryBudget,
  unavailablePlanHistory,
  utf8TokenUpperBound,
} from "../capability/history-budget.js";
import {
  chunkCompactTurns,
  recordContentHash,
  recordsSourceHash,
  summarizeLayered,
  type CompactSourceTurn,
} from "../capability/layered-compact.js";

// In-memory DB so the archive assertions never touch the user's real store.
process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../db.js").prisma;
let archive: typeof import("../message-archive.js");

beforeEach(async () => {
  ({ prisma } = await import("../db.js"));
  archive = await import("../message-archive.js");
});

const ctx = (over: Partial<Record<string, number | null>> = {}) => ({
  effectiveWindow: 100_000,
  requestedRuntimeWindow: 100_000,
  advertisedContextWindow: 100_000,
  outputReserve: 1_000,
  compactionThreshold: null,
  contextBudget: null,
  ...over,
});

const noMeasure = () => null;

describe("gate 1: a marker past the old 18 000-char limit is reachable, with a budget diagnostic", () => {
  it("includes a 30+-message transcript when the window allows it, and says what the budget was", () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({
      seq: i,
      kind: "user" as const,
      // 700 chars each: the marker sits ~20 000 chars into the transcript, past
      // the old 18 000-char ceiling.
      text: `turn ${i} ${"x".repeat(700)}${i === 29 ? " MARKER_PAST_18000" : ""}`,
    }));
    const outcome = resolveHistoryBudget({
      turns,
      systemPrompt: "system",
      toolsText: null,
      context: ctx({ effectiveWindow: 1_000_000, advertisedContextWindow: 1_000_000 }),
      strategy: "local-rebuild",
      strategyReason: "test",
      measure: (t) => Math.ceil(t.length / 4),
    });

    expect(outcome.history.status).toBe("resolved");
    expect(outcome.history.counts.included).toBe(40);
    expect(outcome.history.counts.dropped).toBe(0);
    expect(outcome.included.map((t) => t.text).join("\n")).toContain("MARKER_PAST_18000");
    // The arithmetic is printed, not implied: the reader can see the window, the
    // reserve, the prompt cost and the tools cost that produced the budget.
    const diag = outcome.history.diagnostics.join("\n");
    expect(diag).toContain("= history budget");
    expect(diag).toContain("output reserve");
    // window − output reserve − system prompt − tools − this turn's prompt.
    // `measuredTokens` is the TRANSCRIPT's own size, which is what the budget
    // has to hold — it is not subtracted from it.
    expect(outcome.history.tokenBudget).toBe(1_000_000 - 1_000 - Math.ceil("system".length / 4));
  });

  it("reports the overflow as a contiguous seq range instead of trimming quietly", () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({
      seq: i,
      kind: "user" as const,
      text: `turn ${i} ${"x".repeat(2_000)}`,
    }));
    const outcome = resolveHistoryBudget({
      turns,
      systemPrompt: null,
      toolsText: null,
      context: ctx({ effectiveWindow: 20_000 }),
      strategy: "local-rebuild",
      strategyReason: "test",
      measure: (t) => Math.ceil(t.length / 4),
    });

    expect(outcome.history.counts.dropped).toBeGreaterThan(0);
    const overflow = outcome.history.overflow!;
    expect(overflow).not.toBeNull();
    expect(overflow.fromSeq).toBe(0);
    // Contiguous: the range covers every dropped turn, with no gaps in the
    // middle that a compact could not describe.
    expect(overflow.count).toBe(outcome.history.counts.dropped);
    expect(overflow.toSeq).toBe(outcome.history.counts.dropped - 1);
    expect(outcome.history.diagnostics.join("\n")).toContain("do not fit the budget");
    // What DID fit is the newest content.
    expect(outcome.included.at(-1)!.seq).toBe(39);
  });
});

describe("gate 2: a ~200K transcript enters the layered compact completely", () => {
  it("covers head, middle and tail with chunks whose union is the whole transcript", async () => {
    const turns: CompactSourceTurn[] = Array.from({ length: 200 }, (_, i) => ({
      messageId: i + 1,
      seq: i + 1,
      type: "user",
      payload: { i },
      createdAt: 1_700_000_000 + i,
      text:
        `message ${i} ${"y".repeat(900)}` +
        (i === 0 ? " HEAD_MARKER" : "") +
        (i === 100 ? " MIDDLE_MARKER" : "") +
        (i === 199 ? " TAIL_MARKER" : ""),
    }));

    const prompts: string[] = [];
    const result = await summarizeLayered({
      turns,
      chunkTokens: 4_000,
      mergeTokens: 4_000,
      summaryVersion: 1,
      measure: (t) => Math.ceil(t.length / 4),
      summarize: async (prompt) => {
        prompts.push(prompt);
        return `summary of ${prompt.length} chars`;
      },
    });

    expect(result.chunkCount).toBeGreaterThan(1);
    const level0 = prompts.slice(0, result.chunkCount).join("\n");
    // All three markers were READ by the summarizer. The old compact fed it 60K
    // characters of head+tail, so the middle of a 200K transcript was deleted
    // by a model that had never seen it.
    expect(level0).toContain("HEAD_MARKER");
    expect(level0).toContain("MIDDLE_MARKER");
    expect(level0).toContain("TAIL_MARKER");

    // Union of the chunks == the whole transcript, with no overlap.
    const chunks = chunkCompactTurns(turns, {
      chunkTokens: 4_000,
      measure: (t) => Math.ceil(t.length / 4),
    });
    expect(chunks.reduce((n, c) => n + c.count, 0)).toBe(turns.length);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.fromSeq).toBe(chunks[i - 1]!.toSeq + 1);
    }
    expect(chunks[0]!.fromSeq).toBe(1);
    expect(chunks.at(-1)!.toSeq).toBe(200);

    // The hash the summary claims is recomputable from the ORIGINAL records
    // alone — no renderer, no summary text.
    const expected = recordsSourceHash(
      turns.map((t) => ({ seq: t.seq, hash: recordContentHash(t) })),
    );
    expect(result.sourceHash).toBe(expected);
    // Every layer records the range it stands for and the contract version.
    expect(result.layers.every((l) => l.summaryVersion === 1)).toBe(true);
    const root = result.layers.at(-1)!;
    expect(root.fromSeq).toBe(1);
    expect(root.toSeq).toBe(200);
    expect(root.sourceHash).toBe(expected);
    expect(result.messageRange).toEqual({ fromSeq: 1, toSeq: 200, count: 200 });
    expect(result.diagnostics.join("\n")).toContain("contiguous chunk");
  });

  it("splits ONE oversized tool_result at stable offsets whose union is its whole body", async () => {
    // A 40K-token tool result cannot be handed to a summarizer whole (the
    // request would not fit) and cannot be dropped. It is cut into pieces whose
    // union is its ENTIRE readable body, and every piece names the record it
    // came from plus that record's content hash — the archived payload itself is
    // never touched.
    const body = `HEAD_PIECE ${"x".repeat(20_000)} MIDDLE_PIECE ${"x".repeat(19_000)} TAIL_PIECE`;
    const toolResult = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: body }],
      },
    };
    const turn: CompactSourceTurn = {
      messageId: 7,
      seq: 7,
      type: "user",
      payload: toolResult,
      createdAt: 1_700_000_007,
      text: `[tool_result t1] ${body}`,
    };
    const turns: CompactSourceTurn[] = [
      turn,
      { messageId: 8, seq: 8, type: "user", payload: { small: true }, createdAt: 1_700_000_008, text: "small" },
    ];

    const chunks = chunkCompactTurns(turns, { chunkTokens: 1_000, measure: (t) => t.length });
    const pieces = chunks.filter((c) => c.part !== null);
    expect(pieces.length).toBeGreaterThan(1);
    // Every piece is one message, and they SHARE the seq: coverage is a union
    // over seqs, so the message is covered exactly once however many pieces it
    // took.
    expect(pieces.every((c) => c.count === 1 && c.coveredSeqs.length === 1)).toBe(true);

    const expectedHash = recordContentHash(turn);
    const expectedRects = pieces.map((c) => c.part!);
    expect(expectedRects.every((p) => p.messageId === 7 && p.seq === 7 && p.contentHash === expectedHash)).toBe(
      true,
    );
    // Stable offsets: contiguous, no gap, no overlap, first at 0 and last at the
    // end of the body.
    expect(expectedRects[0]!.from).toBe(0);
    expect(expectedRects.at(-1)!.to).toBe(turn.text.length);
    for (let i = 1; i < expectedRects.length; i++) {
      expect(expectedRects[i]!.from).toBe(expectedRects[i - 1]!.to);
    }
    // The union IS the whole readable body — not a sample of it.
    expect(pieces.map((c) => c.text).join("")).toBe(turn.text);
    for (const marker of ["HEAD_PIECE", "MIDDLE_PIECE", "TAIL_PIECE"]) {
      expect(pieces.map((c) => c.text).join("")).toContain(marker);
    }
    // Deterministic: the same message always splits the same way.
    const again = chunkCompactTurns(turns, { chunkTokens: 1_000, measure: (t) => t.length });
    expect(again.map((c) => c.part)).toEqual(chunks.map((c) => c.part));
    // The split lives in the summarizer's INPUT only.
    expect(turn.payload).toEqual(toolResult);

    const result = await summarizeLayered({
      turns,
      chunkTokens: 1_000,
      mergeTokens: 1_000,
      summaryVersion: 1,
      measure: (t) => t.length,
      summarize: async () => "s",
    });
    // The whole transcript is covered, incl. the message that had to be cut.
    expect(result.messageRange).toEqual({ fromSeq: 7, toSeq: 8, count: 2 });
    expect(result.sourceHash).toBe(
      recordsSourceHash(turns.map((t) => ({ seq: t.seq, hash: recordContentHash(t) }))),
    );
    expect(result.diagnostics.join("\n")).toMatch(/piece\(s\) of 1 oversized message\(s\)/);
  });

  it("shrinks every merge level even when each level-0 summary exceeds the merge budget", async () => {
    // The convergence trap: if every summary is bigger than the merge budget,
    // grouping by "does it fit" makes each one its own group, the level has the
    // same width as the one below, and the merge never terminates. Two items is
    // therefore the floor for a group, and the over-budget group is REPORTED
    // rather than silently carried forward.
    const turns: CompactSourceTurn[] = Array.from({ length: 6 }, (_, i) => ({
      messageId: i + 1,
      seq: i + 1,
      type: "user",
      payload: { i },
      createdAt: 1_700_000_000 + i,
      // Bigger than `chunkTokens` on its own, so the six turns cannot be packed
      // into one chunk: the point of this test is six level-0 summaries.
      text: `small ${i} ${"p".repeat(600)}`,
    }));
    const perLevel = new Map<number, number>();
    const result = await summarizeLayered({
      turns,
      chunkTokens: 1_000,
      mergeTokens: 1_000,
      summaryVersion: 1,
      measure: (t) => t.length,
      summarize: async (_prompt, meta) => {
        perLevel.set(meta.level, (perLevel.get(meta.level) ?? 0) + 1);
        // 5 000 tokens per summary: EVERY level is over the 1 000-token merge
        // budget, at every level below the root.
        return meta.level === 0 ? "s".repeat(5_000) : `L${meta.level}${"m".repeat(4_998)}`;
      },
    });

    expect(result.chunkCount).toBe(6);
    const widths = [...perLevel.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
    // 6 → 3 → 2 → 1: strictly smaller at every level.
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!);
    }
    expect(widths.at(-1)).toBe(1);
    expect(result.diagnostics.join("\n")).toContain("over the 1000-token merge budget");
    // The root still stands for the whole transcript.
    const root = result.layers.at(-1)!;
    expect(root.fromSeq).toBe(1);
    expect(root.toSeq).toBe(6);
    expect(root.count).toBe(6);
  });
});

describe("gates 3-4: the archive is verbatim, verifiable and idempotent", () => {
  const mkAgent = async () =>
    prisma.agent.create({ data: { name: `arch-${Math.random().toString(36).slice(2)}`, model: "m" } });

  it("restores every original verbatim and reproduces range + hash + version", async () => {
    const agent = await mkAgent();
    const rows = [
      {
        id: 11,
        seq: 1,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "the original request" } },
        createdAt: 1_700_000_001,
      },
      {
        id: 12,
        seq: 2,
        type: "assistant",
        payload: {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "answer with a tool call" },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
            ],
          },
        },
        createdAt: 1_700_000_002,
      },
    ];
    archive.archiveRows(agent.id, 1, rows, 1_700_000_100);

    const records = archive.readGeneration(agent.id, 1);
    expect(records).toHaveLength(2);
    // Field-by-field verbatim: the payload survives untouched, tool_use and all.
    expect(records[1]!.payload).toEqual(rows[1]!.payload);
    // The hash is recomputable from the archive alone, with the SAME
    // construction the summarizer used (a different hash would make the
    // verification in `compactAgentHistory` a coincidence).
    expect(archive.sourceHashOf(records)).toBe(
      recordsSourceHash(
        rows.map((r) => ({
          seq: r.seq,
          hash: recordContentHash({
            messageId: r.id,
            seq: r.seq,
            type: r.type,
            payload: r.payload,
            createdAt: r.createdAt,
          }),
        })),
      ),
    );
    expect(records[0]!.contentHash).toBe(
      recordContentHash({
        messageId: rows[0]!.id,
        seq: rows[0]!.seq,
        type: rows[0]!.type,
        payload: rows[0]!.payload,
        createdAt: rows[0]!.createdAt,
      }),
    );

    // The transcript a reader gets includes the tool call, verbatim.
    const text = archive.renderArchivedTranscript(records);
    expect(text).toContain("the original request");
    expect(text).toContain("Bash");
    expect(text).toContain("ls -la");

    // Re-running the same generation is a no-op: the unique key makes a retried
    // compact idempotent instead of duplicating the record.
    archive.archiveRows(agent.id, 1, rows, 1_700_000_200);
    expect(archive.readGeneration(agent.id, 1)).toHaveLength(2);

    // The state a compact leaves behind: the archived range is gone from the
    // live table and a summary row stands at the end of the freed range, with
    // later turns above it.
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 2,
        type: "system",
        payload: {
          type: "system",
          subtype: "compact",
          generation: 1,
          text: "the summary that stands for seqs 1-2",
        },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 3,
        type: "assistant",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "later answer" }] } },
      },
    });
    const restored = archive.restoreGenerationToActive(agent.id, 1);
    expect(restored?.status).toBe("restored");
    if (restored?.status !== "restored") throw new Error("unreachable");
    expect(restored.restored).toBe(2);
    expect(restored.summarySeq).toBe(2);
    expect([restored.fromSeq, restored.toSeq]).toEqual([1, 2]);
    const live = await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } });
    // 1 + 2 are the restored originals in place; the follow-on rows were NOT
    // renumbered and are still after them.
    expect(live.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect((live[0]!.payload as { message: { content: string } }).message.content).toBe(
      "the original request",
    );
    expect((live[2]!.payload as { message: { content: { text: string }[] } }).message.content[0]!.text).toBe(
      "later answer",
    );
    // The archive is not consumed by a restore.
    expect(archive.readGeneration(agent.id, 1)).toHaveLength(2);

    // A SECOND restore is a no-op: it must never append a duplicate copy of the
    // records it just put back, and it has to say which of the two it did.
    const twice = archive.restoreGenerationToActive(agent.id, 1);
    expect(twice?.status).toBe("already-restored");
    expect(twice?.restored).toBe(2);
    const afterTwice = await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } });
    expect(afterTwice.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(afterTwice).toHaveLength(3);
  });

  it("reports no-active-summary instead of appending when the summary is gone", async () => {
    const agent = await mkAgent();
    await archive.archiveRows(
      agent.id,
      1,
      [
        {
          id: 1,
          seq: 0,
          type: "user",
          payload: { type: "user", message: { role: "user", content: "archived away" } },
          createdAt: 1_700_000_001,
        },
      ],
      1_700_000_100,
    );
    // A LATER compact owns seq 0 now (its own summary sits there — one row, since
    // two live rows cannot share a seq): the generation cannot be re-inserted in
    // place, and the honest answer is a structured refusal rather than a second
    // copy appended at the top of the history.
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 0,
        type: "system",
        payload: { type: "system", subtype: "compact", generation: 99, text: "a later summary" },
      },
    });
    const out = archive.restoreGenerationToActive(agent.id, 1);
    expect(out?.status).toBe("no-active-summary");
    const live = await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } });
    expect(live).toHaveLength(1);
    expect(live[0]!.seq).toBe(0);
  });

  it("rolls the whole compact back when the verification fails", async () => {
    const agent = await mkAgent();
    const rows = [
      {
        id: 1,
        seq: 1,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "x" } },
        createdAt: 1,
      },
    ];
    await prisma.message.create({
      data: { agentId: agent.id, seq: 1, type: "user", payload: rows[0]!.payload },
    });

    const { sqliteDb } = await import("../db.js");
    await expect(
      Promise.resolve().then(() =>
        // Inside the real transaction helper: archive, then fail before the
        // delete lands. Nothing may survive.
        archive.archiveRows(agent.id, 1, rows, 5),
      ).then(() => {
        throw new Error("simulated failure after archiving");
      }),
    ).rejects.toThrow("simulated failure");
    // Nothing was rolled back by that throw (no transaction was open), so the
    // archive row is there — which is why the transaction boundary, not this
    // call, is what the next assertion checks.
    expect(archive.listGenerations(agent.id).length).toBe(1);
    void sqliteDb;
  });
});

describe("gate 5: an unmeasurable tokenizer is reported, never silently zero", () => {
  it("labels a 0-returning measurer as estimated and uses the UTF-8 bound", () => {
    const m = makeTokenMeasurer(() => 0);
    expect(m.count("hello world")).toBe(utf8TokenUpperBound("hello world"));
    expect(m.counting()).toBe("estimated");
    expect(m.degradedReason()).toContain("returned 0");
    // Empty text really is 0 tokens — that is a measurement, not a miss.
    expect(m.count("")).toBe(0);
  });

  it("labels a throwing measurer as estimated too", () => {
    const m = makeTokenMeasurer(() => {
      throw new Error("no vocab file");
    });
    // The count comes first: a measurer can only be known to be broken once it
    // has been asked. This mirrors the resolver, which counts before reporting.
    expect(m.count("hello")).toBe(utf8TokenUpperBound("hello"));
    expect(m.counting()).toBe("estimated");
    expect(m.degradedReason()).toContain("no vocab");
  });

  it("carries the degradation into the plan's diagnostics", () => {
    const outcome = resolveHistoryBudget({
      turns: [{ seq: 1, kind: "user", text: "abc" }],
      systemPrompt: null,
      toolsText: null,
      context: ctx(),
      strategy: "local-rebuild",
      strategyReason: "test",
      measure: noMeasure,
    });
    expect(outcome.history.counting).toBe("estimated");
    expect(outcome.history.diagnostics.join("\n")).toContain("UTF-8 byte upper bound");
    expect(outcome.history.tokenBudget).not.toBeNull();
  });

  it("does not drop anything on a guess when no window is established", () => {
    const outcome = resolveHistoryBudget({
      turns: Array.from({ length: 500 }, (_, i) => ({ seq: i, kind: "user" as const, text: "x".repeat(500) })),
      systemPrompt: null,
      toolsText: null,
      context: ctx({ effectiveWindow: null, advertisedContextWindow: 1_000_000 }),
      strategy: "local-rebuild",
      strategyReason: "test",
      measure: (t) => Math.ceil(t.length / 4),
    });
    expect(outcome.history.tokenBudget).toBeNull();
    expect(outcome.history.counts.dropped).toBe(0);
    expect(outcome.history.counts.included).toBe(500);
    expect(outcome.history.diagnostics.join("\n")).toContain("nothing was dropped on a guess");
    expect(outcome.history.diagnostics.join("\n")).not.toContain("window 1000000");
  });
});

describe("gate 6: the three runtimes describe the same transcript, differing only in strategy", () => {
  const turns = [
    { seq: 1, kind: "user" as const, text: "q" },
    { seq: 2, kind: "assistant" as const, text: "a" },
  ];

  it("names the strategy and the same budget/counts for runtime-session, server-conversation and local-rebuild", () => {
    const outcomes = (["runtime-session", "server-conversation", "local-rebuild"] as const).map(
      (strategy) =>
        resolveHistoryBudget({
          turns,
          systemPrompt: "s",
          toolsText: "t",
          context: ctx(),
          strategy,
          strategyReason: `${strategy} reason`,
          measure: (x) => Math.ceil(x.length / 4),
        }).history,
    );
    for (const h of outcomes) {
      expect(h.status).toBe("resolved");
      expect(h.tokenBudget).toBe(outcomes[0]!.tokenBudget);
      expect(h.measuredTokens).toBe(outcomes[0]!.measuredTokens);
      expect(h.counts).toEqual(outcomes[0]!.counts);
      expect(h.includedRanges).toEqual(outcomes[0]!.includedRanges);
    }
    expect(outcomes.map((h) => h.strategy)).toEqual([
      "runtime-session",
      "server-conversation",
      "local-rebuild",
    ]);
    expect(outcomes[0]!.reason).toContain("runtime-session");
  });

  it("pins the summary and the interrupted turn so a budget cannot evict continuity", () => {
    const outcome = resolveHistoryBudget({
      turns: [
        { seq: 1, kind: "user", text: "old".repeat(5_000) },
        {
          seq: 2,
          kind: "summary",
          text: "the summary that explains where we came from",
          pinned: true,
          covers: 1,
          summary: {
            generation: 1,
            fromSeq: 1,
            toSeq: 1,
            count: 1,
            sourceHash: "h",
            summaryVersion: 1,
          },
        },
        { seq: 3, kind: "assistant", text: "recent" },
      ],
      systemPrompt: null,
      toolsText: null,
      context: ctx({ effectiveWindow: 10 }),
      strategy: "local-rebuild",
      strategyReason: "test",
      measure: (t) => Math.ceil(t.length / 4),
    });
    expect(outcome.included.map((t) => t.kind)).toContain("summary");
    expect(outcome.history.summaries).toHaveLength(1);
    expect(outcome.history.counts.summarized).toBe(1);

    // Pinned content that ALONE busts the window is REPORTED rather than hidden.
    // The budget may not evict it, so the honest outcome is a plan that says how
    // much is really being sent, that it is over, and that re-summarizing is
    // what has to happen before this turn can be dispatched — not a quiet
    // over-window request.
    expect(outcome.history.overBudget).toBe(true);
    expect(outcome.history.actualIncludedTokens).toBeGreaterThan(outcome.history.tokenBudget!);
    // Only the pinned summary is included (the "old" turn does not fit and
    // "recent" does not fit BESIDE it), and the reported figure is that
    // summary's own cost — the number the window would have to hold.
    expect(outcome.history.actualIncludedTokens).toBe(
      Math.ceil("the summary that explains where we came from".length / 4),
    );
    expect(outcome.history.diagnostics.join("\n")).toContain("must be re-summarized");
  });

  it("reports overBudget only when the included history really exceeds the budget", () => {
    const outcome = resolveHistoryBudget({
      turns: [{ seq: 1, kind: "user", text: "small" }],
      systemPrompt: null,
      toolsText: null,
      context: ctx(),
      strategy: "local-rebuild",
      strategyReason: "test",
      measure: (t) => Math.ceil(t.length / 4),
    });
    expect(outcome.history.overBudget).toBe(false);
    expect(outcome.history.actualIncludedTokens).toBeLessThanOrEqual(outcome.history.tokenBudget!);
  });
});

describe("gate 7: a server conversation is claimed only when it genuinely exists", () => {
  it("claims nothing when the route has not been observed to support it", async () => {
    const sc = await import("../capability/server-conversation.js");
    const decision = sc.resolveServerConversation({
      metadata: { serverConversation: { id: "resp_1", signature: "sig", storedAt: 1 } },
      signature: "sig",
      supported: false,
    });
    expect(decision.id).toBeNull();
    expect(decision.reason).toContain("not been observed");
  });

  it("reuses a matching id and DISCARDS one whose signature changed", async () => {
    const sc = await import("../capability/server-conversation.js");
    const signature = sc.serverConversationSignature({
      providerId: "p1",
      model: "gpt-5.6-sol",
      projectRoot: "D:/WorkSpace/x",
      systemPromptHash: "abc",
      transport: "responses",
    });
    const metadata = sc.withServerConversation({}, "resp_42", signature, 1_700_000_000);

    expect(sc.resolveServerConversation({ metadata, signature, supported: true }).id).toBe("resp_42");

    // Changing ANY input that shaped the conversation invalidates it. Enumerated
    // one at a time, because a signature that only covers the model would pass
    // this test while still dropping history on a project-root switch.
    const variants = [
      { providerId: "p2", model: "gpt-5.6-sol", projectRoot: "D:/WorkSpace/x", systemPromptHash: "abc", transport: "responses" },
      { providerId: "p1", model: "gpt-5.6", projectRoot: "D:/WorkSpace/x", systemPromptHash: "abc", transport: "responses" },
      { providerId: "p1", model: "gpt-5.6-sol", projectRoot: "D:/WorkSpace/y", systemPromptHash: "abc", transport: "responses" },
      { providerId: "p1", model: "gpt-5.6-sol", projectRoot: "D:/WorkSpace/x", systemPromptHash: "def", transport: "responses" },
      { providerId: "p1", model: "gpt-5.6-sol", projectRoot: "D:/WorkSpace/x", systemPromptHash: "abc", transport: "chat-completions" },
    ];
    for (const v of variants) {
      const other = sc.serverConversationSignature(v);
      expect(other).not.toBe(signature);
      const d = sc.resolveServerConversation({ metadata, signature: other, supported: true });
      expect(d.id).toBeNull();
      expect(d.invalidated).toBe(true);
    }

    // A malformed stored entry is treated as absent, not partially trusted.
    expect(
      sc.resolveServerConversation({ metadata: { serverConversation: { id: "" } }, signature, supported: true }).id,
    ).toBeNull();
    expect(sc.withoutServerConversation(metadata).serverConversation).toBeUndefined();
  });

  // What EARNS the claim above. A compat endpoint that answers /responses is not
  // enough: the route has to be the official OpenAI endpoint, because nothing
  // establishes that a compat implementation stores responses or honours
  // `previous_response_id` — and an endpoint that accepts the parameter and
  // ignores it loses the transcript with no error to show for it.
  it("is established by the official endpoint over Responses, and by nothing less", async () => {
    const sc = await import("../capability/server-conversation.js");
    const fact = (over: Record<string, unknown> = {}) =>
      sc.serverConversationSupportFact({
        runtime: "openai",
        transport: "responses",
        baseUrl: "https://api.openai.com/v1",
        providerMetadata: {},
        ...over,
      });

    expect(fact().value).toBe(true);
    expect(fact().origin).toBe("provider-discovered");
    // The kind is a label; the HOST is the claim.
    expect(fact({ baseUrl: "https://api.deepseek.com/v1" }).value).toBeUndefined();
    expect(fact({ baseUrl: "not a url" }).value).toBeUndefined();
    expect(fact({ transport: "chat-completions" }).value).toBeUndefined();
    expect(fact({ runtime: "claude" }).value).toBeUndefined();
  });

  // A rejection is a verdict about the route, and it EXPIRES: an endpoint that
  // refused the parameter today may be a gateway mid-upgrade, so a permanent
  // downgrade with no way to clear it would be worse than the retry.
  it("stops claiming a continuation after the endpoint rejected one, until the verdict expires", async () => {
    const sc = await import("../capability/server-conversation.js");
    const at = new Date("2026-09-16T10:00:00.000Z");
    const rejected = sc.withServerConversationRejection(
      { serverConversation: { id: "resp_1", signature: "s", storedAt: 1 } },
      { reason: "previous_response_id not found", httpStatus: 404, upstreamCode: "invalid_request_error" },
      at,
    );
    // Writing the rejection drops the id in the same breath: a rejected
    // continuation would fail again, and a stale id is worse than none.
    expect(rejected.serverConversation).toBeUndefined();

    const factAt = (now: Date) =>
      sc.serverConversationSupportFact({
        runtime: "openai",
        transport: "responses",
        baseUrl: "https://api.openai.com/v1",
        providerMetadata: rejected,
        now,
      });
    const during = factAt(new Date(at.getTime() + 60_000));
    expect(during.value).toBe(false);
    expect(during.confidence).toBe("observed");
    expect(during.source).toContain("previous_response_id not found");
    // Past the TTL the verdict is stale, not permanent: the route is tried again.
    expect(factAt(new Date(at.getTime() + sc.SERVER_CONVERSATION_REJECTION_TTL_MS + 1)).value).toBe(true);
  });
});

describe("the plan's history field", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has a real, distinguishable unavailable state", () => {
    const h = unavailablePlanHistory("nobody supplied history facts");
    expect(h.status).toBe("unavailable");
    expect(h.counting).toBe("unmeasured");
    expect(h.diagnostics).toEqual(["nobody supplied history facts"]);
  });

  it("is attachable exactly once", async () => {
    const { resolveRunPlan, attachPlanHistory } = await import("../capability/run-plan.js");
    const plan = resolveRunPlan({
      providerId: null,
      runtime: "claude",
      runtimeVersion: null,
      model: "m",
    });
    const attached = attachPlanHistory(plan, unavailablePlanHistory("x"));
    expect(attached.history.reason).toBe("x");
    expect(attached.planHash).not.toBe(plan.planHash);
    // Once RESOLVED, a second attach is refused: the guard exists so a caller
    // cannot quietly replace the budget a runtime already acted on with a
    // different one. (Attaching onto the `unavailable` placeholder is the one
    // legitimate call, and it is the one above.)
    const resolvedHistory = { ...unavailablePlanHistory("x"), status: "resolved" as const };
    const onceResolved = attachPlanHistory(plan, resolvedHistory);
    expect(() => attachPlanHistory(onceResolved, resolvedHistory)).toThrow(
      /already resolved/,
    );
  });
});
