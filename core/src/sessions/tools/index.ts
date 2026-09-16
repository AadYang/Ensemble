// Slice 3: barrel + helpers for wiring NormalizedTools into runtimes.

import { tool, type FunctionTool } from "@openai/agents";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AnyNormalizedTool, ToolContext, ToolOutputSink } from "./types.js";
import { finalizeToolOutput, stringSource } from "./tool-output.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { exitPlanModeTool } from "./exit-plan-mode.js";

export type {
  NormalizedTool,
  AnyNormalizedTool,
  ToolContext,
  ToolOutputSink,
  ToolOutputPresentation,
} from "./types.js";
export type { LineSearchResult, ToolResultTooLarge } from "./tool-output.js";
export { readTool, writeTool, editTool, bashTool, grepTool, globTool, exitPlanModeTool };
export {
  makePeerSendTool,
  makePeerQueryTool,
  makeConversationSearchTool,
  makeAskUserTool,
  makeTaskTool,
  makeEnsembleHelpTool,
  makeSkillListTool,
  makeSkillInvokeTool,
  makeArtifactReadTool,
  makeArtifactSearchTool,
  makeJobTools,
} from "./session-aware.js";

/** All built-in NormalizedTools. OpenAIAgentRuntime registers these via
 *  toOpenAITool(); Claude side ignores (CLI provides native equivalents).
 *  ExitPlanMode is included since it's static (no session closure). The
 *  session-aware tools (peer_send / ask_user / Task) are added per-call by
 *  OpenAIAgentRuntime using the makeXxxTool factories. */
export const NORMALIZED_TOOLS: readonly AnyNormalizedTool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  globTool,
  exitPlanModeTool,
];

/** Read-only tools never trigger approval prompts: they don't mutate state
 *  and don't escape the sandbox. */
const READ_ONLY_TOOL_NAMES = new Set(["Read", "Grep", "Glob"]);

/** Session-aware coordination tools are system-level safe operations: they
 *  fan messages between agents (peer_send / peer_query), surface UI dialogs
 *  (ask_user), or delegate to subagents whose own tools are gated independently
 *  (Task). Match Claude side semantics where these are in `allowedTools`
 *  (auto-approve). peer_query is read-only DB-only, never needs approval. */
const SESSION_AWARE_FREE_TOOLS = new Set([
  "peer_send",
  "peer_query",
  "conversation_search",
  "ask_user",
  "Task",
  "ensemble_help",
  "skill_list",
  "skill_invoke",
  // Reading a stored result is a read-only DB lookup of the caller's own
  // transcript material — same class as peer_query / conversation_search.
  "artifact_read",
  "artifact_search",
  // Job status/log reads are inert, and the case jobs exist for is the one
  // where nobody is watching — a prompt here would stall the very loop that
  // checks on unattended work. Wait is bounded by JOB_WAIT_MAX_MS.
  //
  // job_start and job_cancel are deliberately NOT free: they execute and kill
  // processes, the class the Bash tool still gates. Freeing them would make
  // the job primitive a way around the permission prompt.
  "job_status",
  "job_wait",
]);

/** Maps a permissionMode + tool name to whether the SDK should pause for
 *  approval. See docs/plans/openai-permission-state-machine.md §3 + Slice 5
 *  for the full table. */
export function shouldRequireApproval(mode: PermissionMode, toolName: string): boolean {
  if (mode === "bypassPermissions" || mode === "dontAsk") return false;
  // Session-aware coordination tools never gate (Claude side parity).
  if (SESSION_AWARE_FREE_TOOLS.has(toolName)) return false;
  // ExitPlanMode gates only in plan mode — that's its whole job there.
  // In other modes it degrades to a no-op echo of the plan text.
  if (toolName === "ExitPlanMode") return mode === "plan";
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return false;
  if (mode === "acceptEdits") {
    // Edits accepted silently; shell still gates because it can have side
    // effects beyond the workspace (git push, curl, rm -rf, etc.).
    return toolName === "Bash";
  }
  // default / plan: gate all write/shell tools.
  return true;
}

/** Adapt a NormalizedTool to the OpenAI Agents SDK's FunctionTool.
 *
 *  `projectRoot` is the turn's directory (from the run plan) and is passed to
 *  the tool as its context. It is NOT the SDK's own cwd: the Agents SDK runs
 *  in-process, so its HTTP runtime's tools have no working directory of their
 *  own and used to fall back to the sidecar's.
 *
 *  This wrapper is also the LAST core-owned point before a tool result becomes
 *  model input — past it the result belongs to the SDK's runner. So it is where
 *  a result from a tool that does not bound its own output (Read, Bash) is
 *  measured against the turn's tool-result budget: over budget, the complete
 *  bytes are stored as a `tool-output` artifact FIRST and the model is handed a
 *  preview plus the artifact handle. Grep / Glob already do this themselves and
 *  answer with an object, which passes through untouched. */
export function toOpenAITool(
  nt: AnyNormalizedTool,
  opts: { permissionMode: PermissionMode; projectRoot: string; toolOutput?: ToolOutputSink },
): FunctionTool<unknown, never, string> {
  const ctx: ToolContext = {
    projectRoot: opts.projectRoot,
    ...(opts.toolOutput ? { toolOutput: opts.toolOutput } : {}),
  };
  return tool({
    name: nt.name,
    description: nt.description,
    // The Agents SDK accepts a zod schema directly under strict mode.
    parameters: nt.parameters,
    strict: true,
    needsApproval: shouldRequireApproval(opts.permissionMode, nt.name),
    async execute(args, _ctx) {
      try {
        const out = await nt.execute(args, ctx);
        if (typeof out !== "string") return JSON.stringify(out);
        const bounded = finalizeToolOutput({
          ctx,
          tool: nt.name,
          source: stringSource(out),
          narrowing:
            `ask for less in the call itself: ${nt.name} with a narrower request (a smaller limit/offset, ` +
            "a pattern that matches less), or a command that reports a summary instead of the whole stream",
        });
        if (bounded.kind === "artifact") return bounded.presentation.text;
        if (bounded.kind === "too_large") return JSON.stringify(bounded.error);
        return bounded.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error: ${msg}`;
      }
    },
  }) as FunctionTool<unknown, never, string>;
}
