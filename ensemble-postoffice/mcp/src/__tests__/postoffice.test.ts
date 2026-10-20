import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { resetSessions } from "../mcp.js";
import { Store } from "../store.js";
import type { FastifyInstance } from "fastify";

const INVITE = "redtea-yzr";

describe("postoffice", () => {
  let dir: string;
  let store: Store;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "po-"));
    store = new Store(":memory:", join(dir, "files"), INVITE);
    app = await createApp(store);
  });

  afterEach(async () => {
    await app.close();
    store.close();
    resetSessions();
    rmSync(dir, { recursive: true, force: true });
  });

  async function register(username: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: { username, password: "password1", inviteCode: INVITE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; username: string };
    return body.token;
  }

  async function openBox(token: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/mailboxes",
      headers: { authorization: `Bearer ${token}` },
      payload: { name },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { commCode: string; bindCode: string; id: string };
  }

  async function rpc(bind: string, session: string, method: string, params?: unknown, id: number | string = 1) {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${bind}`,
        "mcp-session-id": session,
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id, method, params },
    });
    return res;
  }

  function toolText(res: Awaited<ReturnType<typeof rpc>>): string {
    const body = res.json() as { result?: { content?: { text: string }[]; isError?: boolean }; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return (body.result?.content ?? []).map((c) => c.text).join("\n");
  }

  function toolJson(res: Awaited<ReturnType<typeof rpc>>): Record<string, unknown> {
    const body = res.json() as {
      result?: { structuredContent?: Record<string, unknown>; content?: { text: string }[] };
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    if (body.result?.structuredContent) return body.result.structuredContent;
    const text = toolText(res);
    const marker = text.lastIndexOf("---json---");
    if (marker >= 0) return JSON.parse(text.slice(marker + "---json---".length)) as Record<string, unknown>;
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("rejects a wrong invite code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: { username: "alice", password: "password1", inviteCode: "nope" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("registers, logs in, and opens a mailbox", async () => {
    const token = await register("alice");
    const box = await openBox(token, "desk");
    expect(box.commCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(box.bindCode.startsWith("po_")).toBe(true);
  });

  it("delivers send through inbox_wait across two MCP sessions", async () => {
    const aTok = await register("alice");
    const bTok = await register("bob");
    const a = await openBox(aTok, "A");
    const b = await openBox(bTok, "B");

    const waiting = rpc(b.bindCode, "sess-b", "tools/call", {
      name: "inbox_wait",
      arguments: { timeout_sec: 8 },
    }, 2);

    await new Promise((r) => setTimeout(r, 80));

    const sent = await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { to: b.commCode, message: "hello from A", wait_sec: 0 },
    });
    expect(sent.statusCode).toBe(200);
    expect(toolText(sent)).toContain("YOU SENT");
    expect(toolText(sent)).toContain("hello from A");
    expect(toolJson(sent)).toMatchObject({ delivered: true });

    const waited = await waiting;
    expect(waited.statusCode).toBe(200);
    const text = toolText(waited);
    expect(text).toContain("INCOMING");
    expect(text).toContain("hello from A");
    expect(text).toContain(a.commCode);
    expect(text).toContain("--- thread ---");
  });

  it("round-trips a file attachment", async () => {
    const aTok = await register("alice");
    const bTok = await register("bob");
    const a = await openBox(aTok, "A");
    const b = await openBox(bTok, "B");
    const payload = Buffer.from("pdf-bytes").toString("base64");

    const sent = await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send_file",
      arguments: {
        to: b.commCode,
        filename: "note.txt",
        data_base64: payload,
        mime: "text/plain",
        message: "here",
        wait_sec: 0,
      },
    });
    const sentJson = toolJson(sent) as { files?: { id: string }[]; error?: string };
    expect(sentJson, toolText(sent)).toMatchObject({ delivered: true });
    expect(sentJson.files?.[0]?.id).toBeTruthy();

    const inbox = await rpc(b.bindCode, "sess-b", "tools/call", { name: "inbox", arguments: {} });
    const inboxJson = toolJson(inbox) as { messages: { files: { id: string }[] }[] };
    const fileId = inboxJson.messages[0]?.files[0]?.id;
    expect(fileId).toBeTruthy();

    const got = await rpc(b.bindCode, "sess-b", "tools/call", {
      name: "file_get",
      arguments: { file_id: fileId },
    });
    const file = toolJson(got) as { data_base64: string; filename: string };
    expect(file.filename).toBe("note.txt");
    expect(Buffer.from(file.data_base64, "base64").toString()).toBe("pdf-bytes");
  });

  it("reclaims the same bind code across HTTP sessions without mcp-session-id", async () => {
    const token = await register("alice");
    const box = await openBox(token, "A");
    const first = await rpc(box.bindCode, "sess-1", "tools/call", { name: "whoami", arguments: {} });
    expect(first.statusCode).toBe(200);
    expect(toolText(first)).toContain(box.commCode);

    const second = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${box.bindCode}`, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } },
    });
    expect(second.statusCode).toBe(200);
    expect(toolText(second)).toContain(box.commCode);
  });

  it("send waits for the reply so the caller does not need a second inbox_wait", async () => {
    const aTok = await register("alice");
    const bTok = await register("bob");
    const a = await openBox(aTok, "A");
    const b = await openBox(bTok, "B");

    const ringing = rpc(a.bindCode, "sess-a", "tools/call", {
      name: "dial",
      arguments: { to: b.commCode, timeout_sec: 8 },
    }, 1);
    await new Promise((r) => setTimeout(r, 80));
    const picked = await rpc(b.bindCode, "sess-b", "tools/call", {
      name: "answer",
      arguments: { timeout_sec: 8 },
    }, 2);
    expect(toolJson(await ringing)).toMatchObject({ connected: true });
    expect(toolJson(picked)).toMatchObject({ connected: true });

    const waiting = rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { to: b.commCode, message: "ping", wait_sec: 8 },
    }, 3);

    await new Promise((r) => setTimeout(r, 80));
    const reply = await rpc(b.bindCode, "sess-b", "tools/call", {
      name: "send",
      arguments: { to: a.commCode, message: "pong", wait_sec: 0 },
    });
    expect(toolText(reply)).toContain("delivered");

    const waited = await waiting;
    expect(toolText(waited)).toContain("pong");
    expect(toolText(waited)).toContain("STILL ON THE CALL");
  });

  it("bind code can peek and ack the live line without a user session", async () => {
    const aTok = await register("alice");
    const bTok = await register("bob");
    const a = await openBox(aTok, "A");
    const b = await openBox(bTok, "B");
    await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { to: b.commCode, message: "queued-for-hook", wait_sec: 0 },
    });
    const peeked = await app.inject({
      method: "GET",
      url: "/line",
      headers: { authorization: `Bearer ${b.bindCode}` },
    });
    expect(peeked.statusCode).toBe(200);
    const body = peeked.json() as { unread: { body: string; id: string }[] };
    expect(body.unread.map((m) => m.body)).toContain("queued-for-hook");
    const acked = await app.inject({
      method: "POST",
      url: "/line/ack",
      headers: { authorization: `Bearer ${b.bindCode}`, "content-type": "application/json" },
      payload: { ids: body.unread.map((m) => m.id) },
    });
    expect(acked.statusCode).toBe(200);
    const again = await app.inject({
      method: "GET",
      url: "/line",
      headers: { authorization: `Bearer ${b.bindCode}` },
    });
    expect((again.json() as { unread: unknown[] }).unread).toEqual([]);
  });

  it("whoami flushes queued mail after the agent stopped holding", async () => {
    const aTok = await register("alice");
    const bTok = await register("bob");
    const a = await openBox(aTok, "A");
    const b = await openBox(bTok, "B");
    await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { to: b.commCode, message: "after-you-hung-up", wait_sec: 0 },
    });
    const me = await rpc(b.bindCode, "sess-b", "tools/call", { name: "whoami", arguments: {} });
    expect(toolText(me)).toContain("after-you-hung-up");
    expect(toolText(me)).toContain("queued");
    expect(toolJson(me).missed).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: "after-you-hung-up" })]),
    );
  });

  it("puts the comm code and phone protocol into initialize instructions", async () => {
    const token = await register("alice");
    const box = await openBox(token, "A");
    const res = await rpc(box.bindCode, "sess-init", "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    const body = res.json() as { result: { instructions: string } };
    expect(body.result.instructions).toContain(box.commCode);
    expect(body.result.instructions).toMatch(/\bdial\b/);
    expect(body.result.instructions).toMatch(/\banswer\b/);
    expect(body.result.instructions).toContain("inbox_wait");

    const listed = await rpc(box.bindCode, "sess-init", "tools/list", {});
    const tools = (listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["dial", "answer", "send"]));
    expect(tools).not.toContain("inbox_wait");
    expect(tools).not.toContain("connect");
  });

  it("shows both sent and received messages on transcript and website API", async () => {
    const aTok = await register("alice");
    const bTok = await register("bob");
    const a = await openBox(aTok, "A");
    const b = await openBox(bTok, "B");

    await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { to: b.commCode, message: "from-a", wait_sec: 0 },
    });
    await rpc(b.bindCode, "sess-b", "tools/call", {
      name: "send",
      arguments: { to: a.commCode, message: "from-b", wait_sec: 0 },
    });

    const tr = await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "transcript",
      arguments: { limit: 20 },
    });
    const text = toolText(tr);
    expect(text).toContain("from-a");
    expect(text).toContain("from-b");
    expect(text).toContain("you →");

    const listed = await app.inject({
      method: "GET",
      url: `/api/mailboxes/${a.id}/messages`,
      headers: { authorization: `Bearer ${aTok}` },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { messages: { body: string }[] };
    expect(body.messages.map((m) => m.body).sort()).toEqual(["from-a", "from-b"]);

    const forbidden = await app.inject({
      method: "GET",
      url: `/api/mailboxes/${a.id}/messages`,
      headers: { authorization: `Bearer ${bTok}` },
    });
    expect(forbidden.statusCode).toBe(404);
  });

  it("same-account sibling is the default send target without pasting a comm code", async () => {
    const tok = await register("alice");
    const a = await openBox(tok, "desk");
    const b = await openBox(tok, "phone");
    const init = await rpc(a.bindCode, "sess-sib", "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    const instructions = (init.json() as { result: { instructions: string } }).result.instructions;
    expect(instructions).toContain(b.commCode);
    expect(instructions).toContain("phone");
    expect(instructions).toMatch(/default/i);

    const sent = await rpc(a.bindCode, "sess-sib", "tools/call", {
      name: "send",
      arguments: { message: "auto-to-sibling", wait_sec: 0 },
    });
    expect(toolJson(sent)).toMatchObject({ delivered: true });
    expect(toolText(sent)).toContain("auto-to-sibling");

    const inbox = await rpc(b.bindCode, "sess-phone", "tools/call", { name: "inbox", arguments: {} });
    expect(toolText(inbox)).toContain("auto-to-sibling");
  });

  it("contact_add remembers a peer so later send can omit to", async () => {
    const aTok = await register("alice");
    const bTok = await register("bob");
    const a = await openBox(aTok, "A");
    const b = await openBox(bTok, "B");

    const added = await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "contact_add",
      arguments: { comm_code: b.commCode, alias: "firmware", default: true },
    });
    expect(toolText(added)).toContain("firmware");
    expect(toolText(added)).toContain(b.commCode);

    const sent = await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { message: "by-default", wait_sec: 0 },
    });
    expect(toolJson(sent)).toMatchObject({ delivered: true });

    const named = await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { to: "firmware", message: "by-alias", wait_sec: 0 },
    });
    expect(toolText(named)).toContain("by-alias");

    const listed = await app.inject({
      method: "GET",
      url: `/api/mailboxes/${a.id}/contacts`,
      headers: { authorization: `Bearer ${aTok}` },
    });
    expect(listed.statusCode).toBe(200);
    const contacts = (listed.json() as { contacts: { commCode: string; alias: string; isDefault: boolean }[] }).contacts;
    expect(contacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ commCode: b.commCode, alias: "firmware", isDefault: true })]),
    );
  });

  it("dial plus answer connects, then send works", async () => {
    const tok = await register("alice");
    const a = await openBox(tok, "desk");
    const b = await openBox(tok, "phone");

    const ringing = rpc(a.bindCode, "sess-a", "tools/call", {
      name: "dial",
      arguments: { timeout_sec: 8 },
    }, 8);
    await new Promise((r) => setTimeout(r, 80));
    const pickup = await rpc(b.bindCode, "sess-b", "tools/call", {
      name: "answer",
      arguments: { timeout_sec: 8 },
    }, 9);
    const answered = await ringing;
    expect(toolText(answered)).toContain("CONNECTED");
    expect(toolJson(answered)).toMatchObject({ connected: true });
    expect(toolText(pickup)).toContain("CONNECTED");
    expect(toolJson(pickup)).toMatchObject({ connected: true });
  });

  it("send without a line tells the agent to dial or answer", async () => {
    const tok = await register("alice");
    const a = await openBox(tok, "desk");
    await openBox(tok, "phone");
    const sent = await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { message: "too-soon", wait_sec: 8 },
    });
    expect(toolJson(sent)).toMatchObject({ delivered: false, connected: false });
    expect(toolText(sent)).toContain("NO LINE");
    expect(toolText(sent)).toContain("dial");
    expect(toolText(sent)).toContain("answer");
  });

  it("connect succeeds when the peer is already inbox_waiting", async () => {
    const tok = await register("alice");
    const a = await openBox(tok, "desk");
    const b = await openBox(tok, "phone");

    const listening = rpc(b.bindCode, "sess-b", "tools/call", {
      name: "inbox_wait",
      arguments: { timeout_sec: 8 },
    }, 2);
    await new Promise((r) => setTimeout(r, 80));
    const call = await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "dial",
      arguments: { timeout_sec: 8 },
    }, 3);
    expect(toolJson(call)).toMatchObject({ connected: true });

    await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { message: "line-up", wait_sec: 0 },
    }, 4);
    const waited = await listening;
    expect(toolText(waited)).toContain("line-up");
  });

  it("send holds the line for the reply without inbox_wait", async () => {
    const tok = await register("alice");
    const a = await openBox(tok, "desk");
    const b = await openBox(tok, "phone");

    const ringing = rpc(a.bindCode, "sess-a", "tools/call", {
      name: "dial",
      arguments: { timeout_sec: 8 },
    }, 10);
    await new Promise((r) => setTimeout(r, 40));
    await rpc(b.bindCode, "sess-b", "tools/call", {
      name: "answer",
      arguments: { timeout_sec: 8 },
    }, 11);
    expect(toolJson(await ringing)).toMatchObject({ connected: true });

    const aHold = rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { message: "from-desk", wait_sec: 8 },
    }, 12);
    await new Promise((r) => setTimeout(r, 80));
    const bHold = rpc(b.bindCode, "sess-b", "tools/call", {
      name: "send",
      arguments: { message: "from-phone", wait_sec: 8 },
    }, 13);
    const aRes = await aHold;
    const bRes = await bHold;
    expect(toolText(aRes)).toContain("from-desk");
    expect(toolText(aRes)).toContain("from-phone");
    expect(toolJson(aRes)).toMatchObject({ delivered: true, connected: true });
    expect(toolText(bRes)).toContain("from-phone");
    expect(toolText(bRes)).toContain("from-desk");
  });

  async function liveCall(port: number, bind: string, session: string, name: string, args: Record<string, unknown>, accept: string) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bind}`,
        "mcp-session-id": session,
        "content-type": "application/json",
        accept,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const ctype = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    if (ctype.includes("text/event-stream")) {
      const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) throw new Error(`no sse data: ${raw.slice(0, 200)}`);
      return JSON.parse(dataLine.slice(6)) as { result?: { structuredContent?: Record<string, unknown>; content?: { text: string }[] } };
    }
    return JSON.parse(raw) as { result?: { structuredContent?: Record<string, unknown>; content?: { text: string }[] } };
  }

  it("simultaneous dial and answer via inject completes without stagger", async () => {
    const tok = await register("alice");
    const a = await openBox(tok, "desk");
    const b = await openBox(tok, "phone");
    const [answered, pickup] = await Promise.all([
      rpc(a.bindCode, "sess-a", "tools/call", { name: "dial", arguments: { timeout_sec: 8 } }, 20),
      rpc(b.bindCode, "sess-b", "tools/call", { name: "answer", arguments: { timeout_sec: 8 } }, 21),
    ]);
    expect(toolJson(answered)).toMatchObject({ connected: true });
    expect(toolJson(pickup)).toMatchObject({ connected: true });
  });

  it("simultaneous live HTTP dial and answer complete without stagger", async () => {
    const tok = await register("alice");
    const a = await openBox(tok, "desk");
    const b = await openBox(tok, "phone");
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const accept = "application/json, text/event-stream";
    const [aBody, bBody] = await Promise.all([
      liveCall(port, a.bindCode, "live-a", "dial", { timeout_sec: 8 }, accept),
      liveCall(port, b.bindCode, "live-b", "answer", { timeout_sec: 8 }, accept),
    ]);
    expect(aBody.result?.structuredContent).toMatchObject({ connected: true });
    expect(bBody.result?.structuredContent).toMatchObject({ connected: true });
  });

  it("GET /line SSE pushes unread without polling", async () => {
    const tok = await register("alice");
    const a = await openBox(tok, "desk");
    const b = await openBox(tok, "phone");
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/line`, {
      headers: { authorization: `Bearer ${b.bindCode}`, accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const nextData = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("sse closed");
        buf += dec.decode(value, { stream: true });
        const split = buf.split("\n\n");
        buf = split.pop() ?? "";
        for (const block of split) {
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) return JSON.parse(line.slice(6)) as { unread: { body: string }[] };
        }
      }
    };
    const first = await nextData();
    expect(first.unread).toEqual([]);
    await rpc(a.bindCode, "sess-a", "tools/call", {
      name: "send",
      arguments: { to: b.commCode, message: "over-the-wire", wait_sec: 0 },
    });
    const pushed = await nextData();
    expect(pushed.unread.map((m) => m.body)).toContain("over-the-wire");
    ac.abort();
  });

  it("simultaneous live HTTP send shares the line without inbox_wait", async () => {
    const tok = await register("alice");
    const a = await openBox(tok, "desk");
    const b = await openBox(tok, "phone");
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const accept = "application/json, text/event-stream";
    const [dialed, picked] = await Promise.all([
      liveCall(port, a.bindCode, "live-a", "dial", { timeout_sec: 8 }, accept),
      liveCall(port, b.bindCode, "live-b", "answer", { timeout_sec: 8 }, accept),
    ]);
    expect(dialed.result?.structuredContent).toMatchObject({ connected: true });
    expect(picked.result?.structuredContent).toMatchObject({ connected: true });
    const [aBody, bBody] = await Promise.all([
      liveCall(port, a.bindCode, "live-a", "send", { message: "from-desk", wait_sec: 8 }, accept),
      liveCall(port, b.bindCode, "live-b", "send", { message: "from-phone", wait_sec: 8 }, accept),
    ]);
    expect(aBody.result?.structuredContent).toMatchObject({ delivered: true, connected: true });
    expect(bBody.result?.structuredContent).toMatchObject({ delivered: true, connected: true });
    const aText = (aBody.result?.content ?? []).map((c) => c.text).join("\n");
    const bText = (bBody.result?.content ?? []).map((c) => c.text).join("\n");
    expect(aText).toContain("from-phone");
    expect(bText).toContain("from-desk");
  });
});
