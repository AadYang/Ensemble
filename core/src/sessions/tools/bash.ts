// Slice 3.2: Bash tool. Cross-platform shell execution.
//   Windows  → powershell.exe -NoProfile -NonInteractive -Command <cmd>
//   POSIX    → sh -c <cmd>
//
// Per user decision in Slice 3 kickoff. Stdout + stderr are concatenated and
// returned together (matches Claude SDK's Bash behavior). Exit code is
// reported in the trailing line.

import { spawn } from "node:child_process";
import { z } from "zod";
import type { NormalizedTool } from "./types.js";
import { finalizeToolOutput, openToolOutputSpool, toolOutputResult } from "./tool-output.js";

const BASH_SCHEMA = z.object({
  command: z.string().describe("The shell command to execute."),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .optional()
    .describe("Maximum execution time in milliseconds (default 120000, max 600000)."),
  cwd: z.string().optional().describe("Working directory; defaults to the agent's project root."),
});

const DEFAULT_TIMEOUT = 120_000;

/** Exported so `jobs.ts` spawns a job through the SAME platform shell this tool
 *  uses. Two implementations of "how do we run a command on this OS" is how the
 *  two paths start disagreeing about quoting, and a job that runs a subtly
 *  different command than the agent wrote is worse than one that fails. */
export function shellFor(command: string): { cmd: string; args: string[] } {
  if (process.platform === "win32") {
    // `powershell -Command <cmd>` does NOT propagate a native command's exit
    // code: measured on this machine, `cmd /c exit 7`, `cmd /c exit 1` and
    // `node -e "process.exit(3)"` ALL come back as 1. Without the trailer below
    // every failure in the product reads as "exit 1" — a compiler error, a
    // missing binary and a failed test suite become indistinguishable, and the
    // job primitive would write a terminal record whose exit code is a lie.
    //
    // The trailer is on its OWN LINE, not joined with `;`: a command ending in
    // a `#` comment would otherwise swallow the guard and silently restore the
    // old behavior. `$LASTEXITCODE` is only consulted when a native command
    // actually set it (a pure-cmdlet command leaves it null — PowerShell exits
    // 0 for `exit $null`, which would turn a parse error into success), so the
    // `$?` fallback keeps a cmdlet-only failure failing.
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif ($?) { exit 0 } else { exit 1 }`,
      ],
    };
  }
  // `sh -c` already returns the last command's status; nothing to correct.
  return { cmd: "sh", args: ["-c", command] };
}

export const bashTool: NormalizedTool<typeof BASH_SCHEMA> = {
  name: "Bash",
  description:
    "Run a shell command. Returns combined stdout+stderr plus the exit code. " +
    "Windows runs PowerShell; macOS/Linux runs sh. Default timeout 120s (max 600s).",
  parameters: BASH_SCHEMA,
  async execute({ command, timeout_ms = DEFAULT_TIMEOUT, cwd }, ctx) {
    const { cmd, args } = shellFor(command);
    // The default is the TURN's project root, never `process.cwd()`: the
    // sidecar's own directory is not the agent's project, and a command that
    // resolved against it would run in the wrong tree silently.
    const child = spawn(cmd, args, {
      cwd: cwd ?? ctx.projectRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    // Chunks go into the SPOOL as they arrive, not into an array that is joined
    // at the end: a command that prints a gigabyte must not be held in memory
    // just so the result can then be measured and stored. The spool keeps the
    // first `budgetBytes` in memory and puts the rest in a temporary file.
    //
    // The spool decodes through a StringDecoder rather than per chunk, which is
    // what keeps a multi-byte character that straddles a stdout chunk boundary
    // from becoming two U+FFFD: the split is a property of the pipe (64 KiB on
    // Windows), not of the output, so it can land inside any CJK character or
    // emoji — and the result would read as if the command had printed a
    // replacement character.
    const spool = openToolOutputSpool(ctx, "bash");
    try {
      const collect = (buf: Buffer) => spool.write(buf);
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout_ms);

      const exitCode: number = await new Promise((resolve) => {
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          // SIGKILL via timeout → expose as 124 (GNU timeout convention).
          if (timedOut) resolve(124);
          else if (typeof code === "number") resolve(code);
          else if (signal) resolve(128);
          else resolve(-1);
        });
        child.once("error", () => {
          clearTimeout(timer);
          resolve(-1);
        });
      });

      const trailer = timedOut
        ? `\n[timeout after ${timeout_ms}ms; SIGKILL'd]`
        : `\n[exit ${exitCode}]`;
      // Into the spool, so the size and the digest already cover it: the artifact
      // holds the exit code too, and nothing has to be rebuilt around it.
      spool.write(trailer);
      return toolOutputResult(
        finalizeToolOutput({
          ctx,
          tool: "Bash",
          source: spool,
          narrowing:
            "reduce what the command prints (pipe it through tail/head, add -q, or redirect it to a file and read " +
            "that file in pages)",
        }),
      );
    } finally {
      // Also on failure: a timed-out or errored command wrote a spill file like
      // any other, and leaving it behind is a leak on the user's disk.
      spool.dispose();
    }
  },
};
