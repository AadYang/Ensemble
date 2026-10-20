import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_BASE, VERSION } from "./config.js";
import { bindFromHeader, dropSession, getSession, handleRpc, mcpSnippet, type RpcReq } from "./mcp.js";
import { Store } from "./store.js";

const WEBSITE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "website");

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return undefined;
}

function sessionToken(req: FastifyRequest): string | undefined {
  const fromAuth = bearer(req);
  if (fromAuth && !fromAuth.startsWith("po_")) return fromAuth;
  const c = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.po_session;
  return c || undefined;
}

function sendErr(reply: FastifyReply, e: unknown): FastifyReply {
  const status = typeof e === "object" && e && "status" in e ? Number((e as { status: number }).status) : 400;
  const message = e instanceof Error ? e.message : String(e);
  return reply.code(status || 400).send({ error: message });
}

export async function createApp(store: Store): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: true,
    requestTimeout: 960_000,
  });

  await app.register(cookie);

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Mcp-Session-Id",
    );
    reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    reply.header("Access-Control-Expose-Headers", "mcp-session-id, Mcp-Session-Id");
    return payload;
  });

  app.options("/*", async (_req, reply) => reply.code(204).send());

  app.get("/healthz", async () => ({ ok: true, name: "ensemble-postoffice", version: VERSION }));

  app.get("/api/config", async () => ({
    publicBase: PUBLIC_BASE.replace(/\/$/, ""),
    mcpUrl: `${PUBLIC_BASE.replace(/\/$/, "")}/mcp`,
    version: VERSION,
  }));

  app.post("/api/register", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: string; password?: string; inviteCode?: string };
    try {
      const user = store.register(b.username ?? "", b.password ?? "", b.inviteCode ?? "");
      const { token, username } = store.login(user.username, b.password ?? "");
      reply.setCookie("po_session", token, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 30 * 86400 });
      return { token, username };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.post("/api/login", async (req, reply) => {
    const b = (req.body ?? {}) as { username?: string; password?: string };
    try {
      const { token, username } = store.login(b.username ?? "", b.password ?? "");
      reply.setCookie("po_session", token, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 30 * 86400 });
      return { token, username };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.post("/api/logout", async (req, reply) => {
    const token = sessionToken(req);
    if (token) store.logout(token);
    reply.clearCookie("po_session", { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    return user;
  });

  app.get("/api/mailboxes", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    return { mailboxes: store.listMailboxes(user.id) };
  });

  app.post("/api/mailboxes", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    const b = (req.body ?? {}) as { name?: string };
    try {
      const box = store.createMailbox(user.id, b.name ?? "");
      return { ...box, mcp: mcpSnippet(box.bindCode) };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.post("/api/mailboxes/:id/reset-bind", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    try {
      const { bindCode } = store.resetBind(user.id, (req.params as { id: string }).id);
      return { bindCode, mcp: mcpSnippet(bindCode) };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.delete("/api/mailboxes/:id", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    try {
      store.deleteMailbox(user.id, (req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  const mcpHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === "DELETE") {
      const sid = String(req.headers["mcp-session-id"] ?? "");
      if (sid) dropSession(sid);
      return reply.code(204).send();
    }
    if (req.method === "GET") {
      const sid = getSession(String(req.headers["mcp-session-id"] ?? "")).id;
      reply.header("mcp-session-id", sid);
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache");
      return reply.send(`event: ping\ndata: {}\n\n`);
    }

    const session = getSession(typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined);
    reply.header("mcp-session-id", session.id);
    try {
      const headerBind = bearer(req);
      if (headerBind) bindFromHeader(store, session, headerBind);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(401).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: msg } });
    }

    const ac = new AbortController();
    req.raw.on("close", () => ac.abort());

    const body = req.body;
    const batch = Array.isArray(body) ? (body as RpcReq[]) : [body as RpcReq];
    const first = batch[0];
    const firstName =
      first && typeof first === "object" && first.method === "tools/call"
        ? String((first.params as { name?: string } | undefined)?.name ?? "")
        : "";
    const longWait = batch.length === 1 && firstName === "inbox_wait";
    const wantSse = String(req.headers.accept ?? "").includes("text/event-stream");

    if (longWait && wantSse) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "mcp-session-id": session.id,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "mcp-session-id, Mcp-Session-Id",
      });
      const ping = setInterval(() => {
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          ac.abort();
        }
      }, 15000);
      try {
        const out = await handleRpc(store, session, first!, ac.signal);
        if (!out.notification) {
          reply.raw.write(`event: message\ndata: ${JSON.stringify(out.body)}\n\n`);
        }
      } finally {
        clearInterval(ping);
        reply.raw.end();
      }
      return;
    }

    const results: unknown[] = [];
    for (const item of batch) {
      if (!item || typeof item !== "object") continue;
      const out = await handleRpc(store, session, item, ac.signal);
      if (!out.notification) results.push(out.body);
    }
    if (results.length === 0) return reply.code(202).send();
    return reply.send(Array.isArray(body) ? results : results[0]);
  };

  app.post("/mcp", mcpHandler);
  app.get("/mcp", mcpHandler);
  app.delete("/mcp", mcpHandler);

  await app.register(fastifyStatic, {
    root: WEBSITE,
    prefix: "/",
    wildcard: false,
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/mcp")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });

  return app;
}
