import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager } from "./sessions/SessionManager.js";
import { backgroundSubagentStartedText } from "./sessions/subagentFinish.js";

export const SUBAGENT_MCP_SERVER_NAME = "agentorch-subagent";
export const SUBAGENT_TOOL_NAME = `mcp__${SUBAGENT_MCP_SERVER_NAME}__spawn_subagent`;

/** Pure closure over `parentId`. Extracted so the closure-binding invariant can
 *  be unit-tested without booting the SDK. Round-trips through
 *  SessionManager.spawnTaskSubagent so the child is a REAL Ensemble Agent row
 *  (nested under the parent in the sidebar tree), not an invisible in-SDK
 *  subagent. This is what the Claude runtime was missing entirely — the native
 *  SDK `Task` tool spawns subagents that never become Ensemble agents, so the
 *  user never saw them in the panel or the left agent list. */
export function makeSpawnSubagentHandler(
  sessions: Pick<SessionManager, "spawnTaskSubagent">,
  parentId: string,
): (args: {
  description: string;
  prompt: string;
  background?: boolean;
}) => Promise<{ finalText: string; subagentId: string; background?: boolean }> {
  return async (args) =>
    sessions.spawnTaskSubagent(parentId, args.description, args.prompt, {
      background: args.background === true,
    });
}

/** Per-call MCP exposing `spawn_subagent(description, prompt, background?)` to
 *  the Claude runtime. The child inherits the parent's model + provider and runs
 *  in an isolated context. It is a real Ensemble agent visible in the sidebar. */
export function makeSubagentMcpServer(
  sessions: SessionManager,
  parentId: string,
): McpSdkServerConfigWithInstance {
  const handler = makeSpawnSubagentHandler(sessions, parentId);
  const spawnSubagent = tool(
    "spawn_subagent",
    "Spawn a subagent as a REAL Ensemble agent (visible nested under you in the " +
      "sidebar tree — unlike the built-in Task tool, whose subagents are invisible). " +
      "The subagent inherits your model + provider and runs in an isolated context. " +
      "Prefer this over the native Task tool so the user can watch the work. " +
      "Set background=true to spawn a detached BACKGROUND TASK: the tool returns the " +
      "subagent's id immediately and you keep working while it runs; you will be sent a " +
      "`subagent-finished` message when it reaches a terminal state. Omit background to " +
      "wait and receive the final response. Subagent depth is capped at 3 levels.",
    {
      description: z.string().min(1).describe("Short task summary (3-5 words); becomes the subagent's name."),
      prompt: z.string().min(1).describe("Full task description / instructions for the subagent."),
      background: z
        .boolean()
        .optional()
        .describe(
          "true = detached background task (returns id immediately, you keep working). " +
            "false/omitted = wait and return the subagent's final response.",
        ),
    },
    async (args) => {
      const result = await handler(args);
      const text = result.background
        ? backgroundSubagentStartedText(result.subagentId)
        : result.finalText;
      return { content: [{ type: "text" as const, text }] };
    },
  );
  return createSdkMcpServer({
    name: SUBAGENT_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [spawnSubagent],
  });
}
