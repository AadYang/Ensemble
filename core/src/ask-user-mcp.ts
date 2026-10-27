import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager } from "./sessions/SessionManager.js";

export const ASK_USER_MCP_SERVER_NAME = "agentorch-ask-user";
export const ASK_USER_TOOL_NAME = `mcp__${ASK_USER_MCP_SERVER_NAME}__ask_user`;

/** Pure closure over `fromAgentId`. Extracted so the closure-binding
 *  invariant can be unit-tested without booting the SDK. */
export function makeAskUserHandler(
  sessions: Pick<SessionManager, "askUser">,
  fromAgentId: string,
): (args: { question: string; options?: string[] }) => Promise<string> {
  return async (args) => sessions.askUser(fromAgentId, args.question, args.options ?? []);
}

/** Per-call MCP exposing `ask_user(question, options)`. The handler suspends
 * the agent's stream until the user clicks a button or submits typed text. */
export function makeAskUserMcpServer(
  sessions: SessionManager,
  fromAgentId: string,
): McpSdkServerConfigWithInstance {
  const handler = makeAskUserHandler(sessions, fromAgentId);
  const askUser = tool(
    "ask_user",
    "Ask the HUMAN a question and wait. Optional `options` appear as buttons; the user may click one OR type a free-text answer. The tool returns whatever they submitted. Omit options or pass [] for an open question.",
    {
      question: z.string().min(1).describe("Question text shown to the user."),
      options: z
        .array(z.string().min(1))
        .optional()
        .default([])
        .describe("Optional button labels. The user can still type a custom answer. Empty = open question."),
    },
    async (args) => {
      const choice = await handler(args);
      return { content: [{ type: "text" as const, text: choice }] };
    },
  );
  return createSdkMcpServer({
    name: ASK_USER_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [askUser],
  });
}
