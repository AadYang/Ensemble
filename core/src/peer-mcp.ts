import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { PeerIncludeSource } from "@agentorch/shared";
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
): (args: {
  target: string;
  message: string;
  mode?: typeof PEER_MODES[number];
  includeSource?: PeerIncludeSource;
  interrupt?: boolean;
  interruptReason?: string;
}) => Promise<string> {
  return async (args) =>
    sessions.sendPeerMessage(fromAgentId, args.target, args.message, args.mode ?? "raw", {
      includeSource: args.includeSource,
      interrupt: args.interrupt,
      interruptReason: args.interruptReason,
    });
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
      "back to the source agent; their reply arrives as a new turn in your chat.",
      "",
      "Modes, from the sender's perspective:",
      "  - continue: hand off your work-in-progress; recipient continues from your trajectory.",
      "  - review:   ask recipient for a second-opinion audit of your work; quote verbatim.",
      "  - fork:     same task, different approach; recipient should NOT replicate your path.",
      "  - raw:      plain message forwarding (default).",
      "",
      "Source context defaults to includeSource='auto': raw sends only your message;",
      "continue/review/fork include a bounded <<<source-output>>> block with your current",
      "or most recent key output. If more context is needed, the recipient should use peer_query.",
      "",
      "interrupt=true is emergency-only: use it only when delayed delivery would make the",
      "message stale or cause the target to continue incorrectly. You must provide",
      "interruptReason. Ordinary notifications, questions, and handoffs must not interrupt.",
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
      includeSource: z
        .union([z.boolean(), z.literal("auto")])
        .optional()
        .describe("Whether to include source-output. Default 'auto': raw=false, continue/review/fork=true."),
      interrupt: z
        .boolean()
        .optional()
        .describe("Emergency only. Interrupt the target's current run so this message is delivered immediately."),
      interruptReason: z
        .string()
        .optional()
        .describe("Required when interrupt=true. Explain why delayed delivery would be harmful or stale."),
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
      "you received a peer-handoff but need more context, or when you want to inspect",
      "a peer agent before sending them work.",
      "",
      "Does NOT cause the target agent to run; it is a pure DB read. The returned text",
      "is chronological (oldest to newest), interleaving [user] and [assistant] markers.",
      "Tool-use noise is filtered out; only natural-language text is included.",
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
