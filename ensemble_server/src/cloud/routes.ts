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
import { CloudRevisionConflictError, publicAccount } from "./store.js";

const EMAIL_MAX = 255;
const PASSWORD_MAX = 1024;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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

const paramsSchema = z.object({
  workspaceId: z.string().regex(CLOUD_ID_RE),
});

export interface CloudRoutesOptions {
  fixedAccounts?: FixedAccountConfig[];
  inviteCode?: string;
  sessionTtlMs?: number;
  loginWindowMs?: number;
  loginMaxFailures?: number;
}

interface AuthContext {
  tokenHash: string;
  account: CloudAccountRecord;
}

interface LoginFailureBucket {
  count: number;
  resetAt: number;
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1]?.trim() || null;
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

async function authenticate(req: FastifyRequest, store: CloudStore): Promise<AuthContext | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await store.getSessionByTokenHash(tokenHash);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await store.deleteSession(tokenHash);
    return null;
  }
  const account = await store.getAccountById(session.accountId);
  if (!account) return null;
  await store.touchSession(tokenHash, new Date());
  return { tokenHash, account };
}

async function requireAuth(req: FastifyRequest, store: CloudStore): Promise<AuthContext> {
  const auth = await authenticate(req, store);
  if (!auth) throw new Error("unauthorized");
  return auth;
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
    const auth = await authenticate(req, store);
    if (!auth) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    return { account: publicAccount(auth.account) };
  });

  app.get("/v1/cloud/workspaces", async (req, reply) => {
    try {
      const auth = await requireAuth(req, store);
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
      const auth = await requireAuth(req, store);
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
      const auth = await requireAuth(req, store);
      const snapshot = await store.getSnapshot(auth.account.id, params.data.workspaceId);
      if (!snapshot) {
        reply.code(404);
        return { error: "not_found" };
      }
      return { snapshot };
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
    try {
      const auth = await requireAuth(req, store);
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
    try {
      const auth = await requireAuth(req, store);
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
