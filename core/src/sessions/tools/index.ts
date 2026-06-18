// Slice 3: barrel + helpers for wiring NormalizedTools into runtimes.

import { tool, type FunctionTool } from "@openai/agents";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AnyNormalizedTool } from "./types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { exitPlanModeTool } from "./exit-plan-mode.js";

export type { NormalizedTool, AnyNormalizedTool } from "./types.js";
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

/** Adapt a NormalizedTool to the OpenAI Agents SDK's FunctionTool. */
export function toOpenAITool(
  nt: AnyNormalizedTool,
  opts: { permissionMode: PermissionMode },
): FunctionTool<unknown, never, string> {
  return tool({
    name: nt.name,
    description: nt.description,
    // The Agents SDK accepts a zod schema directly under strict mode.
    parameters: nt.parameters,
    strict: true,
    needsApproval: shouldRequireApproval(opts.permissionMode, nt.name),
    async execute(args, _ctx) {
      try {
        const out = await nt.execute(args);
        return typeof out === "string" ? out : JSON.stringify(out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Error: ${msg}`;
      }
    },
  }) as FunctionTool<unknown, never, string>;
}
