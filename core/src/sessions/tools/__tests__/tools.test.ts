// Slice 3.2 / 3.3: NormalizedTool happy-path + boundary tests for the 6
// built-in tools (Read / Edit / Write / Bash / Grep / Glob). Each test uses
// vitest's tmpdir-style fixture in os.tmpdir() — full Node runtime, real fs,
// no mocking. Bash is OS-aware (PowerShell on Windows, sh elsewhere).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, EOL } from "node:os";
import { join } from "node:path";
import { readTool } from "../read.js";
import { writeTool } from "../write.js";
import { editTool } from "../edit.js";
import { bashTool } from "../bash.js";
import { grepTool } from "../grep.js";
import { globTool } from "../glob.js";

let tmp: string;

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
    const out = await readTool.execute({ file_path: f });
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("gamma");
    expect(out).toMatch(/^\s*1\t/);
  });

  it("honors offset + limit (boundary: middle slice)", async () => {
    const f = join(tmp, "lines.txt");
    await writeFile(f, Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join("\n"));
    const out = await readTool.execute({ file_path: f, offset: 10, limit: 3 });
    const lines = (out as string).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/\b10\b.*L10/);
    expect(lines[2]).toMatch(/\b12\b.*L12/);
  });

  it("rejects relative paths (boundary)", async () => {
    await expect(readTool.execute({ file_path: "relative/path.txt" })).rejects.toThrow(/absolute/i);
  });
});

describe("Write", () => {
  it("creates the file and parent dirs", async () => {
    const f = join(tmp, "deep", "dir", "out.txt");
    const out = await writeTool.execute({ file_path: f, content: "hello" });
    expect(out).toMatch(/Wrote 5 bytes/);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(f, "utf8")).toBe("hello");
  });
});

describe("Edit", () => {
  it("replaces a unique occurrence", async () => {
    const f = join(tmp, "code.ts");
    await writeFile(f, "const x = 1;\nconst y = 2;");
    await editTool.execute({ file_path: f, old_string: "const y = 2;", new_string: "const y = 99;" });
    const { readFile } = await import("node:fs/promises");
    const updated = await readFile(f, "utf8");
    expect(updated).toContain("const y = 99;");
    expect(updated).not.toContain("const y = 2;");
  });

  it("refuses ambiguous edits unless replace_all (boundary)", async () => {
    const f = join(tmp, "ambig.txt");
    await writeFile(f, "X\nX\n");
    await expect(
      editTool.execute({ file_path: f, old_string: "X", new_string: "Y" }),
    ).rejects.toThrow(/multiple times/i);
    await editTool.execute({ file_path: f, old_string: "X", new_string: "Y", replace_all: true });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(f, "utf8")).toBe("Y\nY\n");
  });
});

describe("Bash", () => {
  it("returns stdout + exit code on a trivial command", async () => {
    // 'echo hi' works in both PowerShell and sh.
    const out = await bashTool.execute({ command: "echo hi" });
    expect(out).toContain("hi");
    expect(out).toMatch(/\[exit 0\]/);
  });

  it("reports nonzero exit (boundary)", async () => {
    // 'exit 42' works in both shells.
    const out = await bashTool.execute({ command: "exit 42" });
    expect(out).toMatch(/\[exit 42\]/);
  });
});

describe("Grep", () => {
  it("finds matching files (default mode)", async () => {
    await writeFile(join(tmp, "a.txt"), "match me");
    await writeFile(join(tmp, "b.txt"), "no hit");
    await mkdir(join(tmp, "sub"), { recursive: true });
    await writeFile(join(tmp, "sub", "c.txt"), "match too");
    const out = await grepTool.execute({ pattern: "match", path: tmp });
    const lines = (out as string).split(/\r?\n/).filter(Boolean);
    expect(lines.some((l) => l.includes("a.txt"))).toBe(true);
    expect(lines.some((l) => l.includes("c.txt"))).toBe(true);
    expect(lines.some((l) => l.includes("b.txt"))).toBe(false);
  });

  it("returns empty when no matches (boundary)", async () => {
    await writeFile(join(tmp, "a.txt"), "nope");
    const out = await grepTool.execute({ pattern: "zzz_never", path: tmp });
    expect(out).toBe("");
  });
});

describe("Glob", () => {
  it("matches *.txt pattern recursively (boundary: ** wildcard)", async () => {
    await writeFile(join(tmp, "a.txt"), "");
    await writeFile(join(tmp, "b.ts"), "");
    await mkdir(join(tmp, "nested"), { recursive: true });
    await writeFile(join(tmp, "nested", "c.txt"), "");
    const out = await globTool.execute({ pattern: "**/*.txt", path: tmp });
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
    const out = await globTool.execute({ pattern: "**/*.txt", path: tmp });
    const lines = (out as string).split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("keep.txt");
  });
});

// EOL kept imported for tests that need explicit \r\n compatibility; if
// future tests don't use it, vitest's no-unused-imports check should flag.
void EOL;
