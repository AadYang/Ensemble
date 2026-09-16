// The CLAUDE-side surface of the job primitive: the `agentorch-jobs` MCP
// server.
//
// The operations themselves and their rendering live in `jobs.ts` — this file
// only declares them as MCP tools, because Codex reaches the same operations
// through the internal bridge (sessions/mcp-bridge.ts) and OpenAI through the
// normalized-tool path (sessions/tools/session-aware.ts). One implementation,
// three transports.
//
// The tools here are the ONLY sanctioned way to start work that may outlive a
// turn. They exist because the alternative — the agent CLI's own background
// shell — is a child of the CLI process, and therefore dies with the session
// (see the header of `jobs.ts` for the outage that made this concrete).
//
// The descriptions are part of the mechanism, not decoration: an agent that
// does not know why `job_start` exists will reach for the tool it already has,
// and the failure returns. So each description says what the tool is FOR and
// what it protects against.

import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  JOB_WAIT_MAX_MS,
  jobCancelToolText,
  jobStartToolText,
  jobStatusToolText,
  jobWaitToolText,
  type JobToolContext,
} from "./jobs.js";

export const JOBS_MCP_SERVER_NAME = "agentorch-jobs";
export const JOB_START_TOOL_NAME = `mcp__${JOBS_MCP_SERVER_NAME}__job_start`;
export const JOB_STATUS_TOOL_NAME = `mcp__${JOBS_MCP_SERVER_NAME}__job_status`;
export const JOB_WAIT_TOOL_NAME = `mcp__${JOBS_MCP_SERVER_NAME}__job_wait`;
export const JOB_CANCEL_TOOL_NAME = `mcp__${JOBS_MCP_SERVER_NAME}__job_cancel`;

const JOB_START_DESCRIPTION =
  "Start a long-running command whose OWNER IS ENSEMBLE'S SERVER, not this agent process, and return immediately with a job id. " +
  "Use this — not a background shell — for anything that may outlive the current turn: builds, installers, test suites, long downloads. " +
  "A background shell is a child of this agent process, so it is killed when the session is recycled (for example when the context window fills) " +
  "and its exit is never recorded; a job survives that, keeps writing to a log file, and always ends with a recorded status. " +
  "Poll with job_status, or block with job_wait. Output is streamed to a log file you can read in full.";

const JOB_STATUS_DESCRIPTION =
  "Report one job's status (running / exited / failed / cancelled / lost), its exit code, and the last lines of its log. " +
  "With no job id, list this agent's jobs. `lost` means the process is gone without a recorded exit — the honest answer after a crash — " +
  "and it is never reported as success.";

const JOB_WAIT_DESCRIPTION =
  "Block until a job reaches a terminal status or the timeout elapses, then report it the same way job_status does. " +
  "Prefer this to polling when you have nothing else to do; the timeout is capped so a turn can never hang here forever.";

const JOB_CANCEL_DESCRIPTION =
  "Kill a running job and its descendants. The job is recorded as `cancelled`, with whatever it printed kept in its log.";

export function makeJobsMcpServer(ctx: JobToolContext): McpSdkServerConfigWithInstance {
  const start = tool(
    "job_start",
    JOB_START_DESCRIPTION,
    {
      command: z
        .string()
        .min(1)
        .describe("Shell command. Auto detects common Git-Bash syntax on Windows; otherwise uses PowerShell."),
      shell: z
        .enum(["auto", "powershell", "sh"])
        .optional()
        .describe('Shell contract. Default auto; use "sh" for Git-Bash syntax on Windows.'),
      cwd: z.string().optional().describe("Working directory; defaults to the agent's project root."),
      timeout_ms: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional hard ceiling. Omit for work whose length is unknown — a job has no default timeout."),
    },
    async (args) => {
      try {
        return { content: [{ type: "text" as const, text: jobStartToolText(ctx, args) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `job_start failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  const status = tool(
    "job_status",
    JOB_STATUS_DESCRIPTION,
    {
      job_id: z.string().optional().describe("Job id from job_start. Omit to list this agent's jobs."),
    },
    async (args) => {
      const r = jobStatusToolText(ctx, args);
      return {
        content: [{ type: "text" as const, text: r.text }],
        ...(r.isError ? { isError: true as const } : {}),
      };
    },
  );

  const wait = tool(
    "job_wait",
    JOB_WAIT_DESCRIPTION,
    {
      job_id: z.string().min(1).describe("Job id from job_start."),
      timeout_ms: z
        .number()
        .int()
        .min(1)
        .max(JOB_WAIT_MAX_MS)
        .optional()
        .describe(`How long to wait before reporting the job as still running (max ${JOB_WAIT_MAX_MS}).`),
    },
    async (args) => {
      const r = await jobWaitToolText(ctx, args);
      return {
        content: [{ type: "text" as const, text: r.text }],
        ...(r.isError ? { isError: true as const } : {}),
      };
    },
  );

  const cancel = tool(
    "job_cancel",
    JOB_CANCEL_DESCRIPTION,
    {
      job_id: z.string().min(1).describe("Job id from job_start."),
    },
    async (args) => {
      const r = jobCancelToolText(ctx, args);
      return {
        content: [{ type: "text" as const, text: r.text }],
        ...(r.isError ? { isError: true as const } : {}),
      };
    },
  );

  return createSdkMcpServer({
    name: JOBS_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [start, status, wait, cancel],
  });
}
