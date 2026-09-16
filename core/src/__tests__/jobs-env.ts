// Imported FIRST by jobs.test.ts.
//
// The job manager writes its logs under DATA_DIR and its rows into the SQLite
// path, and BOTH are resolved when `paths.ts` / `db.ts` are first evaluated.
// A `process.env` assignment in the test's own body runs after every import has
// already been evaluated, so it would pick up whatever the developer's shell
// exported (the running desktop app exports AGENTORCH_DATA_DIR) instead of a
// temp directory. Keeping the assignment in its own module, imported before
// anything that reads it, is the only ordering that works — same reason as
// sessions/__tests__/project-root-env.ts.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTORCH_DATA_DIR = mkdtempSync(join(tmpdir(), "ensemble-jobs-data-"));
process.env.AGENTORCH_DB_PATH = ":memory:";
