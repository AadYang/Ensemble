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

const BASH_SCHEMA = z.object({
  command: z.string().describe("The shell command to execute."),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .optional()
    .describe("Maximum execution time in milliseconds (default 120000, max 600000)."),
  cwd: z.string().optional().describe("Working directory; defaults to the agent's cwd."),
});

const DEFAULT_TIMEOUT = 120_000;

function shellFor(command: string): { cmd: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return { cmd: "sh", args: ["-c", command] };
}

export const bashTool: NormalizedTool<typeof BASH_SCHEMA> = {
  name: "Bash",
  description:
    "Run a shell command. Returns combined stdout+stderr plus the exit code. " +
    "Windows runs PowerShell; macOS/Linux runs sh. Default timeout 120s (max 600s).",
  parameters: BASH_SCHEMA,
  async execute({ command, timeout_ms = DEFAULT_TIMEOUT, cwd }) {
    const { cmd, args } = shellFor(command);
    const child = spawn(cmd, args, {
      cwd: cwd ?? process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    const chunks: string[] = [];
    const collect = (buf: Buffer) => chunks.push(buf.toString("utf8"));
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

    const output = chunks.join("");
    const trailer = timedOut
      ? `\n[timeout after ${timeout_ms}ms; SIGKILL'd]`
      : `\n[exit ${exitCode}]`;
    return output + trailer;
  },
};
