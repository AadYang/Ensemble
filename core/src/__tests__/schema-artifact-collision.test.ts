// A live user database already had an Artifact table from an earlier
// project-orchestration experiment (projectId, no agentId). Phase 4's
// CREATE TABLE IF NOT EXISTS Artifact was a no-op; the next
// CREATE INDEX ... ON Artifact(agentId) crashed sidecar boot with
// `no such column: agentId` and left the 0.0.30 window white.
//
// File DB, not :memory:: we have to CREATE the colliding table BEFORE db.ts
// opens the same path and runs SCHEMA.

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

const dbPath = join(tmpdir(), `ensemble-artifact-collide-${process.pid}.db`);
if (existsSync(dbPath)) unlinkSync(dbPath);
process.env.AGENTORCH_DB_PATH = dbPath;

const seed = new DatabaseSync(dbPath);
seed.exec(`
  CREATE TABLE Artifact (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    kind TEXT NOT NULL,
    createdAt INTEGER NOT NULL DEFAULT (unixepoch())
  );
  INSERT INTO Artifact (id, projectId, kind) VALUES ('old-1', 'proj-1', 'plan');
`);
seed.close();

const db = await import("../db.js");

afterAll(() => {
  try {
    unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

describe("schema boot with a pre-existing Artifact table", () => {
  it("creates ResultArtifact and leaves the old Artifact rows untouched", () => {
    const old = db.sqliteDb.prepare("PRAGMA table_info(Artifact)").all() as { name: string }[];
    expect(old.map((c) => c.name)).toEqual(["id", "projectId", "kind", "createdAt"]);
    const next = db.sqliteDb.prepare("PRAGMA table_info(ResultArtifact)").all() as { name: string }[];
    expect(next.map((c) => c.name)).toContain("agentId");
    const kept = db.sqliteDb.prepare("SELECT id, projectId FROM Artifact").all();
    expect(kept).toEqual([{ id: "old-1", projectId: "proj-1" }]);
  });
});
