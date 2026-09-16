// The cloud's read-only answer about ONE agent's run plan.
//
// The cloud has no runtime, so it cannot resolve a plan — it can only relay the
// one the owning desktop published, or say it has none. Two rules are pinned
// here, and both exist to stop a plausible wrong answer:
//
//   * the lookup is scoped to the WORKSPACE SNAPSHOT by id. A local agent on
//     some other machine that happens to share an id or a name is never
//     consulted, and a name is never used to find one.
//   * "no plan published" is `source: "unavailable"` with a reason — a complete
//     answer, not an empty 200 a surface would render as "nothing to see".
//
// Plus the write-side half of gate 7: an ordinary config upload that says
// nothing about the plan does not DELETE it.

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerCloudRoutes } from "../cloud/routes.js";
import { MemoryCloudStore, PUBLISHED_PLAN_KEY } from "../cloud/store.js";

function makeApp() {
  const app = Fastify({ logger: false });
  const store = new MemoryCloudStore();
  registerCloudRoutes(app, store, {
    fixedAccounts: [{ email: "fixed@example.com", password: "fixed-pass", displayName: "Fixed User" }],
    inviteCode: "invite-123",
    sessionTtlMs: 60 * 60 * 1000,
  });
  return { app, store };
}

async function token(app: ReturnType<typeof Fastify>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cloud/auth/login",
    payload: { email: "fixed@example.com", password: "fixed-pass" },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function workspace(app: ReturnType<typeof Fastify>, bearer: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cloud/workspaces",
    headers: auth(bearer),
    payload: { name: "ws", id: "ws-1" },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { workspace: { id: string } }).workspace.id;
}

const planView = (planHash: string) => ({
  source: "last-turn",
  planHash,
  resolvedAt: "2026-09-15T10:00:00.000Z",
  identity: { providerId: null, providerScope: "openai-compat", runtime: "http", transport: "responses", modelId: "m", runtimeVersion: null },
  settings: [{ field: "transport", path: "transport", requested: null, resolved: "responses", outcome: "inherit", source: "s", confidence: "confirmed", reason: "r", editable: true, rejectedChoices: [] }],
  diagnostics: [],
});

async function upload(
  app: ReturnType<typeof Fastify>,
  bearer: string,
  workspaceId: string,
  agent: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/cloud/workspaces/${workspaceId}/sync-batch`,
    headers: auth(bearer),
    payload: { agents: [agent] },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

const agentBody = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  parentId: null,
  teamId: null,
  name: "Agent",
  systemPrompt: null,
  model: "m",
  providerKind: null,
  providerName: null,
  providerId: null,
  permissionMode: "default",
  sandboxMode: null,
  reasoningEffort: null,
  projectRoot: "D:/work/project",
  metadata: { maxRunDurationMs: 1000 },
  sortOrder: 0,
  revision: 0,
  updatedAt: "2026-09-15T00:00:00.000Z",
  ...over,
});

describe("GET /agents/:agentId/status", () => {
  it("relays the published plan verbatim", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const workspaceId = await workspace(app, bearer);
      await upload(app, bearer, workspaceId, agentBody({
        metadata: { [PUBLISHED_PLAN_KEY]: { planView: planView("hash-a"), publishedAt: "2026-09-15T10:00:00.000Z" } },
      }));

      const res = await app.inject({
        method: "GET",
        url: `/v1/cloud/workspaces/${workspaceId}/agents/agent-1/status`,
        headers: auth(bearer),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { source: string; planView: { planHash: string }; publishedAt: string };
      expect(body.source).toBe("snapshot");
      expect(body.planView.planHash).toBe("hash-a");
      expect(body.publishedAt).toBe("2026-09-15T10:00:00.000Z");
    } finally {
      await app.close();
    }
  });

  it("says `unavailable` — with a reason — when no plan was ever published", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const workspaceId = await workspace(app, bearer);
      await upload(app, bearer, workspaceId, agentBody());

      const res = await app.inject({
        method: "GET",
        url: `/v1/cloud/workspaces/${workspaceId}/agents/agent-1/status`,
        headers: auth(bearer),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { source: string; planView: null; reason: string };
      expect(body.source).toBe("unavailable");
      expect(body.planView).toBeNull();
      expect(body.reason).not.toBe("");
    } finally {
      await app.close();
    }
  });

  it("is not a name lookup: an unknown id 404s even when the name matches", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const workspaceId = await workspace(app, bearer);
      await upload(app, bearer, workspaceId, agentBody({ id: "the-real-id", name: "Agent" }));

      const res = await app.inject({
        method: "GET",
        // "Agent" is the NAME of an agent in this workspace. The route takes an
        // id, so this must not resolve to it.
        url: `/v1/cloud/workspaces/${workspaceId}/agents/Agent/status`,
        headers: auth(bearer),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("404s for another account's workspace rather than answering from it", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const workspaceId = await workspace(app, bearer);
      await upload(app, bearer, workspaceId, agentBody());

      const res = await app.inject({
        method: "GET",
        url: `/v1/cloud/workspaces/not-this-account/agents/agent-1/status`,
        headers: auth(bearer),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed id with a structured 400", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const res = await app.inject({
        method: "GET",
        url: "/v1/cloud/workspaces//agents//status",
        headers: auth(bearer),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "bad_request" });
    } finally {
      await app.close();
    }
  });
});

// ── The write half of the relay ──────────────────────────────────────────────
//
// Publishing used to ride a whole-agent `sync-batch`: the desktop sent its
// ENTIRE copy of the agent along with the plan, and a desktop whose snapshot
// predated another client's settings change reverted that change on its next
// turn — a status publish acting as a config write. These gates pin the write
// the plan route performs: one field, on one row, named by id.
describe("a plan publish moves the plan and nothing else", () => {
  async function snapshotAgent(
    app: ReturnType<typeof Fastify>,
    bearer: string,
    workspaceId: string,
    agentId: string,
  ): Promise<{ agent: Record<string, unknown> | null; revision: number }> {
    const res = await app.inject({
      method: "GET",
      url: `/v1/cloud/workspaces/${workspaceId}/snapshot`,
      headers: auth(bearer),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      snapshot: { agents: Array<Record<string, unknown>>; workspace: { revision: number } };
    };
    return {
      agent: body.snapshot.agents.find((entry) => entry.id === agentId) ?? null,
      revision: body.snapshot.workspace.revision,
    };
  }

  async function publishPlan(
    app: ReturnType<typeof Fastify>,
    bearer: string,
    workspaceId: string,
    agentId: string,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const res = await app.inject({
      method: "POST",
      url: `/v1/cloud/workspaces/${workspaceId}/agents/${agentId}/plan`,
      headers: auth(bearer),
      payload,
    });
    return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  it("keeps the configuration another client changed, and moves only the plan", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const workspaceId = await workspace(app, bearer);
      // Client A uploads the agent.
      await upload(app, bearer, workspaceId, agentBody());
      const first = await snapshotAgent(app, bearer, workspaceId, "agent-1");

      // Client B changes the configuration.
      await upload(app, bearer, workspaceId, agentBody({
        name: "Renamed by B",
        model: "model-b",
        projectRoot: "D:/b",
        permissionMode: "acceptEdits",
        metadata: { maxRunDurationMs: 2000, sandboxMode: "workspace-write" },
      }));
      const b = await snapshotAgent(app, bearer, workspaceId, "agent-1");

      // Client A — whose snapshot still holds its OLD copy of every field —
      // publishes a plan, and tries to send that stale copy with it. None of it
      // may land: a publish writes the plan, not the agent.
      const res = await publishPlan(app, bearer, workspaceId, "agent-1", {
        planView: planView("hash-a"),
        publishedAt: "2026-09-15T10:00:00.000Z",
        name: "Agent",
        model: "m",
        projectRoot: "D:/work/project",
        permissionMode: "default",
        revision: 0,
        metadata: { maxRunDurationMs: 1000 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ agentId: "agent-1" });

      const after = await snapshotAgent(app, bearer, workspaceId, "agent-1");
      // B's values, field by field.
      expect(after.agent!.name).toBe("Renamed by B");
      expect(after.agent!.model).toBe("model-b");
      expect(after.agent!.projectRoot).toBe("D:/b");
      expect(after.agent!.permissionMode).toBe("acceptEdits");
      expect(after.agent!.metadata).toMatchObject({
        maxRunDurationMs: 2000,
        sandboxMode: "workspace-write",
      });
      // …and the plan is the ONE thing that moved.
      expect(after.agent!.metadata).toMatchObject({
        [PUBLISHED_PLAN_KEY]: { planView: { planHash: "hash-a" }, publishedAt: "2026-09-15T10:00:00.000Z" },
      });
      // The read route serves it, so the write went where `/status` reads.
      const status = await app.inject({
        method: "GET",
        url: `/v1/cloud/workspaces/${workspaceId}/agents/agent-1/status`,
        headers: auth(bearer),
      });
      expect((status.json() as { planView: { planHash: string } }).planView.planHash).toBe("hash-a");

      // A plan is not configuration: the revision other clients sync against
      // does not move, so a publish cannot make their next upload conflict —
      // and it did not move for B's config change either.
      expect(after.revision).toBe(b.revision);
      expect(b.revision).not.toBe(first.revision);
      // The agent's own row was not rewritten wholesale either.
      expect(after.agent!.updatedAt).toBe(b.agent!.updatedAt);
    } finally {
      await app.close();
    }
  });

  it("refuses an unknown agent, and never creates one", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const workspaceId = await workspace(app, bearer);
      await upload(app, bearer, workspaceId, agentBody({ id: "the-real-id", name: "Agent" }));

      const missing = await publishPlan(app, bearer, workspaceId, "no-such-agent", {
        planView: planView("hash-a"),
        publishedAt: "at-a",
      });
      expect(missing.statusCode).toBe(404);

      // A name is not an id, and the refusal creates nothing.
      const byName = await publishPlan(app, bearer, workspaceId, "Agent", {
        planView: planView("hash-a"),
        publishedAt: "at-a",
      });
      expect(byName.statusCode).toBe(404);

      const unknownWorkspace = await publishPlan(app, bearer, "not-this-account", "the-real-id", {
        planView: planView("hash-a"),
        publishedAt: "at-a",
      });
      expect(unknownWorkspace.statusCode).toBe(404);

      const listed = await snapshotAgent(app, bearer, workspaceId, "the-real-id");
      const all = await app.inject({
        method: "GET",
        url: `/v1/cloud/workspaces/${workspaceId}/snapshot`,
        headers: auth(bearer),
      });
      expect((all.json() as { snapshot: { agents: unknown[] } }).snapshot.agents).toHaveLength(1);
      // Nothing was published onto the agent that DOES exist either.
      expect(listed.agent!.metadata).not.toHaveProperty(PUBLISHED_PLAN_KEY);
    } finally {
      await app.close();
    }
  });

  it("rejects a plan the read path could not serve, with a structured 400", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const workspaceId = await workspace(app, bearer);
      await upload(app, bearer, workspaceId, agentBody());

      // No `settings` array: storing this would make `/status` answer
      // `unavailable` for a plan the client believes it published.
      const bad = await publishPlan(app, bearer, workspaceId, "agent-1", {
        planView: { source: "last-turn", planHash: "hash-a" },
        publishedAt: "at-a",
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).toMatchObject({ error: "bad_request" });

      const after = await snapshotAgent(app, bearer, workspaceId, "agent-1");
      expect(after.agent!.metadata).not.toHaveProperty(PUBLISHED_PLAN_KEY);
    } finally {
      await app.close();
    }
  });
});

describe("gate 7: a config upload does not delete the published plan", () => {
  it("keeps the stored plan when the incoming metadata is silent about it", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const workspaceId = await workspace(app, bearer);
      await upload(app, bearer, workspaceId, agentBody({
        metadata: { [PUBLISHED_PLAN_KEY]: { planView: planView("hash-a"), publishedAt: "at-a" } },
      }));
      // The ordinary settings upload: local metadata, no plan key at all.
      await upload(app, bearer, workspaceId, agentBody({ name: "Renamed" }));

      const res = await app.inject({
        method: "GET",
        url: `/v1/cloud/workspaces/${workspaceId}/agents/agent-1/status`,
        headers: auth(bearer),
      });
      const body = res.json() as { source: string; planView: { planHash: string } | null };
      expect(body.source).toBe("snapshot");
      expect(body.planView?.planHash).toBe("hash-a");

      // …and an EXPLICIT new plan still replaces it.
      await upload(app, bearer, workspaceId, agentBody({
        metadata: { [PUBLISHED_PLAN_KEY]: { planView: planView("hash-b"), publishedAt: "at-b" } },
      }));
      const replaced = await app.inject({
        method: "GET",
        url: `/v1/cloud/workspaces/${workspaceId}/agents/agent-1/status`,
        headers: auth(bearer),
      });
      expect((replaced.json() as { planView: { planHash: string } }).planView.planHash).toBe("hash-b");
    } finally {
      await app.close();
    }
  });

  it("does not resurrect a plan that is not there", async () => {
    const { app } = makeApp();
    try {
      const bearer = await token(app);
      const workspaceId = await workspace(app, bearer);
      await upload(app, bearer, workspaceId, agentBody());
      await upload(app, bearer, workspaceId, agentBody({ metadata: { maxRunDurationMs: 2000 } }));
      const res = await app.inject({
        method: "GET",
        url: `/v1/cloud/workspaces/${workspaceId}/agents/agent-1/status`,
        headers: auth(bearer),
      });
      expect((res.json() as { source: string }).source).toBe("unavailable");
    } finally {
      await app.close();
    }
  });
});
