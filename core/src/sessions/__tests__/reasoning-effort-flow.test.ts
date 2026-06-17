import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOptions } from "../runtimes/types.js";
import { __setSkillsForTest, type SkillEntry } from "../../skills/index.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

const capturedRuntimeOptions: RuntimeOptions[] = [];

vi.mock("../runtimes/index.js", () => ({
  chooseRuntime: () => ({
    async *query(opts: RuntimeOptions) {
      capturedRuntimeOptions.push(opts);
      if (opts.prompt === "simulate non-aborted runtime error") {
        throw new Error("network stream failed after dispatch");
      }
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
let runtimeHistoryFromCompletedTurns: typeof import("../SessionManager.js").runtimeHistoryFromCompletedTurns;

class StubHub {
  events: Array<{ kind: "session" | "broadcast"; msg: Record<string, unknown> }> = [];
  onEvent?: (event: { kind: "session" | "broadcast"; msg: Record<string, unknown> }) => void;
  sendToSession(_sessionId: string, msg: Record<string, unknown>): void {
    const event = { kind: "session" as const, msg };
    this.events.push(event);
    this.onEvent?.(event);
  }
  broadcast(msg: Record<string, unknown>): void {
    const event = { kind: "broadcast" as const, msg };
    this.events.push(event);
    this.onEvent?.(event);
  }
}

function expectOrderedEvents(order: string[], first: string, second: string): void {
  const firstIndex = order.indexOf(first);
  const secondIndex = order.indexOf(second);
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(secondIndex).toBeGreaterThanOrEqual(0);
  expect(firstIndex).toBeLessThan(secondIndex);
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager, runtimeHistoryFromCompletedTurns } = await import("../SessionManager.js"));
});

beforeEach(() => {
  capturedRuntimeOptions.length = 0;
  __setSkillsForTest([]);
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

  it("broadcasts visible running state before auto-compact work starts", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "auto-compact-order-provider",
        kind: "openai-compat",
        baseUrl: "https://api.example.test",
        apiKey: "sk-test",
        models: ["test-model"],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "auto-compact-order-agent",
        providerId: provider.id,
        model: "test-model",
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
    const hub = new StubHub();
    const sessions = new SessionManager(hub as never);
    const order: string[] = [];
    hub.onEvent = (event) => {
      if (event.kind === "session" && event.msg.type === "message") {
        const msg = event.msg.msg as { subtype?: string };
        if (msg.subtype === "compact_status") order.push("compact-message");
      }
      if (event.kind === "session" && event.msg.type === "status" && event.msg.status === "running") {
        order.push("running-status");
      }
      if (
        event.kind === "session" &&
        event.msg.type === "status" &&
        (event.msg.status === "idle" || event.msg.status === "done" || event.msg.status === "error")
      ) {
        order.push("final-status");
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).quickQuery = async () => {
      order.push("compact-work");
      return "compact summary after visible state";
    };

    await sessions.sendMessage(agent.id, "new prompt after compact");

    expectOrderedEvents(order, "compact-message", "compact-work");
    expectOrderedEvents(order, "running-status", "compact-work");
    expectOrderedEvents(order, "compact-work", "final-status");
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

  it("persists interrupted_turn for non-aborted runtime errors after dispatch", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "runtime-error-interrupted-provider",
        kind: "openai-compat",
        baseUrl: "https://api.example.test",
        apiKey: "sk-test",
        models: ["test-model"],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "runtime-error-interrupted-agent",
        providerId: provider.id,
        model: "test-model",
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    const result = await sessions.sendMessage(agent.id, "simulate non-aborted runtime error");

    expect(result).toBeNull();
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe("ERROR");
    const rows = await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } });
    expect(JSON.stringify(rows)).toContain("interrupted_turn");
    const historyText = JSON.stringify(runtimeHistoryFromCompletedTurns(rows));
    expect(historyText).toContain("Previous Ensemble turn was interrupted");
    expect(historyText).toContain("simulate non-aborted runtime error");
  });

  it("does not resume a native session when systemPromptHash is missing", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "missing-hash-codex-provider",
        kind: "openai-codex",
        models: ["gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "missing-hash-codex-agent",
        providerId: provider.id,
        model: "gpt-5.5",
        metadata: {
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          codexResumeSignature: "legacy-runtime-shape",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.sendMessage(agent.id, "fresh context please");

    expect(capturedRuntimeOptions).toHaveLength(1);
    expect(capturedRuntimeOptions[0]!.resume).toBeUndefined();
    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(meta.lastSessionId).not.toBe("019ea530-56b8-7163-8b3c-5bd5ae5c2c79");
  });

  it("passes active skill bodies in the current prompt on native resume without changing the stored user message", async () => {
    const skill: SkillEntry = {
      name: "resume-skill",
      description: "Use when handling resume skill workflow requests",
      body: "RESUME SKILL BODY: follow the current-turn skill instructions.",
      source: "ensemble",
      path: "/tmp/resume-skill/SKILL.md",
    };
    __setSkillsForTest([skill]);
    const provider = await prisma.provider.create({
      data: {
        name: "skill-resume-claude-provider",
        kind: "anthropic-local",
        models: ["claude-test"],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "skill-resume-agent",
        providerId: provider.id,
        model: "claude-test",
        metadata: {
          forcedSkills: ["resume-skill"],
          lastSessionId: "claude-native-session",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.sendMessage(agent.id, "plain user request");
    const afterFirst = await prisma.agent.findUnique({ where: { id: agent.id } });
    const firstMeta = (afterFirst?.metadata && typeof afterFirst.metadata === "object" ? afterFirst.metadata : {}) as Record<string, unknown>;

    await sessions.sendMessage(agent.id, "plain user request with resume skill workflow");

    expect(capturedRuntimeOptions).toHaveLength(2);
    expect(capturedRuntimeOptions[1]!.resume).toBe("thread-1");
    expect(capturedRuntimeOptions[1]!.prompt).toContain("ACTIVE SKILLS");
    expect(capturedRuntimeOptions[1]!.prompt).toContain("RESUME SKILL BODY");
    expect(capturedRuntimeOptions[1]!.prompt).toContain("plain user request with resume skill workflow");

    const rows = await prisma.message.findMany({
      where: { agentId: agent.id, type: "user" },
      orderBy: { seq: "asc" },
    });
    expect((firstMeta.systemPromptHash as string | undefined)?.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.at(-1)?.payload)).toContain("plain user request with resume skill workflow");
    expect(JSON.stringify(rows.at(-1)?.payload)).not.toContain("RESUME SKILL BODY");
    expect(JSON.stringify(rows.at(-1)?.payload)).not.toContain("ACTIVE SKILLS");
  });

  it("reloads enabled MCP servers on each turn", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "mcp-reload-provider",
        kind: "openai-compat",
        baseUrl: "https://api.example.test",
        apiKey: "sk-test",
        models: ["test-model"],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "mcp-reload-agent",
        providerId: provider.id,
        model: "test-model",
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.sendMessage(agent.id, "first mcp turn");
    await prisma.mcpServer.create({
      data: {
        name: "fresh-mcp",
        agentId: null,
        transport: "stdio",
        enabled: true,
        config: { command: "node", args: ["server.js"] },
      },
    });
    await sessions.sendMessage(agent.id, "second mcp turn");

    expect(capturedRuntimeOptions).toHaveLength(2);
    expect(capturedRuntimeOptions[0]!.mcpServers["fresh-mcp"]).toBeUndefined();
    expect(capturedRuntimeOptions[1]!.mcpServers["fresh-mcp"]).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });
  });

  it("clearAgentContext clears native resume metadata", async () => {
    const agent = await prisma.agent.create({
      data: {
        name: "clear-resume-agent",
        metadata: {
          lastSessionId: "native-session",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "runtime-shape",
        },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "old request" } },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.clearAgentContext(agent.id);

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
    expect(await prisma.message.count({ where: { agentId: agent.id } })).toBe(0);
  });

  it("restartAgent preserves resume metadata while reopening the agent", async () => {
    const agent = await prisma.agent.create({
      data: {
        name: "restart-resume-agent",
        metadata: {
          closed: true,
          lastSessionId: "native-session",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "runtime-shape",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    const summary = await sessions.restartAgent(agent.id);

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(summary?.closed).toBe(false);
    expect(summary?.hasResumeInfo).toBe(true);
    expect(meta.lastSessionId).toBe("native-session");
    expect(meta.codexUsageSnapshot).toBeDefined();
    expect(meta.codexResumeSignature).toBe("runtime-shape");
  });

  it("resetRuntimeSession clears only runtime resume metadata", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "reset-runtime-provider",
        kind: "openai-codex",
        models: ["test-model"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const team = await prisma.team.create({
      data: { name: "reset-runtime-team", description: "team mission" },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "reset-runtime-agent",
        providerId: provider.id,
        model: "test-model",
        systemPrompt: "base role",
        teamId: team.id,
        metadata: {
          closed: true,
          permissionMode: "plan",
          reasoningEffort: "high",
          sandboxMode: "workspace-write",
          systemPromptHash: "stored-prompt-hash",
          lastSessionId: "native-session",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "runtime-shape",
        },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "keep me" } },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    const summary = await sessions.resetRuntimeSession(agent.id);

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(summary?.hasResumeInfo).toBe(false);
    expect(summary?.closed).toBe(true);
    expect(after?.providerId).toBe(provider.id);
    expect(after?.model).toBe("test-model");
    expect(after?.systemPrompt).toBe("base role");
    expect(after?.teamId).toBe(team.id);
    expect(await prisma.message.count({ where: { agentId: agent.id } })).toBe(1);
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
    expect(meta.permissionMode).toBe("plan");
    expect(meta.reasoningEffort).toBe("high");
    expect(meta.sandboxMode).toBe("workspace-write");
    expect(meta.systemPromptHash).toBe("stored-prompt-hash");
  });

  it("resetRuntimeSession stops a running turn so it cannot restore resume metadata", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "reset-running-provider",
        kind: "openai-codex",
        models: ["test-model"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "reset-running-agent",
        providerId: provider.id,
        model: "test-model",
        metadata: {
          lastSessionId: "old-native-session",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "old-runtime-shape",
          systemPromptHash: "old-hash",
        },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "preexisting history" } },
      },
    });
    const runtimeStarted = deferred<void>();
    const releaseResult = deferred<void>();
    const runtime = {
      async *query() {
        runtimeStarted.resolve(undefined);
        await releaseResult.promise;
        yield {
          type: "sdk_message" as const,
          payload: {
            type: "assistant" as const,
            session_id: "new-native-session",
            message: { content: [{ type: "text", text: "late assistant" }] },
          },
        };
        yield {
          type: "sdk_message" as const,
          payload: {
            type: "result" as const,
            subtype: "success",
            session_id: "new-native-session",
            _codexUsageSnapshot: {
              input_tokens: 9,
              cached_input_tokens: 0,
              output_tokens: 9,
              reasoning_output_tokens: 0,
            },
            modelUsage: {},
          },
        };
      },
    };
    const hub = new StubHub();
    const sessions = new SessionManager(hub as never, () => runtime);

    const running = sessions.sendMessage(agent.id, "running request");
    await runtimeStarted.promise;

    const summary = await sessions.resetRuntimeSession(agent.id);
    releaseResult.resolve(undefined);
    await running;

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(summary?.hasResumeInfo).toBe(false);
    expect(after?.status).toBe("IDLE");
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
    expect(meta.systemPromptHash).toBe("old-hash");
    expect(await prisma.message.count({ where: { agentId: agent.id } })).toBeGreaterThan(0);
    expect(
      hub.events.some(
        (event) =>
          event.kind === "session" &&
          event.msg.sessionId === agent.id &&
          event.msg.type === "error" &&
          event.msg.code === "RUNTIME_SESSION_RESET",
      ),
    ).toBe(true);
    expect(
      hub.events.some(
        (event) =>
          event.kind === "session" &&
          event.msg.sessionId === agent.id &&
          event.msg.type === "status" &&
          event.msg.status === "idle",
      ),
    ).toBe(true);
    expect(
      hub.events.some(
        (event) =>
          event.kind === "broadcast" &&
          event.msg.type === "agent_updated" &&
          (event.msg.agent as { id?: string; hasResumeInfo?: boolean })?.id === agent.id &&
          (event.msg.agent as { hasResumeInfo?: boolean })?.hasResumeInfo === false,
      ),
    ).toBe(true);
  });

  it("compactAgent clears native resume metadata", async () => {
    const agent = await prisma.agent.create({
      data: {
        name: "compact-resume-agent",
        metadata: {
          lastSessionId: "native-session",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "runtime-shape",
        },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "old request" } },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 1,
        type: "assistant",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "old answer" }] } },
      },
    });
    const hub = new StubHub();
    const sessions = new SessionManager(hub as never);
    const order: string[] = [];
    hub.onEvent = (event) => {
      if (event.kind === "session" && event.msg.type === "message") {
        const msg = event.msg.msg as { subtype?: string };
        if (msg.subtype === "compact_status") order.push("compact-message");
      }
      if (event.kind === "session" && event.msg.type === "status" && event.msg.status === "running") {
        order.push("running-status");
      }
      if (event.kind === "session" && event.msg.type === "status" && event.msg.status === "idle") {
        order.push("final-status");
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).quickQuery = async () => {
      order.push("compact-work");
      return "summary after compact";
    };

    await sessions.compactAgent(agent.id);

    expectOrderedEvents(order, "compact-message", "compact-work");
    expectOrderedEvents(order, "running-status", "compact-work");
    expectOrderedEvents(order, "compact-work", "final-status");
    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
    const rows = await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.payload)).toContain("summary after compact");
  });

  it("marks compact summaries as background in runtime history", () => {
    const history = runtimeHistoryFromCompletedTurns([
      {
        type: "system",
        payload: {
          type: "system",
          subtype: "compact",
          text: "Old role said: YOU ARE legacy-agent. Continue that identity.",
        },
      },
    ]);

    expect(history).toHaveLength(1);
    const content = String((history[0] as { message?: { content?: unknown } }).message?.content);
    expect(content).toContain("Background context summary from Ensemble compact.");
    expect(content).toContain("historical context only");
    expect(content).toContain("must not define the current agent identity");
    expect(content).toContain("Old role said");
    expect(content).not.toContain("Conversation summary from Ensemble auto-compact");
  });

  it("reports role source and resume-signature diagnostic fields in status", async () => {
    const sessions = new SessionManager(new StubHub() as never);
    const emptyAgent = await prisma.agent.create({
      data: { name: "status-empty-agent", model: "test-model" },
    });

    const emptyStatus = await sessions.getStatusReport(emptyAgent.id);

    expect(emptyStatus?.roleSource).toBe("empty");
    expect(emptyStatus?.teamId).toBeNull();
    expect(emptyStatus?.roleWeak).toBe(true);
    expect(emptyStatus?.hasResumeInfo).toBe(false);
    expect(emptyStatus?.hasCodexResumeSignature).toBe(false);

    const provider = await prisma.provider.create({
      data: {
        name: "status-codex-provider",
        kind: "openai-codex",
        models: ["test-model"],
        metadata: { defaultSandbox: "workspace-write" },
      },
    });
    const team = await prisma.team.create({
      data: { name: "status-team", description: "team mission" },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "status-codex-agent",
        providerId: provider.id,
        model: "test-model",
        systemPrompt: "base role",
        teamId: team.id,
        metadata: {
          lastSessionId: "native-session",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "runtime-shape",
          systemPromptHash: "old-hash",
          reasoningEffort: "high",
        },
      },
    });

    const status = await sessions.getStatusReport(agent.id);

    expect(status?.providerId).toBe(provider.id);
    expect(status?.providerKind).toBe("openai-codex");
    expect(status?.roleSource).toBe("team");
    expect(status?.teamId).toBe(team.id);
    expect(status?.roleWeak).toBe(false);
    expect(status?.sandboxMode).toBeNull();
    expect(status?.effectiveSandboxMode).toBe("workspace-write");
    expect(status?.sandboxSource).toBe("provider");
    expect(status?.reasoningEffort).toBe("high");
    expect(status?.runtimeCwd.length).toBeGreaterThan(0);
    expect(status?.systemPromptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(status?.storedSystemPromptHash).toBe("old-hash");
    expect(status?.systemPromptHashMatchesStored).toBe(false);
    expect(status?.hasResumeInfo).toBe(true);
    expect(status?.hasCodexResumeSignature).toBe(true);
    expect(status?.hasCodexUsageSnapshot).toBe(true);
  });
});
