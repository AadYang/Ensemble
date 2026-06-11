import type { Pool, RowDataPacket } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { normalizeEmail } from "./auth.js";
import type {
  CloudAccountRecord,
  CloudAgent,
  CloudMessage,
  CloudMessageCursor,
  CloudSessionRecord,
  CloudSnapshot,
  CloudSyncBatchInput,
  CloudSyncBatchResult,
  CloudSnapshotInput,
  CloudStore,
  CloudTeam,
  CloudWorkspace,
  JsonObject,
  JsonValue,
} from "./store.js";
import { CloudRevisionConflictError, sanitizeSnapshotInput } from "./store.js";

const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS cloud_account (
     id            VARCHAR(36)  NOT NULL,
     email         VARCHAR(255) NOT NULL,
     password_hash VARCHAR(255) NOT NULL,
     display_name  VARCHAR(255) NULL,
     created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
     PRIMARY KEY (id),
     UNIQUE KEY uq_cloud_account_email (email)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cloud_invite (
     code_hash     VARCHAR(64)  NOT NULL,
     created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     used_by       VARCHAR(36)  NULL,
     used_at       DATETIME(3)  NULL,
     PRIMARY KEY (code_hash),
     KEY idx_cloud_invite_used_by (used_by)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cloud_session (
     id            VARCHAR(36)  NOT NULL,
     account_id    VARCHAR(36)  NOT NULL,
     token_hash    VARCHAR(64)  NOT NULL,
     user_agent    VARCHAR(512) NULL,
     created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     expires_at    DATETIME(3)  NOT NULL,
     last_seen_at  DATETIME(3)  NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_cloud_session_token (token_hash),
     KEY idx_cloud_session_account (account_id),
     CONSTRAINT fk_cloud_session_account FOREIGN KEY (account_id) REFERENCES cloud_account(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cloud_workspace (
     id            VARCHAR(128) NOT NULL,
     account_id    VARCHAR(36)  NOT NULL,
     name          VARCHAR(160) NOT NULL,
     revision      BIGINT       NOT NULL DEFAULT 0,
     created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     PRIMARY KEY (account_id, id),
     KEY idx_cloud_workspace_updated (account_id, updated_at),
     CONSTRAINT fk_cloud_workspace_account FOREIGN KEY (account_id) REFERENCES cloud_account(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cloud_team (
     id            VARCHAR(128) NOT NULL,
     account_id    VARCHAR(36)  NOT NULL,
     workspace_id  VARCHAR(128) NOT NULL,
     name          VARCHAR(160) NOT NULL,
     description   TEXT         NULL,
     sort_order    INT          NOT NULL DEFAULT 0,
     revision      BIGINT       NOT NULL DEFAULT 0,
     updated_at    DATETIME(3)  NOT NULL,
     PRIMARY KEY (account_id, workspace_id, id),
     KEY idx_cloud_team_workspace (account_id, workspace_id),
     CONSTRAINT fk_cloud_team_workspace FOREIGN KEY (account_id, workspace_id)
       REFERENCES cloud_workspace(account_id, id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cloud_agent (
     id                VARCHAR(128) NOT NULL,
     account_id        VARCHAR(36)  NOT NULL,
     workspace_id      VARCHAR(128) NOT NULL,
     parent_id         VARCHAR(128) NULL,
     team_id           VARCHAR(128) NULL,
     name              VARCHAR(160) NOT NULL,
     system_prompt     MEDIUMTEXT   NULL,
     model             VARCHAR(160) NULL,
     provider_kind     VARCHAR(80)  NULL,
     provider_name     VARCHAR(160) NULL,
     provider_id       VARCHAR(128) NULL,
     permission_mode   VARCHAR(80)  NULL,
     sandbox_mode      VARCHAR(80)  NULL,
     reasoning_effort  VARCHAR(80)  NULL,
     codex_workspace   VARCHAR(512) NULL,
     metadata          JSON         NOT NULL,
     sort_order        INT          NOT NULL DEFAULT 0,
     revision          BIGINT       NOT NULL DEFAULT 0,
     updated_at        DATETIME(3)  NOT NULL,
     PRIMARY KEY (account_id, workspace_id, id),
     KEY idx_cloud_agent_workspace (account_id, workspace_id),
     KEY idx_cloud_agent_team (account_id, workspace_id, team_id),
     CONSTRAINT fk_cloud_agent_workspace FOREIGN KEY (account_id, workspace_id)
       REFERENCES cloud_workspace(account_id, id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cloud_message (
     id            BIGINT       NOT NULL AUTO_INCREMENT,
     account_id    VARCHAR(36)  NOT NULL,
     workspace_id  VARCHAR(128) NOT NULL,
     agent_id      VARCHAR(128) NOT NULL,
     seq           INT          NOT NULL,
     type          VARCHAR(40)  NOT NULL,
     payload       JSON         NOT NULL,
     created_at    DATETIME(3)  NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uq_cloud_message_seq (account_id, workspace_id, agent_id, seq),
     KEY idx_cloud_message_agent (account_id, workspace_id, agent_id, seq),
     CONSTRAINT fk_cloud_message_workspace FOREIGN KEY (account_id, workspace_id)
       REFERENCES cloud_workspace(account_id, id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cloud_desktop_connection (
     account_id     VARCHAR(36)  NOT NULL,
     connection_id  VARCHAR(128) NOT NULL,
     connected_at   DATETIME(3)  NOT NULL,
     last_seen_at   DATETIME(3)  NOT NULL,
     PRIMARY KEY (account_id),
     CONSTRAINT fk_cloud_desktop_connection_account FOREIGN KEY (account_id) REFERENCES cloud_account(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cloud_config_change (
     id            VARCHAR(36)  NOT NULL,
     account_id    VARCHAR(36)  NOT NULL,
     workspace_id  VARCHAR(128) NOT NULL,
     agent_id      VARCHAR(128) NOT NULL,
     patch         JSON         NOT NULL,
     status        VARCHAR(32)  NOT NULL,
     revision      BIGINT       NOT NULL DEFAULT 0,
     created_at    DATETIME(3)  NOT NULL,
     acked_at      DATETIME(3)  NULL,
     PRIMARY KEY (id),
     KEY idx_cloud_config_change_agent (account_id, workspace_id, agent_id, created_at),
     CONSTRAINT fk_cloud_config_change_workspace FOREIGN KEY (account_id, workspace_id)
       REFERENCES cloud_workspace(account_id, id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

type Row = RowDataPacket & Record<string, unknown>;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function parseJson(value: unknown, fallback: JsonValue): JsonValue {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return fallback;
    }
  }
  return value as JsonValue;
}

function jsonString(value: JsonValue): string {
  return JSON.stringify(value);
}

function mapAccount(row: Row): CloudAccountRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    displayName: row.display_name == null ? null : String(row.display_name),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapSession(row: Row): CloudSessionRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    tokenHash: String(row.token_hash),
    userAgent: row.user_agent == null ? null : String(row.user_agent),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    lastSeenAt: toIso(row.last_seen_at),
  };
}

function mapWorkspace(row: Row): CloudWorkspace {
  return {
    id: String(row.id),
    name: String(row.name),
    revision: Number(row.revision ?? 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapTeam(row: Row): CloudTeam {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    sortOrder: Number(row.sort_order ?? 0),
    revision: Number(row.revision ?? 0),
    updatedAt: toIso(row.updated_at),
  };
}

function mapAgent(row: Row): CloudAgent {
  const metadata = parseJson(row.metadata, {}) as JsonObject;
  return {
    id: String(row.id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    teamId: row.team_id == null ? null : String(row.team_id),
    name: String(row.name),
    systemPrompt: row.system_prompt == null ? null : String(row.system_prompt),
    model: row.model == null ? null : String(row.model),
    providerKind: row.provider_kind == null ? null : String(row.provider_kind),
    providerName: row.provider_name == null ? null : String(row.provider_name),
    providerId: row.provider_id == null ? null : String(row.provider_id),
    permissionMode: row.permission_mode == null ? null : String(row.permission_mode),
    sandboxMode: row.sandbox_mode == null ? null : String(row.sandbox_mode),
    reasoningEffort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
    codexWorkspace: row.codex_workspace == null ? null : String(row.codex_workspace),
    metadata,
    sortOrder: Number(row.sort_order ?? 0),
    revision: Number(row.revision ?? 0),
    updatedAt: toIso(row.updated_at),
  };
}

function mapMessage(row: Row): CloudMessage {
  return {
    id: Number(row.id),
    agentId: String(row.agent_id),
    seq: Number(row.seq),
    type: String(row.type),
    payload: parseJson(row.payload, null),
    createdAt: toIso(row.created_at),
  };
}

export class CloudDb implements CloudStore {
  constructor(readonly pool: Pool) {}

  async migrate(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      for (const statement of SCHEMA_STATEMENTS) await conn.query(statement);
    } finally {
      conn.release();
    }
  }

  async findAccountByEmail(email: string): Promise<CloudAccountRecord | null> {
    const [rows] = await this.pool.query<Row[]>("SELECT * FROM cloud_account WHERE email = ? LIMIT 1", [normalizeEmail(email)]);
    return rows[0] ? mapAccount(rows[0]) : null;
  }

  async getAccountById(accountId: string): Promise<CloudAccountRecord | null> {
    const [rows] = await this.pool.query<Row[]>("SELECT * FROM cloud_account WHERE id = ? LIMIT 1", [accountId]);
    return rows[0] ? mapAccount(rows[0]) : null;
  }

  async createAccount(input: { email: string; passwordHash: string; displayName?: string | null }): Promise<CloudAccountRecord> {
    const id = randomUUID();
    const email = normalizeEmail(input.email);
    await this.pool.query(
      `INSERT INTO cloud_account (id, email, password_hash, display_name)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE email = email`,
      [id, email, input.passwordHash, input.displayName ?? null],
    );
    const account = await this.findAccountByEmail(email);
    if (!account) throw new Error("account_create_failed");
    return account;
  }

  async createSession(input: { accountId: string; tokenHash: string; expiresAt: Date; userAgent?: string | null }): Promise<CloudSessionRecord> {
    const id = randomUUID();
    const now = new Date();
    await this.pool.query(
      `INSERT INTO cloud_session (id, account_id, token_hash, user_agent, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.accountId, input.tokenHash, input.userAgent ?? null, input.expiresAt, now],
    );
    const session = await this.getSessionByTokenHash(input.tokenHash);
    if (!session) throw new Error("session_create_failed");
    return session;
  }

  async getSessionByTokenHash(tokenHash: string): Promise<CloudSessionRecord | null> {
    const [rows] = await this.pool.query<Row[]>("SELECT * FROM cloud_session WHERE token_hash = ? LIMIT 1", [tokenHash]);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async touchSession(tokenHash: string, at: Date): Promise<void> {
    await this.pool.query("UPDATE cloud_session SET last_seen_at = ? WHERE token_hash = ?", [at, tokenHash]);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM cloud_session WHERE token_hash = ?", [tokenHash]);
  }

  async listWorkspaces(accountId: string): Promise<CloudWorkspace[]> {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT * FROM cloud_workspace WHERE account_id = ? ORDER BY updated_at DESC, id ASC",
      [accountId],
    );
    return rows.map(mapWorkspace);
  }

  async createWorkspace(accountId: string, input: { id?: string; name: string }): Promise<CloudWorkspace> {
    const id = input.id ?? randomUUID();
    const now = new Date();
    await this.pool.query(
      `INSERT INTO cloud_workspace (id, account_id, name, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = VALUES(updated_at)`,
      [id, accountId, input.name, now],
    );
    const workspace = await this.getWorkspace(accountId, id);
    if (!workspace) throw new Error("workspace_create_failed");
    return workspace;
  }

  async getWorkspace(accountId: string, workspaceId: string): Promise<CloudWorkspace | null> {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT * FROM cloud_workspace WHERE account_id = ? AND id = ? LIMIT 1",
      [accountId, workspaceId],
    );
    return rows[0] ? mapWorkspace(rows[0]) : null;
  }

  async getSnapshot(accountId: string, workspaceId: string): Promise<CloudSnapshot | null> {
    const workspace = await this.getWorkspace(accountId, workspaceId);
    if (!workspace) return null;
    const [teamRows] = await this.pool.query<Row[]>(
      "SELECT * FROM cloud_team WHERE account_id = ? AND workspace_id = ? ORDER BY sort_order ASC, id ASC",
      [accountId, workspaceId],
    );
    const [agentRows] = await this.pool.query<Row[]>(
      "SELECT * FROM cloud_agent WHERE account_id = ? AND workspace_id = ? ORDER BY sort_order ASC, id ASC",
      [accountId, workspaceId],
    );
    const [messageRows] = await this.pool.query<Row[]>(
      "SELECT * FROM cloud_message WHERE account_id = ? AND workspace_id = ? ORDER BY agent_id ASC, seq ASC",
      [accountId, workspaceId],
    );
    return {
      workspace,
      teams: teamRows.map(mapTeam),
      agents: agentRows.map(mapAgent),
      messages: messageRows.map(mapMessage),
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
    const { teams, agents, messages } = sanitizeSnapshotInput(input);
    const readMessageCursors = async (): Promise<CloudMessageCursor[]> => {
      const [cursorRows] = await this.pool.query<Row[]>(
        `SELECT agent_id AS agentId, MAX(seq) AS maxSeq
         FROM cloud_message
         WHERE account_id = ? AND workspace_id = ?
         GROUP BY agent_id
         ORDER BY agent_id ASC`,
        [accountId, workspaceId],
      );
      return cursorRows.map((row) => ({
        agentId: String(row.agentId),
        maxSeq: Number(row.maxSeq ?? -1),
      }));
    };
    if (teams.length === 0 && agents.length === 0 && messages.length === 0) {
      return {
        workspace,
        applied: { teams: 0, agents: 0, messages: 0 },
        messageCursors: await readMessageCursors(),
      };
    }
    const conn = await this.pool.getConnection();
    const now = new Date();
    const nextRevision = workspace.revision + 1;
    try {
      await conn.beginTransaction();
      await conn.query(
        "UPDATE cloud_workspace SET revision = ?, updated_at = ? WHERE account_id = ? AND id = ?",
        [nextRevision, now, accountId, workspaceId],
      );
      for (const team of teams) {
        await conn.query(
          `INSERT INTO cloud_team
             (id, account_id, workspace_id, name, description, sort_order, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             name = VALUES(name),
             description = VALUES(description),
             sort_order = VALUES(sort_order),
             revision = VALUES(revision),
             updated_at = VALUES(updated_at)`,
          [team.id, accountId, workspaceId, team.name, team.description, team.sortOrder, nextRevision, now],
        );
      }
      for (const agent of agents) {
        await conn.query(
          `INSERT INTO cloud_agent
             (id, account_id, workspace_id, parent_id, team_id, name, system_prompt, model, provider_kind,
              provider_name, provider_id, permission_mode, sandbox_mode, reasoning_effort, codex_workspace,
              metadata, sort_order, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             parent_id = VALUES(parent_id),
             team_id = VALUES(team_id),
             name = VALUES(name),
             system_prompt = VALUES(system_prompt),
             model = VALUES(model),
             provider_kind = VALUES(provider_kind),
             provider_name = VALUES(provider_name),
             provider_id = VALUES(provider_id),
             permission_mode = VALUES(permission_mode),
             sandbox_mode = VALUES(sandbox_mode),
             reasoning_effort = VALUES(reasoning_effort),
             codex_workspace = VALUES(codex_workspace),
             metadata = VALUES(metadata),
             sort_order = VALUES(sort_order),
             revision = VALUES(revision),
             updated_at = VALUES(updated_at)`,
          [
            agent.id,
            accountId,
            workspaceId,
            agent.parentId,
            agent.teamId,
            agent.name,
            agent.systemPrompt,
            agent.model,
            agent.providerKind,
            agent.providerName,
            agent.providerId,
            agent.permissionMode,
            agent.sandboxMode,
            agent.reasoningEffort,
            agent.codexWorkspace,
            jsonString(agent.metadata),
            agent.sortOrder,
            nextRevision,
            now,
          ],
        );
      }
      for (const message of messages) {
        await conn.query(
          `INSERT INTO cloud_message
             (account_id, workspace_id, agent_id, seq, type, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             type = VALUES(type),
             payload = VALUES(payload),
             created_at = VALUES(created_at)`,
          [accountId, workspaceId, message.agentId, message.seq, message.type, jsonString(message.payload), message.createdAt],
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    const nextWorkspace = await this.getWorkspace(accountId, workspaceId);
    if (!nextWorkspace) throw new Error("workspace_not_found");
    return {
      workspace: nextWorkspace,
      applied: {
        teams: teams.length,
        agents: agents.length,
        messages: messages.length,
      },
      messageCursors: await readMessageCursors(),
    };
  }
}
