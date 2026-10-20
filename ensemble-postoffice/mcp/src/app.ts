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

  app.get("/api/mailboxes/:id/messages", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    const id = (req.params as { id: string }).id;
    const box = store.mailbox(id);
    if (!box || box.userId !== user.id) return reply.code(404).send({ error: "信箱不存在" });
    const raw = Number((req.query as { limit?: string }).limit);
    const limit = Number.isFinite(raw) ? raw : 50;
    return { commCode: box.commCode, messages: store.thread(box.id, limit) };
  });

  app.get("/api/mailboxes/:id/contacts", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    const box = store.mailbox((req.params as { id: string }).id);
    if (!box || box.userId !== user.id) return reply.code(404).send({ error: "信箱不存在" });
    const me = store.whoami(box);
    return { contacts: me.contacts, defaultTo: me.defaultTo };
  });

  app.post("/api/mailboxes/:id/contacts", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    const box = store.mailbox((req.params as { id: string }).id);
    if (!box || box.userId !== user.id) return reply.code(404).send({ error: "信箱不存在" });
    const b = (req.body ?? {}) as { commCode?: string; alias?: string; default?: boolean };
    try {
      const row = store.addContact(box.id, b.commCode ?? "", b.alias ?? "", b.default === true);
      const me = store.whoami(box);
      return { contact: row, contacts: me.contacts, defaultTo: me.defaultTo };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.post("/api/mailboxes/:id/contacts/:comm/default", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    const box = store.mailbox((req.params as { id: string }).id);
    if (!box || box.userId !== user.id) return reply.code(404).send({ error: "信箱不存在" });
    try {
      const row = store.setDefault(box.id, (req.params as { comm: string }).comm);
      const me = store.whoami(box);
      return { contact: row, contacts: me.contacts, defaultTo: me.defaultTo };
    } catch (e) {
      return sendErr(reply, e);
    }
  });

  app.delete("/api/mailboxes/:id/contacts/:comm", async (req, reply) => {
    const user = store.userByToken(sessionToken(req));
    if (!user) return reply.code(401).send({ error: "未登录" });
    const box = store.mailbox((req.params as { id: string }).id);
    if (!box || box.userId !== user.id) return reply.code(404).send({ error: "信箱不存在" });
    try {
      store.removeContact(box.id, (req.params as { comm: string }).comm);
      const me = store.whoami(box);
      return { ok: true, contacts: me.contacts, defaultTo: me.defaultTo };
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
    const abortWait = () => {
      if (!ac.signal.aborted) ac.abort();
    };
    // IncomingMessage "close" fires when the POST body is consumed, not when the
    // client hangs up. MCP hosts keep the socket open for a 10-minute hold; treating
    // body-complete as abort makes both sides RINGING in a few hundred ms.
    req.raw.on("aborted", abortWait);
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abortWait();
    });

    const body = req.body;
    const batch = Array.isArray(body) ? (body as RpcReq[]) : [body as RpcReq];
    const first = batch[0];
    const firstName =
      first && typeof first === "object" && first.method === "tools/call"
        ? String((first.params as { name?: string } | undefined)?.name ?? "")
        : "";
    const longWait =
      batch.length === 1 &&
      (firstName === "inbox_wait" ||
        firstName === "connect" ||
        firstName === "dial" ||
        firstName === "answer" ||
        firstName === "send" ||
        firstName === "send_file");
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

  app.get("/line", async (req, reply) => {
    const code = bearer(req);
    if (!code?.startsWith("po_")) return reply.code(401).send({ error: "需要绑定码" });
    const box = store.mailboxByBind(code);
    if (!box) return reply.code(401).send({ error: "绑定码无效" });
    const snapshot = () => store.lineSnapshot(box.id);
    const wantSse = String(req.headers.accept ?? "").includes("text/event-stream");
    if (!wantSse) return snapshot();

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    const write = (data: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    write(snapshot());
    const unsub = store.watchLine(box.id, () => {
      try {
        write(snapshot());
      } catch {
        /* socket gone */
      }
    });
    const ping = setInterval(() => {
      try {
        reply.raw.write(": keepalive\n\n");
      } catch {
        /* */
      }
    }, 15000);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsub();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    req.raw.on("aborted", done);
    reply.raw.on("close", done);
  });

  app.post("/line/ack", async (req, reply) => {
    const code = bearer(req);
    if (!code?.startsWith("po_")) return reply.code(401).send({ error: "需要绑定码" });
    const box = store.mailboxByBind(code);
    if (!box) return reply.code(401).send({ error: "绑定码无效" });
    const ids = (req.body as { ids?: string[] } | null)?.ids;
    const unread = store.unread(box.id);
    store.markRead(ids && ids.length ? ids : unread.map((m) => m.id), box.id);
    return { ok: true, acked: ids?.length ?? unread.length };
  });

  app.post("/mcp", mcpHandler);
  app.get("/mcp", mcpHandler);
  app.delete("/mcp", mcpHandler);

  await app.register(fastifyStatic, {
    root: WEBSITE,
    prefix: "/",
    wildcard: false,
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/mcp") || req.url.startsWith("/line")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });

  return app;
}
