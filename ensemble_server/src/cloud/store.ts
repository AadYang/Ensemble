import { randomUUID } from "node:crypto";
import type { RunPlanStatusView } from "@agentorch/shared";
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
  projectRoot: string | null;
  /** Legacy alias of `projectRoot`. Kept in the DTO so an older desktop client
   *  that still reads `codexWorkspace` keeps rendering the same directory. */
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
  /** Publish ONE agent's run plan. Field-level by construction: the stored
   *  agent's configuration fields are the ones already in the row, never the
   *  caller's copy of them.
   *
   *  Why this is not `syncBatch` with a plan in the metadata: the publishing
   *  desktop reads the plan off a live turn, so its copy of the workspace is
   *  whatever it last synced. Sending that whole copy back means a desktop
   *  holding a stale snapshot silently reverts configuration another client has
   *  since changed — a status publish turning into a config write. Publishing a
   *  plan is therefore its own narrow write: only `metadata.publishedPlan`
   *  moves, the config columns are untouched, and `revision` does NOT advance
   *  (the plan is not configuration, is not in the config signature, and
   *  advancing the workspace revision every turn would make every other
   *  client's next config upload conflict).
   *
   *  Returns the stored plan, or `null` when this account's workspace has no
   *  such agent — an unknown id is refused, never created. */
  publishAgentPlan(
    accountId: string,
    workspaceId: string,
    agentId: string,
    plan: PublishedAgentPlan,
  ): Promise<PublishedAgentPlan | null>;
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

/** A cloud write the mirror refuses to store. Structured like the local
 *  `ProjectRootRejected`: the HTTP/WS boundary turns the code into a declared
 *  4xx / remote_error instead of a generic failure, so the desktop can
 *  highlight the field it sent wrong. */
export class CloudInputRejected extends Error {
  readonly code: "PROJECT_ROOT_CONFLICT";
  readonly path: string;
  constructor(code: "PROJECT_ROOT_CONFLICT", path: string, reason: string) {
    super(reason);
    this.name = "CloudInputRejected";
    this.code = code;
    this.path = path;
  }
}

export const isCloudInputRejection = (err: unknown): err is CloudInputRejected =>
  err instanceof CloudInputRejected ||
  (typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "PROJECT_ROOT_CONFLICT");

/**
 * Lexical identity of a project path, computed WITHOUT touching the filesystem.
 *
 * The mirror stores the DESKTOP's directory, and the server may well run on
 * another OS — it cannot `realpath` or even `stat` that path, so the local
 * side's identity rule (projectRootIdentity) is not available here. What is
 * available is a spelling comparison, and it has to be EXPLICIT rather than
 * platform-dependent, or the same payload would be accepted or refused
 * depending on where the server happens to run:
 *
 *   • separators are unified, `.` and `..` segments collapse, trailing
 *     separators drop — so `D:\Repo\.\` and `D:/Repo` are one directory;
 *   • a Windows-style path (drive letter or UNC) folds case, because Windows
 *     volumes are case-insensitive by default; a POSIX-style path does not,
 *     because there those really are two directories.
 *
 * The comparison is only used to decide whether two spellings CONFLICT. The
 * canonical value is stored exactly as the client spelled it, so the user still
 * reads back what they typed.
 */
export function cloudPathIdentity(path: string): string {
  const trimmed = path.trim();
  const unified = trimmed.replace(/\\/g, "/");
  const isUnc = unified.startsWith("//");
  const isDrive = /^[a-zA-Z]:\//.test(unified);
  const absolute = unified.startsWith("/");
  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const body = segments.join("/");
  const withRoot =
    isUnc || isDrive
      ? `${isUnc ? "//" : ""}${body}`
      : absolute
        ? `/${body}`
        : body;
  return isUnc || isDrive ? withRoot.toLowerCase() : withRoot;
}

/** The two names of one field must name one directory. Both non-empty and
 *  lexically different is a caller bug, not a merge order to pick: the mirror
 *  refuses it exactly like the local write path does instead of letting the
 *  disagreement surface later as "the desktop is running somewhere else". */
export function assertProjectRootAgreement(
  projectRoot: string | null,
  legacyCodexWorkspace: string | null,
): void {
  if (projectRoot === null || legacyCodexWorkspace === null) return;
  if (cloudPathIdentity(projectRoot) === cloudPathIdentity(legacyCodexWorkspace)) return;
  throw new CloudInputRejected(
    "PROJECT_ROOT_CONFLICT",
    projectRoot,
    `projectRoot and the legacy codexWorkspace disagree (${projectRoot} vs ${legacyCodexWorkspace}); ` +
      "they are aliases of one field, so send one of them",
  );
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

/** The canonical value from a payload that may carry either name (or both). */
function resolveProjectRootInput(obj: Record<string, unknown>): string | null {
  const canonical = optionalString(obj.projectRoot, 512);
  const legacy = optionalString(obj.codexWorkspace, 512);
  assertProjectRootAgreement(canonical, legacy);
  return canonical ?? legacy;
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
    // Canonical first, legacy alias second: a client that sends only
    // `codexWorkspace` still binds a project, and the SQLite side applies the
    // identical translation (reconcileProjectRootInput) — including its refusal
    // to choose between two different directories.
    projectRoot: resolveProjectRootInput(obj),
    codexWorkspace: null,
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

/** Read-side alias for a reader that predates `projectRoot`: the deployed web
 *  page and older desktop builds only know `codexWorkspace`, and phase 2
 *  stopped WRITING that field. Echoing the canonical value keeps such a reader
 *  pointing at the right directory instead of a blank — it is one directory
 *  with two names, never a second answer (see `sanitizeAgentInput`, which
 *  translates the same alias on the way IN). */
export function withLegacyProjectRootAlias(agent: CloudAgent): CloudAgent {
  return { ...agent, codexWorkspace: agent.projectRoot };
}

/** Where a desktop's last published plan for an agent lives inside the synced
 *  `metadata` bag.
 *
 *  Deliberately `metadata` and not a column: `metadata` is the existing synced
 *  extension bag, so publishing a plan needs no migration and no new route on
 *  the write side — the desktop sends it with the agent it was already syncing.
 *  It is NOT part of the config signature (the client drops the key before
 *  hashing), because it changes every turn and a signature that moved with it
 *  would make every turn look like a configuration change.
 *
 *  What this is NOT: a plan the CLOUD resolved. The server has no runtime, no
 *  provider and no capability registry, and inventing one here would be the
 *  second resolver this whole design exists to remove. It is a read-only relay
 *  of what the OWNING desktop published — or nothing, said out loud. */
export const PUBLISHED_PLAN_KEY = "publishedPlan";

export interface PublishedAgentPlan {
  /** The desktop's own `/status` view-model, verbatim. Never re-derived here. */
  planView: RunPlanStatusView;
  publishedAt: string;
}

/** The plan a desktop published for this agent, or `null`.
 *
 *  `null` covers both "nobody has published one" and "what is stored is not a
 *  plan" — the route turns the first into `source: "unavailable"` and the second
 *  into the same answer with a different reason, because neither is a status the
 *  cloud can honestly serve. The structural check is deliberately shallow: the
 *  only thing worse than refusing a malformed plan is ACCEPTING one and letting
 *  a surface render it as complete. Deep-validating every field here would be a
 *  second implementation of a contract that already lives in `shared`. */
/** A config write that says nothing about the published plan does not DELETE it.
 *
 *  The plan is not configuration, so it is not in the config signature: every
 *  ordinary settings upload therefore arrives with metadata that simply has no
 *  `publishedPlan` key. A plain `metadata = VALUES(metadata)` write would read
 *  that silence as "delete the plan" and quietly turn `/status` into
 *  `unavailable` until the owning desktop runs another turn. Only an EXPLICIT
 *  `publishedPlan` in the incoming metadata replaces what is stored.
 *
 *  Takes only the metadata half of the stored agent so a writer can carry the
 *  plan forward from a projection rather than a full row. */
export function carryPublishedPlanForward(
  incoming: CloudAgent,
  existing: Pick<CloudAgent, "metadata"> | undefined,
): CloudAgent {
  if (!existing) return incoming;
  if (PUBLISHED_PLAN_KEY in incoming.metadata) return incoming;
  const stored = (existing.metadata as Record<string, unknown>)[PUBLISHED_PLAN_KEY];
  if (stored === undefined) return incoming;
  return {
    ...incoming,
    metadata: { ...incoming.metadata, [PUBLISHED_PLAN_KEY]: stored as JsonValue },
  };
}

export function publishedAgentPlan(agent: CloudAgent): PublishedAgentPlan | null {
  const raw = (agent.metadata as Record<string, unknown>)[PUBLISHED_PLAN_KEY];
  if (!isPlainObject(raw)) return null;
  const planView = raw.planView;
  const publishedAt = raw.publishedAt;
  if (typeof publishedAt !== "string") return null;
  if (!isPlainObject(planView)) return null;
  if (typeof planView.source !== "string") return null;
  if (typeof planView.planHash !== "string") return null;
  if (!Array.isArray(planView.settings)) return null;
  return { planView: planView as unknown as RunPlanStatusView, publishedAt };
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
    const messageCursors = (): CloudMessageCursor[] => {
      const cursors = new Map<string, number>();
      const prefix = `${accountId}\u0000${workspaceId}\u0000`;
      for (const [messageKey, message] of this.messages.entries()) {
        if (!messageKey.startsWith(prefix)) continue;
        cursors.set(message.agentId, Math.max(cursors.get(message.agentId) ?? -1, message.seq));
      }
      return [...cursors.entries()]
        .map(([agentId, maxSeq]) => ({ agentId, maxSeq }))
        .sort((a, b) => a.agentId.localeCompare(b.agentId));
    };
    if (sanitized.teams.length === 0 && sanitized.agents.length === 0 && sanitized.messages.length === 0) {
      return {
        workspace,
        applied: { teams: 0, agents: 0, messages: 0 },
        messageCursors: messageCursors(),
      };
    }
    const at = nowIso();
    const nextRevision = workspace.revision + 1;
    workspace.revision = nextRevision;
    workspace.updatedAt = at;

    for (const team of sanitized.teams) {
      this.teams.set(key(accountId, workspaceId, team.id), { ...team, revision: nextRevision, updatedAt: at });
    }
    for (const agent of sanitized.agents) {
      const agentKey = key(accountId, workspaceId, agent.id);
      const carried = carryPublishedPlanForward(agent, this.agents.get(agentKey));
      this.agents.set(agentKey, { ...carried, revision: nextRevision, updatedAt: at });
    }
    for (const message of sanitized.messages) {
      const messageKey = key(accountId, workspaceId, message.agentId, String(message.seq));
      const existing = this.messages.get(messageKey);
      this.messages.set(messageKey, { ...message, id: existing?.id ?? this.nextMessageId++ });
    }

    return {
      workspace,
      applied: {
        teams: sanitized.teams.length,
        agents: sanitized.agents.length,
        messages: sanitized.messages.length,
      },
      messageCursors: messageCursors(),
    };
  }

  async publishAgentPlan(
    accountId: string,
    workspaceId: string,
    agentId: string,
    plan: PublishedAgentPlan,
  ): Promise<PublishedAgentPlan | null> {
    const workspace = await this.getWorkspace(accountId, workspaceId);
    if (!workspace) return null;
    const agentKey = key(accountId, workspaceId, agentId);
    const existing = this.agents.get(agentKey);
    // No agent, no plan. A publish is not a create: an unknown id is refused
    // rather than materialized from a desktop's stale view of the workspace.
    if (!existing) return null;
    const published: PublishedAgentPlan = { planView: plan.planView, publishedAt: plan.publishedAt };
    this.agents.set(agentKey, {
      // FIELD-LEVEL: every config field is the STORED one, copied forward.
      ...existing,
      metadata: {
        ...existing.metadata,
        [PUBLISHED_PLAN_KEY]: published as unknown as JsonValue,
      },
    });
    return published;
  }
}
