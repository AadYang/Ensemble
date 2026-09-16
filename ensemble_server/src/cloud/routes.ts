import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  fixedAccountMatches,
  hashPassword,
  hashToken,
  inviteCodeMatches,
  newSessionToken,
  normalizeEmail,
  parseFixedAccounts,
  verifyPassword,
  type FixedAccountConfig,
} from "./auth.js";
import type { CloudAccountRecord, CloudStore } from "./store.js";
import {
  CloudRevisionConflictError,
  isCloudInputRejection,
  publicAccount,
  publishedAgentPlan,
  sanitizeAgentInput,
  withLegacyProjectRootAlias,
} from "./store.js";
import type { RunPlanStatusView } from "@agentorch/shared";
import { bearerToken, authenticateCloudRequest, requireCloudAuth } from "./session-auth.js";

const EMAIL_MAX = 255;
const PASSWORD_MAX = 1024;
// Account workspace sessions are intentionally long lived. Product semantics:
// switching between local/cloud workspaces must not sign the user out; only an
// explicit logout should end the saved desktop/web session in normal use.
const SESSION_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const CLOUD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

const loginBodySchema = z.object({
  email: z.string().email().max(EMAIL_MAX),
  password: z.string().min(1).max(PASSWORD_MAX),
  inviteCode: z.string().max(512).optional(),
  displayName: z.string().max(255).optional(),
});

const workspaceCreateSchema = z.object({
  id: z.string().regex(CLOUD_ID_RE).optional(),
  name: z.string().min(1).max(160),
  // Intentionally accepted then ignored; account ownership comes only from auth.
  accountId: z.string().optional(),
});

const snapshotBodySchema = z.object({
  teams: z.array(z.unknown()).max(500).optional(),
  agents: z.array(z.unknown()).max(1_000).optional(),
  messages: z.array(z.unknown()).max(20_000).optional(),
  // Intentionally ignored for anti-confused-deputy behavior.
  accountId: z.string().optional(),
});

const syncBatchBodySchema = snapshotBodySchema.extend({
  expectedRevision: z.number().int().min(0).optional(),
});

/** The SAME canonical-root rule the local write path enforces, applied to an
 *  incoming body before anything is stored: one field, and a payload that names
 *  two different directories for it is refused with a structured code rather
 *  than resolved by field order. Returns the refusal to send, or null. */
function refuseProjectRootConflict(
  agents: unknown[] | undefined,
  reply: { code: (status: number) => unknown },
): { error: string; path: string; message: string } | null {
  try {
    for (const agent of agents ?? []) sanitizeAgentInput(agent);
  } catch (err) {
    if (!isCloudInputRejection(err)) throw err;
    reply.code(400);
    return { error: err.code, path: err.path, message: err.message };
  }
  return null;
}

const agentParamsSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
});

const paramsSchema = z.object({
  workspaceId: z.string().regex(CLOUD_ID_RE),
});

/** A published plan is relayed, not resolved: the shape checked here is the
 *  same shallow one the read path accepts (see `publishedAgentPlan`), so a
 *  write can never store something `/status` would then refuse to serve. The
 *  full contract lives in `shared` and is validated by the surface that renders
 *  it — re-deriving it here would be the second resolver this design removes. */
const planPublishBodySchema = z.object({
  planView: z.object({
    source: z.string().min(1),
    planHash: z.string().min(1),
    settings: z.array(z.unknown()),
  }).passthrough(),
  publishedAt: z.string().min(1).max(64),
});

export interface CloudRoutesOptions {
  fixedAccounts?: FixedAccountConfig[];
  inviteCode?: string;
  sessionTtlMs?: number;
  loginWindowMs?: number;
  loginMaxFailures?: number;
}

interface LoginFailureBucket {
  count: number;
  resetAt: number;
}

function userAgent(req: FastifyRequest): string | null {
  const value = req.headers["user-agent"];
  return typeof value === "string" ? value.slice(0, 512) : null;
}

function loginFailureKey(req: FastifyRequest, email: string): string {
  return `${req.ip || "unknown"}:${normalizeEmail(email)}`;
}

function getLoginBucket(
  failures: Map<string, LoginFailureBucket>,
  key: string,
  now: number,
): LoginFailureBucket | null {
  const bucket = failures.get(key);
  if (!bucket) return null;
  if (bucket.resetAt <= now) {
    failures.delete(key);
    return null;
  }
  return bucket;
}

function recordLoginFailure(
  failures: Map<string, LoginFailureBucket>,
  key: string,
  now: number,
  windowMs: number,
): LoginFailureBucket {
  const existing = getLoginBucket(failures, key, now);
  const next = existing
    ? { count: existing.count + 1, resetAt: existing.resetAt }
    : { count: 1, resetAt: now + windowMs };
  failures.set(key, next);
  return next;
}

async function ensureFixedAccount(
  store: CloudStore,
  fixed: FixedAccountConfig,
  password: string,
): Promise<CloudAccountRecord> {
  const existing = await store.findAccountByEmail(fixed.email);
  if (existing) return existing;
  return store.createAccount({
    email: fixed.email,
    passwordHash: hashPassword(password),
    displayName: fixed.displayName ?? null,
  });
}

async function loginAccount(
  store: CloudStore,
  body: z.infer<typeof loginBodySchema>,
  options: Required<Pick<CloudRoutesOptions, "fixedAccounts" | "inviteCode" | "sessionTtlMs">>,
): Promise<CloudAccountRecord | null> {
  const email = normalizeEmail(body.email);
  const existing = await store.findAccountByEmail(email);
  if (existing && verifyPassword(body.password, existing.passwordHash)) return existing;

  const fixed = fixedAccountMatches(options.fixedAccounts, email, body.password);
  if (fixed) return ensureFixedAccount(store, fixed, body.password);

  if (existing) return null;
  if (!inviteCodeMatches(body.inviteCode, options.inviteCode)) return null;

  return store.createAccount({
    email,
    passwordHash: hashPassword(body.password),
    displayName: body.displayName ?? null,
  });
}

export function registerCloudRoutes(app: FastifyInstance, store: CloudStore, routeOptions: CloudRoutesOptions = {}): void {
  const options = {
    fixedAccounts: routeOptions.fixedAccounts ?? parseFixedAccounts(),
    inviteCode: routeOptions.inviteCode ?? process.env.ENSEMBLE_BETA_INVITE_CODE ?? "",
    sessionTtlMs: routeOptions.sessionTtlMs ?? SESSION_TTL_MS,
    loginWindowMs: routeOptions.loginWindowMs ?? LOGIN_WINDOW_MS,
    loginMaxFailures: routeOptions.loginMaxFailures ?? LOGIN_MAX_FAILURES,
  };
  const loginFailures = new Map<string, LoginFailureBucket>();

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/v1/cloud/")) return;
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "authorization,content-type");
    reply.header("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  app.post("/v1/cloud/auth/login", async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", detail: parsed.error.issues };
    }
    const failureKey = loginFailureKey(req, parsed.data.email);
    const now = Date.now();
    const bucket = getLoginBucket(loginFailures, failureKey, now);
    if (bucket && bucket.count >= options.loginMaxFailures) {
      reply.code(429);
      return {
        error: "rate_limited",
        retryAfterMs: Math.max(0, bucket.resetAt - now),
      };
    }
    const account = await loginAccount(store, parsed.data, options);
    if (!account) {
      const failed = recordLoginFailure(loginFailures, failureKey, now, options.loginWindowMs);
      reply.code(401);
      return {
        error: "invalid_credentials",
        remainingAttempts: Math.max(0, options.loginMaxFailures - failed.count),
      };
    }
    loginFailures.delete(failureKey);
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + options.sessionTtlMs);
    await store.createSession({
      accountId: account.id,
      tokenHash: hashToken(token),
      expiresAt,
      userAgent: userAgent(req),
    });
    return { token, expiresAt: expiresAt.toISOString(), account: publicAccount(account) };
  });

  app.post("/v1/cloud/auth/logout", async (req) => {
    const token = bearerToken(req);
    if (token) await store.deleteSession(hashToken(token));
    return { ok: true };
  });

  app.get("/v1/cloud/me", async (req, reply) => {
    const auth = await authenticateCloudRequest(req, store);
    if (!auth) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    return { account: publicAccount(auth.account) };
  });

  app.get("/v1/cloud/workspaces", async (req, reply) => {
    try {
      const auth = await requireCloudAuth(req, store);
      return { workspaces: await store.listWorkspaces(auth.account.id) };
    } catch {
      reply.code(401);
      return { error: "unauthorized" };
    }
  });

  app.post("/v1/cloud/workspaces", async (req, reply) => {
    const parsed = workspaceCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", detail: parsed.error.issues };
    }
    try {
      const auth = await requireCloudAuth(req, store);
      const workspace = await store.createWorkspace(auth.account.id, {
        id: parsed.data.id,
        name: parsed.data.name,
      });
      return { workspace };
    } catch {
      reply.code(401);
      return { error: "unauthorized" };
    }
  });

  app.get("/v1/cloud/workspaces/:workspaceId/snapshot", async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: "bad_request", detail: params.error.issues };
    }
    try {
      const auth = await requireCloudAuth(req, store);
      const snapshot = await store.getSnapshot(auth.account.id, params.data.workspaceId);
      if (!snapshot) {
        reply.code(404);
        return { error: "not_found" };
      }
      // One response shape whichever store answered: the legacy column is
      // written as NULL by new writers, so a reader that still asks for
      // `codexWorkspace` gets the canonical value echoed back.
      return { snapshot: { ...snapshot, agents: snapshot.agents.map(withLegacyProjectRootAlias) } };
    } catch {
      reply.code(401);
      return { error: "unauthorized" };
    }
  });

  // Read-only, and honest about what it does not have.
  //
  // The cloud has no runtime, so it cannot RESOLVE a plan — it can only relay
  // the one the owning desktop published with the agent it already syncs. Two
  // answers, and no third:
  //
  //   404                      — this account's workspace has no such agent. The
  //                              lookup is scoped to the WORKSPACE snapshot, so
  //                              a local agent that happens to share the id is
  //                              never consulted and a name is never matched.
  //   { source: "snapshot" }   — the desktop published a plan; here it is,
  //                              verbatim.
  //   { source: "unavailable" }— the agent is known and no plan was published
  //                              for it. An explicit answer, not an empty 200
  //                              the client would have to interpret.
  app.get("/v1/cloud/workspaces/:workspaceId/agents/:agentId/status", async (req, reply) => {
    const params = agentParamsSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: "bad_request", detail: params.error.issues };
    }
    try {
      const auth = await requireCloudAuth(req, store);
      const snapshot = await store.getSnapshot(auth.account.id, params.data.workspaceId);
      if (!snapshot) {
        reply.code(404);
        return { error: "not_found" };
      }
      const agent = snapshot.agents.find((entry) => entry.id === params.data.agentId);
      if (!agent) {
        reply.code(404);
        return { error: "not_found" };
      }
      const published = publishedAgentPlan(agent);
      if (!published) {
        return {
          source: "unavailable" as const,
          planView: null,
          publishedAt: null,
          reason:
            "no desktop has published a run plan for this agent — the cloud holds this agent's " +
            "synced configuration, but a plan is a fact about a run, and only the desktop that " +
            "owns the agent can resolve one",
        };
      }
      return {
        source: "snapshot" as const,
        planView: published.planView,
        publishedAt: published.publishedAt,
        reason: `published by the owning desktop at ${published.publishedAt}`,
      };
    } catch {
      reply.code(401);
      return { error: "unauthorized" };
    }
  });

  // The write half of the same relay — narrow on purpose.
  //
  // Publishing a plan used to ride along with a whole-agent `sync-batch`, which
  // meant the publishing desktop sent its ENTIRE copy of the agent back with it.
  // A desktop holding a snapshot from before another client's change would then
  // revert that change on the next turn: a status publish acting as a config
  // write. This route writes exactly one thing — `metadata.publishedPlan` on the
  // named agent — so no configuration field can be carried, overwritten or
  // rewritten by a publish.
  //
  // 404 for an unknown workspace or agent: an id this account does not have is
  // never created, and a name is never matched.
  app.post("/v1/cloud/workspaces/:workspaceId/agents/:agentId/plan", async (req, reply) => {
    const params = agentParamsSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: "bad_request", detail: params.error.issues };
    }
    const body = planPublishBodySchema.safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: "bad_request", detail: body.error.issues };
    }
    try {
      const auth = await requireCloudAuth(req, store);
      const published = await store.publishAgentPlan(
        auth.account.id,
        params.data.workspaceId,
        params.data.agentId,
        { planView: body.data.planView as unknown as RunPlanStatusView, publishedAt: body.data.publishedAt },
      );
      if (!published) {
        reply.code(404);
        return { error: "not_found" };
      }
      return { agentId: params.data.agentId, publishedAt: published.publishedAt };
    } catch {
      reply.code(401);
      return { error: "unauthorized" };
    }
  });

  app.put("/v1/cloud/workspaces/:workspaceId/snapshot", async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: "bad_request", detail: params.error.issues };
    }
    const body = snapshotBodySchema.safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: "bad_request", detail: body.error.issues };
    }
    const refused = refuseProjectRootConflict(body.data.agents, reply);
    if (refused) return refused;
    try {
      const auth = await requireCloudAuth(req, store);
      const workspace = await store.getWorkspace(auth.account.id, params.data.workspaceId);
      if (!workspace) {
        reply.code(404);
        return { error: "not_found" };
      }
      const snapshot = await store.upsertSnapshot(auth.account.id, params.data.workspaceId, body.data);
      const cursors = new Map<string, number>();
      for (const message of snapshot.messages) {
        cursors.set(message.agentId, Math.max(cursors.get(message.agentId) ?? -1, message.seq));
      }
      return {
        mode: "upsert",
        snapshot,
        revision: snapshot.workspace.revision,
        messageCursors: [...cursors.entries()].map(([agentId, maxSeq]) => ({ agentId, maxSeq })),
      };
    } catch (err) {
      if (err instanceof Error && err.message === "workspace_not_found") {
        reply.code(404);
        return { error: "not_found" };
      }
      reply.code(401);
      return { error: "unauthorized" };
    }
  });

  app.post("/v1/cloud/workspaces/:workspaceId/sync-batch", async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: "bad_request", detail: params.error.issues };
    }
    const body = syncBatchBodySchema.safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: "bad_request", detail: body.error.issues };
    }
    const refused = refuseProjectRootConflict(body.data.agents, reply);
    if (refused) return refused;
    try {
      const auth = await requireCloudAuth(req, store);
      const workspace = await store.getWorkspace(auth.account.id, params.data.workspaceId);
      if (!workspace) {
        reply.code(404);
        return { error: "not_found" };
      }
      const result = await store.syncBatch(auth.account.id, params.data.workspaceId, body.data);
      return { mode: "sync-batch", ...result };
    } catch (err) {
      if (err instanceof CloudRevisionConflictError) {
        reply.code(409);
        return {
          error: "revision_conflict",
          currentRevision: err.currentRevision,
        };
      }
      if (err instanceof Error && err.message === "workspace_not_found") {
        reply.code(404);
        return { error: "not_found" };
      }
      reply.code(401);
      return { error: "unauthorized" };
    }
  });
}
