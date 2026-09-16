// The six built-in tools take their working directory from the turn's project
// root, and NOT from the process's own directory.
//
// This is the OpenAI/API runtime's whole directory story: the tools run
// in-process over HTTP, so the only thing that can tell them where the agent
// works is the context the runtime hands them. Before this, Bash/Glob/Grep
// resolved a missing path against `process.cwd()` — the sidecar's install
// directory, a tree the model never chose and cannot see.
//
// The native runtimes do not go through these tools at all (their CLI provides
// equivalents scoped by the spawn cwd); the adapter assertion at the bottom is
// the seam the OpenAI runtime uses.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "../read.js";
import { writeTool } from "../write.js";
import { editTool } from "../edit.js";
import { bashTool } from "../bash.js";
import { grepTool } from "../grep.js";
import { globTool } from "../glob.js";
import { toOpenAITool } from "../index.js";
import type { ToolContext } from "../types.js";

let projectRootDir: string;
let elsewhere: string;
const ctx = (): ToolContext => ({ projectRoot: projectRootDir });

/** `pwd` is the one probe both shells answer without a call operator (Windows
 *  runs the command through PowerShell, where a quoted executable path is a
 *  syntax error, and POSIX runs it through sh). Comparing separator-normalized
 *  keeps the assertion about the DIRECTORY, not about Windows vs POSIX. */
const norm = (value: string): string => value.replace(/\\/g, "/").toLowerCase();

beforeEach(() => {
  projectRootDir = mkdtempSync(join(tmpdir(), "ensemble-ctx-root-"));
  elsewhere = mkdtempSync(join(tmpdir(), "ensemble-ctx-elsewhere-"));
});

afterEach(() => {
  rmSync(projectRootDir, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

describe("tools resolve against ctx.projectRoot", () => {
  it("Bash runs in the project root by default", async () => {
    const out = await bashTool.execute({ command: "pwd" }, ctx());
    expect(norm(String(out))).toContain(norm(projectRootDir));
    // ...and not in whatever directory the test process happens to be in.
    expect(norm(String(out))).not.toContain(norm(process.cwd()));
  });

  it("Bash still honors an explicit cwd when the model passes one", async () => {
    const out = await bashTool.execute({ command: "pwd", cwd: elsewhere }, ctx());
    expect(norm(String(out))).toContain(norm(elsewhere));
  });

  it("Glob uses the project root when no path is given", async () => {
    writeFileSync(join(projectRootDir, "only-here.txt"), "x");
    writeFileSync(join(elsewhere, "only-there.txt"), "x");
    const out = (await globTool.execute({ pattern: "**/*.txt" }, ctx())) as string;
    expect(out).toContain("only-here.txt");
    expect(out).not.toContain("only-there.txt");
  });

  it("Grep searches the project root when no path is given", async () => {
    writeFileSync(join(projectRootDir, "root.md"), "needle-in-project");
    writeFileSync(join(elsewhere, "other.md"), "needle-elsewhere");
    const out = (await grepTool.execute({ pattern: "needle", output_mode: "content" }, ctx())) as string;
    expect(out).toContain("needle-in-project");
    expect(out).not.toContain("needle-elsewhere");
  });

  it("Grep resolves a RELATIVE path against the project root, not the sidecar's", async () => {
    mkdirSync(join(projectRootDir, "src"));
    writeFileSync(join(projectRootDir, "src", "a.ts"), "relative-hit");
    const out = (await grepTool.execute({ pattern: "relative-hit", path: "src" }, ctx())) as string;
    expect(out).toContain("a.ts");
  });
});

describe("file tools name the project root when refusing a relative path", () => {
  // The rule is unchanged (absolute only); what the error now carries is the
  // directory to resolve against, so a refused call is correctable in one step.
  it.each([
    ["Read", () => readTool.execute({ file_path: "rel.txt" }, ctx())],
    ["Edit", () => editTool.execute({ file_path: "rel.txt", old_string: "a", new_string: "b" }, ctx())],
    ["Write", () => writeTool.execute({ file_path: "rel.txt", content: "x" }, ctx())],
  ] as const)("%s", async (_name, run) => {
    await expect(run()).rejects.toThrow(/path must be absolute/);
    await expect(run()).rejects.toThrow(new RegExp(escapeRe(projectRootDir)));
  });

  it("never silently joins a relative path onto the root", async () => {
    // The message suggests the resolved path; the call itself still fails, so a
    // model that ignores the advice cannot end up reading a file it did not
    // name. Nothing is created or read by the refusal either.
    const err = await readTool.execute({ file_path: "rel.txt" }, ctx()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(join(projectRootDir, "rel.txt"));
  });
});

describe("the OpenAI adapter hands the plan's root to the tool", () => {
  it("invokes Bash in the root the adapter was constructed with", async () => {
    const tool = toOpenAITool(bashTool, {
      permissionMode: "bypassPermissions",
      projectRoot: projectRootDir,
    });
    const out = await tool.invoke({} as never, JSON.stringify({ command: "pwd" }));
    expect(norm(String(out))).toContain(norm(projectRootDir));
    expect(norm(String(out))).not.toContain(norm(elsewhere));
  });

  it("keeps the approval policy independent of the root", async () => {
    const readOnly = toOpenAITool(readTool, { permissionMode: "default", projectRoot: projectRootDir });
    const shell = toOpenAITool(bashTool, { permissionMode: "default", projectRoot: projectRootDir });
    expect(await readOnly.needsApproval({} as never, { file_path: join(projectRootDir, "a.txt") } as never)).toBe(false);
    expect(await shell.needsApproval({} as never, { command: "echo hi" } as never)).toBe(true);
  });
});

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Guards the fixture itself: if the two temp dirs could ever be the same path,
// "resolves in the root" and "does not resolve elsewhere" would be one claim.
it("fixtures are distinct directories", () => {
  expect(projectRootDir).not.toBe(elsewhere);
});
