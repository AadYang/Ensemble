// Slice 3.2 / 3.3: NormalizedTool happy-path + boundary tests for the 6
// built-in tools (Read / Edit / Write / Bash / Grep / Glob). Each test uses
// vitest's tmpdir-style fixture in os.tmpdir() — full Node runtime, real fs,
// no mocking. Bash is OS-aware (PowerShell on Windows, sh elsewhere).

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, EOL } from "node:os";
import { join } from "node:path";
import { readTool } from "../read.js";
import { writeTool } from "../write.js";
import { editTool } from "../edit.js";
import { bashTool } from "../bash.js";

// Grep and Glob reach db.ts (grep → tool-output → artifacts → db), and db.ts is
// read at import time, so this has to be set before they are loaded — hence the
// dynamic imports below. Without it the test opens the developer's real
// database; db.ts now refuses that outright rather than doing it quietly.
process.env.AGENTORCH_DB_PATH = ":memory:";

let grepTool: typeof import("../grep.js").grepTool;
let globTool: typeof import("../glob.js").globTool;

beforeAll(async () => {
  ({ grepTool } = await import("../grep.js"));
  ({ globTool } = await import("../glob.js"));
});

/** `node script.js`, in the shell the Bash tool actually uses.
 *
 *  PowerShell needs the call operator for a quoted command path — `"exe" args`
 *  is a parse error there, while `sh` must not see the `&`. */
function quoteCommand(execPath: string, script: string): string {
  return process.platform === "win32"
    ? `& ${JSON.stringify(execPath)} ${JSON.stringify(script)}`
    : `${JSON.stringify(execPath)} ${JSON.stringify(script)}`;
}

let tmp: string;
/** The tools' working-directory context. In production it is the turn's
 *  project root from the run plan; here it is the fixture dir, so a relative
 *  default (`Glob` with no path, a bare `Bash` cwd) resolves inside it. */
const ctx = () => ({ projectRoot: tmp });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ensemble-tools-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("Read", () => {
  it("returns line-numbered content for an existing file", async () => {
    const f = join(tmp, "a.txt");
    await writeFile(f, "alpha\nbeta\ngamma");
    const out = await readTool.execute({ file_path: f }, ctx());
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("gamma");
    expect(out).toMatch(/^\s*1\t/);
  });

  it("honors offset + limit (boundary: middle slice)", async () => {
    const f = join(tmp, "lines.txt");
    await writeFile(f, Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join("\n"));
    const out = (await readTool.execute({ file_path: f, offset: 10, limit: 3 }, ctx())) as string;
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/\b10\b.*L10/);
    expect(lines[2]).toMatch(/\b12\b.*L12/);
    // Lines 10-12 of 50 is a prefix, and the result says so rather than reading
    // like the whole file: a truncation the model cannot see is the failure.
    expect(lines[3]).toContain("showing lines 10-12 of 50");
    expect(lines[3]).toContain("offset=13");
    expect(lines[3]).toContain("NOT included");
  });

  it("says when a read is a prefix of a long file, and the pages reassemble", async () => {
    const f = join(tmp, "long.txt");
    // Past the tool's own default limit, which is the case that used to read
    // exactly like a whole file.
    const defaultLines = 2_000;
    const total = defaultLines + 500;
    await writeFile(f, Array.from({ length: total }, (_, i) => `L${i + 1}`).join("\n"));

    const first = (await readTool.execute({ file_path: f }, ctx())) as string;
    // The default read of a 2 500-line file names what it left out...
    expect(first).toContain(`showing lines 1-${defaultLines} of ${total}`);
    expect(first).toContain(`offset=${defaultLines + 1}`);

    // ...and the second call, taken exactly as the notice describes it, ends the
    // file. That is what "the pages reassemble" means: no gap between them.
    const second = (await readTool.execute({ file_path: f, offset: defaultLines + 1 }, ctx())) as string;
    expect(second).not.toContain("showing lines");
    expect(second.split("\n")).toHaveLength(total - defaultLines);
    expect(second).toContain(`L${total}`);
  });

  it("rejects relative paths (boundary)", async () => {
    await expect(readTool.execute({ file_path: "relative/path.txt" }, ctx())).rejects.toThrow(/absolute/i);
  });
});

describe("Write", () => {
  it("creates the file and parent dirs", async () => {
    const f = join(tmp, "deep", "dir", "out.txt");
    const out = await writeTool.execute({ file_path: f, content: "hello" }, ctx());
    expect(out).toMatch(/Wrote 5 bytes/);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(f, "utf8")).toBe("hello");
  });
});

describe("Edit", () => {
  it("replaces a unique occurrence", async () => {
    const f = join(tmp, "code.ts");
    await writeFile(f, "const x = 1;\nconst y = 2;");
    await editTool.execute({ file_path: f, old_string: "const y = 2;", new_string: "const y = 99;" }, ctx());
    const { readFile } = await import("node:fs/promises");
    const updated = await readFile(f, "utf8");
    expect(updated).toContain("const y = 99;");
    expect(updated).not.toContain("const y = 2;");
  });

  it("refuses ambiguous edits unless replace_all (boundary)", async () => {
    const f = join(tmp, "ambig.txt");
    await writeFile(f, "X\nX\n");
    await expect(
      editTool.execute({ file_path: f, old_string: "X", new_string: "Y" }, ctx()),
    ).rejects.toThrow(/multiple times/i);
    await editTool.execute({ file_path: f, old_string: "X", new_string: "Y", replace_all: true }, ctx());
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(f, "utf8")).toBe("Y\nY\n");
  });
});

describe("Bash", () => {
  it("returns stdout + exit code on a trivial command", async () => {
    // 'echo hi' works in both PowerShell and sh.
    const out = await bashTool.execute({ command: "echo hi" }, ctx());
    expect(out).toContain("hi");
    expect(out).toMatch(/\[exit 0\]/);
  });

  it("keeps a multi-byte character split across a pipe chunk intact", async () => {
    // The pipe hands over ~64 KiB at a time, and that boundary lands wherever it
    // lands — here, one byte into a 3-byte character. Decoding each chunk on
    // arrival replaces both halves with U+FFFD, so a CJK log line comes back
    // mangled and nothing in the result says why. The output has to survive the
    // split the same way the file it came from did.
    const script = join(tmp, "cjk.js");
    const count = 70_000; // 210 000 bytes of '中' — several chunks.
    await writeFile(script, `process.stdout.write("中".repeat(${count}));`);
    const out = (await bashTool.execute(
      { command: quoteCommand(process.execPath, script), cwd: tmp },
      ctx(),
    )) as string;

    expect(out).not.toContain("�");
    expect(out.startsWith("中".repeat(100))).toBe(true);
    // The payload is every character, not most of them: the trailer is the only
    // thing after it.
    expect(out.split("\n[exit ")[0]).toHaveLength(count);
    expect(out).toContain("\n[exit 0]");
  });

  it("reports nonzero exit (boundary)", async () => {
    // 'exit 42' works in both shells.
    const out = await bashTool.execute({ command: "exit 42" }, ctx());
    expect(out).toMatch(/\[exit 42\]/);
  });

  it("reports the REAL exit code of a failing command, not a generic 1", async () => {
    // `exit 42` above is PowerShell's own exit STATEMENT, which propagates on
    // its own — so it passed while every real failing command did not.
    // `powershell -Command <cmd>` collapses any native command's non-zero status
    // to 1, so a compiler error, a missing binary and a failed test suite all
    // used to report "[exit 1]". Measured distinct codes, deliberately not 1,
    // so a regression cannot pass by coincidence.
    const three = await bashTool.execute({ command: `node -e "process.exit(3)"` }, ctx());
    expect(three).toMatch(/\[exit 3\]/);
    const seven = await bashTool.execute({ command: `node -e "process.exit(7)"` }, ctx());
    expect(seven).toMatch(/\[exit 7\]/);
  });
});

describe("Grep", () => {
  it("finds matching files (default mode)", async () => {
    await writeFile(join(tmp, "a.txt"), "match me");
    await writeFile(join(tmp, "b.txt"), "no hit");
    await mkdir(join(tmp, "sub"), { recursive: true });
    await writeFile(join(tmp, "sub", "c.txt"), "match too");
    const out = await grepTool.execute({ pattern: "match", path: tmp }, ctx());
    const lines = (out as string).split(/\r?\n/).filter(Boolean);
    expect(lines.some((l) => l.includes("a.txt"))).toBe(true);
    expect(lines.some((l) => l.includes("c.txt"))).toBe(true);
    expect(lines.some((l) => l.includes("b.txt"))).toBe(false);
  });

  it("returns empty when no matches (boundary)", async () => {
    await writeFile(join(tmp, "a.txt"), "nope");
    const out = await grepTool.execute({ pattern: "zzz_never", path: tmp }, ctx());
    expect(out).toBe("");
  });
});

describe("Glob", () => {
  it("matches *.txt pattern recursively (boundary: ** wildcard)", async () => {
    await writeFile(join(tmp, "a.txt"), "");
    await writeFile(join(tmp, "b.ts"), "");
    await mkdir(join(tmp, "nested"), { recursive: true });
    await writeFile(join(tmp, "nested", "c.txt"), "");
    const out = await globTool.execute({ pattern: "**/*.txt", path: tmp }, ctx());
    const lines = (out as string).split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.endsWith("a.txt"))).toBe(true);
    expect(lines.some((l) => l.endsWith("c.txt"))).toBe(true);
  });

  it("skips node_modules and .git", async () => {
    await mkdir(join(tmp, "node_modules"), { recursive: true });
    await writeFile(join(tmp, "node_modules", "skip.txt"), "");
    await mkdir(join(tmp, ".git"), { recursive: true });
    await writeFile(join(tmp, ".git", "skip2.txt"), "");
    await writeFile(join(tmp, "keep.txt"), "");
    const out = await globTool.execute({ pattern: "**/*.txt", path: tmp }, ctx());
    const lines = (out as string).split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("keep.txt");
  });
});

// EOL kept imported for tests that need explicit \r\n compatibility; if
// future tests don't use it, vitest's no-unused-imports check should flag.
void EOL;
