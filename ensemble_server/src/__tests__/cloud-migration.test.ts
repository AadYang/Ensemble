// The cloud mirror's half of the phase-2 migration contract.
//
// The SQLite side runs `backfillProjectRoot()` on every boot; this side runs
// `CloudDb.migrate()`. Both must be idempotent and both must treat a NULL /
// empty legacy value as an ANSWER ("unbound") rather than a gap to fill —
// inventing a directory for such a row would move an agent's work somewhere
// the user never chose.
//
// MySQL has no ADD COLUMN IF NOT EXISTS, so the migration asks
// information_schema first. A fake connection records the SQL and answers that
// catalog question, which lets the test drive both the "old deployment" and the
// "already migrated" case without a live server.

import { describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { CloudDb } from "../cloud/db.js";

type Query = { sql: string; values?: unknown[] };

class FakeConn {
  readonly queries: Query[] = [];
  /** Whether `cloud_agent.project_root` is already present, i.e. whether this
   *  is a fresh-enough deployment. */
  constructor(public columnExists: boolean) {}

  async query(sql: string, values?: unknown[]): Promise<unknown> {
    this.queries.push({ sql, values });
    if (/information_schema\.columns/i.test(sql)) {
      return [[{ n: this.columnExists ? 1 : 0 }], []];
    }
    if (/SELECT \* FROM cloud_workspace/i.test(sql)) {
      return [[{ id: "workspace", name: "Workspace", revision: 3, created_at: new Date(0), updated_at: new Date(0) }], []];
    }
    // `[rows, fields]` — the shape mysql2 hands back, so `const [rows] = ...`
    // destructures to an empty result rather than to an object.
    return [[], []];
  }

  release(): void {
    /* no-op */
  }

  beginTransaction(): Promise<void> {
    return Promise.resolve();
  }

  commit(): Promise<void> {
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    return Promise.resolve();
  }

  sqlMatching(re: RegExp): string[] {
    return this.queries.map((q) => q.sql).filter((sql) => re.test(sql));
  }

  /** The parameters of the LAST statement matching `re`. */
  paramsOf(re: RegExp): unknown[] | undefined {
    return this.queries.filter((q) => re.test(q.sql)).at(-1)?.values;
  }
}

function makeDb(conn: FakeConn): CloudDb {
  const pool = {
    getConnection: async () => conn,
    query: async (sql: string, values?: unknown[]) => conn.query(sql, values),
  } as unknown as Pool;
  return new CloudDb(pool);
}

const ALTER_RE = /ALTER TABLE\s+cloud_agent\s+ADD COLUMN\s+project_root/i;
const BACKFILL_RE = /UPDATE\s+cloud_agent\s+SET\s+project_root\s*=/i;
const AGENT_UPSERT_RE = /INSERT INTO cloud_agent/i;

describe("cloud migration", () => {
  it("adds project_root once, then leaves the table alone on later boots", async () => {
    const conn = new FakeConn(false);
    const db = makeDb(conn);

    await db.migrate();
    const firstAlters = conn.sqlMatching(ALTER_RE);
    expect(firstAlters).toHaveLength(1);
    expect(firstAlters[0]).toContain("VARCHAR(512) NULL");

    // The column now exists (as it would after that ALTER): a second boot must
    // issue no DDL at all, so restarting the sidecar is never a schema change.
    conn.columnExists = true;
    conn.queries.length = 0;
    await db.migrate();
    expect(conn.sqlMatching(ALTER_RE)).toHaveLength(0);
  });

  it("creates the column for a fresh database without a separate ALTER", async () => {
    const conn = new FakeConn(true);
    const db = makeDb(conn);
    await db.migrate();
    // CREATE TABLE IF NOT EXISTS carries the column for a new deployment...
    const creates = conn.sqlMatching(/CREATE TABLE IF NOT EXISTS\s+cloud_agent/i);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatch(/project_root\s+VARCHAR\(512\)\s+NULL/);
    // ...and everything else is skipped, because the catalog said it was there.
    expect(conn.sqlMatching(ALTER_RE)).toHaveLength(0);
  });

  it("backfills only a non-empty legacy value and never invents one", async () => {
    const conn = new FakeConn(true);
    await makeDb(conn).migrate();

    const backfills = conn.sqlMatching(BACKFILL_RE);
    expect(backfills).toHaveLength(1);
    const backfill = backfills[0]!.replace(/\s+/g, " ");

    // The narrow predicate, verbatim: NULL and empty stay unbounded.
    expect(backfill).toContain("WHERE project_root IS NULL");
    expect(backfill).toContain("codex_workspace IS NOT NULL");
    expect(backfill).toContain("codex_workspace <> ''");
    // No default, no fallback expression, no server-side cwd stand-in.
    expect(backfill).not.toMatch(/COALESCE|IFNULL|\bDEFAULT\b/i);
    // And the legacy column is only READ here — new writes tombstone it, so
    // the migration must not "normalize" it either.
    expect(backfill).not.toMatch(/codex_workspace\s*=/);
  });

  it("tombstones the legacy column on write, so an unbind cannot be re-bound", async () => {
    // The round trip that matters: a row backfilled from the legacy column,
    // then explicitly unbound by the user, then the sidecar restarts. If the
    // upsert preserved `codex_workspace` (the old behavior) the next migrate()
    // would see "project_root IS NULL AND codex_workspace IS NOT NULL" and
    // silently rebind the agent the user just unbound.
    const conn = new FakeConn(true);
    const db = makeDb(conn);

    await db.migrate();
    // One row, the three transitions, driven by the statements the mirror
    // actually issues (captured in `conn`) rather than by a restatement of
    // them. `row` stands in for the stored cloud_agent row.
    const row: { project_root: unknown; codex_workspace: unknown } = {
      project_root: null,
      codex_workspace: "/repo/legacy",
    };

    // 1. Legacy deployment: the row predates project_root, and the boot
    //    migration binds it. That is the state the whole tombstone rule exists
    //    for.
    const backfill = conn.sqlMatching(BACKFILL_RE)[0]!;
    const rebinds = (r: typeof row): boolean =>
      // The predicate as the migration writes it: only a NULL canonical with a
      // NON-EMPTY legacy value is a row waiting to be migrated.
      r.project_root === null && r.codex_workspace !== null && r.codex_workspace !== "";
    expect(backfill).toContain("project_root IS NULL");
    expect(rebinds(row)).toBe(true);
    row.project_root = row.codex_workspace;
    expect(row.project_root).toBe("/repo/legacy");

    // 2. The user explicitly unbinds the agent, and the mirror stores it.
    await db.syncBatch("acct", "workspace", {
      agents: [{ id: "agent", name: "Agent", projectRoot: null, codexWorkspace: null }],
    });

    const params = conn.paramsOf(AGENT_UPSERT_RE);
    expect(params).toBeDefined();
    // The parameter order mirrors the column list: project_root is the 15th
    // column, codex_workspace the 16th.
    const upsert = conn.sqlMatching(AGENT_UPSERT_RE)[0]!.replace(/\s+/g, " ");
    expect(upsert).toContain("project_root = VALUES(project_root)");
    // The canonical value is written; the legacy column is CLEARED, not kept.
    expect(upsert).toContain("codex_workspace = VALUES(codex_workspace)");
    expect(upsert).not.toContain("codex_workspace = codex_workspace");
    // Apply that write: both columns take the payload's value.
    if (upsert.includes("project_root = VALUES(project_root)")) row.project_root = params![14];
    if (upsert.includes("codex_workspace = VALUES(codex_workspace)")) row.codex_workspace = params![15];
    expect(row).toEqual({ project_root: null, codex_workspace: null });

    // 3. The next boot's migration finds nothing to rebind — the agent the user
    //    unbound stays unbound, which is what the previous `codex_workspace =
    //    codex_workspace` made impossible.
    expect(rebinds(row)).toBe(false);
  });

  it("refuses a payload that names two different directories", async () => {
    const conn = new FakeConn(true);
    const db = makeDb(conn);
    await expect(
      db.syncBatch("acct", "workspace", {
        agents: [
          { id: "agent", name: "Agent", projectRoot: "/repo/one", codexWorkspace: "/repo/two" },
        ],
      }),
    ).rejects.toMatchObject({ code: "PROJECT_ROOT_CONFLICT" });
    // Refused before anything was written.
    expect(conn.sqlMatching(AGENT_UPSERT_RE)).toHaveLength(0);
  });
});
