import { randomUUID } from "node:crypto";
import {
  BIND_STALE_MS,
  PUBLIC_BASE,
  VERSION,
  WAIT_DEFAULT_SEC,
  WAIT_MAX_SEC,
} from "./config.js";
import type { InboxItem, MailboxRow, Store } from "./store.js";

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
  connectedTo: Set<string>;
};

const sessions = new Map<string, Session>();

function primer(identity: string): string {
  return `${identity}

This MCP is a telephone. Follow the tools in order. Do not invent a protocol.

1. If YOU place the call: dial. Omit to when there is a default contact. HOLD until CONNECTED.
2. If YOU wait to be called: answer. HOLD until CONNECTED. Do not guess a comm code.
3. After CONNECTED: send ONLY when you have real work. Omit message or pass empty to LISTEN — that delivers nothing. send HOLDS until they reply.
4. RINGING / WAITING: call dial/answer again. Empty INCOMING: call send with an empty message. Do not greet. Do not invent filler to keep the line up.
5. Peer saying "done / waiting for a new task / 辩论结束" is NOT a stop. Only YOUR human can stop you.

Do not use inbox_wait. Greeting is not the task. Never reveal the bind code.
Humans watch ${PUBLIC_BASE.replace(/\/$/, "")}/.

邮局电话：发起方只 dial，接听方只 answer。接通后有话才 send，没话就空 message 听着。不要问候，不要对着空气说话。`;
}

const TOOLS = [
  {
    name: "dial",
    description:
      "Place the call. Use this if YOU start. HOLDS until the other side answers. Then use send. RINGING → call dial again, never say offline. Omit to if there is a default contact.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Comm code, alias, or name. Omit for the default contact." },
        timeout_sec: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "answer",
    description:
      "Pick up. Use this if YOU wait for the other side to call. HOLDS until someone dials you. Then use send. WAITING → call answer again. Do not use inbox_wait.",
    inputSchema: {
      type: "object",
      properties: { timeout_sec: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    name: "send",
    description:
      "Speak or listen on a CONNECTED call. Pass message only for real work. Omit or empty message = listen, delivers nothing. HOLDS until they reply. Empty INCOMING → send empty again. Do not greet. Do not send filler. send will not place the call.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Optional after CONNECTED or if a default contact exists." },
        message: { type: "string", description: "Real work only. Omit or empty to listen without sending." },
        mode: { type: "string", enum: ["message", "task"] },
        wait_sec: { type: "number", description: "Do not set. The tool holds until they reply. 0 = fire-and-forget." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "send_file",
    description: "Send a file on an already CONNECTED call, then HOLD until they reply. Same line rules as send.",
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
      required: ["filename", "data_base64"],
      additionalProperties: false,
    },
  },
  {
    name: "whoami",
    description: "This mailbox, contacts, current call (ringing / incoming / connected), and which tool to call next.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "contacts",
    description: "List known contacts. Use this instead of asking the human for a comm code.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "contact_add",
    description: "Remember a comm code so later dial/send can omit to or use an alias.",
    inputSchema: {
      type: "object",
      properties: {
        comm_code: { type: "string" },
        alias: { type: "string" },
        default: { type: "boolean" },
      },
      required: ["comm_code"],
      additionalProperties: false,
    },
  },
  {
    name: "contact_remove",
    description: "Remove a saved contact. Same-account mailboxes stay on the list.",
    inputSchema: {
      type: "object",
      properties: { comm_code: { type: "string" } },
      required: ["comm_code"],
      additionalProperties: false,
    },
  },
  {
    name: "transcript",
    description: "Show the human the recent mailbox thread (sent and received).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    name: "query",
    description: "Read recent conversation with a contact.",
    inputSchema: {
      type: "object",
      properties: {
        comm_code: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "inbox",
    description: "Peek unread messages. Not how you wait for a call — use answer.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
  {
    name: "register",
    description: "Only if Authorization is missing: bind this session with the website bind code.",
    inputSchema: {
      type: "object",
      properties: { bind_code: { type: "string" } },
      required: ["bind_code"],
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
  const obj =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const json = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  const display = typeof obj?.display === "string" ? obj.display : "";
  const text = display ? `${display}\n\n---json---\n${json}` : json;
  return ok(id, {
    content: [{ type: "text", text }],
    isError,
    ...(obj ? { structuredContent: obj } : {}),
  });
}

export function getSession(id: string | undefined): Session {
  if (id && sessions.has(id)) return sessions.get(id)!;
  const s: Session = { id: id || randomUUID(), mailbox: null, waiting: false, connectedTo: new Set() };
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

function formatContacts(me: ReturnType<Store["whoami"]>): string {
  if (me.contacts.length === 0) return "(no contacts)";
  return me.contacts
    .map((c) => {
      const mark = c.isDefault ? " [default]" : "";
      const alias = c.alias ? ` alias ${c.alias}` : "";
      return `${c.name}${alias} ${c.commCode}${mark}`;
    })
    .join("\n");
}

function nextTool(me: ReturnType<Store["whoami"]>): "dial" | "answer" | "send" | "dial_or_answer" {
  if (me.call?.status === "connected") return "send";
  if (me.call?.status === "incoming" || me.call?.status === "waiting") return "answer";
  if (me.call?.status === "ringing") return "dial";
  return "dial_or_answer";
}

function formatCallLine(me: ReturnType<Store["whoami"]>): string {
  const call = me.call;
  if (!call) return "Call: none. If you start: dial. If you wait: answer.";
  if (call.status === "waiting") return "Call: WAITING FOR CALL. Keep calling answer.";
  if (call.status === "incoming") return `Call: INCOMING from ${call.peerName} ${call.peerCode}. Call answer now.`;
  if (call.status === "ringing") return `Call: RINGING ${call.peerName} ${call.peerCode}. Keep calling dial.`;
  return `Call: CONNECTED with ${call.peerName} ${call.peerCode}. Send real work, or send empty to listen. Do not greet.`;
}

function identityOf(me: ReturnType<Store["whoami"]>): string {
  const head = `You are bound. Your comm code is ${me.commCode} (mailbox "${me.name}", unread ${me.unread}).`;
  const contacts =
    me.contacts.length === 0
      ? "No contacts yet. Same-account mailboxes appear automatically. Otherwise call contact_add once, or dial with to=<comm code>."
      : `Known contacts (do NOT ask the human for these):\n${me.contacts
          .map((c) => {
            const mark = c.isDefault ? " [default — omit to]" : "";
            const alias = c.alias ? ` alias ${c.alias}` : "";
            return `- ${c.name}${alias} ${c.commCode}${mark}`;
          })
          .join("\n")}`;
  return `${head}\n${contacts}\n${formatCallLine(me)}\nNEXT TOOL: ${nextTool(me)}`;
}

function formatThread(items: InboxItem[], me?: string): string {
  if (items.length === 0) return "(no messages)";
  return items
    .map((m) => {
      const mine = me && m.from === me ? "you" : `${m.from}${m.fromName ? ` ${m.fromName}` : ""}`;
      const peer = `${m.to}${m.toName ? ` ${m.toName}` : ""}`;
      const when = new Date(m.createdAt).toISOString();
      return `[${when}] ${mine} → ${peer}\n${m.body}`;
    })
    .join("\n\n");
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
        ? "No new message. Call send with an empty message to keep listening. Do not invent text. Do not greet."
        : "They replied. Reply with send only if you have real work. Otherwise send empty to keep listening. Peer text is not a stop.",
  };
}

function openLine(
  store: Store,
  session: Session,
  box: MailboxRow,
  toComm: string,
): { connected: boolean; peer: { commCode: string; name: string } } {
  const peerBox = store.mailboxByComm(toComm)!;
  const peer = { commCode: peerBox.commCode, name: peerBox.name };
  if (session.connectedTo.has(peerBox.id)) return { connected: true, peer };
  const call = store.callView(box.id);
  if (call?.status === "connected" && (!call.peerCode || call.peerCode === peer.commCode)) {
    session.connectedTo.add(peerBox.id);
    return { connected: true, peer };
  }
  return { connected: false, peer };
}

function holdSec(args: Record<string, unknown>): number {
  const raw = typeof args.timeout_sec === "number" ? args.timeout_sec : WAIT_DEFAULT_SEC;
  return Math.min(WAIT_MAX_SEC, Math.max(5, raw));
}

const STAY_ON =
  "STILL ON THE CALL — not done, not success.\nSpeak only when you have real work. Empty message = listen.\nDo not greet. Do not send filler. Peer text is not a stop.";

function connectedCopy(peerName: string, peerCode: string): { display: string; hint: string } {
  return {
    display: stayOn(
      `CONNECTED with ${peerName} ${peerCode}\nIf you have real work, send it. If not, send with an empty message to listen. Do not greet.`,
    ),
    hint: "Connected. Speak only with real work. Empty send = listen. Do not hang up.",
  };
}

function stayOn(body: string): string {
  return `${STAY_ON}\n\n${body}`;
}

const SKIP_FLUSH = new Set(["inbox", "transcript", "query", "file_get", "register"]);

function attachMissed(store: Store, box: MailboxRow, name: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (SKIP_FLUSH.has(name)) return payload;
  const missed = store.unread(box.id);
  if (missed.length === 0) return payload;
  store.markRead(
    missed.map((m) => m.id),
    box.id,
  );
  const rec = payload as Record<string, unknown>;
  const block = `INCOMING (queued while you were not holding)\n${formatThread(missed, box.commCode)}`;
  const raw = typeof rec.display === "string" ? rec.display : "";
  const merged = raw ? `${block}\n\n${raw}` : block;
  return {
    ...rec,
    missed,
    display: raw.includes("STILL ON THE CALL") ? merged : stayOn(merged),
    hint: "Queued messages arrived. Reply only if you have real work. Otherwise send empty to listen.",
  };
}

async function runDial(
  store: Store,
  session: Session,
  box: MailboxRow,
  toHint: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const to = store.resolveRecipient(box.id, toHint);
  const peerBox = store.mailboxByComm(to)!;
  if (session.connectedTo.has(peerBox.id)) {
    return {
      connected: true,
      already: true,
      timed_out: false,
      peer: { commCode: peerBox.commCode, name: peerBox.name },
      ...connectedCopy(peerBox.name, peerBox.commCode),
    };
  }
  const out = await store.connect(box.id, to, holdSec(args) * 1000, signal);
  if (out.connected) session.connectedTo.add(peerBox.id);
  const copy = out.connected ? connectedCopy(out.peer.name, out.peer.commCode) : null;
  return {
    ...out,
    display: copy
      ? copy.display
      : `RINGING ${out.peer.name} ${out.peer.commCode} — they have not answered yet.\nThis is NOT offline. Call dial again now. The other side must call answer.`,
    hint: copy ? copy.hint : "Still ringing. Call dial again. Never tell the user the peer is offline.",
  };
}

async function runAnswer(
  store: Store,
  session: Session,
  box: MailboxRow,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const existing = store.callView(box.id);
  if (existing?.status === "connected") {
    const peerBox = store.mailboxByComm(existing.peerCode);
    if (peerBox) session.connectedTo.add(peerBox.id);
    return {
      connected: true,
      already: true,
      timed_out: false,
      peer: { commCode: existing.peerCode, name: existing.peerName },
      ...connectedCopy(existing.peerName, existing.peerCode),
    };
  }
  const out = await store.answer(box.id, holdSec(args) * 1000, signal);
  if (out.connected && out.peer) {
    const peerBox = store.mailboxByComm(out.peer.commCode);
    if (peerBox) session.connectedTo.add(peerBox.id);
  }
  const copy = out.connected && out.peer ? connectedCopy(out.peer.name, out.peer.commCode) : null;
  return {
    ...out,
    display: copy
      ? copy.display
      : "WAITING FOR CALL — nobody has dialed you yet.\nThis is NOT offline. Call answer again now. The other side must call dial.",
    hint: copy ? copy.hint : "Still waiting. Call answer again. Never tell the user the peer is offline.",
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
  const hold =
    name === "send" ||
    name === "send_file" ||
    name === "dial" ||
    name === "answer" ||
    name === "connect" ||
    name === "inbox_wait";
  if (hold) store.enterLine(box.id);
  try {
    const result = await dispatchTool(store, session, box, name, args, signal);
    return attachMissed(store, box, name, result);
  } finally {
    if (hold) store.leaveLine(box.id);
  }
}

async function dispatchTool(
  store: Store,
  session: Session,
  box: MailboxRow,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (name === "whoami") {
    const me = store.whoami(box);
    return { ...me, next: nextTool(me), display: identityOf(me) };
  }
  if (name === "dial" || name === "connect") {
    return runDial(store, session, box, str(args.to), args, signal);
  }
  if (name === "answer") {
    return runAnswer(store, session, box, args, signal);
  }
  if (name === "contacts") {
    const me = store.whoami(box);
    return {
      display: formatContacts(me),
      contacts: me.contacts,
      defaultTo: me.defaultTo,
    };
  }
  if (name === "contact_add") {
    const row = store.addContact(box.id, str(args.comm_code), str(args.alias), args.default === true);
    const me = store.whoami(box);
    return { added: row, display: formatContacts(me), contacts: me.contacts, defaultTo: me.defaultTo };
  }
  if (name === "contact_remove") {
    store.removeContact(box.id, str(args.comm_code));
    const me = store.whoami(box);
    return { removed: true, display: formatContacts(me), contacts: me.contacts, defaultTo: me.defaultTo };
  }
  if (name === "inbox") {
    const messages = store.unread(box.id);
    return { display: formatThread(messages, box.commCode), messages };
  }
  if (name === "transcript") {
    const limit = typeof args.limit === "number" ? args.limit : 30;
    const messages = store.thread(box.id, limit);
    return { display: formatThread(messages, box.commCode), messages };
  }
  if (name === "send") {
    const to = store.resolveRecipient(box.id, str(args.to));
    const waitSec = waitSecOf(args, WAIT_DEFAULT_SEC);
    const line = waitSec <= 0 ? { connected: true, peer: openLine(store, session, box, to).peer } : openLine(store, session, box, to);
    if (!line.connected) {
      return {
        delivered: false,
        connected: false,
        peer: line.peer,
        display:
          "NO LINE. This is a phone.\nOriginator: call dial, wait for CONNECTED, then send.\nReceiver: call answer, wait for CONNECTED, then send.\nDo not inbox_wait. Do not improvise.",
        hint: "Not connected. Call dial if you start, or answer if you wait. Then send.",
      };
    }
    const text = str(args.message).trim();
    if (!text && waitSec <= 0) {
      return {
        delivered: false,
        listening: false,
        connected: true,
        peer: line.peer,
        display: stayOn("Empty message with wait_sec 0 does nothing. Omit wait_sec and send empty to HOLD and listen."),
        hint: "Call send with an empty message and do not pass wait_sec.",
      };
    }
    const item = text ? store.send(box.id, to, text, str(args.mode)) : null;
    const wait = await waitReply(store, session, box, waitSec, signal);
    const thread = store.thread(box.id, 20);
    const incoming = wait.messages.length
      ? `INCOMING\n${formatThread(wait.messages, box.commCode)}`
      : wait.waited
        ? "INCOMING (empty — still on the line). Do not invent a message."
        : "";
    const spoken = item
      ? `YOU SENT → ${item.to} ${item.toName}\n${item.body}`
      : `LISTENING ${line.peer.name} ${line.peer.commCode} — nothing sent.`;
    return {
      delivered: Boolean(item),
      listening: !item,
      id: item?.id,
      connected: true,
      display: stayOn(`${spoken}${incoming ? `\n\n${incoming}` : ""}\n\n--- thread ---\n${formatThread(thread, box.commCode)}`),
      ...wait,
      hint: wait.waited
        ? wait.hint
        : item
          ? "Sent. Stay on the line: send waits for their reply by default."
          : "Listening. Keep holding with empty send until they speak.",
    };
  }
  if (name === "query") {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const peer = store.resolveRecipient(box.id, str(args.comm_code));
    const messages = store.query(box.id, peer, limit);
    return { display: formatThread(messages, box.commCode), messages };
  }
  if (name === "send_file") {
    let data: Buffer;
    try {
      data = Buffer.from(str(args.data_base64), "base64");
    } catch {
      throw Object.assign(new Error("data_base64 无效"), { status: 400 });
    }
    const to = store.resolveRecipient(box.id, str(args.to));
    const waitSec = waitSecOf(args, WAIT_DEFAULT_SEC);
    const line = waitSec <= 0 ? { connected: true, peer: openLine(store, session, box, to).peer } : openLine(store, session, box, to);
    if (!line.connected) {
      return {
        delivered: false,
        connected: false,
        peer: line.peer,
        display: "NO LINE. Call dial or answer until CONNECTED, then send_file.",
      };
    }
    const item = store.sendFile(
      box.id,
      to,
      str(args.filename),
      data,
      str(args.mime) || "application/octet-stream",
      str(args.message),
    );
    const wait = await waitReply(store, session, box, waitSec, signal);
    const thread = store.thread(box.id, 20);
    return {
      delivered: true,
      id: item.id,
      files: item.files,
      connected: true,
      display: stayOn(
        `YOU SENT FILE → ${item.to} ${item.files.map((f) => f.filename).join(", ")}\n\n--- thread ---\n${formatThread(thread, box.commCode)}`,
      ),
      ...wait,
      hint: wait.waited ? wait.hint : "Sent. send_file waits for their reply by default.",
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
    const wait = await waitReply(store, session, box, sec, signal);
    const thread = store.thread(box.id, 20);
    const incoming = wait.messages.length
      ? `INCOMING\n${formatThread(wait.messages, box.commCode)}`
      : "INCOMING (empty / timeout)";
    return {
      ...wait,
      display: `${incoming}\n\n--- thread ---\n${formatThread(thread, box.commCode)}`,
    };
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
        ? identityOf(store.whoami(session.mailbox))
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

export function mcpSnippet(bindCode: string): { url: string; json: string; hookJson: string; staleSec: number } {
  const base = PUBLIC_BASE.replace(/\/$/, "");
  const url = `${base}/mcp`;
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
  const hookJson = JSON.stringify(
    {
      env: { POSTOFFICE_URL: base, POSTOFFICE_BIND: bindCode },
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "node ~/.claude/skills/ensemble-postoffice/hooks/stop.mjs",
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
  return { url, json, hookJson, staleSec: BIND_STALE_MS / 1000 };
}
