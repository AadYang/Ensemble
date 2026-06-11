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
    ["openai-codex", "max"],
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

  it("auto-compacts oversized local history before building runtime context", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "auto-compact-openai-provider",
        kind: "openai-compat",
        baseUrl: "https://api.example.test",
        apiKey: "sk-test",
        models: ["test-model"],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "auto-compact-agent",
        providerId: provider.id,
        model: "test-model",
        metadata: {
          lastSessionId: "stale-native-session",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        },
      },
    });
    for (let i = 0; i < 82; i++) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          seq: i,
          type: i % 2 === 0 ? "user" : "assistant",
          payload:
            i % 2 === 0
              ? { type: "user", message: { role: "user", content: `old question ${i} ${"x".repeat(650)}` } }
              : { type: "assistant", message: { content: [{ type: "text", text: `old answer ${i} ${"y".repeat(650)}` }] } },
        },
      });
    }
    const sessions = new SessionManager(new StubHub() as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).quickQuery = async () => "compact summary for old turns";

    await sessions.sendMessage(agent.id, "new prompt after compact");

    expect(capturedRuntimeOptions).toHaveLength(1);
    const historyText = JSON.stringify(capturedRuntimeOptions[0]!.history);
    expect(historyText).toContain("compact summary for old turns");
    expect(historyText).toContain("old answer 81");
    expect(historyText).not.toContain("old question 0");
    const rows = await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } });
    expect(rows[0]?.type).toBe("system");
    expect(JSON.stringify(rows[0]?.payload)).toContain("compact summary for old turns");
    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(meta.lastSessionId).not.toBe("stale-native-session");
    expect(meta.codexUsageSnapshot).toBeUndefined();
  });

  it("keeps interrupted context in local history after model switch clears native resume", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "model-switch-history-codex",
        kind: "openai-codex",
        models: ["gpt-5.4", "gpt-5.5"],
        metadata: { defaultSandbox: "workspace-write" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "model-switch-history-agent",
        providerId: provider.id,
        model: "gpt-5.4",
        metadata: {
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "old-runtime-shape",
          reasoningEffort: "xhigh",
          sandboxMode: "danger-full-access",
        },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 0,
        type: "system",
        payload: { type: "system", subtype: "compact", text: "compact summary before model switch" },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 1,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "interrupted model switch task" } },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 2,
        type: "system",
        payload: {
          type: "system",
          subtype: "interrupted_turn",
          reason: "cancelled",
          runId: "run-model-switch",
          userSeq: 1,
          userRequest: "interrupted model switch task",
          partialAssistantText: "partial model switch work",
          interruptedAt: new Date().toISOString(),
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { model: "gpt-5.5" });
    const patched = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (patched?.metadata && typeof patched.metadata === "object" ? patched.metadata : {}) as Record<string, unknown>;
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
    expect(meta.reasoningEffort).toBe("xhigh");
    expect(meta.sandboxMode).toBe("danger-full-access");

    await sessions.sendMessage(agent.id, "继续");

    expect(capturedRuntimeOptions).toHaveLength(1);
    const opts = capturedRuntimeOptions[0]!;
    expect(opts.resume).toBeUndefined();
    expect(opts.model).toBe("gpt-5.5");
    expect(opts.reasoningEffort).toBe("xhigh");
    expect((opts.agentMetadata as Record<string, unknown>).sandboxMode).toBe("danger-full-access");
    const historyText = JSON.stringify(opts.history);
    expect(historyText).toContain("compact summary before model switch");
    expect(historyText).toContain("Previous Ensemble turn was interrupted");
    expect(historyText).toContain("interrupted model switch task");
    expect(historyText).toContain("partial model switch work");
  });
});
