import { randomUUID } from "node:crypto";
import {
  BIND_STALE_MS,
  PUBLIC_BASE,
  VERSION,
  WAIT_DEFAULT_SEC,
  WAIT_MAX_SEC,
} from "./config.js";
import type { MailboxRow, Store } from "./store.js";

export type RpcReq = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type Session = {
  id: string;
  mailbox: MailboxRow | null;
  waiting: boolean;
};

const sessions = new Map<string, Session>();

function primer(identity: string): string {
  return `${identity}

Ensemble Postoffice is a mailbox, not a one-shot ping. A greeting or "channel ok" is NOT the task. Keep collaborating until the USER's actual goal is done.

How:
1. send your work/question to the other comm code (immediate return).
2. Call inbox_wait and stay in this turn (holds up to 10 minutes; returns as soon as mail arrives).
3. Read the peer's message, do the next piece of work, send again, inbox_wait again.
4. Empty timeout → inbox_wait again. Never stop after the first reply.
5. Do not tell the user "communication confirmed" and end. Only stop if the user said to stop, or the joint goal is clearly finished.

Never reveal the bind code.

邮局：问候通了不算完成。按用户的真实任务多轮 send → inbox_wait → 做事 → 再 send。第一封回信之后必须继续等。`;
}

const TOOLS = [
  {
    name: "whoami",
    description: "Return this mailbox's comm code, name, and unread count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "register",
    description:
      "Bind this MCP session to a mailbox using the bind code from the Postoffice website. Prefer Authorization: Bearer instead.",
    inputSchema: {
      type: "object",
      properties: { bind_code: { type: "string" } },
      required: ["bind_code"],
      additionalProperties: false,
    },
  },
  {
    name: "send",
    description:
      "Send a text message to a comm code (returns immediately). This is not a handshake tool — after send you MUST inbox_wait and keep the joint task going. Do not stop after the first reply.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient comm code" },
        message: { type: "string" },
        mode: { type: "string", enum: ["message", "task"] },
        wait_sec: { type: "number", description: "Optional. Default 0 (do not wait). Only set if the peer is already blocked on inbox_wait." },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "inbox",
    description: "List unread messages without marking them read. Prefer inbox_wait when collaborating.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "inbox_wait",
    description:
      "Hold until mail arrives (default 10 min). A received message is the next turn of work, not success. Handle it, send, then inbox_wait again. On timeout, call again. Do not end the turn.",
    inputSchema: {
      type: "object",
      properties: { timeout_sec: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    name: "query",
    description: "Read recent conversation (sent and received) with another comm code.",
    inputSchema: {
      type: "object",
      properties: {
        comm_code: { type: "string" },
        limit: { type: "number" },
      },
      required: ["comm_code"],
      additionalProperties: false,
    },
  },
  {
    name: "send_file",
    description: "Send a file (base64, max 12MB) plus optional caption, then return immediately. Call inbox_wait in a loop afterward.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        filename: { type: "string" },
        data_base64: { type: "string" },
        mime: { type: "string" },
        message: { type: "string" },
        wait_sec: { type: "number" },
      },
      required: ["to", "filename", "data_base64"],
      additionalProperties: false,
    },
  },
  {
    name: "file_get",
    description: "Download a file previously received or sent. Returns base64 bytes.",
    inputSchema: {
      type: "object",
      properties: { file_id: { type: "string" } },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
];

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function ok(id: RpcReq["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(id: RpcReq["id"], message: string, code = -32000) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(id: RpcReq["id"], payload: unknown, isError = false) {
  return ok(id, {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
    isError,
  });
}

export function getSession(id: string | undefined): Session {
  if (id && sessions.has(id)) return sessions.get(id)!;
  const s: Session = { id: id || randomUUID(), mailbox: null, waiting: false };
  sessions.set(s.id, s);
  return s;
}

export function dropSession(id: string): void {
  sessions.delete(id);
}

export function resetSessions(): void {
  sessions.clear();
}

export function bindFromHeader(store: Store, session: Session, bindCode: string | undefined): void {
  if (!bindCode) return;
  if (session.mailbox) {
    const current = store.mailboxByBind(bindCode);
    if (current && current.id === session.mailbox.id) return;
  }
  session.mailbox = store.bindSession(bindCode, session.id);
}

function requireBox(session: Session): MailboxRow {
  if (!session.mailbox) {
    throw Object.assign(new Error("未绑定信箱：在 MCP 配置里放 Authorization: Bearer <绑定码>，或调用 register"), {
      status: 401,
    });
  }
  return session.mailbox;
}

function waitSecOf(args: Record<string, unknown>, fallback: number): number {
  if (args.wait_sec === 0 || args.wait_sec === "0") return 0;
  const raw = typeof args.wait_sec === "number" ? args.wait_sec : fallback;
  if (raw <= 0) return 0;
  return Math.min(WAIT_MAX_SEC, Math.max(5, raw));
}

async function waitReply(store: Store, session: Session, box: MailboxRow, sec: number, signal?: AbortSignal) {
  if (sec <= 0) return { messages: [] as Awaited<ReturnType<Store["unread"]>>, timed_out: false, waited: false };
  const messages = await store.waitInbox(box.id, sec * 1000, signal);
  store.markRead(
    messages.map((m) => m.id),
    box.id,
  );
  store.heartbeat(box.id, session.id);
  return {
    messages,
    timed_out: messages.length === 0,
    waited: true,
    hint:
      messages.length === 0
        ? "Still empty. Peer is probably thinking. Call inbox_wait again now. Do not report success. Do not end the turn."
        : "Peer message received. This is not completion. Do the next work, send, then inbox_wait again. Do not tell the user the channel is merely 'confirmed'.",
  };
}

async function callTool(
  store: Store,
  session: Session,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (name === "register") {
    const box = store.bindSession(str(args.bind_code), session.id);
    session.mailbox = box;
    return { bound: true, ...store.whoami(box) };
  }

  const box = requireBox(session);
  store.heartbeat(box.id, session.id);

  if (name === "whoami") return store.whoami(box);
  if (name === "inbox") return { messages: store.unread(box.id) };
  if (name === "send") {
    const item = store.send(box.id, str(args.to).toUpperCase(), str(args.message), str(args.mode));
    const wait = await waitReply(store, session, box, waitSecOf(args, 0), signal);
    return {
      delivered: true,
      id: item.id,
      ...wait,
      hint: wait.waited
        ? wait.hint
        : "Sent. Call inbox_wait now. After any reply, continue the user's actual task — do not stop at handshake.",
    };
  }
  if (name === "query") {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    return { messages: store.query(box.id, str(args.comm_code).toUpperCase(), limit) };
  }
  if (name === "send_file") {
    let data: Buffer;
    try {
      data = Buffer.from(str(args.data_base64), "base64");
    } catch {
      throw Object.assign(new Error("data_base64 无效"), { status: 400 });
    }
    const item = store.sendFile(
      box.id,
      str(args.to).toUpperCase(),
      str(args.filename),
      data,
      str(args.mime) || "application/octet-stream",
      str(args.message),
    );
    const wait = await waitReply(store, session, box, waitSecOf(args, 0), signal);
    return {
      delivered: true,
      id: item.id,
      files: item.files,
      ...wait,
      hint: wait.waited
        ? wait.hint
        : "Sent. Call inbox_wait now. After any reply, continue the user's actual task — do not stop at handshake.",
    };
  }
  if (name === "file_get") {
    const file = store.getFile(box.id, str(args.file_id));
    return {
      filename: file.filename,
      mime: file.mime,
      bytes: file.data.length,
      data_base64: file.data.toString("base64"),
    };
  }
  if (name === "inbox_wait") {
    const secRaw = typeof args.timeout_sec === "number" ? args.timeout_sec : WAIT_DEFAULT_SEC;
    const sec = Math.min(WAIT_MAX_SEC, Math.max(5, secRaw));
    return waitReply(store, session, box, sec, signal);
  }
  throw Object.assign(new Error(`未知工具 ${name}`), { status: 400 });
}

export async function handleRpc(
  store: Store,
  session: Session,
  req: RpcReq,
  signal?: AbortSignal,
): Promise<{ body: unknown; notification: boolean }> {
  const id = req.id;
  const method = req.method ?? "";
  const notification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      const params = asObj(req.params);
      const v = str(params.protocolVersion) || "2025-03-26";
      const ident = session.mailbox
        ? (() => {
            const me = store.whoami(session.mailbox!);
            return `You are bound. Your comm code is ${me.commCode} (mailbox "${me.name}", unread ${me.unread}).`;
          })()
        : "Not bound yet. Put Authorization: Bearer <bind_code> on this MCP server.";
      return {
        notification: false,
        body: ok(id, {
          protocolVersion: v,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ensemble-postoffice", version: VERSION },
          instructions: primer(ident),
        }),
      };
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return { notification: true, body: null };
    }
    if (method === "ping") return { notification: false, body: ok(id, {}) };
    if (method === "tools/list") return { notification: false, body: ok(id, { tools: TOOLS }) };
    if (method === "tools/call") {
      const params = asObj(req.params);
      const name = str(params.name);
      const args = asObj(params.arguments);
      try {
        const result = await callTool(store, session, name, args, signal);
        return { notification: false, body: toolResult(id, result, false) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { notification: false, body: toolResult(id, { error: msg }, true) };
      }
    }
    if (notification) return { notification: true, body: null };
    return { notification: false, body: fail(id, `Method not found: ${method}`, -32601) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { notification: false, body: fail(id, msg) };
  }
}

export function mcpSnippet(bindCode: string): { url: string; json: string; staleSec: number } {
  const url = `${PUBLIC_BASE.replace(/\/$/, "")}/mcp`;
  const json = JSON.stringify(
    {
      mcpServers: {
        "ensemble-postoffice": {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${bindCode}` },
        },
      },
    },
    null,
    2,
  );
  return { url, json, staleSec: BIND_STALE_MS / 1000 };
}
