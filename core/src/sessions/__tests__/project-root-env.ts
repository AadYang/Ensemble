// Imported FIRST by project-root-flow.test.ts.
//
// `DATA_DIR` and the SQLite path are resolved when `paths.ts` / `db.ts` are
// first evaluated — that is, at import time. A test that assigns to
// `process.env` in its own body would do so AFTER every import has run, so the
// assertions about "under DATA_DIR" would be measuring the dev default (a
// `_data/` directory inside the repo) while comparing against the temp path.
// Keeping the assignment in its own module, imported before anything that reads
// it, makes the env the only source for this file's run.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTORCH_DATA_DIR = mkdtempSync(join(tmpdir(), "ensemble-projectroot-data-"));
process.env.AGENTORCH_DB_PATH = ":memory:";
