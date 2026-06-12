import type { AgentSummary, TeamSummary } from "@agentorch/shared";
import type { PersistedMessage } from "./agent-api";

const DEFAULT_CLOUD_ORIGIN = "https://ensemble-ai.cn";
const CLOUD_SESSION_KEY = "ensemble:cloud-session";

const SECRET_KEY_RE =
  /(api[_-]?key|secret|token|oauth|ssh|password|credential|cookie|private[_-]?key|env|authorization|bearer|access[_-]?token|refresh[_-]?token|session)/i;
const BLOCKED_METADATA_KEYS = new Set([
  "lastSessionId",
  "codexResumeSignature",
  "codexUsageSnapshot",
  "resumeMetadata",
  "providerSecrets",
  "providerCredentials",
]);

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

export interface CloudWorkspace {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudTeam {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  revision: number;
  updatedAt: string;
}

export interface CloudAgent {
  id: string;
  parentId: string | null;
  teamId: string | null;
  name: string;
  systemPrompt: string | null;
  model: string | null;
  providerKind: string | null;
  providerName: string | null;
  providerId: string | null;
  permissionMode: string | null;
  sandboxMode: string | null;
  reasoningEffort: string | null;
  codexWorkspace: string | null;
  metadata: Record<string, unknown>;
  sortOrder: number;
  revision: number;
  updatedAt: string;
}

export interface CloudMessage {
  agentId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt?: string;
}

export interface CloudSnapshot {
  workspace: CloudWorkspace;
  teams: CloudTeam[];
  agents: CloudAgent[];
  messages: CloudMessage[];
}

export interface CloudSnapshotInput {
  teams: CloudTeam[];
  agents: CloudAgent[];
  messages: CloudMessage[];
}

export interface CloudMessageCursor {
  agentId: string;
  maxSeq: number;
}

export interface CloudSyncBatchInput extends Partial<CloudSnapshotInput> {
  expectedRevision?: number;
}

export interface CloudSyncBatchResult {
  workspace: CloudWorkspace;
  applied: {
    teams: number;
    agents: number;
    messages: number;
  };
  messageCursors: CloudMessageCursor[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (value == null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 500).map((entry) => scrubSecrets(entry, depth + 1));
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 100)) {
    if (SECRET_KEY_RE.test(key) || BLOCKED_METADATA_KEYS.has(key)) continue;
    out[key] = scrubSecrets(nested, depth + 1);
  }
  return out;
}

function messageTypeFromPayload(msg: PersistedMessage): string {
  if (isRecord(msg.msg) && typeof msg.msg.type === "string") return msg.msg.type;
  return "system";
}

export function buildCloudSnapshotFromLocal(input: {
  agents: AgentSummary[];
  teams: TeamSummary[];
  messagesByAgent: Record<string, PersistedMessage[]>;
}): CloudSnapshotInput {
  const teams: CloudTeam[] = input.teams.map((team, index) => ({
    id: team.id,
    name: team.name,
    description: team.description,
    sortOrder: index,
    revision: 0,
    updatedAt: team.createdAt,
  }));

  const agents: CloudAgent[] = input.agents.map((agent, index) => ({
    id: agent.id,
    parentId: agent.parentId,
    teamId: agent.teamId,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    providerKind: null,
    providerName: null,
    providerId: agent.providerId,
    permissionMode: agent.permissionMode,
    sandboxMode: agent.sandboxMode,
    reasoningEffort: agent.reasoningEffort,
    codexWorkspace: agent.codexWorkspace,
    metadata: {
      forcedSkills: agent.forcedSkills,
      disabledSkills: agent.disabledSkills,
      closed: agent.closed,
    },
    sortOrder: index,
    revision: 0,
    updatedAt: agent.createdAt,
  }));

  const messages: CloudMessage[] = [];
  for (const agent of input.agents) {
    const agentMessages = input.messagesByAgent[agent.id] ?? [];
    for (const msg of agentMessages) {
      messages.push({
        agentId: agent.id,
        seq: msg.seq,
        type: messageTypeFromPayload(msg),
        payload: scrubSecrets(msg.msg),
      });
    }
  }
  return { teams, agents, messages };
}

function stableConfigMetadata(value: unknown): unknown {
  const scrubbed = scrubSecrets(value);
  if (!isRecord(scrubbed)) return {};
  return sortObject(scrubbed);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortObject(value[key]);
  }
  return out;
}

export function cloudConfigSignature(snapshot: { teams: CloudTeam[]; agents: CloudAgent[] }): string {
  const teams = [...snapshot.teams]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((team) => ({
      id: team.id,
      name: team.name,
      description: team.description,
      sortOrder: team.sortOrder,
    }));
  const agents = [...snapshot.agents]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((agent) => ({
      id: agent.id,
      parentId: agent.parentId,
      teamId: agent.teamId,
      name: agent.name,
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      providerId: agent.providerId,
      permissionMode: agent.permissionMode,
      sandboxMode: agent.sandboxMode,
      reasoningEffort: agent.reasoningEffort,
      codexWorkspace: agent.codexWorkspace,
      metadata: stableConfigMetadata(agent.metadata),
      sortOrder: agent.sortOrder,
    }));
  return JSON.stringify({ teams, agents });
}
