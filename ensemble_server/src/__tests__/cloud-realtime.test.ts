import { describe, expect, it } from "vitest";
import type { AgentSummary } from "@agentorch/shared";
import Fastify from "fastify";
import { CloudRealtimeHub, registerCloudRealtimeRoutes, type CloudSocket } from "../cloud/realtime.js";
import { registerCloudRoutes } from "../cloud/routes.js";
import { MemoryCloudStore } from "../cloud/store.js";

class FakeSocket implements CloudSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

describe("CloudRealtimeHub", () => {
  it("rejects a second desktop connection for the same account", () => {
    const hub = new CloudRealtimeHub();
    const first = new FakeSocket();
    const second = new FakeSocket();

    expect(hub.connect("acct", "desktop", first)).toBe(true);
    expect(hub.connect("acct", "desktop", second)).toBe(false);

    expect(second.closed).toMatchObject({ code: 4409, reason: "desktop_already_online" });
    expect(second.sent).toContainEqual(
      expect.objectContaining({ type: "remote_error", code: "DESKTOP_ALREADY_ONLINE" }),
    );
    expect(hub.isDesktopOnline("acct")).toBe(true);
  });

  it("returns an offline error when web sends without an online desktop", () => {
    const hub = new CloudRealtimeHub();
    const web = new FakeSocket();
    hub.connect("acct", "web", web);

    hub.handle("acct", "web", web, {
      type: "remote_send",
      requestId: "req-1",
      workspaceId: "workspace",
      agentId: "agent",
      text: "hello",
    });

    expect(web.sent).toContainEqual(
      expect.objectContaining({
        type: "remote_error",
        requestId: "req-1",
        code: "DESKTOP_OFFLINE",
        workspaceId: "workspace",
        agentId: "agent",
      }),
    );
  });

  it("forwards web remote sends to desktop and desktop events to web", () => {
    const hub = new CloudRealtimeHub();
    const web = new FakeSocket();
    const desktop = new FakeSocket();

    hub.connect("acct", "web", web);
    hub.connect("acct", "desktop", desktop);

    expect(web.sent).toContainEqual({ type: "online_status", desktopOnline: true });

    hub.handle("acct", "web", web, {
      type: "remote_send",
      requestId: "req-2",
      workspaceId: "workspace",
      agentId: "agent",
      text: "continue",
    });
    expect(desktop.sent).toContainEqual({
      type: "remote_send",
      requestId: "req-2",
      workspaceId: "workspace",
      agentId: "agent",
      text: "continue",
    });

    hub.handle("acct", "desktop", desktop, {
      type: "remote_ack",
      requestId: "req-2",
      workspaceId: "workspace",
      agentId: "agent",
    });
    expect(web.sent).toContainEqual({
      type: "remote_ack",
      requestId: "req-2",
      workspaceId: "workspace",
      agentId: "agent",
    });

    hub.disconnect("acct", "desktop", desktop);
    expect(web.sent).toContainEqual({ type: "online_status", desktopOnline: false });
  });

  it("serializes remote sends per agent until a terminal desktop event", () => {
    const hub = new CloudRealtimeHub();
    const web = new FakeSocket();
    const desktop = new FakeSocket();
    hub.connect("acct", "web", web);
    hub.connect("acct", "desktop", desktop);

    hub.handle("acct", "web", web, {
      type: "remote_send",
      requestId: "req-1",
      workspaceId: "workspace",
      agentId: "agent",
      text: "first",
    });
    hub.handle("acct", "web", web, {
      type: "remote_send",
      requestId: "req-2",
      workspaceId: "workspace",
      agentId: "agent",
      text: "second",
    });

    expect(desktop.sent).toContainEqual(
      expect.objectContaining({ type: "remote_send", requestId: "req-1", text: "first" }),
    );
    expect(desktop.sent).not.toContainEqual(
      expect.objectContaining({ type: "remote_send", requestId: "req-2" }),
    );
    expect(web.sent).toContainEqual(
      expect.objectContaining({ type: "remote_error", requestId: "req-2", code: "AGENT_BUSY" }),
    );

    hub.handle("acct", "desktop", desktop, {
      type: "agent_status",
      workspaceId: "workspace",
      agentId: "agent",
      status: "done",
    });
    hub.handle("acct", "web", web, {
      type: "remote_send",
      requestId: "req-3",
      workspaceId: "workspace",
      agentId: "agent",
      text: "third",
    });

    expect(desktop.sent).toContainEqual(
      expect.objectContaining({ type: "remote_send", requestId: "req-3", text: "third" }),
    );
  });

  it("serializes remote config requests per agent until desktop ack or error", () => {
    const hub = new CloudRealtimeHub();
    const web = new FakeSocket();
    const desktop = new FakeSocket();
    hub.connect("acct", "web", web);
    hub.connect("acct", "desktop", desktop);

    hub.handle("acct", "web", web, {
      type: "config_request",
      requestId: "cfg-1",
      workspaceId: "workspace",
      agentId: "agent",
      patch: { name: "First" },
    });
    hub.handle("acct", "web", web, {
      type: "config_request",
      requestId: "cfg-2",
      workspaceId: "workspace",
      agentId: "agent",
      patch: { name: "Second" },
    });

    expect(desktop.sent).toContainEqual(
      expect.objectContaining({ type: "config_request", requestId: "cfg-1", patch: { name: "First" } }),
    );
    expect(desktop.sent).not.toContainEqual(expect.objectContaining({ type: "config_request", requestId: "cfg-2" }));
    expect(web.sent).toContainEqual(expect.objectContaining({ type: "remote_error", requestId: "cfg-2", code: "CONFIG_BUSY" }));

    hub.handle("acct", "desktop", desktop, {
      type: "remote_error",
      requestId: "cfg-1",
      workspaceId: "workspace",
      agentId: "agent",
      code: "LOCAL_AGENT_NOT_FOUND",
      message: "missing",
    });
    hub.handle("acct", "web", web, {
      type: "config_request",
      requestId: "cfg-3",
      workspaceId: "workspace",
      agentId: "agent",
      patch: { name: "Third" },
    });

    expect(desktop.sent).toContainEqual(
      expect.objectContaining({ type: "config_request", requestId: "cfg-3", patch: { name: "Third" } }),
    );
  });
});

async function makeRealtimeApp() {
  const app = Fastify({ logger: false });
  const store = new MemoryCloudStore();
  registerCloudRoutes(app, store, {
    inviteCode: "invite-123",
    sessionTtlMs: 60 * 60 * 1000,
  });
  registerCloudRealtimeRoutes(app, store);
  await app.ready();
  return { app, store };
}

async function login(app: Awaited<ReturnType<typeof makeRealtimeApp>>["app"], email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cloud/auth/login",
    payload: { email, password: "pass", inviteCode: "invite-123" },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

async function setupCloudAgent(app: Awaited<ReturnType<typeof makeRealtimeApp>>["app"], token: string): Promise<void> {
  const create = await app.inject({
    method: "POST",
    url: "/v1/cloud/workspaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { id: "workspace", name: "Workspace" },
  });
  expect(create.statusCode).toBe(200);
  const sync = await app.inject({
    method: "POST",
    url: "/v1/cloud/workspaces/workspace/sync-batch",
    headers: { authorization: `Bearer ${token}` },
    payload: { expectedRevision: 0, agents: [{ id: "agent", name: "Agent" }] },
  });
  expect(sync.statusCode).toBe(200);
}

async function setupCloudAgentWithMetadata(app: Awaited<ReturnType<typeof makeRealtimeApp>>["app"], token: string): Promise<void> {
  const create = await app.inject({
    method: "POST",
    url: "/v1/cloud/workspaces",
    headers: { authorization: `Bearer ${token}` },
    payload: { id: "workspace", name: "Workspace" },
  });
  expect(create.statusCode).toBe(200);
  const sync = await app.inject({
    method: "POST",
    url: "/v1/cloud/workspaces/workspace/sync-batch",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      expectedRevision: 0,
      agents: [{ id: "agent", name: "Agent", metadata: { displayGroup: "beta", closed: false } }],
    },
  });
  expect(sync.statusCode).toBe(200);
}

function waitForWsJson(
  ws: { once(event: "message", listener: (data: unknown) => void): void },
  predicate: (msg: unknown) => boolean = () => true,
  timeoutMs = 1500,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), timeoutMs);
    const listen = () => {
      ws.once("message", (data) => {
        const msg = JSON.parse(String(data));
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(msg);
          return;
        }
        listen();
      });
    };
    listen();
  });
}

describe("cloud realtime websocket routes", () => {
  it("rejects web remote_send while desktop is offline", async () => {
    const { app } = await makeRealtimeApp();
    try {
      const token = await login(app, "offline@example.com");
      await setupCloudAgent(app, token);
      const web = await app.injectWS(`/v1/cloud/realtime?role=web&token=${encodeURIComponent(token)}`);

      const next = waitForWsJson(web, (msg) => (msg as { type?: string }).type === "remote_error");
      web.send(JSON.stringify({ type: "remote_send", requestId: "req", workspaceId: "workspace", agentId: "agent", text: "hello" }));
      expect(await next).toMatchObject({ type: "remote_error", code: "DESKTOP_OFFLINE", requestId: "req" });
      web.close();
    } finally {
      await app.close();
    }
  });

  it("forwards web sends to desktop and stores desktop message events", async () => {
    const { app } = await makeRealtimeApp();
    try {
      const token = await login(app, "online@example.com");
      await setupCloudAgent(app, token);
      const web = await app.injectWS(`/v1/cloud/realtime?role=web&token=${encodeURIComponent(token)}`);
      const desktop = await app.injectWS(`/v1/cloud/realtime?role=desktop&token=${encodeURIComponent(token)}`);

      const forwarded = waitForWsJson(desktop, (msg) => (msg as { type?: string }).type === "remote_send");
      web.send(JSON.stringify({ type: "remote_send", requestId: "req", workspaceId: "workspace", agentId: "agent", text: "continue" }));
      expect(await forwarded).toMatchObject({
        type: "remote_send",
        requestId: "req",
        workspaceId: "workspace",
        agentId: "agent",
        text: "continue",
      });

      const syncResult = waitForWsJson(desktop, (msg) => (msg as { type?: string }).type === "sync_result");
      desktop.send(
        JSON.stringify({
          type: "agent_message",
          workspaceId: "workspace",
          agentId: "agent",
          seq: 7,
          msg: { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
        }),
      );
      expect(await syncResult).toMatchObject({
        type: "sync_result",
        workspaceId: "workspace",
        revision: 2,
        messageCursors: [{ agentId: "agent", maxSeq: 7 }],
      });

      const snapshot = await app.inject({
        method: "GET",
        url: "/v1/cloud/workspaces/workspace/snapshot",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toMatchObject({
        snapshot: {
          messages: [{ agentId: "agent", seq: 7, type: "assistant" }],
        },
      });
      web.close();
      desktop.close();
    } finally {
      await app.close();
    }
  });

  it("rejects web config changes while desktop is offline", async () => {
    const { app } = await makeRealtimeApp();
    try {
      const token = await login(app, "config-offline@example.com");
      await setupCloudAgent(app, token);
      const web = await app.injectWS(`/v1/cloud/realtime?role=web&token=${encodeURIComponent(token)}`);

      const next = waitForWsJson(web, (msg) => (msg as { type?: string }).type === "remote_error");
      web.send(JSON.stringify({
        type: "config_request",
        requestId: "cfg-offline",
        workspaceId: "workspace",
        agentId: "agent",
        patch: { name: "Remote name" },
      }));
      expect(await next).toMatchObject({ type: "remote_error", code: "DESKTOP_OFFLINE", requestId: "cfg-offline" });
      web.close();
    } finally {
      await app.close();
    }
  });

  it("forwards web config changes and stores desktop acked agent config", async () => {
    const { app } = await makeRealtimeApp();
    try {
      const token = await login(app, "config-online@example.com");
      await setupCloudAgent(app, token);
      const web = await app.injectWS(`/v1/cloud/realtime?role=web&token=${encodeURIComponent(token)}`);
      const desktop = await app.injectWS(`/v1/cloud/realtime?role=desktop&token=${encodeURIComponent(token)}`);

      const forwarded = waitForWsJson(desktop, (msg) => (msg as { type?: string }).type === "config_request");
      web.send(JSON.stringify({
        type: "config_request",
        requestId: "cfg",
        workspaceId: "workspace",
        agentId: "agent",
        patch: { name: "Remote name", model: "gpt-5.5", reasoningEffort: "high" },
      }));
      expect(await forwarded).toMatchObject({
        type: "config_request",
        requestId: "cfg",
        workspaceId: "workspace",
        agentId: "agent",
        patch: { name: "Remote name", model: "gpt-5.5", reasoningEffort: "high" },
      });

      const updated = waitForWsJson(web, (msg) => (msg as { type?: string }).type === "config_updated");
      const sync = waitForWsJson(desktop, (msg) => (msg as { type?: string }).type === "sync_result");
      desktop.send(JSON.stringify({
        type: "config_ack",
        requestId: "cfg",
        workspaceId: "workspace",
        agentId: "agent",
        agent: agentSummary({ name: "Remote name", model: "gpt-5.5", reasoningEffort: "high" }),
      }));
      expect(await updated).toMatchObject({
        type: "config_updated",
        requestId: "cfg",
        workspaceId: "workspace",
        agentId: "agent",
        revision: 2,
        agent: { id: "agent", name: "Remote name", model: "gpt-5.5", reasoningEffort: "high" },
      });
      expect(await sync).toMatchObject({ type: "sync_result", workspaceId: "workspace", revision: 2 });

      const snapshot = await app.inject({
        method: "GET",
        url: "/v1/cloud/workspaces/workspace/snapshot",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toMatchObject({
        snapshot: {
          agents: [{ id: "agent", name: "Remote name", model: "gpt-5.5", reasoningEffort: "high" }],
        },
      });
      web.close();
      desktop.close();
    } finally {
      await app.close();
    }
  });

  it("preserves existing safe cloud metadata when storing desktop acked config", async () => {
    const { app } = await makeRealtimeApp();
    try {
      const token = await login(app, "config-metadata@example.com");
      await setupCloudAgentWithMetadata(app, token);
      const web = await app.injectWS(`/v1/cloud/realtime?role=web&token=${encodeURIComponent(token)}`);
      const desktop = await app.injectWS(`/v1/cloud/realtime?role=desktop&token=${encodeURIComponent(token)}`);

      const forwarded = waitForWsJson(desktop, (msg) => (msg as { type?: string }).type === "config_request");
      web.send(JSON.stringify({
        type: "config_request",
        requestId: "cfg-meta",
        workspaceId: "workspace",
        agentId: "agent",
        patch: { closed: true },
      }));
      await forwarded;

      const updated = waitForWsJson(web, (msg) => (msg as { type?: string }).type === "config_updated");
      desktop.send(JSON.stringify({
        type: "config_ack",
        requestId: "cfg-meta",
        workspaceId: "workspace",
        agentId: "agent",
        agent: agentSummary({ closed: true }),
      }));
      await updated;

      const snapshot = await app.inject({
        method: "GET",
        url: "/v1/cloud/workspaces/workspace/snapshot",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(snapshot.json()).toMatchObject({
        snapshot: {
          agents: [{ id: "agent", metadata: { displayGroup: "beta", closed: true } }],
        },
      });
      web.close();
      desktop.close();
    } finally {
      await app.close();
    }
  });

  it("does not store config when desktop returns a remote error", async () => {
    const { app } = await makeRealtimeApp();
    try {
      const token = await login(app, "config-error@example.com");
      await setupCloudAgent(app, token);
      const web = await app.injectWS(`/v1/cloud/realtime?role=web&token=${encodeURIComponent(token)}`);
      const desktop = await app.injectWS(`/v1/cloud/realtime?role=desktop&token=${encodeURIComponent(token)}`);

      const forwarded = waitForWsJson(desktop, (msg) => (msg as { type?: string }).type === "config_request");
      web.send(JSON.stringify({
        type: "config_request",
        requestId: "cfg-error",
        workspaceId: "workspace",
        agentId: "agent",
        patch: { name: "Should not persist" },
      }));
      await forwarded;

      const webError = waitForWsJson(web, (msg) => (msg as { type?: string }).type === "remote_error");
      desktop.send(JSON.stringify({
        type: "remote_error",
        requestId: "cfg-error",
        workspaceId: "workspace",
        agentId: "agent",
        code: "AGENT_NOT_AVAILABLE",
        message: "not loaded",
      }));
      expect(await webError).toMatchObject({ type: "remote_error", requestId: "cfg-error", code: "AGENT_NOT_AVAILABLE" });

      const snapshot = await app.inject({
        method: "GET",
        url: "/v1/cloud/workspaces/workspace/snapshot",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(snapshot.json()).toMatchObject({ snapshot: { agents: [{ id: "agent", name: "Agent" }] } });
      web.close();
      desktop.close();
    } finally {
      await app.close();
    }
  });

  it("rejects sensitive or unknown config fields before forwarding", async () => {
    const { app } = await makeRealtimeApp();
    try {
      const token = await login(app, "config-secret@example.com");
      await setupCloudAgent(app, token);
      const web = await app.injectWS(`/v1/cloud/realtime?role=web&token=${encodeURIComponent(token)}`);
      const desktop = await app.injectWS(`/v1/cloud/realtime?role=desktop&token=${encodeURIComponent(token)}`);

      const error = waitForWsJson(web, (msg) => (msg as { type?: string }).type === "remote_error");
      web.send(JSON.stringify({
        type: "config_request",
        requestId: "cfg-secret",
        workspaceId: "workspace",
        agentId: "agent",
        patch: { name: "ok", apiKey: "secret" },
      }));
      expect(await error).toMatchObject({ type: "remote_error", code: "BAD_REQUEST" });
      expect(desktop).toBeDefined();
      web.close();
      desktop.close();
    } finally {
      await app.close();
    }
  });
});

function agentSummary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return { ...agentSummaryBase(), ...overrides };
}

function agentSummaryBase(): AgentSummary {
  return {
    id: "agent",
    name: "Agent",
    parentId: null,
    status: "idle",
    model: "model",
    systemPrompt: null,
    providerId: null,
    codexWorkspace: null,
    permissionMode: "default",
    sandboxMode: null,
    reasoningEffort: null,
    teamId: null,
    forcedSkills: [],
    disabledSkills: [],
    closed: false,
    hasResumeInfo: false,
    createdAt: new Date(0).toISOString(),
  };
}
