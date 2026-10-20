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
    return body.result?.content?.[0]?.text ?? "";
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
    expect(toolText(sent)).toContain("delivered");

    const waited = await waiting;
    expect(waited.statusCode).toBe(200);
    const text = toolText(waited);
    expect(text).toContain("hello from A");
    expect(text).toContain(a.commCode);
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
    const sentText = toolText(sent);
    const sentJson = JSON.parse(sentText) as { files?: { id: string }[]; error?: string };
    expect(sentJson, sentText).toMatchObject({ delivered: true });
    expect(sentJson.files?.[0]?.id).toBeTruthy();

    const inbox = await rpc(b.bindCode, "sess-b", "tools/call", { name: "inbox", arguments: {} });
    const inboxJson = JSON.parse(toolText(inbox)) as { messages: { files: { id: string }[] }[] };
    const fileId = inboxJson.messages[0]?.files[0]?.id;
    expect(fileId).toBeTruthy();

    const got = await rpc(b.bindCode, "sess-b", "tools/call", {
      name: "file_get",
      arguments: { file_id: fileId },
    });
    const file = JSON.parse(toolText(got)) as { data_base64: string; filename: string };
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
  });

  it("puts the comm code into initialize instructions", async () => {
    const token = await register("alice");
    const box = await openBox(token, "A");
    const res = await rpc(box.bindCode, "sess-init", "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    const body = res.json() as { result: { instructions: string } };
    expect(body.result.instructions).toContain(box.commCode);
  });
});
