import { describe, expect, it } from "vitest";
import type { MCPServer } from "@openai/agents";
import { CLOSE_ALL_TIMEOUT_MS, closeAll } from "../mcp-adapter.js";

describe("closeAll", () => {
  it("returns immediately when there is nothing to close", async () => {
    await closeAll([]);
  });

  it("does not wait forever on a hung close", async () => {
    const hung = { close: () => new Promise<void>(() => {}) } as MCPServer;
    const t0 = Date.now();
    await closeAll([hung]);
    expect(Date.now() - t0).toBeLessThan(CLOSE_ALL_TIMEOUT_MS + 500);
  });
});
