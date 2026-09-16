// Phase 4: large tool results are stored WHOLE before any of them is shown.
//
// What these tests are about, in the order the rule is stated:
//   • an over-budget Grep result becomes a `tool-output` artifact whose stored
//     bytes hash-match the complete output, and the handle comes back with it;
//   • a caller-supplied head_limit is still honoured, and the result SAYS it is
//     a prefix instead of reading as the whole match list;
//   • a Glob over a huge match set neither returns a raw Node error nor hands an
//     unbounded list to the model.
//
// The sink is injected rather than reached through a runtime: that is the
// contract (`ToolContext.toolOutput`), and the one the OpenAI adapter passes
// through. The sink here writes REAL artifact rows, so the hash claim is checked
// against storage rather than against a stub's own bookkeeping.
//
// Every import is dynamic, and the DB path is set first: db.ts reads
// AGENTORCH_DB_PATH when it is loaded, and grep.ts reaches it transitively
// (grep → tool-output → artifacts → db), so a static import here would open the
// user's real database before the `:memory:` line below could run.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineSearchResult, ToolResultTooLarge } from "../tool-output.js";
import type { ArtifactBodySource } from "../../../artifacts.js";
import type { ToolContext, ToolOutputPresentation, ToolOutputSink } from "../types.js";
import type { toOpenAITool as ToOpenAITool } from "../index.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

let grepTool: typeof import("../grep.js").grepTool;
let globTool: typeof import("../glob.js").globTool;
let bashTool: typeof import("../bash.js").bashTool;
let toOpenAITool: typeof ToOpenAITool;
let finalizeLineSearch: typeof import("../tool-output.js").finalizeLineSearch;
let stringSource: typeof import("../tool-output.js").stringSource;
let createArtifactFromSpool: typeof import("../../../artifacts.js").createArtifactFromSpool;
let getArtifact: typeof import("../../../artifacts.js").getArtifact;
let handleOf: typeof import("../../../artifacts.js").handleOf;
let artifactPreview: typeof import("../../../artifacts.js").artifactPreview;
let renderArtifactResult: typeof import("../../../artifacts.js").renderArtifactResult;
let sha256OfText: typeof import("../../../artifacts.js").sha256OfText;
let verifyArtifact: typeof import("../../../artifacts.js").verifyArtifact;
let readArtifactPage: typeof import("../../../artifacts.js").readArtifactPage;
let spoolClass: typeof import("../spool.js").OutputSpool;

beforeAll(async () => {
  ({ grepTool } = await import("../grep.js"));
  ({ globTool } = await import("../glob.js"));
  ({ bashTool } = await import("../bash.js"));
  ({ toOpenAITool } = await import("../index.js"));
  ({ finalizeLineSearch, stringSource } = await import("../tool-output.js"));
  ({
    createArtifactFromSpool,
    getArtifact,
    handleOf,
    artifactPreview,
    renderArtifactResult,
    sha256OfText,
    verifyArtifact,
    readArtifactPage,
  } = await import("../../../artifacts.js"));
  ({ OutputSpool: spoolClass } = await import("../spool.js"));
});

const PREVIEW_BYTES = 64;

/** The complete stored text of an artifact, assembled ONLY from the pages a
 *  reader gets.
 *
 *  This is the contract a chunked body has to keep: every page byte-exact and
 *  UTF-8 safe, the last one saying so, and the cursor joining them with no gap.
 *  Reading `getArtifact(id).body` would prove nothing here — a streamed body has
 *  no `body`. */
function readWholeArtifact(id: string): string {
  const parts: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10_000; page++) {
    const read = readArtifactPage(id, { cursor, pageBytes: 262_144 });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    parts.push(read.text);
    if (read.endReached) return parts.join("");
    expect(read.nextCursor).not.toBeNull();
    cursor = read.nextCursor;
  }
  throw new Error("paging an artifact did not reach its end");
}

/** A sink that behaves like the session-backed one: it stores the complete
 *  source as a `tool-output` artifact and returns a preview plus the handle. The
 *  preview size is the real sink's business (it comes from the run plan), not
 *  the tool's — 64 bytes here just keeps a test result readable. */
function sinkWithBudget(budgetBytes: number | null): ToolOutputSink {
  return {
    budgetBytes,
    present: (args: { source: ArtifactBodySource; headerLines?: string[] }): ToolOutputPresentation => {
      const row = createArtifactFromSpool({ agentId: "test-agent", kind: "tool-output", source: args.source });
      const handle = handleOf(row);
      const preview = artifactPreview(row, PREVIEW_BYTES);
      return {
        text: renderArtifactResult({
          handle,
          text: preview.text,
          inline: false,
          reason: "over the budget injected by this test",
          previewCursor: preview.cursor,
          ...(args.headerLines ? { headerLines: args.headerLines } : {}),
        }),
        handle,
        inlined: false,
        reason: "over the budget injected by this test",
      };
    },
  };
}

/** Records the id of every artifact it is asked to write, so a test can prove
 *  the bytes that reached STORAGE are the COMPLETE output and not a prefix.
 *  It records ids rather than the incoming source because a source that spilled
 *  cannot be asked for its text at all — which is the point. */
function recordingSink(): ToolOutputSink & { ids: string[] } {
  const ids: string[] = [];
  const inner = sinkWithBudget(1);
  return {
    budgetBytes: 1,
    ids,
    present: (args: { source: ArtifactBodySource; headerLines?: string[] }): ToolOutputPresentation => {
      const out = inner.present(args);
      ids.push(out.handle.id);
      return out;
    },
  };
}

let tmp: string;
/** A directory of our own for the spool unit test, so "did dispose remove the
 *  file" is answered about files THIS test made and nothing else. */
let spoolDir: string;
const ctx = (sink?: ToolOutputSink): ToolContext =>
  sink ? { projectRoot: tmp, toolOutput: sink } : { projectRoot: tmp };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ensemble-tool-budget-"));
  spoolDir = await mkdtemp(join(tmpdir(), "ensemble-spool-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  await rm(spoolDir, { recursive: true, force: true }).catch(() => {});
});

/** Spill files this test process left behind, for one tool label. The pid is in
 *  the name, so a parallel worker's in-flight file is not counted as a leak. */
function leftoverSpills(label: string, dir: string = tmpdir()): string[] {
  return readdirSync(dir).filter((f) => f.includes(`-${process.pid}-`) && f.endsWith(`-${label}.tmp`));
}

/** One file with `n` matching lines. A single file keeps the output order
 *  deterministic for both backends (ripgrep on PATH and the Node fallback), so
 *  two runs over the same fixture can be compared byte for byte. */
async function writeHits(name: string, n: number): Promise<void> {
  const lines = Array.from({ length: n }, (_, i) => `hit needle-${i}`);
  await writeFile(join(tmp, name), lines.join("\n"));
}

describe("Grep: an over-budget result is stored before it is shown", () => {
  it("returns a handle whose stored bytes hash-match the COMPLETE output", async () => {
    await writeHits("big.txt", 5_000);
    const args = { pattern: "hit", path: tmp, output_mode: "content" as const };

    // Run one: a budget nothing can exceed, so the tool hands the matches over
    // whole. That string IS the complete output, taken from the tool itself
    // rather than reconstructed by the test.
    const complete = await grepTool.execute(args, ctx(sinkWithBudget(Number.MAX_SAFE_INTEGER)));
    expect(typeof complete).toBe("string");
    const full = complete as string;
    expect(full).toContain("hit needle-4999");

    // Run two: a budget the output cannot fit, so it must be stored whole.
    const out = (await grepTool.execute(args, ctx(sinkWithBudget(1_024)))) as LineSearchResult;
    expect(typeof out).toBe("object");
    expect(out.ok).toBe(true);
    expect(out.artifact).toBeDefined();

    const handle = out.artifact!;
    // The stored bytes are the complete output, and the handle's sha256 is a
    // claim about them — checked against storage, not against memory.
    expect(handle.byteSize).toBe(Buffer.byteLength(full, "utf8"));
    expect(handle.sha256).toBe(sha256OfText(full));
    const row = getArtifact(handle.id);
    expect(row).not.toBeNull();
    // Over the budget, so this body was streamed into chunk rows: the pages a
    // reader gets reassemble to the COMPLETE output, byte for byte.
    expect(readWholeArtifact(handle.id)).toBe(full);
    expect(verifyArtifact(row!).ok).toBe(true);

    // What the model sees is a preview plus the handle — never the whole thing
    // presented as if it were.
    expect(out.result).toContain(`id=${handle.id}`);
    expect(out.result).toContain(handle.sha256);
    expect(out.truncated).toBe(true);
    expect(out.endReached).toBe(false);
    expect(out.result.length).toBeLessThan(full.length);
  });

  it("stores the complete output, not the preview, when it stores at all", async () => {
    await writeHits("record.txt", 300);
    const sink = recordingSink();
    await grepTool.execute({ pattern: "hit", path: tmp, output_mode: "content" }, ctx(sink));
    expect(sink.ids).toHaveLength(1);
    const stored = readWholeArtifact(sink.ids[0]!);
    expect(stored.split("\n")).toHaveLength(300);
    expect(stored).toContain("hit needle-299");
  });

  it("leaves an in-budget result as a plain string (no artifact noise)", async () => {
    await writeHits("small.txt", 3);
    const out = await grepTool.execute(
      { pattern: "hit", path: tmp, output_mode: "content" },
      ctx(sinkWithBudget(1_048_576)),
    );
    expect(typeof out).toBe("string");
    expect(out as string).toContain("hit needle-2");
    expect(out as string).not.toContain("artifact");
  });

  it("refuses structurally, with a narrowing suggestion, when nothing can store the bytes", async () => {
    // No sink + output past the ceiling. The refusal is the honest answer: the
    // alternative is a prefix that reads as the whole result.
    await writeFile(join(tmp, "huge.txt"), `hit ${"x".repeat(1_048_600)}`);
    const out = (await grepTool.execute(
      { pattern: "hit", path: tmp, output_mode: "content" },
      ctx(),
    )) as ToolResultTooLarge;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("RESULT_TOO_LARGE");
    expect(out.limitBytes).toBe(1_048_576);
    expect(out.suggestion).toMatch(/head_limit/);
    expect(out.suggestion).toMatch(/glob=|path=|pattern/);
    // Never a raw Node error, and never a claim that this was the result.
    expect(out.message).not.toMatch(/ENOBUFS|maxBuffer/);
  });
});

describe("Grep: head_limit is honoured and reported", () => {
  it("returns exactly head_limit matches and says it is a prefix", async () => {
    await writeHits("many.txt", 40);
    const out = (await grepTool.execute(
      { pattern: "hit", path: tmp, output_mode: "content", head_limit: 5 },
      ctx(sinkWithBudget(1_048_576)),
    )) as LineSearchResult;

    expect(typeof out).toBe("object");
    expect(out.matched).toBe(40);
    expect(out.returned).toBe(5);
    expect(out.head_limit).toBe(5);
    expect(out.truncated).toBe(true);
    expect(out.endReached).toBe(false);
    // Exactly the caller's first five matches are visible — a prefix, not a
    // silent hole in the middle — and no sixth match leaked in.
    expect(out.result).toContain("hit needle-4");
    expect(out.result.split("\n").filter((l) => l.includes("hit needle-")).length).toBe(5);
    // No artifact is written just to satisfy a bound the caller asked for.
    expect(out.artifact).toBeUndefined();
  });

  it("honours a head_limit the search already satisfies without calling it truncation", async () => {
    await writeHits("few.txt", 3);
    const out = await grepTool.execute({ pattern: "hit", path: tmp, head_limit: 10 }, ctx(sinkWithBudget(1_048_576)));
    // Nothing was left out, so the answer is still the matches themselves.
    expect(typeof out).toBe("string");
    expect(out as string).toContain("few.txt");
  });

  it("still returns an empty result for no matches", async () => {
    await writeHits("none.txt", 2);
    const out = await grepTool.execute({ pattern: "zzz_never_here", path: tmp }, ctx(sinkWithBudget(1_024)));
    expect(out).toBe("");
  });
});

describe("the bound holds while the bytes arrive, not after", () => {
  it("a 10 MB spool keeps a fixed amount in memory and re-hashes to every byte", async () => {
    // The whole point of the spool: the bytes are produced faster than anyone
    // could decide what to do with them, and none of that decides how much
    // memory this takes. 12 MB written in 64 KiB pipe-sized chunks — the same
    // shape a command's stdout arrives in, and the boundary lands mid-character
    // on purpose.
    const limit = 64 * 1024;
    const spool = new spoolClass({ memoryLimitBytes: limit, label: "peak", tmpDir: spoolDir });
    const piece = "中".repeat(21_845); // 65 535 bytes of CJK
    const pieces = 200; // ~13 MB
    const written: string[] = [];
    for (let i = 0; i < pieces; i++) {
      // The trailing digit makes each piece 65 536 bytes — one byte past a
      // multiple of three — so every seam lands INSIDE a 中 and the decoder has
      // to carry the partial character across chunks.
      const text = `${piece}${i % 10}`;
      written.push(text);
      spool.write(Buffer.from(text, "utf8"));
    }
    const expected = written.join("");

    // Peak retained memory is the bound, and it is the bound the tool promised:
    // not "much less than the result", not "one chunk over" — the limit.
    expect(spool.peakRetainedBytes).toBeLessThanOrEqual(limit);
    expect(spool.spilled).toBe(true);
    expect(spool.byteSize).toBe(Buffer.byteLength(expected, "utf8"));
    // `text()` refuses rather than quietly assembling what was deliberately not
    // kept — the one call that would undo the bound.
    expect(() => spool.text()).toThrow(/spilled/);

    // Every byte, in order, through the same chunking storage uses.
    const assembled: Buffer[] = [];
    for (const chunk of spool.chunks(1_048_576)) assembled.push(chunk);
    expect(Buffer.concat(assembled).toString("utf8")).toBe(expected);
    expect(spool.sha256).toBe(sha256OfText(expected));

    const spillPath = join(spoolDir, leftoverSpills("peak", spoolDir)[0] ?? "");
    expect(leftoverSpills("peak", spoolDir), "the spill file is not on disk").toHaveLength(1);
    spool.dispose();
    expect(existsSync(spillPath), "dispose did not remove the spill file").toBe(false);
    // Idempotent: a second dispose (every caller runs it in a `finally`) must
    // not throw.
    expect(() => spool.dispose()).not.toThrow();
  });

  it("keeps the bytes in memory when they fit, and stores them on the row", async () => {
    const spool = new spoolClass({ memoryLimitBytes: 1_048_576, label: "inline", tmpDir: spoolDir });
    spool.write("small enough\n");
    expect(spool.spilled).toBe(false);
    expect(spool.text()).toBe("small enough\n");
    expect(spool.peakRetainedBytes).toBe("small enough\n".length);
    spool.dispose();
    expect(leftoverSpills("inline", spoolDir)).toHaveLength(0);
  });
});

describe("Bash: a 10 MB stream is stored whole, never held whole", () => {
  it("hands the model a preview and an artifact that pages back to every byte", async () => {
    // 10 MB is past anything a result may inline, and past what a sidecar can
    // afford to hold per command: the size decision has to bite while the bytes
    // are arriving, which is what makes the peak memory a fixed number rather
    // than the size of the output.
    const line = `行${"x".repeat(99)}\n`; // 103 bytes, multi-byte and ASCII
    const lines = 102_000; // ~10.5 MB
    const script = join(tmp, "huge.js");
    await writeFile(
      script,
      `const line = ${JSON.stringify(line)};\n` +
        `const buf = Buffer.from(line.repeat(${lines}), "utf8");\n` +
        "let at = 0;\n" +
        "while (at < buf.length) { const end = Math.min(buf.length, at + 65536);\n" +
        "  if (!process.stdout.write(buf.subarray(at, end))) break;\n" +
        "  at = end; }\n" +
        "if (at < buf.length) process.stdout.once('drain', () => process.stdout.write(buf.subarray(at)));\n",
    );
    const adapter = toOpenAITool(bashTool, {
      permissionMode: "bypassPermissions",
      projectRoot: tmp,
      toolOutput: sinkWithBudget(16_384),
    });
    const command =
      process.platform === "win32"
        ? `& ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
        : `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;

    const out = String(await adapter.invoke({} as never, JSON.stringify({ command })));
    // What the model sees is a preview plus the handle — never the stream.
    expect(out.length).toBeLessThan(16_384 + 8_192);
    const idMatch = /id=([0-9a-fA-F-]{36})/.exec(out);
    expect(idMatch, `no artifact handle in:\n${out.slice(0, 400)}`).not.toBeNull();
    const id = idMatch![1]!;

    const row = getArtifact(id)!;
    expect(row.chunkCount).toBeGreaterThan(1);
    // The row itself carries no text: the body never existed as a string.
    expect(row.body).toBe("");
    const complete = `${line.repeat(lines)}\n[exit 0]`;
    expect(row.byteSize).toBe(Buffer.byteLength(complete, "utf8"));
    expect(row.sha256).toBe(sha256OfText(complete));

    // ...and every byte is still there, page by page, with no U+FFFD where a
    // multi-byte character was cut: the reassembled text IS the output.
    const stored = readWholeArtifact(id);
    expect(stored).toBe(complete);
    expect(stored).not.toContain("�");
    expect(verifyArtifact(row).ok).toBe(true);

    // And the spill file the stream lived in is gone.
    expect(leftoverSpills("bash")).toHaveLength(0);
  }, 180_000);

  it("cleans up the spill file when the command FAILS, and still stores what it printed", async () => {
    // A command that floods and then exits nonzero: the `finally` is the only
    // thing standing between a failed run and a 2 MB file nothing will remove.
    // (A killed-by-timeout variant of this would hang on Windows: SIGKILL lands
    // on PowerShell, the node grandchild survives holding stdout open, and the
    // 'close' event the tool waits on never arrives — a pre-existing property of
    // the Bash tool's timeout, not of the spool.)
    const script = join(tmp, "flood.js");
    // The exit goes in the write's own callback: `process.exit` right after a
    // write to a pipe can cut the output short, and this test is about what the
    // command produced, not about that.
    await writeFile(script, `process.stdout.write("y".repeat(2_000_000), () => process.exit(3));\n`);
    const command =
      process.platform === "win32"
        ? `& ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
        : `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const out = (await bashTool.execute({ command }, ctx(sinkWithBudget(4_096)))) as string;
    expect(leftoverSpills("bash")).toHaveLength(0);
    // The bytes a failed command produced are exactly the ones worth keeping:
    // the stored artifact is complete, and the exit code is inside it rather
    // than lost with the process.
    const id = /id=([0-9a-fA-F-]{36})/.exec(out)![1]!;
    const stored = readWholeArtifact(id);
    const trailer = /\n\[exit (\d+)\]$/.exec(stored);
    // The produced bytes, then the trailer — nothing clipped and nothing lost.
    // The trailer's NUMBER is asserted as "nonzero" rather than as the script's
    // own 3: PowerShell reports a failing native command's `-Command` as 1, so
    // pinning the literal would be asserting the shell's convention, not this
    // tool's behaviour.
    expect(trailer).not.toBeNull();
    expect(Number(trailer![1])).toBeGreaterThan(0);
    expect(stored.slice(0, stored.length - trailer![0].length)).toBe("y".repeat(2_000_000));
  }, 60_000);
});

describe("Glob: a huge match set is bounded, never a raw Node error", () => {
  it("stores the complete listing as an artifact when it does not fit", async () => {
    // 400 files is enough to exceed a 1 KiB budget without making the fixture
    // slow on Windows.
    const dir = join(tmp, "many");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 400; i++) await writeFile(join(dir, `f${String(i).padStart(3, "0")}.txt`), "");

    const complete = await globTool.execute(
      { pattern: "**/*.txt", path: tmp },
      ctx(sinkWithBudget(Number.MAX_SAFE_INTEGER)),
    );
    expect(typeof complete).toBe("string");
    const full = complete as string;
    expect(full.split("\n")).toHaveLength(400);

    const out = (await globTool.execute(
      { pattern: "**/*.txt", path: tmp },
      ctx(sinkWithBudget(1_024)),
    )) as LineSearchResult;
    expect(out.ok).toBe(true);
    expect(out.matched).toBe(400);
    expect(out.artifact).toBeDefined();
    expect(out.artifact!.sha256).toBe(sha256OfText(full));
    expect(readWholeArtifact(out.artifact!.id)).toBe(full);
    expect(out.result).toContain(`id=${out.artifact!.id}`);
  });

  it("reports a head_limit prefix honestly", async () => {
    const dir = join(tmp, "few");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 20; i++) await writeFile(join(dir, `g${i}.txt`), "");

    const out = (await globTool.execute(
      { pattern: "**/*.txt", path: tmp, head_limit: 4 },
      ctx(sinkWithBudget(1_048_576)),
    )) as LineSearchResult;
    expect(out.ok).toBe(true);
    expect(out.matched).toBe(20);
    expect(out.returned).toBe(4);
    expect(out.truncated).toBe(true);
    expect(out.endReached).toBe(false);
    expect(out.result).toContain("head_limit=4");
  });

  it("hands a large-but-bounded set over whole (no blow-up, no raw Node error)", async () => {
    const dir = join(tmp, "wide");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 600; i++) await writeFile(join(dir, `w${String(i).padStart(3, "0")}.txt`), "");

    // No sink at all: this is the worst case for a caller that has nowhere to
    // store bytes, and 600 paths are still far under the ceiling, so the honest
    // answer is the list itself — a string, not a refusal and not a Node error.
    const out = await globTool.execute({ pattern: "**/*.txt", path: tmp }, ctx());
    expect(typeof out).toBe("string");
    expect((out as string).split("\n")).toHaveLength(600);
    expect(out as string).not.toMatch(/ENOBUFS|maxBuffer|Error/);
  });

  it("refuses structurally rather than dumping an unbounded set", async () => {
    // The same code path Glob uses, driven with a synthetic match set: paths of
    // this length over 40 000 files is what `**/*` over a large tree produces
    // (~1.6 MiB), past the last-resort ceiling, and there is no sink here, so
    // the answer is a structured refusal carrying the narrowing advice.
    const body = Array.from({ length: 40_000 }, (_, i) => `/some/very/long/root/path/file-${i}.ts`).join("\n");
    const out = finalizeLineSearch({
      ctx: { projectRoot: tmp },
      tool: "Glob",
      source: stringSource(body),
      matched: 40_000,
      headLimit: null,
      narrowing: 'narrow the pattern (e.g. "src/**/*.ts") or search a subdirectory with path=',
    }) as ToolResultTooLarge;

    expect(typeof out).toBe("object");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("RESULT_TOO_LARGE");
    expect(out.byteSize).toBeGreaterThan(out.limitBytes);
    expect(out.suggestion).toMatch(/path=/);
    expect(out.suggestion).toMatch(/head_limit/);
    expect(out.message).not.toMatch(/ENOBUFS|maxBuffer/);
  });
});

describe("Bash: an oversized output is readable by hash, through the adapter", () => {
  it("stores the COMPLETE output and hands back a preview the hash verifies", async () => {
    // Driven through `toOpenAITool` on purpose: that is the seam where a
    // tool's raw string meets the session's sink, and it is the seam a runtime
    // could forget to thread (the tool itself would look fine either way).
    const adapter = toOpenAITool(bashTool, {
      permissionMode: "bypassPermissions",
      projectRoot: tmp,
      toolOutput: sinkWithBudget(1_024),
    });

    // ~400 KiB of output: a real command's worth of build log, and far past the
    // 1 KiB budget this sink declares.
    const line = "x".repeat(199) + "\n";
    const script = join(tmp, "big.js");
    await writeFile(script, `process.stdout.write(${JSON.stringify(line)}.repeat(2000));`);
    // PowerShell needs the call operator for a quoted command path; sh must not
    // see it.
    const command =
      process.platform === "win32"
        ? `& ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
        : `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const out = String(await adapter.invoke({} as never, JSON.stringify({ command })));

    // What the model sees carries the handle, not the whole stream...
    const idMatch = /id=([0-9a-fA-F-]{36})/.exec(out);
    expect(idMatch, `no artifact handle in the adapter's result:\n${out.slice(0, 400)}`).not.toBeNull();
    const id = idMatch![1]!;
    expect(out.length).toBeLessThan(8_192);

    // ...and the artifact behind it holds EVERY byte, with a digest that
    // matches what was produced. This is the whole point of storing before
    // showing: the rest is one artifact_read away rather than gone.
    const row = getArtifact(id)!;
    expect(row).toBeDefined();
    expect(row.kind).toBe("tool-output");
    // The stream was past the budget, so it was SPOOLED: nothing held it whole,
    // and the body lives in chunk rows rather than on the row.
    expect(row.chunkCount).toBeGreaterThan(0);
    expect(row.body).toBe("");
    // ...plus the exit trailer the Bash tool appends.
    const complete = `${line.repeat(2000)}\n[exit 0]`;
    expect(row.byteSize).toBe(Buffer.byteLength(complete, "utf8"));
    expect(readWholeArtifact(id)).toBe(complete);
    const handle = handleOf(row);
    expect(handle.sha256).toBe(sha256OfText(complete));
    const verified = verifyArtifact(row);
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
  });
});
