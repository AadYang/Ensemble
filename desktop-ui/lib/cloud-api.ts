// The cloud client: session storage and the requests. The DTO, the upload
// builder and the config signature live in `@agentorch/shared` (see
// `shared/src/cloud-config.ts`) — they are the half that has invariants worth
// testing (no legacy path field in the payload, signature keys === payload keys,
// the run ceiling in `metadata`), and `desktop-ui` has no test runner. They are
// re-exported here so every existing import keeps working and there is still
// exactly ONE definition of each name.
export {
  CLOUD_AGENT_FIELDS,
  CLOUD_AGENT_SERVER_FIELDS,
  CloudSnapshotScrubError,
  PUBLISHED_PLAN_KEY,
  buildCloudSnapshotFromLocal,
  cloudConfigSignature,
  isCloudSnapshotScrubError,
  scrubSecrets,
} from "@agentorch/shared";
export type {
  CloudAgent,
  CloudAgentStatus,
  CloudMessage,
  CloudMessageCursor,
  CloudSnapshot,
  CloudSnapshotInput,
  CloudSyncBatchInput,
  CloudSyncBatchResult,
  CloudTeam,
  CloudWorkspace,
} from "@agentorch/shared";

import {
  type CloudAgentStatus,
  type CloudMessageCursor,
  type CloudSnapshot,
  type CloudSnapshotInput,
  type CloudSyncBatchInput,
  type CloudSyncBatchResult,
  type CloudWorkspace,
  type RunPlanStatusView,
} from "@agentorch/shared";

const DEFAULT_CLOUD_ORIGIN = "https://ensemble-ai.cn";
const CLOUD_SESSION_KEY = "ensemble:cloud-session";

export interface CloudAccount {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudSession {
  origin: string;
  token: string;
  expiresAt: string;
  account: CloudAccount;
}

interface StoredCloudSession {
  origin: string;
  token: string;
  expiresAt: string;
  account: CloudAccount;
}

function normalizeOrigin(origin: string): string {
  const raw = origin.trim() || DEFAULT_CLOUD_ORIGIN;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Cloud server must use HTTPS.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function defaultCloudOrigin(): string {
  return DEFAULT_CLOUD_ORIGIN;
}

export function loadCloudSession(): CloudSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(CLOUD_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCloudSession>;
    if (!parsed.origin || !parsed.token || !parsed.expiresAt || !parsed.account) return null;
    return {
      origin: normalizeOrigin(parsed.origin),
      token: parsed.token,
      expiresAt: parsed.expiresAt,
      account: parsed.account as CloudAccount,
    };
  } catch {
    window.localStorage.removeItem(CLOUD_SESSION_KEY);
    return null;
  }
}

export function saveCloudSession(session: CloudSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CLOUD_SESSION_KEY, JSON.stringify(session));
}

export function clearCloudSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(CLOUD_SESSION_KEY);
}

async function cloudFetch<T>(
  origin: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${normalizeOrigin(origin)}${path}`, {
    ...init,
    headers,
    credentials: "omit",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = body || `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string; retryAfterMs?: number };
      message = parsed.message ?? parsed.error ?? message;
      if (res.status === 429 && typeof parsed.retryAfterMs === "number") {
        message = `${message}; retry after ${Math.ceil(parsed.retryAfterMs / 1000)}s`;
      }
    } catch {
      // plain text response
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function loginCloud(input: {
  origin?: string;
  email: string;
  password: string;
  inviteCode?: string;
}): Promise<CloudSession> {
  const origin = normalizeOrigin(input.origin ?? DEFAULT_CLOUD_ORIGIN);
  const body: Record<string, string> = {
    email: input.email,
    password: input.password,
  };
  if (input.inviteCode?.trim()) body.inviteCode = input.inviteCode.trim();
  const res = await cloudFetch<{
    token: string;
    expiresAt: string;
    account: CloudAccount;
  }>(origin, "/v1/cloud/auth/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const session: CloudSession = { origin, token: res.token, expiresAt: res.expiresAt, account: res.account };
  saveCloudSession(session);
  return session;
}

export async function logoutCloud(session: CloudSession): Promise<void> {
  try {
    await cloudFetch(session.origin, "/v1/cloud/auth/logout", { method: "POST" }, session.token);
  } finally {
    clearCloudSession();
  }
}

export async function fetchCloudMe(session: CloudSession): Promise<CloudAccount> {
  const body = await cloudFetch<{ account: CloudAccount }>(session.origin, "/v1/cloud/me", {}, session.token);
  return body.account;
}

export async function listCloudWorkspaces(session: CloudSession): Promise<CloudWorkspace[]> {
  const body = await cloudFetch<{ workspaces: CloudWorkspace[] }>(
    session.origin,
    "/v1/cloud/workspaces",
    {},
    session.token,
  );
  return body.workspaces;
}

export async function createCloudWorkspace(session: CloudSession, name: string): Promise<CloudWorkspace> {
  const body = await cloudFetch<{ workspace: CloudWorkspace }>(
    session.origin,
    "/v1/cloud/workspaces",
    { method: "POST", body: JSON.stringify({ name }) },
    session.token,
  );
  return body.workspace;
}

export async function fetchCloudSnapshot(
  session: CloudSession,
  workspaceId: string,
): Promise<CloudSnapshot> {
  const body = await cloudFetch<{ snapshot: CloudSnapshot }>(
    session.origin,
    `/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/snapshot`,
    {},
    session.token,
  );
  return body.snapshot;
}

export async function upsertCloudSnapshot(
  session: CloudSession,
  workspaceId: string,
  snapshot: CloudSnapshotInput,
): Promise<{ snapshot: CloudSnapshot; messageCursors: CloudMessageCursor[] }> {
  const body = await cloudFetch<{ mode: "upsert"; snapshot: CloudSnapshot; messageCursors?: CloudMessageCursor[] }>(
    session.origin,
    `/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/snapshot`,
    { method: "PUT", body: JSON.stringify(snapshot) },
    session.token,
  );
  return { snapshot: body.snapshot, messageCursors: body.messageCursors ?? [] };
}

export async function syncCloudBatch(
  session: CloudSession,
  workspaceId: string,
  batch: CloudSyncBatchInput,
): Promise<CloudSyncBatchResult> {
  const body = await cloudFetch<{ mode: "sync-batch" } & CloudSyncBatchResult>(
    session.origin,
    `/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/sync-batch`,
    { method: "POST", body: JSON.stringify(batch) },
    session.token,
  );
  return {
    workspace: body.workspace,
    applied: body.applied,
    messageCursors: body.messageCursors,
  };
}

export async function fetchCloudAgentStatus(
  session: CloudSession,
  workspaceId: string,
  agentId: string,
): Promise<CloudAgentStatus> {
  return cloudFetch<CloudAgentStatus>(
    session.origin,
    `/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/status`,
    {},
    session.token,
  );
}

/** Publish THIS desktop's resolved plan for one agent.
 *
 *  A plan is not configuration, so it travels on its own narrow write — the
 *  agent is named by ID and nothing but `metadata.publishedPlan` moves. Sending
 *  the whole agent back (as this used to) meant a desktop whose snapshot was
 *  older than another client's settings change would revert that change on its
 *  next turn: a status publish acting as a config write. Nothing about the
 *  agent's configuration is sent, so nothing about it can be rewritten here. */
export async function publishCloudAgentPlan(
  session: CloudSession,
  workspaceId: string,
  agentId: string,
  planView: RunPlanStatusView,
): Promise<void> {
  await cloudFetch<{ agentId: string; publishedAt: string }>(
    session.origin,
    `/v1/cloud/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/plan`,
    { method: "POST", body: JSON.stringify({ planView, publishedAt: new Date().toISOString() }) },
    session.token,
  );
}
