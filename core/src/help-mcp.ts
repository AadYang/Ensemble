// Claude SDK MCP factory for the ensemble_help tool. Mirrors peer-mcp.ts /
// ask-user-mcp.ts pattern. Stateless — no fromAgentId binding needed since
// the help content is global static. The factory still takes no real
// dependencies; we wrap it in an SDK McpServer so Claude SDK can discover
// the tool via its allowedTools auto-approval list.

import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { formatEnsembleHelp, HELP_TOPIC_NAMES } from "./help/index.js";

export const HELP_MCP_SERVER_NAME = "agentorch-help";
export const ENSEMBLE_HELP_TOOL_NAME = `mcp__${HELP_MCP_SERVER_NAME}__ensemble_help`;

export function makeHelpMcpServer(): McpSdkServerConfigWithInstance {
  const helpTool = tool(
    "ensemble_help",
    [
      "Ensemble runtime guidance. Call this BEFORE attempting Ensemble-specific",
      "tasks (mount an MCP server, switch provider, configure sandbox, etc.) —",
      "Ensemble's own source code is NOT on the user's machine, so don't try to",
      "Grep for it. The returned text describes UI paths + HTTP API endpoints.",
      "",
      `Topics: ${HELP_TOPIC_NAMES.join(", ")}.`,
      "Call with no topic for the index.",
    ].join("\n"),
    {
      topic: z
        .string()
        .optional()
        .describe(`Topic name. One of: ${HELP_TOPIC_NAMES.join(", ")}.`),
    },
    async ({ topic }) => {
      return { content: [{ type: "text" as const, text: formatEnsembleHelp(topic) }] };
    },
  );
  return createSdkMcpServer({
    name: HELP_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [helpTool],
  });
}
