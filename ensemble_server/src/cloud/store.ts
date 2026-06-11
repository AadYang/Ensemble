import { randomUUID } from "node:crypto";
import { normalizeEmail } from "./auth.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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

const MAX_STRING = 64_000;
const MAX_SYSTEM_PROMPT = 32_000;
const MAX_NAME = 160;
const MAX_DESCRIPTION = 2_000;
const MAX_OBJECT_KEYS = 100;
const MAX_ARRAY_ITEMS = 500;
const MAX_DEPTH = 8;

export interface CloudAccount {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudAccountRecord extends CloudAccount {
  passwordHash: string;
}

export interface CloudSessionRecord {
  id: string;
  accountId: string;
  tokenHash: string;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
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
  metadata: JsonObject;
  sortOrder: number;
  revision: number;
  updatedAt: string;
}

export interface CloudMessage {
  id?: number;
  agentId: string;
  seq: number;
  type: string;
  payload: JsonValue;
  createdAt: string;
}

export interface CloudSnapshot {
  workspace: CloudWorkspace;
  teams: CloudTeam[];
  agents: CloudAgent[];
  messages: CloudMessage[];
}

export interface CloudSnapshotInput {
  teams?: unknown[];
  agents?: unknown[];
  messages?: unknown[];
}

export interface CloudSyncBatchInput extends CloudSnapshotInput {
  expectedRevision?: number;
}

export interface CloudMessageCursor {
  agentId: string;
  maxSeq: number;
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

export class CloudRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("workspace_revision_conflict");
  }
}

export interface CloudStore {
  migrate(): Promise<void>;
  findAccountByEmail(email: string): Promise<CloudAccountRecord | null>;
  getAccountById(accountId: string): Promise<CloudAccountRecord | null>;
  createAccount(input: { email: string; passwordHash: string; displayName?: string | null }): Promise<CloudAccountRecord>;
  createSession(input: { accountId: string; tokenHash: string; expiresAt: Date; userAgent?: string | null }): Promise<CloudSessionRecord>;
  getSessionByTokenHash(tokenHash: string): Promise<CloudSessionRecord | null>;
  touchSession(tokenHash: string, at: Date): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  listWorkspaces(accountId: string): Promise<CloudWorkspace[]>;
  createWorkspace(accountId: string, input: { id?: string; name: string }): Promise<CloudWorkspace>;
  getWorkspace(accountId: string, workspaceId: string): Promise<CloudWorkspace | null>;
  getSnapshot(accountId: string, workspaceId: string): Promise<CloudSnapshot | null>;
  upsertSnapshot(accountId: string, workspaceId: string, input: CloudSnapshotInput): Promise<CloudSnapshot>;
  syncBatch(accountId: string, workspaceId: string, input: CloudSyncBatchInput): Promise<CloudSyncBatchResult>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.65);
  const tail = Math.max(0, max - head - 32);
  return `${value.slice(0, head)}\n...[truncated]...\n${value.slice(value.length - tail)}`;
}

function optionalString(value: unknown, max = MAX_STRING): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? truncate(trimmed, max) : null;
}

function requiredString(value: unknown, fallback: string, max = MAX_NAME): string {
  return optionalString(value, max) ?? fallback;
}

function cleanId(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (SAFE_ID_RE.test(trimmed)) return trimmed;
  }
  return randomUUID();
}

function cleanNumber(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.trunc(value);
}

function cleanRevision(value: unknown): number {
  return Math.max(0, cleanNumber(value, 0));
}

function parseDate(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return nowIso();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

export function scrubSecrets(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) return null;
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return truncate(value, MAX_STRING);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => scrubSecrets(entry, depth + 1));
  }
  if (!isPlainObject(value)) return null;

  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (SECRET_KEY_RE.test(key) || BLOCKED_METADATA_KEYS.has(key)) continue;
    out[key] = scrubSecrets(nested, depth + 1);
  }
  return out;
}

function scrubMetadata(value: unknown): JsonObject {
  const scrubbed = scrubSecrets(value);
  return isPlainObject(scrubbed) ? scrubbed : {};
}

export function sanitizeTeamInput(input: unknown): CloudTeam {
  const obj = isPlainObject(input) ? input : {};
  return {
    id: cleanId(obj.id),
    name: requiredString(obj.name, "Team", MAX_NAME),
    description: optionalString(obj.description, MAX_DESCRIPTION),
    sortOrder: cleanNumber(obj.sortOrder, 0),
    revision: cleanRevision(obj.revision),
    updatedAt: parseDate(obj.updatedAt),
  };
}

export function sanitizeAgentInput(input: unknown): CloudAgent {
  const obj = isPlainObject(input) ? input : {};
  return {
    id: cleanId(obj.id),
    parentId: optionalString(obj.parentId, 128),
    teamId: optionalString(obj.teamId, 128),
    name: requiredString(obj.name, "Agent", MAX_NAME),
    systemPrompt: optionalString(obj.systemPrompt, MAX_SYSTEM_PROMPT),
    model: optionalString(obj.model, 160),
    providerKind: optionalString(obj.providerKind, 80),
    providerName: optionalString(obj.providerName, 160),
    providerId: optionalString(obj.providerId, 128),
    permissionMode: optionalString(obj.permissionMode, 80),
    sandboxMode: optionalString(obj.sandboxMode, 80),
    reasoningEffort: optionalString(obj.reasoningEffort, 80),
    codexWorkspace: optionalString(obj.codexWorkspace, 512),
    metadata: scrubMetadata(obj.metadata),
    sortOrder: cleanNumber(obj.sortOrder, 0),
    revision: cleanRevision(obj.revision),
    updatedAt: parseDate(obj.updatedAt),
  };
}

export function sanitizeMessageInput(input: unknown): CloudMessage | null {
  const obj = isPlainObject(input) ? input : {};
  const agentId = optionalString(obj.agentId, 128);
  const seq = cleanNumber(obj.seq, -1);
  if (!agentId || seq < 0) return null;
  return {
    agentId,
    seq,
    type: requiredString(obj.type, "system", 40),
    payload: scrubSecrets(obj.payload),
    createdAt: parseDate(obj.createdAt),
  };
}

export function sanitizeSnapshotInput(input: CloudSnapshotInput): {
  teams: CloudTeam[];
  agents: CloudAgent[];
  messages: CloudMessage[];
} {
  return {
    teams: (input.teams ?? []).map(sanitizeTeamInput),
    agents: (input.agents ?? []).map(sanitizeAgentInput),
    messages: (input.messages ?? []).map(sanitizeMessageInput).filter((m): m is CloudMessage => m !== null),
  };
}

export function publicAccount(account: CloudAccountRecord): CloudAccount {
  const { passwordHash: _passwordHash, ...rest } = account;
  return rest;
}

function key(...parts: string[]): string {
  return parts.join("\u0000");
}

export class MemoryCloudStore implements CloudStore {
  private readonly accounts = new Map<string, CloudAccountRecord>();
  private readonly sessions = new Map<string, CloudSessionRecord>();
  private readonly workspaces = new Map<string, CloudWorkspace>();
  private readonly teams = new Map<string, CloudTeam>();
  private readonly agents = new Map<string, CloudAgent>();
  private readonly messages = new Map<string, CloudMessage>();
  private nextMessageId = 1;

  async migrate(): Promise<void> {}

  async findAccountByEmail(email: string): Promise<CloudAccountRecord | null> {
    const normalized = normalizeEmail(email);
    return [...this.accounts.values()].find((account) => account.email === normalized) ?? null;
  }

  async getAccountById(accountId: string): Promise<CloudAccountRecord | null> {
    return this.accounts.get(accountId) ?? null;
  }

  async createAccount(input: { email: string; passwordHash: string; displayName?: string | null }): Promise<CloudAccountRecord> {
    const existing = await this.findAccountByEmail(input.email);
    if (existing) return existing;
    const at = nowIso();
    const account: CloudAccountRecord = {
      id: randomUUID(),
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      displayName: input.displayName ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.accounts.set(account.id, account);
    return account;
  }

  async createSession(input: { accountId: string; tokenHash: string; expiresAt: Date; userAgent?: string | null }): Promise<CloudSessionRecord> {
    const at = nowIso();
    const session: CloudSessionRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      tokenHash: input.tokenHash,
      userAgent: input.userAgent ?? null,
      createdAt: at,
      expiresAt: input.expiresAt.toISOString(),
      lastSeenAt: at,
    };
    this.sessions.set(input.tokenHash, session);
    return session;
  }

  async getSessionByTokenHash(tokenHash: string): Promise<CloudSessionRecord | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  async touchSession(tokenHash: string, at: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) session.lastSeenAt = at.toISOString();
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async listWorkspaces(accountId: string): Promise<CloudWorkspace[]> {
    return [...this.workspaces.entries()]
      .filter(([k]) => k.startsWith(`${accountId}\u0000`))
      .map(([, workspace]) => workspace)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async createWorkspace(accountId: string, input: { id?: string; name: string }): Promise<CloudWorkspace> {
    const id = cleanId(input.id);
    const workspaceKey = key(accountId, id);
    const existing = this.workspaces.get(workspaceKey);
    if (existing) return existing;
    const at = nowIso();
    const workspace: CloudWorkspace = {
      id,
      name: requiredString(input.name, "Account Workspace", MAX_NAME),
      revision: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.workspaces.set(workspaceKey, workspace);
    return workspace;
  }

  async getWorkspace(accountId: string, workspaceId: string): Promise<CloudWorkspace | null> {
    return this.workspaces.get(key(accountId, workspaceId)) ?? null;
  }

  async getSnapshot(accountId: string, workspaceId: string): Promise<CloudSnapshot | null> {
    const workspace = await this.getWorkspace(accountId, workspaceId);
    if (!workspace) return null;
    const prefix = `${accountId}\u0000${workspaceId}\u0000`;
    return {
      workspace,
      teams: [...this.teams.entries()].filter(([k]) => k.startsWith(prefix)).map(([, team]) => team),
      agents: [...this.agents.entries()].filter(([k]) => k.startsWith(prefix)).map(([, agent]) => agent),
      messages: [...this.messages.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, message]) => message)
        .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.seq - b.seq),
    };
  }

  async upsertSnapshot(accountId: string, workspaceId: string, input: CloudSnapshotInput): Promise<CloudSnapshot> {
    await this.syncBatch(accountId, workspaceId, input);
    const snapshot = await this.getSnapshot(accountId, workspaceId);
    if (!snapshot) throw new Error("workspace_not_found");
    return snapshot;
  }

  async syncBatch(accountId: string, workspaceId: string, input: CloudSyncBatchInput): Promise<CloudSyncBatchResult> {
    const workspace = await this.getWorkspace(accountId, workspaceId);
    if (!workspace) throw new Error("workspace_not_found");
    if (input.expectedRevision !== undefined && input.expectedRevision !== workspace.revision) {
      throw new CloudRevisionConflictError(workspace.revision);
    }
    const sanitized = sanitizeSnapshotInput(input);
    const at = nowIso();
    const nextRevision = workspace.revision + 1;
    workspace.revision = nextRevision;
    workspace.updatedAt = at;

    for (const team of sanitized.teams) {
      this.teams.set(key(accountId, workspaceId, team.id), { ...team, revision: nextRevision, updatedAt: at });
    }
    for (const agent of sanitized.agents) {
      this.agents.set(key(accountId, workspaceId, agent.id), { ...agent, revision: nextRevision, updatedAt: at });
    }
    for (const message of sanitized.messages) {
      const messageKey = key(accountId, workspaceId, message.agentId, String(message.seq));
      const existing = this.messages.get(messageKey);
      this.messages.set(messageKey, { ...message, id: existing?.id ?? this.nextMessageId++ });
    }

    const cursors = new Map<string, number>();
    const prefix = `${accountId}\u0000${workspaceId}\u0000`;
    for (const [messageKey, message] of this.messages.entries()) {
      if (!messageKey.startsWith(prefix)) continue;
      cursors.set(message.agentId, Math.max(cursors.get(message.agentId) ?? -1, message.seq));
    }
    return {
      workspace,
      applied: {
        teams: sanitized.teams.length,
        agents: sanitized.agents.length,
        messages: sanitized.messages.length,
      },
      messageCursors: [...cursors.entries()]
        .map(([agentId, maxSeq]) => ({ agentId, maxSeq }))
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),
    };
  }
}
