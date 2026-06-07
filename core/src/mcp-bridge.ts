// W20 Slice 5.5: HTTP MCP bridge for the codex runtime.
//
// codex CLI consumes MCP servers via TOML `[mcp_servers.X]` entries in
// ~/.codex/config.toml (or `--config` overrides from the codex SDK). It does
// NOT accept in-process JavaScript MCP server instances (unlike Claude SDK's
// createSdkMcpServer). So to give codex access to Ensemble's internal tools
// (peer_send / ask_user / Task), we expose them over a streamable-HTTP MCP
// endpoint hosted inside Ensemble core's Fastify, and inject the URL into
// codex's config.mcp_servers map.
//
// Security: the URL embeds a boot-time bridge token. Requests without a
// matching token are rejected. The token never leaves the local machine
// (codex CLI is loopback-only). The URL also carries agentId so the
// handler set is bound per-agent — same fromAgentId closure invariant as
// the Claude side's makePeerMcpServer/makeAskUserMcpServer factories.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const BRIDGE_TOKEN = randomUUID();
// The internal Fastify route. Other API routes in core/src/index.ts are
// registered WITHOUT the /api/ prefix because a `prependListener("request")`
// hook on the underlying http.Server strips it before Fastify routes. So
// the route handler must register at `/mcp/internal`, but external callers
// (codex CLI / browsers in packaged mode) still hit `/api/mcp/internal`.
const BRIDGE_ROUTE_INTERNAL = "/mcp/internal";
const BRIDGE_ROUTE_PUBLIC = "/api/mcp/internal";

let bridgePort: number | null = null;

export function setBridgePort(port: number): void {
  bridgePort = port;
}

export function getBridgeUrl(agentId: string): string | null {
  if (bridgePort == null) return null;
  const t = encodeURIComponent(BRIDGE_TOKEN);
  const a = encodeURIComponent(agentId);
  return `http://127.0.0.1:${bridgePort}${BRIDGE_ROUTE_PUBLIC}?token=${t}&agentId=${a}`;
}

/** URL form used when codex authenticates via `Authorization: Bearer <token>`
 *  header (configured via `bearer_token_env_var` in its mcp_servers entry).
 *  Codex 0.130's streamable HTTP MCP client SKIPS all OAuth discovery when
 *  bearer auth is configured this way — that's what unblocks the agent that
 *  was previously stuck on PRM/ASM probing.
 *
 *  agentId still has to reach the bridge, so we keep it in the URL path.
 *  Bearer token comes from the header.
 */
export function getBridgeUrlForBearer(agentId: string): string | null {
  if (bridgePort == null) return null;
  const a = encodeURIComponent(agentId);
  return `http://127.0.0.1:${bridgePort}${BRIDGE_ROUTE_PUBLIC}/${a}`;
}

export function getBridgeBaseUrl(): string | null {
  if (bridgePort == null) return null;
  return `http://127.0.0.1:${bridgePort}`;
}

export interface BridgeHandlers {
  peerSend?: (args: {
    target: string;
    message: string;
    mode?: "continue" | "review" | "fork" | "raw";
  }) => Promise<string>;
  peerQuery?: (args: { target: string; limit?: number }) => Promise<string>;
  askUser?: (args: { question: string; options: string[] }) => Promise<string>;
  spawnTask?: (args: { description: string; prompt: string }) => Promise<{
    finalText: string;
    subagentId: string;
  }>;
  /** Stateless help — always available; agent-id closure not needed. */
  ensembleHelp?: (args: { topic?: string }) => Promise<string>;
  /** Skill registry inspection / explicit invocation. */
  skillList?: () => Promise<string>;
  skillInvoke?: (args: { name: string }) => Promise<string>;
}

const handlersByAgent = new Map<string, BridgeHandlers>();

export interface McpBridgeOptions {
  getFallbackHandlers?: (agentId: string) => BridgeHandlers | null | undefined;
}

export function registerHandlers(agentId: string, handlers: BridgeHandlers): void {
  handlersByAgent.set(agentId, handlers);
}

export function unregisterHandlers(agentId: string): void {
  handlersByAgent.delete(agentId);
}

export type InternalToolName =
  | "peer_send"
  | "peer_query"
  | "ensemble_help"
  | "skill_list"
  | "skill_invoke"
  | "ask_user"
  | "Task";

export type InternalToolInvoker = (name: InternalToolName, args: Record<string, unknown>) => Promise<string>;

async function invokeHandlers(handlers: BridgeHandlers, name: InternalToolName, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "peer_send":
      if (!handlers.peerSend) throw new Error("peer_send is not available for this agent");
      return handlers.peerSend({
        target: String(args.target ?? ""),
        message: String(args.message ?? ""),
        mode: args.mode === "continue" || args.mode === "review" || args.mode === "fork" || args.mode === "raw" ? args.mode : undefined,
      });
    case "peer_query":
      if (!handlers.peerQuery) throw new Error("peer_query is not available for this agent");
      return handlers.peerQuery({
        target: String(args.target ?? ""),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
    case "ensemble_help":
      if (!handlers.ensembleHelp) throw new Error("ensemble_help is not available for this agent");
      return handlers.ensembleHelp({ topic: typeof args.topic === "string" ? args.topic : undefined });
    case "skill_list":
      if (!handlers.skillList) throw new Error("skill_list is not available for this agent");
      return handlers.skillList();
    case "skill_invoke":
      if (!handlers.skillInvoke) throw new Error("skill_invoke is not available for this agent");
      return handlers.skillInvoke({ name: String(args.name ?? "") });
    case "ask_user":
      if (!handlers.askUser) throw new Error("ask_user is not available for this agent");
      return handlers.askUser({
        question: String(args.question ?? ""),
        options: Array.isArray(args.options) ? args.options.map(String) : [],
      });
    case "Task":
      if (!handlers.spawnTask) throw new Error("Task is not available for this agent");
      return JSON.stringify(
        await handlers.spawnTask({
          description: String(args.description ?? ""),
          prompt: String(args.prompt ?? ""),
        }),
      );
  }
}

export function createInternalMcpServer(invoke: InternalToolInvoker): McpServer {
  const mcp = new McpServer({ name: "agentorch-internal", version: "1.0.0" });
  mcp.tool(
    "peer_send",
    "Send a chat message to another agent in this workspace. Bidirectional. Modes: continue|review|fork|raw (default raw). All modes embed source-output now.",
    {
      target: z.string().min(1),
      message: z.string().min(1),
      mode: z.enum(["continue", "review", "fork", "raw"]).optional(),
    },
    async (args) => ({ content: [{ type: "text", text: await invoke("peer_send", args) }] }),
  );
  mcp.tool(
    "peer_query",
    "Pull another agent's recent text turns (read-only, synchronous, does NOT run the target). Use to gather more context when a handoff feels under-specified.",
    {
      target: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => ({ content: [{ type: "text", text: await invoke("peer_query", args) }] }),
  );
  mcp.tool(
    "ensemble_help",
    "Ensemble runtime guidance. Call this BEFORE attempting Ensemble-specific tasks. Topics: overview, add_mcp_server, switch_provider, switch_model, create_agent, permissions, sandbox, peer_messaging, slash_commands, data_dir, skills. No arg -> index.",
    { topic: z.string().optional() },
    async (args) => ({ content: [{ type: "text", text: await invoke("ensemble_help", args) }] }),
  );
  mcp.tool(
    "skill_list",
    "List available skills. Skills may auto-activate based on user message; check your system prompt for ACTIVE SKILLS first.",
    {},
    async (args) => ({ content: [{ type: "text", text: await invoke("skill_list", args) }] }),
  );
  mcp.tool(
    "skill_invoke",
    "Load a specific skill's body into your context by name.",
    { name: z.string().min(1) },
    async (args) => ({ content: [{ type: "text", text: await invoke("skill_invoke", args) }] }),
  );
  mcp.tool(
    "ask_user",
    "Ask the human user a question and wait for their answer. Pass option labels; the returned string is the chosen label.",
    { question: z.string().min(1), options: z.array(z.string().min(1)).min(1) },
    async (args) => ({ content: [{ type: "text", text: await invoke("ask_user", args) }] }),
  );
  mcp.tool(
    "Task",
    "Delegate a subtask to a subagent. The subagent runs to completion and returns its final text.",
    { description: z.string().min(1), prompt: z.string().min(1) },
    async (args) => ({ content: [{ type: "text", text: await invoke("Task", args) }] }),
  );
  return mcp;
}

/** Extract the bearer token from an Authorization header, if present.
 *  Returns null when the header is missing or malformed. */
function readBearer(headerVal: string | string[] | undefined): string | null {
  if (!headerVal || Array.isArray(headerVal)) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerVal);
  return m ? m[1]!.trim() : null;
}

/** Mount the streamable HTTP MCP endpoint on the given Fastify instance.
 * Stateless — each request creates a fresh McpServer/transport pair. This
 * keeps codex's MCP client (which can re-connect on a new TCP stream per
 * call) simple, and avoids state leaks if a codex turn aborts mid-request.
 *
 * Two URL/auth shapes are supported:
 *   - Query-based:  /api/mcp/internal?token=X&agentId=Y          (Claude SDK path)
 *   - Path + Bearer: /api/mcp/internal/<agentId>  Authorization: Bearer X
 *     (codex 0.130 path — its `bearer_token_env_var` config skips OAuth
 *      discovery entirely and signs requests with this header.) */
export function mountMcpBridge(fastify: FastifyInstance, options: McpBridgeOptions = {}): void {
  const handler = async (request: import("fastify").FastifyRequest<{ Params: { agentId?: string } }>, reply: import("fastify").FastifyReply) => {
    const url = new URL(request.url, "http://127.0.0.1");
    // agentId can come from URL query (legacy) or URL path param (bearer mode).
    const queryAgentId = url.searchParams.get("agentId");
    const paramAgentId = request.params?.agentId ?? null;
    const agentId = paramAgentId || queryAgentId;
    // Token can come from URL query (legacy) or Authorization header (bearer).
    const queryToken = url.searchParams.get("token");
    const bearerToken = readBearer(request.headers.authorization);
    const token = bearerToken ?? queryToken;
    // Diagnostic — observe whether the codex CLI is even reaching the bridge.
    // Logs per-request: method, URL path, auth shape, agent id. Lets us
    // distinguish "codex never connected" from "codex connected but got
    // rejected" in the codex-CLI-can't-see-peer_send bug.
    request.log.info(
      {
        mcpBridge: true,
        method: request.method,
        path: url.pathname,
        agentId: agentId ?? null,
        authShape: bearerToken ? "bearer" : queryToken ? "query" : "none",
        tokenMatches: token === BRIDGE_TOKEN,
        handlersRegistered: agentId ? handlersByAgent.has(agentId) : false,
      },
      "mcp-bridge: incoming request",
    );
    if (token !== BRIDGE_TOKEN) {
      reply.code(401);
      reply.header("WWW-Authenticate", "Bearer");
      return { error: "bad bridge token" };
    }
    if (!agentId) {
      reply.code(400);
      return { error: "agentId required" };
    }
    const handlers = handlersByAgent.get(agentId) ?? options.getFallbackHandlers?.(agentId);
    if (!handlers) {
      reply.code(404);
      return { error: `no active handlers for agentId=${agentId}` };
    }
    const mcp = new McpServer({ name: "agentorch-internal", version: "1.0.0" });

    if (handlers.peerSend) {
      const peerSend = handlers.peerSend;
      mcp.tool(
        "peer_send",
        "Send a chat message to another agent in this workspace. Bidirectional. Modes: continue|review|fork|raw (default raw). All modes embed source-output now.",
        {
          target: z.string().min(1),
          message: z.string().min(1),
          mode: z.enum(["continue", "review", "fork", "raw"]).optional(),
        },
        async (args) => {
          const text = await peerSend(args);
          return { content: [{ type: "text", text }] };
        },
      );
    }
    if (handlers.peerQuery) {
      const peerQuery = handlers.peerQuery;
      mcp.tool(
        "peer_query",
        "Pull another agent's recent text turns (read-only, synchronous, does NOT run the target). Use to gather more context when a handoff feels under-specified.",
        {
          target: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional(),
        },
        async (args) => {
          const text = await peerQuery(args);
          return { content: [{ type: "text", text }] };
        },
      );
    }
    if (handlers.ensembleHelp) {
      const ensembleHelp = handlers.ensembleHelp;
      mcp.tool(
        "ensemble_help",
        "Ensemble runtime guidance. Call this BEFORE attempting Ensemble-specific tasks (Ensemble source is NOT on this machine). Topics: overview, add_mcp_server, switch_provider, switch_model, create_agent, permissions, sandbox, peer_messaging, slash_commands, data_dir, skills. No arg → index.",
        {
          topic: z.string().optional(),
        },
        async (args) => {
          const text = await ensembleHelp(args);
          return { content: [{ type: "text", text }] };
        },
      );
    }
    if (handlers.skillList) {
      const skillList = handlers.skillList;
      mcp.tool(
        "skill_list",
        "List available skills (each with name, description, source, optional tool restrictions). Skills may auto-activate based on user message; check your system prompt for ACTIVE SKILLS first.",
        {},
        async () => ({ content: [{ type: "text", text: await skillList() }] }),
      );
    }
    if (handlers.skillInvoke) {
      const skillInvoke = handlers.skillInvoke;
      mcp.tool(
        "skill_invoke",
        "Load a specific skill's body into your context by name. Use when auto-activation missed or when the user invokes by name.",
        { name: z.string().min(1) },
        async (args) => ({ content: [{ type: "text", text: await skillInvoke(args) }] }),
      );
    }
    if (handlers.askUser) {
      const askUser = handlers.askUser;
      mcp.tool(
        "ask_user",
        "Ask the human user a question and wait for their answer. Pass option labels; the returned string is the chosen label.",
        {
          question: z.string().min(1),
          options: z.array(z.string().min(1)).min(1),
        },
        async (args) => {
          const text = await askUser(args);
          return { content: [{ type: "text", text }] };
        },
      );
    }
    if (handlers.spawnTask) {
      const spawnTask = handlers.spawnTask;
      mcp.tool(
        "Task",
        "Delegate a subtask to a subagent. The subagent runs to completion and returns its final text. Use for parallelizable scoped work.",
        {
          description: z.string().min(1),
          prompt: z.string().min(1),
        },
        async (args) => {
          const out = await spawnTask(args);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ finalText: out.finalText, subagentId: out.subagentId }),
              },
            ],
          };
        },
      );
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    try {
      // StreamableHTTPServerTransport writes directly to Node's ServerResponse.
      // Mark the Fastify reply as hijacked before handing off so Fastify never
      // tries to serialize or finalize a second response around the MCP/SSE
      // payload. This matters for real HTTP clients such as codex's rmcp client,
      // even though fastify.inject can appear to tolerate `return reply`.
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close();
      await mcp.close();
    }
  };
  // Legacy query-string route (Claude SDK uses this).
  fastify.all(BRIDGE_ROUTE_INTERNAL, handler as never);
  fastify.all(BRIDGE_ROUTE_PUBLIC, handler as never);
  // Path-param route (codex bearer-auth uses this; agentId is the last segment).
  fastify.all(`${BRIDGE_ROUTE_INTERNAL}/:agentId`, handler as never);
  fastify.all(`${BRIDGE_ROUTE_PUBLIC}/:agentId`, handler as never);

  const toolHandler = async (
    request: import("fastify").FastifyRequest<{ Params: { agentId?: string; tool?: string }; Body: Record<string, unknown> }>,
    reply: import("fastify").FastifyReply,
  ) => {
    const bearerToken = readBearer(request.headers.authorization);
    if (bearerToken !== BRIDGE_TOKEN) {
      reply.code(401);
      reply.header("WWW-Authenticate", "Bearer");
      return { error: "bad bridge token" };
    }
    const agentId = request.params?.agentId;
    const tool = request.params?.tool as InternalToolName | undefined;
    if (!agentId || !tool) {
      reply.code(400);
      return { error: "agentId and tool required" };
    }
    const handlers = handlersByAgent.get(agentId) ?? options.getFallbackHandlers?.(agentId);
    if (!handlers) {
      reply.code(404);
      return { error: `no active handlers for agentId=${agentId}` };
    }
    try {
      return { content: await invokeHandlers(handlers, tool, request.body ?? {}) };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  fastify.post(`${BRIDGE_ROUTE_INTERNAL}-tool/:agentId/:tool`, toolHandler as never);
  fastify.post(`${BRIDGE_ROUTE_PUBLIC}-tool/:agentId/:tool`, toolHandler as never);
}

/** Translate Ensemble's stored MCP server records (Claude SDK shape) into
 *  codex's `config.mcp_servers` TOML map. codex accepts stdio (command/args/
 *  env) and HTTP (url) transports; sse falls back to URL form, which works
 *  against most modern MCP HTTP servers. In-process SDK MCP entries
 *  (createSdkMcpServer / `type: 'sdk'`) are silently dropped — codex can't
 *  consume JS instances; those are routed through the agentorch-internal
 *  HTTP bridge instead. */
export function mcpServersToCodexConfig(
  servers: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    const cfg = raw as {
      type?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
    };
    if (cfg.type === "stdio" && cfg.command) {
      out[name] = {
        command: cfg.command,
        ...(cfg.args ? { args: cfg.args } : {}),
        ...(cfg.env ? { env: cfg.env } : {}),
      };
    } else if ((cfg.type === "http" || cfg.type === "sse") && cfg.url) {
      out[name] = { url: cfg.url };
    }
  }
  return out;
}
