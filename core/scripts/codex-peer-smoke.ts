import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mountMcpBridge, setBridgePort } from "../src/mcp-bridge.js";
import { closeDb, prisma } from "../src/db.js";
import { SessionManager } from "../src/sessions/SessionManager.js";

type HubMsg = Record<string, unknown>;

function publicResourceMetadata(host: string): Record<string, unknown> {
  return {
    resource: `http://${host}/api/mcp/internal`,
    authorization_servers: [],
    bearer_methods_supported: [],
  };
}

function publicAuthServerMetadata(host: string): Record<string, unknown> {
  return {
    issuer: `http://${host}`,
    authorization_endpoint: `http://${host}/.well-known/no-auth`,
    token_endpoint: `http://${host}/.well-known/no-auth`,
    response_types_supported: [],
    grant_types_supported: [],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function mountCodexMetadataRoutes(app: ReturnType<typeof Fastify>) {
  app.get("/.well-known/oauth-protected-resource", async (req, reply) => {
    reply.type("application/json").send(publicResourceMetadata(String(req.headers.host)));
  });
  app.get("/.well-known/oauth-protected-resource/*", async (req, reply) => {
    reply.type("application/json").send(publicResourceMetadata(String(req.headers.host)));
  });
  app.get("/.well-known/oauth-authorization-server", async (req, reply) => {
    reply.type("application/json").send(publicAuthServerMetadata(String(req.headers.host)));
  });
  app.get("/.well-known/oauth-authorization-server/*", async (req, reply) => {
    reply.type("application/json").send(publicAuthServerMetadata(String(req.headers.host)));
  });
}

class SmokeHub {
  events: HubMsg[] = [];
  size() {
    return 0;
  }
  add() {}
  remove() {}
  subscribe() {}
  unsubscribe() {}
  replayPendingFor() {}
  sendToSession(sessionId: string, msg: HubMsg) {
    this.events.push({ sessionId, ...msg });
    console.log(`[hub:send:${sessionId.slice(0, 8)}] ${JSON.stringify(msg).slice(0, 1200)}`);
  }
  broadcast(msg: HubMsg) {
    this.events.push(msg);
    console.log(`[hub:broadcast] ${JSON.stringify(msg).slice(0, 1200)}`);
  }
}

async function main() {
  const app = Fastify({ logger: false });
  let sessions: SessionManager | null = null;
  let sourceId = "";
  let targetId = "";
  try {
    app.addHook("onRequest", async (req) => {
      console.log(`[http] ${req.method} ${req.url} accept=${String(req.headers.accept ?? "")} content-type=${String(req.headers["content-type"] ?? "")}`);
    });
    mountCodexMetadataRoutes(app);
    mountMcpBridge(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const port = new URL(address).port;
    setBridgePort(Number(port));
    console.log(`[smoke] mcp bridge listening on ${address}`);

    const codexProvider = await prisma.provider.create({
      data: {
        name: `codex-smoke-${Date.now()}`,
        kind: "openai-codex",
        baseUrl: null,
        apiKey: null,
        models: ["codex"],
        isDefault: false,
        // Release-gate the normal product default: workspace-write should
        // still allow peer_send after Ensemble marks the isolated Codex cwd
        // trusted in the generated config.toml.
        metadata: { defaultSandbox: "workspace-write" },
      },
    });

    const compatProvider =
      (await prisma.provider.findFirst({ where: { name: "__smoke_bogus_openai_compat__" } })) ??
      (await prisma.provider.create({
        data: {
          name: "__smoke_bogus_openai_compat__",
          kind: "openai-compat",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "smoke",
          models: ["smoke-model"],
          isDefault: false,
        },
      }));

    const hub = new SmokeHub();
    sessions = new SessionManager(hub as never);
    const suffix = randomUUID().slice(0, 8);
    const targetName = `SmokeTarget-${suffix}`;
    const sourceName = `SmokeCodex-${suffix}`;
    const smokeToken = `SMOKE_PEER_SEND_${suffix}`;

    targetId = await sessions.createAgent({
      name: targetName,
      providerId: compatProvider.id,
      model: "smoke-model",
      systemPrompt: "Smoke target. If run, acknowledge briefly.",
    });
    sourceId = await sessions.createAgent({
      name: sourceName,
      providerId: codexProvider.id,
      model: codexProvider.models[0] ?? "codex",
      systemPrompt: [
        "You are testing Ensemble peer messaging.",
        "When the user asks you to notify a peer, you must call peer_send.",
        "Do not merely say that you sent it.",
      ].join("\n"),
    });
    console.log(`[smoke] source=${sourceName}/${sourceId} target=${targetName}/${targetId}`);

    const prompt = [
      `Call the peer_send tool now.`,
      `target: ${targetName}`,
      `mode: raw`,
      `message: ${smokeToken}`,
      `After the tool call, reply with exactly: done`,
    ].join("\n");

    const timeoutMs = Number(process.env.CODEX_SMOKE_TIMEOUT_MS ?? 180_000);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        if (sessions && sourceId) sessions.cancel(sourceId);
        if (sessions && targetId) sessions.cancel(targetId);
        reject(new Error(`Codex peer smoke timed out after ${timeoutMs}ms`));
      }, timeoutMs).unref();
    });
    const result = await Promise.race([sessions.sendMessage(sourceId, prompt), timeout]);
    console.log(`[smoke] codex result=${JSON.stringify(result)}`);
    sessions.cancel(targetId);

    await new Promise((resolve) => setTimeout(resolve, 4000));
    const targetMessages = await prisma.message.findMany({
      where: { agentId: targetId },
      orderBy: { seq: "asc" },
    });
    const delivered = targetMessages.some((m) => JSON.stringify(m.payload).includes(smokeToken));
    console.log(`[smoke] target message count=${targetMessages.length}`);
    console.log(`[smoke] delivered=${delivered}`);
    if (!delivered) {
      console.log(`[smoke] target payloads=${JSON.stringify(targetMessages.map((m) => m.payload)).slice(0, 4000)}`);
      throw new Error("peer_send smoke token was not delivered to the target agent");
    }
  } finally {
    if (sessions && sourceId) sessions.cancel(sourceId);
    if (sessions && targetId) sessions.cancel(targetId);
    await app.close().catch(() => undefined);
    closeDb();
  }
}

main().catch(async (err) => {
  console.error(`[smoke] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  try {
    closeDb();
  } catch {
    // ignore
  }
  process.exitCode = 1;
});
