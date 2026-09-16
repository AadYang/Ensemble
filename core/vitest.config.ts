import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    // Runs in each worker before the test file's own imports are evaluated,
    // which is the only point early enough to pick the database: db.ts reads
    // AGENTORCH_DB_PATH at import time. Without it, a test that forgets to set
    // the variable either opens the developer's live database or (since the
    // guard in db.ts) fails to import at all. See src/test-setup.ts.
    setupFiles: ["./src/test-setup.ts"],
  },
});
