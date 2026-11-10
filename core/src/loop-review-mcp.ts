import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager } from "./sessions/SessionManager.js";
import { LOOP_REVIEW_ACTIONS, LOOP_REVIEW_DESCRIPTION, type LoopReviewArgs } from "./loop-review-tool.js";

export const LOOP_REVIEW_MCP_SERVER_NAME = "agentorch-loop";
export const LOOP_REVIEW_TOOL_NAME = `mcp__${LOOP_REVIEW_MCP_SERVER_NAME}__loop_review`;

export const LOOP_REVIEW_SCHEMA_SHAPE = {
  action: z.enum(LOOP_REVIEW_ACTIONS).describe("read | post | reply | resolve | lgtm"),
  itemId: z.string().optional().describe("Finding id such as R1. Required for reply and resolve."),
  title: z.string().optional().describe("Short finding title. post only."),
  text: z.string().optional().describe("Finding body (post) or reply body (reply)."),
  runner: z.string().optional().describe("Runner name or UUID when you review more than one loop."),
};

export function makeLoopReviewHandler(
  sessions: Pick<SessionManager, "loopReview">,
  fromAgentId: string,
): (args: LoopReviewArgs) => Promise<string> {
  return async (args) => sessions.loopReview(fromAgentId, args);
}

export function makeLoopReviewMcpServer(
  sessions: SessionManager,
  fromAgentId: string,
): McpSdkServerConfigWithInstance {
  const handler = makeLoopReviewHandler(sessions, fromAgentId);
  const loopReview = tool(
    "loop_review",
    LOOP_REVIEW_DESCRIPTION,
    LOOP_REVIEW_SCHEMA_SHAPE,
    async (args) => {
      const text = await handler(args);
      return { content: [{ type: "text" as const, text }] };
    },
  );
  return createSdkMcpServer({
    name: LOOP_REVIEW_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [loopReview],
  });
}
