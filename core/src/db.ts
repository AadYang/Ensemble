import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureDataDir } from "./paths.js";

// A test run must never open a database it did not ask for.
//
// The default path is derived from the environment, and the environment of a
// test process is whatever the developer's shell had: the desktop app exports
// AGENTORCH_DATA_DIR, so a test that forgot its own path silently opened the
// LIVE database — and the schema statements below then ran against it for real.
// Nothing was lost that time (every table and index it reached already existed),
// but the difference between that and a corrupted user database is which
// statement happened to come next. An unset path in a test is a mistake, and
// this line is the last place it can still be caught.
if (process.env.VITEST && !process.env.AGENTORCH_DB_PATH) {
  throw new Error(
    "refusing to open the default database in a test run: set AGENTORCH_DB_PATH " +
      '(usually ":memory:") before importing db.ts — the default resolves against the ' +
      "developer's real data directory, and tests must not write there",
  );
}

/** The path this process actually opened. Exported so a test can assert WHICH
 *  database it got — the guard above rules out the silent default, and this is
 *  how "the default was never resolved to" is checked rather than assumed. It
 *  is not an interface for callers: nothing may branch on it. */
export const DB_PATH = process.env.AGENTORCH_DB_PATH ?? join(ensureDataDir(), "agentorch.db");

export const sqliteDb = new DatabaseSync(DB_PATH);
sqliteDb.exec("PRAGMA journal_mode = WAL");
sqliteDb.exec("PRAGMA busy_timeout = 1000");
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
  -- Legacy column: kept so old rows stay readable, nothing may start using it
  -- again (its meaning was never defined).
  workspace TEXT,
  -- codexWorkspace is the legacy alias of projectRoot, kept as a column so an
  -- existing row is never rewritten and a downgrade still finds its value.
  -- New writes go to projectRoot only; reads go through projectRootOf().
  codexWorkspace TEXT,
  projectRoot TEXT,
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

-- Phase 3: the recoverable half of /compact. Compaction used to DELETE the
-- rows it summarized, which made an irreversible edit to the user's record.
-- The originals now move here verbatim, in the SAME transaction that writes
-- the summary and removes the active rows, so a compact is either complete or
-- it did not happen. generation is the compact ordinal for the agent, and
-- (agentId, generation, originalSeq) is unique, which is what makes a retried
-- compact idempotent. Deliberately a separate table rather than a soft-delete
-- column on Message: a nullable deletedAt would leave every existing reader
-- (runtime history, /status counts, cloud sync, conversation search) silently
-- including archived rows unless each one was audited and filtered.
CREATE TABLE IF NOT EXISTS MessageArchive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  originalMessageId INTEGER NOT NULL,
  agentId TEXT NOT NULL REFERENCES Agent(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  originalSeq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  archivedAt INTEGER NOT NULL,
  contentHash TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS msg_archive_uq ON MessageArchive(agentId, generation, originalSeq);
CREATE INDEX IF NOT EXISTS msg_archive_gen_idx ON MessageArchive(agentId, generation);

-- Phase 4: result artifacts — the durable, verifiable copy of a large result
-- (peer source output, peer_query transcript, conversation_search page, a
-- subagent's final answer).
--
-- Table is ResultArtifact, not Artifact: some live databases already have an
-- Artifact table from an earlier project-orchestration experiment (projectId /
-- workItemId, no agentId). CREATE TABLE IF NOT EXISTS would no-op, and the
-- next CREATE INDEX ON Artifact(agentId) crashed sidecar boot with
-- "no such column: agentId" — the 0.0.30 white screen.
--
-- Why a table rather than a bigger constant: the previous design capped those
-- results with layered character limits (1 600 / 4 000 / 5 000 / 8 000 / 12 000)
-- and then told the model it could read the result in full. The second half of
-- a large result therefore did not exist anywhere: not in the message, not on
-- disk, not in the archive. An artifact is written BEFORE any digest is built
-- from it, so the whole text always exists and the digest is a view of it.
--
-- The rows are append-only and enforced as such by triggers: an artifact that
-- can be rewritten is a claim that can be edited after the fact, and the
-- sha256 column is only worth having if the body behind it cannot move. No
-- foreign key to Agent on purpose — deleting an agent must not cascade-delete
-- the record of what it produced.
--
-- Retention is PERMANENT, and that is the phase decision rather than an
-- omission: append-only with no DELETE and no UPDATE path (the triggers below),
-- no TTL column, no purge job, no quota, and no age-based cleanup anywhere in
-- the runtime. An id + sha256 printed in an old transcript therefore still
-- resolves, which is the whole reason the digest can be trusted: a reader that
-- kept only the handle has not lost the only copy. "Permanent" is also what
-- makes the absence of an Agent foreign key load-bearing — an artifact
-- deliberately outlives the agent that produced it, so nothing about agent
-- deletion (or team deletion, or a re-created agent with a reused name) may
-- reach these rows. If a bound is ever wanted, it belongs in a new explicit
-- entry point that expires rows on purpose; it does not belong here as a column
-- no reader consults.
CREATE TABLE IF NOT EXISTS ResultArtifact (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  runId TEXT,
  turnSeq INTEGER,
  kind TEXT NOT NULL,
  mediaType TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
  byteSize INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  body TEXT NOT NULL,
  chunkCount INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS result_artifact_agent_time_idx ON ResultArtifact(agentId, createdAt);
CREATE INDEX IF NOT EXISTS result_artifact_sha_idx ON ResultArtifact(sha256);
CREATE TRIGGER IF NOT EXISTS result_artifact_immutable_update BEFORE UPDATE ON ResultArtifact
BEGIN
  SELECT RAISE(ABORT, 'Artifact rows are immutable: write a new artifact instead of rewriting one');
END;
CREATE TRIGGER IF NOT EXISTS result_artifact_append_only_delete BEFORE DELETE ON ResultArtifact
BEGIN
  SELECT RAISE(ABORT, 'Artifact rows are append-only: the durable copy of a result must survive');
END;

-- Phase 4 rework: the body of an artifact that was STREAMED in.
--
-- A tool that produces more output than the turn's budget does not have that
-- output in memory and must not build it there: it spools the bytes to a file
-- as they arrive, then commits them here. So the text of such an artifact lives
-- in chunk rows instead of in Artifact.body (which stays '' and keeps the row
-- shape every reader already selects).
--
-- byteFrom / bytes are what make the row addressable: a page read has to reach
-- byte 40 MB of a 100 MB artifact without reading the 40 MB before it, so a
-- range query has to be answerable from the table itself. The byte count is
-- stored rather than taken from length(body) because length() counts CHARACTERS
-- on a TEXT column while every offset in this system is a BYTE offset.
--
-- The same two guarantees the Artifact rows carry apply here, for the same
-- reason: the sha256 is worth something only if the bytes behind it cannot
-- change. Chunks are inserted inside the same transaction as their Artifact
-- row, and are never updated or deleted afterwards.
CREATE TABLE IF NOT EXISTS ResultArtifactChunk (
  artifactId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  byteFrom INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (artifactId, seq)
);
CREATE TRIGGER IF NOT EXISTS result_artifact_chunk_immutable_update BEFORE UPDATE ON ResultArtifactChunk
BEGIN
  SELECT RAISE(ABORT, 'Artifact chunk rows are immutable: write a new artifact instead of rewriting one');
END;
CREATE TRIGGER IF NOT EXISTS result_artifact_chunk_append_only_delete BEFORE DELETE ON ResultArtifactChunk
BEGIN
  SELECT RAISE(ABORT, 'Artifact chunk rows are append-only: the durable copy of a result must survive');
END;

-- Phase 4: liveness — one row per run, the ONLY place "is this run alive?"
-- is recorded.
--
-- Why a table and not a field on Agent: a run's liveness outlives the run, and
-- the question it has to answer is asked AFTER the fact ("the core restarted
-- while this run was open — did it finish?"). An in-memory map cannot answer
-- that, and the agent's status column cannot either: it says IDLE, which is
-- true and useless.
--
-- Unlike Artifact, this row is MUTABLE by design — it is a state machine, and a
-- state machine that can only be appended to cannot transition. It is
-- still not deletable through any phase-4 entry point, and carries no foreign
-- key to Agent for the same reason as Artifact: the record of how a run ended
-- must not disappear with the agent.
--
-- Timestamps are epoch MILLISECONDS (unlike the second-precision tables above),
-- because the whole point of these numbers is comparing them against suspicion
-- and deadline thresholds that are expressed in ms.
CREATE TABLE IF NOT EXISTS RunLiveness (
  runId TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  state TEXT NOT NULL,
  policy TEXT NOT NULL,
  signals TEXT NOT NULL,
  startedAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0,
  endedAt INTEGER,
  terminalReason TEXT
);
CREATE INDEX IF NOT EXISTS run_liveness_agent_idx ON RunLiveness(agentId, updatedAt);
CREATE INDEX IF NOT EXISTS run_liveness_updated_idx ON RunLiveness(updatedAt);

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

-- A process whose OWNER IS CORE, not the agent session that asked for it.
--
-- Why this table exists (2026-09-15 outage): long work started as an agent-CLI
-- background shell is a child of that CLI process. The CLI process is exactly
-- as long-lived as its session, and a session is recycled whenever the
-- context window fills. So the work died with the session, no terminal record
-- was ever written, and nothing on disk said whether it had finished — the
-- build had to be re-derived from file mtimes and re-run by hand.
--
-- The fix is ownership, not more care: the process is spawned by core, which
-- outlives every session. The pid is kept so the row can be reconciled against
-- the real OS process at boot (a 'running' row whose pid is gone becomes
-- 'lost', never a silent success). logPath is the evidence: output is streamed
-- to a file so the last lines survive whatever happens next. agentName is
-- denormalized alongside the nullable FK for the same reason it is on
-- UsageEvent: the row must still read correctly after the agent is gone.
CREATE TABLE IF NOT EXISTS Job (
  id TEXT PRIMARY KEY,
  agentId TEXT REFERENCES Agent(id) ON DELETE SET NULL,
  agentName TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'exited', 'failed', 'cancelled', 'lost')),
  exitCode INTEGER,
  logPath TEXT NOT NULL,
  lastOutputAt INTEGER,
  startedAt INTEGER NOT NULL DEFAULT (unixepoch()),
  endedAt INTEGER,
  lostReason TEXT,
  transcriptNotifiedAt INTEGER
);
CREATE INDEX IF NOT EXISTS job_agent_idx ON Job(agentId);
CREATE INDEX IF NOT EXISTS job_status_idx ON Job(status);
`;

sqliteDb.exec(SCHEMA);

// ─────────────────────────────────────────────────────────────
// Idempotent column additions (ALTER TABLE ADD COLUMN IF MISSING).
// CREATE TABLE IF NOT EXISTS does not add new columns to pre-existing
// tables, so we check PRAGMA table_info and ALTER for each missing column.
// ─────────────────────────────────────────────────────────────

function ensureColumn(table: string, column: string, decl: string): boolean {
  const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    return true;
  }
  return false;
}

/** Run `fn` inside a real SQLite transaction.
 *
 *  Compaction is the one operation that must move rows between two tables and
 *  delete them from the first: a crash between the archive insert and the
 *  delete would either lose messages or duplicate them. The driver here is
 *  `node:sqlite`'s synchronous `DatabaseSync`, so `fn` is synchronous by
 *  construction — there is no await point at which another writer could
 *  interleave, and no BUSY handling to get wrong. Anything asynchronous (the
 *  model call that produces the summary) happens BEFORE this is entered.
 *
 *  Nested use is rejected rather than silently joined: a nested BEGIN throws in
 *  SQLite, and a silently-joined transaction would commit work the outer scope
 *  still believes it can roll back. */
export function transaction<T>(fn: () => T): T {
  if (sqliteDb.isTransaction) {
    throw new Error("transaction() cannot be nested: the caller is already inside a transaction");
  }
  sqliteDb.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    sqliteDb.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      sqliteDb.exec("ROLLBACK");
    } catch {
      /* the transaction is already gone; the original error is the one to report */
    }
    throw err;
  }
}

ensureColumn("Provider", "disabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("Provider", "metadata", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("Agent", "codexWorkspace", "TEXT");
ensureColumn("Agent", "projectRoot", "TEXT");
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
// Phase 4 rework: how many ResultArtifactChunk rows hold this artifact's body.
// 0 means the body is in `ResultArtifact.body` — which is every row written
// before chunked bodies existed, so the default is also the migration.
ensureColumn("ResultArtifact", "chunkCount", "INTEGER NOT NULL DEFAULT 0");
// A job may settle while its owning agent is still streaming a turn. Its
// transcript notice is therefore committed only after that turn releases the
// message sequence. This marker makes the deferred write durable and
// idempotent across retries/restarts.
const addedJobTranscriptMarker = ensureColumn("Job", "transcriptNotifiedAt", "INTEGER");
if (addedJobTranscriptMarker) {
  // Rows created before this mechanism already emitted their old best-effort
  // notices (or are too old to replay safely). Do not flood transcripts on the
  // migration boot; only jobs settling under the new contract start pending.
  sqliteDb.exec(
    "UPDATE Job SET transcriptNotifiedAt = COALESCE(endedAt, unixepoch()) WHERE status <> 'running'",
  );
}

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
// projectRoot backfill: the legacy `codexWorkspace` column becomes the
// canonical `projectRoot`.
//
// The condition is deliberately narrow. A row is migrated ONLY when it has a
// non-empty legacy value AND no canonical value yet. A row with neither stays
// UNBOUND — it never had a project root, and inventing one (home dir? the
// process's cwd? the data dir?) would silently move that agent's work
// somewhere the user never chose. NULL is an answer here, not a gap.
//
// Idempotent by construction: after the first run `projectRoot` is no longer
// NULL for the migrated rows, so they no longer match. The one way a migrated
// row could match again is an explicit UNBIND (projectRoot back to NULL) while
// a legacy value is still on the row — which is why the write path clears the
// legacy column in the same statement. Otherwise this backfill would read that
// leftover as "not yet migrated" and rebind the agent.
// ─────────────────────────────────────────────────────────────

export function backfillProjectRoot(): { count: number } {
  const res = sqliteDb
    .prepare(
      `UPDATE Agent SET projectRoot = codexWorkspace
       WHERE projectRoot IS NULL AND codexWorkspace IS NOT NULL AND codexWorkspace <> ''`,
    )
    .run();
  return { count: Number(res.changes ?? 0) };
}

backfillProjectRoot();

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
  /** Legacy column. Kept readable for old rows; nothing may write or use it. */
  workspace: string | null;
  /** Legacy alias of `projectRoot` (see the backfill above). Compatibility
   *  only: read `projectRoot`. */
  codexWorkspace: string | null;
  /** The canonical project root for this agent, or NULL when it is unbound. */
  projectRoot: string | null;
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

/** Lifecycle of a core-owned job.
 *
 *  `exited` and `failed` are the two ways a process can END; they are separate
 *  statuses so "finished, exit 0" is never confused with "finished, exit 3".
 *  `lost` is the honest third answer: the row said `running` but the process is
 *  gone and nothing observed it finish — a crash, a reboot, or an owner that
 *  was killed. It is deliberately NOT collapsed into `failed`, because we do
 *  not know it failed; and never into `exited` with a default code, because
 *  that would fabricate the one fact we are missing. */
export type JobStatus = "running" | "exited" | "failed" | "cancelled" | "lost";

export interface Job {
  id: string;
  /** Nullable: the job outlives the agent row (see the DDL comment). */
  agentId: string | null;
  agentName: string;
  command: string;
  cwd: string;
  pid: number | null;
  status: JobStatus;
  exitCode: number | null;
  logPath: string;
  /** Last time output arrived. For a running job this is the only liveness
   *  signal that is not "the pid still exists". */
  lastOutputAt: Date | null;
  startedAt: Date;
  endedAt: Date | null;
  /** Why the row is `lost`, in the reconciler's own words. Null otherwise. */
  lostReason: string | null;
  /** When the terminal job notice was atomically appended to Message. */
  transcriptNotifiedAt: Date | null;
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
  projectRoot: (r.projectRoot as string | null) ?? null,
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

const mapJob = (r: Record<string, unknown>): Job => ({
  id: r.id as string,
  agentId: (r.agentId as string | null) ?? null,
  agentName: r.agentName as string,
  command: r.command as string,
  cwd: r.cwd as string,
  pid: r.pid == null ? null : Number(r.pid),
  status: r.status as JobStatus,
  exitCode: r.exitCode == null ? null : Number(r.exitCode),
  logPath: r.logPath as string,
  lastOutputAt: dateOrNull(r.lastOutputAt as number | null),
  startedAt: dateOf(r.startedAt as number),
  endedAt: dateOrNull(r.endedAt as number | null),
  lostReason: (r.lostReason as string | null) ?? null,
  transcriptNotifiedAt: dateOrNull(r.transcriptNotifiedAt as number | null),
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
      const obj = val as {
        equals?: unknown;
        mode?: "insensitive";
        gte?: unknown;
        lt?: unknown;
      };
      if ("equals" in obj) {
        if (obj.mode === "insensitive") {
          parts.push(`LOWER(${key}) = LOWER(?)`);
        } else {
          parts.push(`${key} = ?`);
        }
        params.push(obj.equals);
      }
      if (obj.gte != null) {
        parts.push(`${key} >= ?`);
        params.push(obj.gte instanceof Date ? Math.floor(obj.gte.getTime() / 1000) : obj.gte);
      }
      if (obj.lt != null) {
        parts.push(`${key} < ?`);
        params.push(obj.lt instanceof Date ? Math.floor(obj.lt.getTime() / 1000) : obj.lt);
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
const jobRepo = makeRepo("Job", mapJob);
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
  job: jobRepo,
};

/** Drop-in for the prior Prisma export so existing imports keep working. */
export const prisma = db;

export function closeDb(): void {
  sqliteDb.close();
}
