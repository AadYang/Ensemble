import type { FastifyRequest } from "fastify";
import { hashToken } from "./auth.js";
import type { CloudAccountRecord, CloudStore } from "./store.js";

export interface CloudAuthContext {
  tokenHash: string;
  account: CloudAccountRecord;
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1]?.trim() || null;
}

export async function authenticateCloudToken(token: string | null | undefined, store: CloudStore): Promise<CloudAuthContext | null> {
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

export async function authenticateCloudRequest(req: FastifyRequest, store: CloudStore): Promise<CloudAuthContext | null> {
  return authenticateCloudToken(bearerToken(req), store);
}

export async function requireCloudAuth(req: FastifyRequest, store: CloudStore): Promise<CloudAuthContext> {
  const auth = await authenticateCloudRequest(req, store);
  if (!auth) throw new Error("unauthorized");
  return auth;
}
