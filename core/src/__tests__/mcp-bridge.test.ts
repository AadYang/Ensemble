import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  BRIDGE_TOKEN,
  getBridgeUrl,
  getBridgeUrlForBearer,
  mcpServersToCodexConfig,
  mountMcpBridge,
  registerHandlers,
  setBridgePort,
  unregisterHandlers,
} from "../mcp-bridge.js";

// W20 Slice 5.5: codex consumes MCP via TOML overrides. The translator
// must keep stdio/http/sse rows and drop in-process SDK rows (which can't
// be expressed in TOML — those go through the agentorch-internal HTTP
// bridge instead).
describe("mcpServersToCodexConfig", () => {
  it("preserves stdio command/args/env", () => {
    const out = mcpServersToCodexConfig({
      foo: { type: "stdio", command: "npx", args: ["@x/server"], env: { K: "v" } },
    });
    expect(out.foo).toEqual({
      command: "npx",
      args: ["@x/server"],
      env: { K: "v" },
    });
  });

  it("omits args/env when missing", () => {
    const out = mcpServersToCodexConfig({
      foo: { type: "stdio", command: "node" },
    });
    expect(out.foo).toEqual({ command: "node" });
  });

  it("translates http transport to url", () => {
    const out = mcpServersToCodexConfig({
      bar: { type: "http", url: "https://example.com/mcp" },
    });
    expect(out.bar).toEqual({ url: "https://example.com/mcp" });
  });

  it("translates sse transport to url (codex falls back to URL form)", () => {
    const out = mcpServersToCodexConfig({
      baz: { type: "sse", url: "https://example.com/sse" },
    });
    expect(out.baz).toEqual({ url: "https://example.com/sse" });
  });

  it("drops in-process SDK MCP entries (type='sdk' or missing transport)", () => {
    const out = mcpServersToCodexConfig({
      "agentorch-peer": { type: "sdk", name: "agentorch-peer", instance: {} },
      "no-type-no-fields": {},
      stdio: { type: "stdio", command: "node" },
    });
    expect(Object.keys(out)).toEqual(["stdio"]);
  });

  it("drops stdio rows missing command", () => {
    const out = mcpServersToCodexConfig({
      broken: { type: "stdio" },
      ok: { type: "stdio", command: "node" },
    });
    expect(Object.keys(out)).toEqual(["ok"]);
  });

  it("drops http/sse rows missing url", () => {
    const out = mcpServersToCodexConfig({
      brokenHttp: { type: "http" },
      brokenSse: { type: "sse" },
    });
    expect(out).toEqual({});
  });

  // Regression: the bridge URL exposed externally must include /api/ — the
  // packaged-mode hook in index.ts strips that prefix before routing, but
  // codex CLI / browsers hit the EXE through the public path. Without this
  // prefix the bridge 404s and codex agents see zero MCP tools (no
  // peer_send / peer_query / ensemble_help / Task / ask_user / skill_*).
  it("getBridgeUrl exposes /api/mcp/internal externally", () => {
    setBridgePort(12345);
    const url = getBridgeUrl("agent-abc");
    expect(url).not.toBeNull();
    expect(url!).toContain("/api/mcp/internal");
    expect(url!).toContain("token=");
    expect(url!).toContain("agentId=agent-abc");
  });

  it("getBridgeUrlForBearer exposes the codex path-param URL", () => {
    setBridgePort(12345);
    const url = getBridgeUrlForBearer("agent abc");
    expect(url).toBe("http://127.0.0.1:12345/api/mcp/internal/agent%20abc");
  });

  it("serves MCP initialize and tools/list over path bearer auth", async () => {
    const fastify = Fastify({ logger: false });
    mountMcpBridge(fastify);
    registerHandlers("agent-abc", {
      peerSend: async () => "sent",
      peerQuery: async () => "history",
      ensembleHelp: async () => "help",
    });

    try {
      const initialize = await fastify.inject({
        method: "POST",
        url: "/mcp/internal/agent-abc",
        headers: {
          authorization: `Bearer ${BRIDGE_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "codex-regression-test", version: "1" },
          },
        }),
      });
      expect(initialize.statusCode).toBe(200);
      expect(initialize.headers["content-type"]).toContain("text/event-stream");
      expect(initialize.body).toContain("\"serverInfo\"");

      const tools = await fastify.inject({
        method: "POST",
        url: "/mcp/internal/agent-abc",
        headers: {
          authorization: `Bearer ${BRIDGE_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });
      expect(tools.statusCode).toBe(200);
      expect(tools.body).toContain("\"peer_send\"");
      expect(tools.body).toContain("\"peer_query\"");
      expect(tools.body).toContain("\"ensemble_help\"");
    } finally {
      unregisterHandlers("agent-abc");
      await fastify.close();
    }
  });

  it("invokes registered tools through the stdio proxy callback endpoint", async () => {
    const fastify = Fastify({ logger: false });
    mountMcpBridge(fastify);
    registerHandlers("agent-stdio", {
      peerSend: async (args) => `sent:${args.target}:${args.message}:${args.mode ?? "raw"}`,
    });

    try {
      const res = await fastify.inject({
        method: "POST",
        url: "/mcp/internal-tool/agent-stdio/peer_send",
        headers: {
          authorization: `Bearer ${BRIDGE_TOKEN}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ target: "A", message: "hello", mode: "raw" }),
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ content: "sent:A:hello:raw" });
    } finally {
      unregisterHandlers("agent-stdio");
      await fastify.close();
    }
  });

  it("rejects non-object input rows defensively", () => {
    const out = mcpServersToCodexConfig({
      nope: "string",
      alsoNope: null,
      ok: { type: "stdio", command: "node" },
    });
    expect(Object.keys(out)).toEqual(["ok"]);
  });
});
