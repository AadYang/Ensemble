import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOptions } from "../runtimes/types.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

const capturedRuntimeOptions: RuntimeOptions[] = [];

vi.mock("../runtimes/index.js", () => ({
  chooseRuntime: () => ({
    async *query(opts: RuntimeOptions) {
      capturedRuntimeOptions.push(opts);
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "result" as const,
          subtype: "success",
          session_id: `thread-${capturedRuntimeOptions.length}`,
          modelUsage: {},
        },
      };
    },
  }),
}));

vi.mock("../../cli-config.js", () => ({
  getClaudeCliPath: vi.fn(async () => "mock-claude"),
  getCodexCliPath: vi.fn(async () => "mock-codex"),
}));

let prisma: typeof import("../../db.js").prisma;
let SessionManager: typeof import("../SessionManager.js").SessionManager;

class StubHub {
  sendToSession(): void {}
  broadcast(): void {}
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager } = await import("../SessionManager.js"));
});

beforeEach(() => {
  capturedRuntimeOptions.length = 0;
});

describe("reasoning effort flow", () => {
  it.each([
    ["anthropic-local", "high"],
    ["openai-codex", "xhigh"],
  ] as const)("passes patched reasoning effort to %s runtime", async (kind, effort) => {
    const provider = await prisma.provider.create({
      data: {
        name: `reasoning-${kind}-${effort}`,
        kind,
        models: ["test-model"],
        metadata: kind === "openai-codex" ? { defaultSandbox: "danger-full-access" } : {},
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: `agent-${kind}-${effort}`,
        providerId: provider.id,
        model: "test-model",
        metadata: {
          reasoningEffort: "low",
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { reasoningEffort: effort });
    await sessions.sendMessage(agent.id, "use current thinking mode");

    expect(capturedRuntimeOptions).toHaveLength(1);
    const opts = capturedRuntimeOptions[0]!;
    expect(opts.provider.kind).toBe(kind);
    expect(opts.reasoningEffort).toBe(effort);
    expect(opts.resume).toBeUndefined();
  });

  it("passes null reasoning effort after clearing the override", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "reasoning-clear-codex",
        kind: "openai-codex",
        models: ["test-model"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "agent-clear-codex",
        providerId: provider.id,
        model: "test-model",
        metadata: {
          reasoningEffort: "xhigh",
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { reasoningEffort: null });
    await sessions.sendMessage(agent.id, "inherit thinking mode");

    expect(capturedRuntimeOptions).toHaveLength(1);
    const opts = capturedRuntimeOptions[0]!;
    expect(opts.reasoningEffort).toBeNull();
    expect(opts.resume).toBeUndefined();
  });
});
