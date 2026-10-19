import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTORCH_DATA_DIR = mkdtempSync(join(tmpdir(), "ensemble-loop-data-"));
process.env.AGENTORCH_DB_PATH = ":memory:";
