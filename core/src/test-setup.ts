// Vitest setup file — runs in every worker BEFORE the test file it belongs to
// is imported (vitest evaluates `setupFiles` first and only then loads the test
// module, so an assignment here is visible to every `import` in that file).
// That ordering is the whole point: `db.ts` resolves its SQLite path at import
// time, so this is the only moment early enough to choose the database. A
// `process.env` assignment written in a test file's own body cannot do it — the
// imports it is trying to influence have already run by the time the body
// executes, which is the same trap project-root-env.ts documents.
//
// Why a shared setup file and not a line in each test: db.ts falls back to the
// terminal path under the user's data directory when AGENTORCH_DB_PATH is
// unset, and a developer shell exports AGENTORCH_DATA_DIR from the running
// desktop app. A test that forgot its own path therefore opened the LIVE
// database and ran the schema against it for real. db.ts now refuses that
// outright under VITEST; this file is what keeps the refusal from being the
// normal case, for every test at once rather than for the handful that were
// noticed. A test that sets its own path is making a deliberate choice and must
// keep winning, so the value is only filled in when it is missing.
//
// ":memory:" and not a per-worker temp file: a `DatabaseSync(":memory:")` is
// private to the process, so two workers cannot collide on a path, nothing is
// left behind when a worker is killed mid-run, and there is no teardown to get
// wrong. No core test needs a database that outlives its own process — every
// one that touches a table seeds what it reads.
if (!process.env.AGENTORCH_DB_PATH) {
  process.env.AGENTORCH_DB_PATH = ":memory:";
}
