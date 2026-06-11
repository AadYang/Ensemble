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
import { publicAccount } from "./store.js";

const EMAIL_MAX = 255;
const PASSWORD_MAX = 1024;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLOUD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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

const paramsSchema = z.object({
  workspaceId: z.string().regex(CLOUD_ID_RE),
});

export interface CloudRoutesOptions {
  fixedAccounts?: FixedAccountConfig[];
  inviteCode?: string;
  sessionTtlMs?: number;
}

interface AuthContext {
  tokenHash: string;
  account: CloudAccountRecord;
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
  };

  app.post("/v1/cloud/auth/login", async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_request", detail: parsed.error.issues };
    }
    const account = await loginAccount(store, parsed.data, options);
    if (!account) {
      reply.code(401);
      return { error: "invalid_credentials" };
    }
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
      return { snapshot };
    } catch (err) {
      if (err instanceof Error && err.message === "workspace_not_found") {
        reply.code(404);
        return { error: "not_found" };
      }
      reply.code(401);
      return { error: "unauthorized" };
    }
  });
}
