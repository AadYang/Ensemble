import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerCloudRoutes } from "../cloud/routes.js";
import { MemoryCloudStore } from "../cloud/store.js";

function makeApp() {
  const app = Fastify({ logger: false });
  const store = new MemoryCloudStore();
  registerCloudRoutes(app, store, {
    fixedAccounts: [{ email: "fixed@example.com", password: "fixed-pass", displayName: "Fixed User" }],
    inviteCode: "invite-123",
    sessionTtlMs: 60 * 60 * 1000,
    loginWindowMs: 60 * 1000,
    loginMaxFailures: 2,
  });
  return { app, store };
}

async function login(app: ReturnType<typeof Fastify>, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cloud/auth/login",
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  const parsed = res.json() as { token: string };
  expect(parsed.token).toBeTruthy();
  return parsed.token;
}

async function createWorkspace(app: ReturnType<typeof Fastify>, token: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cloud/workspaces",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { workspace: { id: string; name: string } };
}

describe("cloud account workspace routes", () => {
  it("logs in a fixed beta account and returns /me from the bearer session", async () => {
    const { app } = makeApp();
    try {
      const token = await login(app, { email: "fixed@example.com", password: "fixed-pass" });
      const me = await app.inject({
        method: "GET",
        url: "/v1/cloud/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        account: { email: "fixed@example.com", displayName: "Fixed User" },
      });
      expect(JSON.stringify(me.json())).not.toContain("passwordHash");
    } finally {
      await app.close();
    }
  });

  it("requires auth for workspace APIs", async () => {
    const { app } = makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/cloud/workspaces" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "unauthorized" });
    } finally {
      await app.close();
    }
  });

  it("answers cloud CORS preflight requests", async () => {
    const { app } = makeApp();
    try {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/v1/cloud/workspaces",
        headers: {
          origin: "tauri://localhost",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(String(res.headers["access-control-allow-headers"])).toContain("authorization");
    } finally {
      await app.close();
    }
  });

  it("rate limits repeated login failures and resets after a successful login", async () => {
    const { app } = makeApp();
    try {
      for (let i = 0; i < 2; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/cloud/auth/login",
          payload: { email: "fixed@example.com", password: "wrong" },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: "invalid_credentials" });
      }

      const limited = await app.inject({
        method: "POST",
        url: "/v1/cloud/auth/login",
        payload: { email: "fixed@example.com", password: "wrong" },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: "rate_limited" });

      const otherIp = await app.inject({
        method: "POST",
        url: "/v1/cloud/auth/login",
        remoteAddress: "203.0.113.10",
        payload: { email: "fixed@example.com", password: "fixed-pass" },
      });
      expect(otherIp.statusCode).toBe(200);

      const afterSuccess = await app.inject({
        method: "POST",
        url: "/v1/cloud/auth/login",
        remoteAddress: "203.0.113.10",
        payload: { email: "fixed@example.com", password: "wrong" },
      });
      expect(afterSuccess.statusCode).toBe(401);
      expect(afterSuccess.json()).toMatchObject({ remainingAttempts: 1 });
    } finally {
      await app.close();
    }
  });

  it("isolates workspaces by bearer account, not request body accountId", async () => {
    const { app } = makeApp();
    try {
      const tokenA = await login(app, {
        email: "alice@example.com",
        password: "alice-pass",
        inviteCode: "invite-123",
      });
      const tokenB = await login(app, {
        email: "bob@example.com",
        password: "bob-pass",
        inviteCode: "invite-123",
      });

      const mine = await createWorkspace(app, tokenA, {
        id: "shared-id",
        name: "Alice Workspace",
        accountId: "bob-account-forgery",
      });
      expect(mine.workspace).toMatchObject({ id: "shared-id", name: "Alice Workspace" });

      const aList = await app.inject({
        method: "GET",
        url: "/v1/cloud/workspaces",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(aList.statusCode).toBe(200);
      expect(aList.json()).toMatchObject({ workspaces: [{ id: "shared-id", name: "Alice Workspace" }] });

      const bList = await app.inject({
        method: "GET",
        url: "/v1/cloud/workspaces",
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(bList.statusCode).toBe(200);
      expect(bList.json()).toMatchObject({ workspaces: [] });

      const bRead = await app.inject({
        method: "GET",
        url: "/v1/cloud/workspaces/shared-id/snapshot",
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(bRead.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("sanitizes synced snapshot data before storage", async () => {
    const { app } = makeApp();
    try {
      const token = await login(app, {
        email: "sync@example.com",
        password: "sync-pass",
        inviteCode: "invite-123",
      });
      await createWorkspace(app, token, { id: "cloud", name: "Cloud" });

      const put = await app.inject({
        method: "PUT",
        url: "/v1/cloud/workspaces/cloud/snapshot",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          accountId: "another-account",
          teams: [{ id: "team-1", name: "Team", secretToken: "drop-me" }],
          agents: [
            {
              id: "agent-1",
              name: "Agent",
              systemPrompt: "normal instructions",
              providerKind: "openai",
              providerName: "OpenAI",
              apiKey: "sk-should-not-sync",
              metadata: {
                theme: "dark",
                token: "drop-me",
                nested: { sshKey: "drop-me", safe: "keep-me" },
                lastSessionId: "drop-me",
              },
            },
          ],
          messages: [
            {
              agentId: "agent-1",
              seq: 1,
              type: "user",
              payload: {
                text: "hello",
                providerSecret: "drop-me",
                nested: { apiKey: "drop-me", keep: "ok" },
              },
            },
          ],
        },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ mode: "upsert" });

      const get = await app.inject({
        method: "GET",
        url: "/v1/cloud/workspaces/cloud/snapshot",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.statusCode).toBe(200);
      const json = get.json();
      expect(json.snapshot.agents[0].metadata).toEqual({
        theme: "dark",
        nested: { safe: "keep-me" },
      });
      expect(json.snapshot.messages[0].payload).toEqual({
        text: "hello",
        nested: { keep: "ok" },
      });
      expect(JSON.stringify(json)).not.toContain("drop-me");
      expect(JSON.stringify(json)).not.toContain("sk-should-not-sync");
    } finally {
      await app.close();
    }
  });

  it("applies revision-guarded sync batches and returns message cursors", async () => {
    const { app } = makeApp();
    try {
      const token = await login(app, {
        email: "batch@example.com",
        password: "batch-pass",
        inviteCode: "invite-123",
      });
      await createWorkspace(app, token, { id: "batch", name: "Batch" });

      const first = await app.inject({
        method: "POST",
        url: "/v1/cloud/workspaces/batch/sync-batch",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          expectedRevision: 0,
          agents: [{ id: "agent-1", name: "Agent", model: "gpt-5" }],
          messages: [
            { agentId: "agent-1", seq: 1, type: "user", payload: { text: "one" } },
            { agentId: "agent-1", seq: 2, type: "assistant", payload: { text: "two" } },
          ],
        },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        mode: "sync-batch",
        workspace: { id: "batch", revision: 1 },
        applied: { agents: 1, messages: 2 },
        messageCursors: [{ agentId: "agent-1", maxSeq: 2 }],
      });

      const conflict = await app.inject({
        method: "POST",
        url: "/v1/cloud/workspaces/batch/sync-batch",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          expectedRevision: 0,
          messages: [{ agentId: "agent-1", seq: 3, type: "user", payload: { text: "stale" } }],
        },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: "revision_conflict", currentRevision: 1 });

      const second = await app.inject({
        method: "POST",
        url: "/v1/cloud/workspaces/batch/sync-batch",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          expectedRevision: 1,
          messages: [{ agentId: "agent-1", seq: 3, type: "user", payload: { text: "three" } }],
        },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        workspace: { revision: 2 },
        applied: { messages: 1 },
        messageCursors: [{ agentId: "agent-1", maxSeq: 3 }],
      });

      const noop = await app.inject({
        method: "POST",
        url: "/v1/cloud/workspaces/batch/sync-batch",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          expectedRevision: 2,
        },
      });
      expect(noop.statusCode).toBe(200);
      expect(noop.json()).toMatchObject({
        workspace: { revision: 2 },
        applied: { teams: 0, agents: 0, messages: 0 },
        messageCursors: [{ agentId: "agent-1", maxSeq: 3 }],
      });
    } finally {
      await app.close();
    }
  });
});
