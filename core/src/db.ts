import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureDataDir } from "./paths.js";

const DB_PATH = process.env.AGENTORCH_DB_PATH ?? join(ensureDataDir(), "agentorch.db");

export const sqliteDb = new DatabaseSync(DB_PATH);
sqliteDb.exec("PRAGMA journal_mode = WAL");
sqliteDb.exec("PRAGMA foreign_keys = ON");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS Provider (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  baseUrl TEXT,
  apiKey TEXT,
  autoManaged INTEGER NOT NULL DEFAULT 0,
  upstreamProvider TEXT,
  upstreamModel TEXT,
  models TEXT NOT NULL DEFAULT '[]',
  isDefault INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS Agent (
  id TEXT PRIMARY KEY,
  parentId TEXT REFERENCES Agent(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  systemPrompt TEXT,
  status TEXT NOT NULL DEFAULT 'IDLE'
    CHECK (status IN ('IDLE','RUNNING','AWAITING_PERMISSION','AWAITING_USER_INPUT','ERROR','DONE')),
  model TEXT NOT NULL DEFAULT 'claude-opus-4-8',
  providerId TEXT REFERENCES Provider(id) ON DELETE RESTRICT,
  workspace TEXT,
  codexWorkspace TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS agent_parent_idx ON Agent(parentId);
CREATE INDEX IF NOT EXISTS agent_status_idx ON Agent(status);
CREATE INDEX IF NOT EXISTS agent_provider_idx ON Agent(providerId);

CREATE TABLE IF NOT EXISTS Message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT NOT NULL REFERENCES Agent(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS msg_agent_seq_uq ON Message(agentId, seq);
CREATE INDEX IF NOT EXISTS msg_agent_time_idx ON Message(agentId, createdAt);

CREATE TABLE IF NOT EXISTS PendingTurn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT NOT NULL REFERENCES Agent(id) ON DELETE CASCADE,
  userInput TEXT NOT NULL,
  opts TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS pending_turn_agent_order_idx ON PendingTurn(agentId, id);

CREATE TABLE IF NOT EXISTS Permission (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL REFERENCES Agent(id) ON DELETE CASCADE,
  toolName TEXT NOT NULL,
  input TEXT NOT NULL,
  decision TEXT,
  updatedInput TEXT,
  decidedBy TEXT,
  reason TEXT,
  requestedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  decidedAt INTEGER
);
CREATE INDEX IF NOT EXISTS perm_agent_req_idx ON Permission(agentId, requestedAt);

CREATE TABLE IF NOT EXISTS McpServer (
  id TEXT PRIMARY KEY,
  agentId TEXT REFERENCES Agent(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- W21: agent teams. A Team groups N agents that the user explicitly framed
-- as collaborators (different roles, possibly different providers). Agents
-- without a team work exactly as before (teamId stays NULL). Deleting a
-- team SET NULL on member agents — preserves the agents so the user doesn't
-- lose data, they just become "ungrouped" again.
CREATE TABLE IF NOT EXISTS Team (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS Workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  layout TEXT NOT NULL,
  activeWindowId TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS AppSetting (
  key TEXT PRIMARY KEY,
  value TEXT,
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

-- W17: usage events are billing/audit data. Independent of Message life-
-- cycle so deleting an Agent or Provider doesn't erase historical cost.
-- agentId / providerId are nullable FK + ON DELETE SET NULL; snapshot
-- fields (agentName, providerName, providerKind, parentId, model) freeze
-- the context at write time so deleted rows still render meaningfully.
CREATE TABLE IF NOT EXISTS UsageEvent (
  id TEXT PRIMARY KEY,
  agentId TEXT REFERENCES Agent(id) ON DELETE SET NULL,
  agentName TEXT NOT NULL,
  parentId TEXT,
  providerId TEXT REFERENCES Provider(id) ON DELETE SET NULL,
  providerName TEXT NOT NULL,
  providerKind TEXT NOT NULL,
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('result', 'meta')),
  inputTokens INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
  cacheCreationTokens INTEGER NOT NULL DEFAULT 0,
  costUSD REAL NOT NULL DEFAULT 0,
  costKnown INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS usage_time_idx ON UsageEvent(createdAt);
CREATE INDEX IF NOT EXISTS usage_agent_idx ON UsageEvent(agentId);
CREATE INDEX IF NOT EXISTS usage_provider_idx ON UsageEvent(providerId);
`;

sqliteDb.exec(SCHEMA);

// ─────────────────────────────────────────────────────────────
// Idempotent column additions (ALTER TABLE ADD COLUMN IF MISSING).
// CREATE TABLE IF NOT EXISTS does not add new columns to pre-existing
// tables, so we check PRAGMA table_info and ALTER for each missing column.
// ─────────────────────────────────────────────────────────────

function ensureColumn(table: string, column: string, decl: string): void {
  const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

ensureColumn("Provider", "disabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("Provider", "metadata", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("Agent", "codexWorkspace", "TEXT");
// W20 Slice 5.6: billingModel distinguishes pay-per-token ('usage') from
// flat-rate plans ('subscription'). codex rows write 'subscription' so the
// W17 cost rollup can either exclude them or render them in a separate
// non-billed lane. Default 'usage' keeps existing rows correct.
ensureColumn("UsageEvent", "billingModel", "TEXT NOT NULL DEFAULT 'usage'");
// Independent token counts produced by Ensemble's local tokenizer (gpt-
// tokenizer / cl100k_base or o200k_base). 0 when local counting wasn't
// performed (claude/codex runtimes — CLI subprocess hides actual byte
// stream — or older rows). Used by the UsageStats UI to flag large
// upstream-vs-local discrepancies that warrant manual scrutiny.
ensureColumn("UsageEvent", "inputTokensLocal", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("UsageEvent", "outputTokensLocal", "INTEGER NOT NULL DEFAULT 0");
// W21: Agent.teamId — nullable FK to Team(id). ALTER ADD doesn't support
// the REFERENCES clause in SQLite, but we never enforce FK at the engine
// level (PRAGMA foreign_keys is off for AgentUI compatibility); the cascade
// behavior is implemented in code by the team delete path.
ensureColumn("Agent", "teamId", "TEXT");

// ─────────────────────────────────────────────────────────────
// W16 Slice 1.2: deprecated provider migration.
// Marks rows with kind in (bedrock, vertex) or autoManaged=1 as disabled
// and stamps a deprecation note in metadata. UI shows banner + one-click
// migration. Idempotent: running twice is a no-op.
// ─────────────────────────────────────────────────────────────

const DEPRECATED_KINDS = ["bedrock", "vertex"] as const;
const DEPRECATION_NOTE = "v0.0.2 dropped bedrock/vertex/autoManaged — please migrate to anthropic or openai-compat";

export function migrateDeprecatedProviders(): { count: number } {
  // Find rows that need disabling: deprecated kind OR autoManaged, and not already disabled.
  const rows = sqliteDb
    .prepare(
      `SELECT id, kind, autoManaged, metadata FROM Provider
       WHERE disabled = 0 AND (kind IN (?, ?) OR autoManaged = 1)`,
    )
    .all(...DEPRECATED_KINDS) as { id: string; kind: string; autoManaged: number; metadata: string }[];

  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try { meta = (JSON.parse(r.metadata) as Record<string, unknown>) ?? {}; } catch { meta = {}; }
    meta.deprecated = DEPRECATION_NOTE;
    meta.deprecatedReason = r.autoManaged ? "autoManaged" : r.kind;
    meta.deprecatedAt = Math.floor(Date.now() / 1000);
    sqliteDb
      .prepare(`UPDATE Provider SET disabled = 1, metadata = ? WHERE id = ?`)
      .run(JSON.stringify(meta), r.id);
  }
  return { count: rows.length };
}

migrateDeprecatedProviders();

// ─────────────────────────────────────────────────────────────
// Type definitions (mirror Prisma row shapes, for callers).
// JSON fields are parsed; DateTime → Date; Boolean → boolean.
// ─────────────────────────────────────────────────────────────

export type AgentStatus =
  | "IDLE"
  | "RUNNING"
  | "AWAITING_PERMISSION"
  | "AWAITING_USER_INPUT"
  | "ERROR"
  | "DONE";

export interface Agent {
  id: string;
  parentId: string | null;
  name: string;
  systemPrompt: string | null;
  status: AgentStatus;
  model: string;
  providerId: string | null;
  workspace: string | null;
  codexWorkspace: string | null;
  /** W21: team membership. NULL = ungrouped (preserves all pre-team behavior). */
  teamId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  apiKey: string | null;
  autoManaged: boolean;
  upstreamProvider: string | null;
  upstreamModel: string | null;
  models: string[];
  isDefault: boolean;
  disabled: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: number;
  agentId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface PendingTurn {
  id: number;
  agentId: string;
  userInput: string;
  opts: unknown;
  createdAt: Date;
}

export interface Permission {
  id: string;
  agentId: string;
  toolName: string;
  input: unknown;
  decision: string | null;
  updatedInput: unknown;
  decidedBy: string | null;
  reason: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
}

export interface McpServer {
  id: string;
  agentId: string | null;
  name: string;
  transport: string;
  config: unknown;
  enabled: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  layout: unknown;
  activeWindowId: string | null;
  createdAt: Date;
}

export interface AppSetting {
  key: string;
  value: unknown;
  updatedAt: Date;
}

export interface UsageEvent {
  id: string;
  agentId: string | null;
  agentName: string;
  parentId: string | null;
  providerId: string | null;
  providerName: string;
  providerKind: string;
  model: string;
  source: "result" | "meta";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  costKnown: boolean;
  /** W20: 'usage' (pay-per-token, default) or 'subscription' (codex via
   *  ChatGPT plan; marginal cost = 0). Aggregator filters / segregates. */
  billingModel: "usage" | "subscription";
  /** Token count produced by Ensemble's LOCAL tokenizer (independent of what
   *  the upstream API reported). Compare against inputTokens to spot gross
   *  over-reporting. 0 means local counting wasn't performed. */
  inputTokensLocal: number;
  outputTokensLocal: number;
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────
// Row mappers (raw SQLite row → typed row)
// ─────────────────────────────────────────────────────────────

const dateOf = (n: number | null | undefined): Date =>
  new Date((Number(n ?? 0)) * 1000);

const dateOrNull = (n: number | null | undefined): Date | null =>
  n == null ? null : new Date(Number(n) * 1000);

const parseJson = (s: string | null | undefined): unknown => {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
};

const mapAgent = (r: Record<string, unknown>): Agent => ({
  id: r.id as string,
  parentId: (r.parentId as string | null) ?? null,
  name: r.name as string,
  systemPrompt: (r.systemPrompt as string | null) ?? null,
  status: r.status as AgentStatus,
  model: r.model as string,
  providerId: (r.providerId as string | null) ?? null,
  workspace: (r.workspace as string | null) ?? null,
  codexWorkspace: (r.codexWorkspace as string | null) ?? null,
  teamId: (r.teamId as string | null) ?? null,
  metadata: parseJson(r.metadata as string),
  createdAt: dateOf(r.createdAt as number),
  updatedAt: dateOf(r.updatedAt as number),
});

const mapTeam = (r: Record<string, unknown>): Team => ({
  id: r.id as string,
  name: r.name as string,
  description: (r.description as string | null) ?? null,
  createdAt: dateOf(r.createdAt as number),
});

const mapProvider = (r: Record<string, unknown>): Provider => ({
  id: r.id as string,
  name: r.name as string,
  kind: r.kind as string,
  baseUrl: (r.baseUrl as string | null) ?? null,
  apiKey: (r.apiKey as string | null) ?? null,
  autoManaged: !!(r.autoManaged as number),
  upstreamProvider: (r.upstreamProvider as string | null) ?? null,
  upstreamModel: (r.upstreamModel as string | null) ?? null,
  models: (parseJson(r.models as string) as string[]) ?? [],
  isDefault: !!(r.isDefault as number),
  disabled: !!(r.disabled as number),
  metadata: (parseJson(r.metadata as string) as Record<string, unknown>) ?? {},
  createdAt: dateOf(r.createdAt as number),
  updatedAt: dateOf(r.updatedAt as number),
});

const mapMessage = (r: Record<string, unknown>): Message => ({
  id: Number(r.id),
  agentId: r.agentId as string,
  seq: r.seq as number,
  type: r.type as string,
  payload: parseJson(r.payload as string),
  createdAt: dateOf(r.createdAt as number),
});

const mapPendingTurn = (r: Record<string, unknown>): PendingTurn => ({
  id: Number(r.id),
  agentId: r.agentId as string,
  userInput: r.userInput as string,
  opts: parseJson(r.opts as string) ?? {},
  createdAt: dateOf(r.createdAt as number),
});

const mapPermission = (r: Record<string, unknown>): Permission => ({
  id: r.id as string,
  agentId: r.agentId as string,
  toolName: r.toolName as string,
  input: parseJson(r.input as string),
  decision: (r.decision as string | null) ?? null,
  updatedInput: r.updatedInput == null ? null : parseJson(r.updatedInput as string),
  decidedBy: (r.decidedBy as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  requestedAt: dateOf(r.requestedAt as number),
  decidedAt: dateOrNull(r.decidedAt as number | null),
});

const mapMcpServer = (r: Record<string, unknown>): McpServer => ({
  id: r.id as string,
  agentId: (r.agentId as string | null) ?? null,
  name: r.name as string,
  transport: r.transport as string,
  config: parseJson(r.config as string),
  enabled: !!(r.enabled as number),
});

const mapWorkspace = (r: Record<string, unknown>): Workspace => ({
  id: r.id as string,
  name: r.name as string,
  layout: parseJson(r.layout as string),
  activeWindowId: (r.activeWindowId as string | null) ?? null,
  createdAt: dateOf(r.createdAt as number),
});

const mapAppSetting = (r: Record<string, unknown>): AppSetting => ({
  key: r.key as string,
  value: parseJson(r.value as string),
  updatedAt: dateOf(r.updatedAt as number),
});

const mapUsageEvent = (r: Record<string, unknown>): UsageEvent => ({
  id: r.id as string,
  agentId: (r.agentId as string | null) ?? null,
  agentName: r.agentName as string,
  parentId: (r.parentId as string | null) ?? null,
  providerId: (r.providerId as string | null) ?? null,
  providerName: r.providerName as string,
  providerKind: r.providerKind as string,
  model: r.model as string,
  source: r.source as "result" | "meta",
  inputTokens: Number(r.inputTokens ?? 0),
  outputTokens: Number(r.outputTokens ?? 0),
  cacheReadTokens: Number(r.cacheReadTokens ?? 0),
  cacheCreationTokens: Number(r.cacheCreationTokens ?? 0),
  costUSD: Number(r.costUSD ?? 0),
  costKnown: !!(r.costKnown as number),
  billingModel: ((r.billingModel as string | null) ?? "usage") as "usage" | "subscription",
  inputTokensLocal: Number(r.inputTokensLocal ?? 0),
  outputTokensLocal: Number(r.outputTokensLocal ?? 0),
  createdAt: dateOf(r.createdAt as number),
});

// ─────────────────────────────────────────────────────────────
// Tiny WHERE builder for the subset of operators we actually use.
// ─────────────────────────────────────────────────────────────

type WhereLeaf =
  | { equals?: unknown; mode?: "insensitive" }
  | string
  | number
  | boolean
  | null
  | undefined;

interface WhereClause {
  [key: string]: WhereLeaf | { equals?: unknown; mode?: "insensitive" } | WhereClause | WhereClause[] | undefined;
  AND?: WhereClause[];
  OR?: WhereClause[];
  NOT?: WhereClause;
}

/** Build raw SQL clauses (no leading "WHERE"). Used both as a recursive helper
 *  for NOT/AND/OR — which would otherwise produce `NOT WHERE …` and crash
 *  SQLite — and by buildWhere() to add the prefix at the outermost call. */
function buildClauses(where: WhereClause | undefined): { sql: string; params: unknown[] } {
  if (!where) return { sql: "", params: [] };
  const params: unknown[] = [];
  const parts: string[] = [];

  for (const [key, val] of Object.entries(where)) {
    if (val === undefined) continue;
    if (key === "AND" && Array.isArray(val)) {
      const inner = (val as WhereClause[]).map(buildClauses).filter((w) => w.sql);
      if (inner.length) {
        parts.push("(" + inner.map((w) => w.sql).join(" AND ") + ")");
        for (const w of inner) params.push(...w.params);
      }
      continue;
    }
    if (key === "OR" && Array.isArray(val)) {
      const inner = (val as WhereClause[]).map(buildClauses).filter((w) => w.sql);
      if (inner.length) {
        parts.push("(" + inner.map((w) => w.sql).join(" OR ") + ")");
        for (const w of inner) params.push(...w.params);
      }
      continue;
    }
    if (key === "NOT" && val && typeof val === "object" && !Array.isArray(val)) {
      const inner = buildClauses(val as WhereClause);
      if (inner.sql) {
        parts.push(`NOT (${inner.sql})`);
        params.push(...inner.params);
      }
      continue;
    }
    // Leaf
    if (val === null) {
      parts.push(`${key} IS NULL`);
    } else if (typeof val === "object" && !Array.isArray(val)) {
      const obj = val as { equals?: unknown; mode?: "insensitive" };
      if ("equals" in obj) {
        if (obj.mode === "insensitive") {
          parts.push(`LOWER(${key}) = LOWER(?)`);
        } else {
          parts.push(`${key} = ?`);
        }
        params.push(obj.equals);
      }
    } else if (typeof val === "boolean") {
      parts.push(`${key} = ?`);
      params.push(val ? 1 : 0);
    } else {
      parts.push(`${key} = ?`);
      params.push(val);
    }
  }

  return { sql: parts.join(" AND "), params };
}

function buildWhere(where: WhereClause | undefined): { sql: string; params: unknown[] } {
  const { sql, params } = buildClauses(where);
  return { sql: sql ? `WHERE ${sql}` : "", params };
}

interface OrderByClause {
  [key: string]: "asc" | "desc";
}

function buildOrderBy(o: OrderByClause | undefined): string {
  if (!o) return "";
  const parts = Object.entries(o).map(([k, v]) => `"${k}" ${v.toUpperCase()}`);
  return parts.length ? "ORDER BY " + parts.join(", ") : "";
}

// ─────────────────────────────────────────────────────────────
// Generic table operator factory
// ─────────────────────────────────────────────────────────────

interface FindArgs {
  where?: WhereClause;
  orderBy?: OrderByClause;
  take?: number;
  skip?: number;
}

function makeRepo<TRow>(
  table: string,
  mapRow: (r: Record<string, unknown>) => TRow,
  encoders: Record<string, (v: unknown) => unknown> = {},
  options: { autoUuid?: boolean } = {},
) {
  const autoUuid = options.autoUuid !== false;
  const enc = (data: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (encoders[k]) out[k] = encoders[k](v);
      else if (typeof v === "boolean") out[k] = v ? 1 : 0;
      else if (v instanceof Date) out[k] = Math.floor(v.getTime() / 1000);
      else out[k] = v;
    }
    return out;
  };

  return {
    findUnique(args: { where: WhereClause }): TRow | null {
      const { sql, params } = buildWhere(args.where);
      const row = sqliteDb.prepare(`SELECT * FROM ${table} ${sql} LIMIT 1`).get(...(params as never[]));
      return row ? mapRow(row as Record<string, unknown>) : null;
    },
    findFirst(args: FindArgs = {}): TRow | null {
      const { sql, params } = buildWhere(args.where);
      const order = buildOrderBy(args.orderBy);
      const row = sqliteDb
        .prepare(`SELECT * FROM ${table} ${sql} ${order} LIMIT 1`)
        .get(...(params as never[]));
      return row ? mapRow(row as Record<string, unknown>) : null;
    },
    findMany(args: FindArgs = {}): TRow[] {
      const { sql, params } = buildWhere(args.where);
      const order = buildOrderBy(args.orderBy);
      const limit = args.take != null ? `LIMIT ${args.take}` : "";
      const offset = args.skip != null ? `OFFSET ${args.skip}` : "";
      const rows = sqliteDb
        .prepare(`SELECT * FROM ${table} ${sql} ${order} ${limit} ${offset}`)
        .all(...(params as never[]));
      return (rows as Record<string, unknown>[]).map(mapRow);
    },
    count(args: { where?: WhereClause } = {}): number {
      const { sql, params } = buildWhere(args.where);
      const row = sqliteDb
        .prepare(`SELECT COUNT(*) as c FROM ${table} ${sql}`)
        .get(...(params as never[])) as { c: number };
      return row.c;
    },
    create(args: { data: Record<string, unknown> }): TRow {
      const data = enc(args.data);
      if (autoUuid && !("id" in data)) data.id = randomUUID();
      const cols = Object.keys(data);
      const placeholders = cols.map(() => "?").join(", ");
      const info = sqliteDb
        .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`)
        .run(...(cols.map((c) => data[c]) as never[]));
      // For auto-increment INTEGER PK tables (e.g. Message), look the row up by
      // the rowid sqlite returned; UUID PK tables look up by the data.id we set.
      const lookupId = autoUuid ? (data.id as string) : info.lastInsertRowid;
      const row = sqliteDb
        .prepare(`SELECT * FROM ${table} WHERE id = ?`)
        .get(lookupId as never) as Record<string, unknown>;
      return mapRow(row);
    },
    update(args: { where: WhereClause; data: Record<string, unknown> }): TRow {
      const data = enc(args.data);
      // Auto-bump updatedAt for tables that have it.
      if (table === "Agent" || table === "Provider") {
        if (!("updatedAt" in data)) data.updatedAt = Math.floor(Date.now() / 1000);
      }
      const sets = Object.keys(data).map((c) => `${c} = ?`).join(", ");
      const { sql: whereSql, params: whereParams } = buildWhere(args.where);
      sqliteDb
        .prepare(`UPDATE ${table} SET ${sets} ${whereSql}`)
        .run(...([...Object.values(data), ...whereParams] as never[]));
      const row = sqliteDb
        .prepare(`SELECT * FROM ${table} ${whereSql} LIMIT 1`)
        .get(...(whereParams as never[])) as Record<string, unknown>;
      return mapRow(row);
    },
    delete(args: { where: WhereClause }): void {
      const { sql, params } = buildWhere(args.where);
      sqliteDb.prepare(`DELETE FROM ${table} ${sql}`).run(...(params as never[]));
    },
  };
}

// JSON-typed columns need stringify on the way in.
const jsonEncoder = (v: unknown) => (v == null ? null : JSON.stringify(v));

const agentRepo = makeRepo("Agent", mapAgent, {
  metadata: jsonEncoder,
});
const providerRepo = makeRepo("Provider", mapProvider, {
  models: jsonEncoder,
  metadata: jsonEncoder,
});
const messageRepo = makeRepo(
  "Message",
  mapMessage,
  { payload: jsonEncoder },
  { autoUuid: false }, // INTEGER PK AUTOINCREMENT — rowid handles id assignment
);
const pendingTurnRepo = makeRepo(
  "PendingTurn",
  mapPendingTurn,
  { opts: jsonEncoder },
  { autoUuid: false },
);
const permissionRepo = makeRepo("Permission", mapPermission, {
  input: jsonEncoder,
  updatedInput: jsonEncoder,
});
const mcpServerRepo = makeRepo("McpServer", mapMcpServer, {
  config: jsonEncoder,
});
const workspaceRepo = makeRepo("Workspace", mapWorkspace, {
  layout: jsonEncoder,
});
const usageEventRepo = makeRepo("UsageEvent", mapUsageEvent);
const teamRepo = makeRepo("Team", mapTeam);
const appSettingRepo = {
  findUnique(args: { where: { key?: unknown } }): AppSetting | null {
    const row = sqliteDb
      .prepare("SELECT * FROM AppSetting WHERE key = ? LIMIT 1")
      .get(args.where.key as never);
    return row ? mapAppSetting(row as Record<string, unknown>) : null;
  },
  create(args: { data: { key: string; value: unknown } }): AppSetting {
    sqliteDb
      .prepare("INSERT INTO AppSetting (key, value) VALUES (?, ?)")
      .run(args.data.key as never, jsonEncoder(args.data.value) as never);
    const row = sqliteDb
      .prepare("SELECT * FROM AppSetting WHERE key = ? LIMIT 1")
      .get(args.data.key as never) as Record<string, unknown>;
    return mapAppSetting(row);
  },
  update(args: { where: { key?: unknown }; data: { value?: unknown } }): AppSetting {
    sqliteDb
      .prepare("UPDATE AppSetting SET value = ?, updatedAt = ? WHERE key = ?")
      .run(
        jsonEncoder(args.data.value) as never,
        Math.floor(Date.now() / 1000) as never,
        args.where.key as never,
      );
    const row = sqliteDb
      .prepare("SELECT * FROM AppSetting WHERE key = ? LIMIT 1")
      .get(args.where.key as never) as Record<string, unknown>;
    return mapAppSetting(row);
  },
};

// Prisma-compatible nested namespace; callers do `db.agent.findUnique(...)`.
export const db = {
  agent: agentRepo,
  provider: providerRepo,
  message: messageRepo,
  pendingTurn: pendingTurnRepo,
  permission: permissionRepo,
  mcpServer: mcpServerRepo,
  workspace: workspaceRepo,
  usageEvent: usageEventRepo,
  appSetting: appSettingRepo,
  team: teamRepo,
};

/** Drop-in for the prior Prisma export so existing imports keep working. */
export const prisma = db;

export function closeDb(): void {
  sqliteDb.close();
}
