import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager } from "./sessions/SessionManager.js";

export const PEER_MCP_SERVER_NAME = "agentorch-peer";
export const PEER_SEND_TOOL_NAME = `mcp__${PEER_MCP_SERVER_NAME}__peer_send`;
export const PEER_QUERY_TOOL_NAME = `mcp__${PEER_MCP_SERVER_NAME}__peer_query`;

const PEER_MODES = ["continue", "review", "fork", "raw"] as const;

/** Pure closure over `fromAgentId`. Extracted so the closure-binding
 *  invariant can be unit-tested without booting the SDK. The MCP server
 *  factory below is a thin wrapper that exposes this through the tool API. */
export function makePeerSendHandler(
  sessions: Pick<SessionManager, "sendPeerMessage">,
  fromAgentId: string,
): (args: { target: string; message: string; mode?: typeof PEER_MODES[number] }) => Promise<string> {
  return async (args) =>
    sessions.sendPeerMessage(fromAgentId, args.target, args.message, args.mode ?? "raw");
}

/** Read-only counterpart to peer_send: pull peer agent's recent text turns.
 *  Same closure-over-fromAgentId contract for unit testability + self-exclusion. */
export function makePeerQueryHandler(
  sessions: Pick<SessionManager, "fetchPeerHistory">,
  fromAgentId: string,
): (args: { target: string; limit?: number }) => Promise<string> {
  return async (args) => sessions.fetchPeerHistory(fromAgentId, args.target, args.limit ?? 20);
}

/** Build a per-call MCP server whose `peer_send` tool is bound to a specific
 * source agent. Each query() invocation gets its own instance so the handler's
 * closure knows which agent is sending. */
export function makePeerMcpServer(
  sessions: SessionManager,
  fromAgentId: string,
): McpSdkServerConfigWithInstance {
  const sendHandler = makePeerSendHandler(sessions, fromAgentId);
  const queryHandler = makePeerQueryHandler(sessions, fromAgentId);
  const peerSend = tool(
    "peer_send",
    [
      "Send a chat message to another agent in this workspace. Bidirectional: anyone can",
      "send to anyone. If you received a peer-handoff and need more info, you can peer_send",
      "back to the source agent (their reply will arrive as a new turn in your chat).",
      "",
      "Modes (cxsm-style handoff semantics — sender's perspective):",
      "  - continue: hand off your work-in-progress; recipient continues from your trajectory.",
      "  - review:   ask recipient for a second-opinion audit of your work; quote verbatim.",
      "  - fork:     same task, different approach; recipient should NOT replicate your path.",
      "  - raw:      plain message forwarding (default).",
      "",
      "All modes now embed a `<<<source-output>>>` block carrying your most recent assistant",
      "output, so the recipient sees the artifact you're forwarding — not just the body text.",
      "",
      "Use the target agent's name (preferred) or its UUID.",
      "Returns delivery status; does NOT wait for the recipient to reply.",
      "For read-only context pulls, prefer peer_query (synchronous, no run).",
    ].join("\n"),
    {
      target: z
        .string()
        .min(1)
        .describe("Name (preferred) or UUID of the recipient agent."),
      message: z.string().min(1).describe("Body of the message to send."),
      mode: z
        .enum(PEER_MODES)
        .optional()
        .describe(
          "Handoff semantics: continue|review|fork|raw. Default 'raw' (plain forwarding).",
        ),
    },
    async (args) => {
      const result = await sendHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
  const peerQuery = tool(
    "peer_query",
    [
      "Pull another agent's recent text turns (read-only, synchronous). Use this when",
      "you received a peer-handoff but feel the embedded source-output is too short to",
      "judge — or when you want to know what a peer agent has been up to before",
      "sending them work.",
      "",
      "Does NOT cause the target agent to run; it's a pure DB read. The returned text",
      "is chronological (oldest → newest), interleaving [user] and [assistant] markers.",
      "Tool-use noise is filtered out — only natural-language text is included.",
    ].join("\n"),
    {
      target: z
        .string()
        .min(1)
        .describe("Name (preferred) or UUID of the peer agent."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max user-turn boundaries to walk back (default 20, max 50)."),
    },
    async (args) => {
      const result = await queryHandler(args);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
  return createSdkMcpServer({
    name: PEER_MCP_SERVER_NAME,
    version: "0.3.0",
    tools: [peerSend, peerQuery],
  });
}
