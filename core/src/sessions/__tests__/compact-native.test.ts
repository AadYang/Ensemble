// /compact asks the native CLI to compact when a session exists. Ensemble
// preserves the live rows; the CLI only owns its native context.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeOptions } from "../runtimes/types.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

const captured: RuntimeOptions[] = [];
let nativeCompactMode: "success" | "silent" = "success";
let failNextUserPrompt = false;

vi.mock("../runtimes/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimes/index.js")>()),
  chooseRuntime: () => ({
    async *compact(opts: RuntimeOptions) {
      yield* this.query(opts);
    },
    async *query(opts: RuntimeOptions): AsyncGenerator<{ type: "sdk_message"; payload: unknown }> {
      captured.push(opts);
      if (failNextUserPrompt && opts.prompt !== "/compact") {
        failNextUserPrompt = false;
        yield {
          type: "sdk_message" as const,
          payload: {
            type: "result" as const,
            subtype: "success",
            is_error: true,
            result: "Prompt is too long",
            session_id: opts.resume ?? "too-long-session",
            modelUsage: {},
          },
        };
        return;
      }
      if (opts.resume && opts.prompt === "/compact") {
        if (nativeCompactMode === "success") {
          opts.captureCompactSummary?.("CLI summary of the native session", { trigger: "manual" });
          yield {
            type: "sdk_message" as const,
            payload: {
              type: "system" as const,
              subtype: "compact_boundary",
              compact_metadata: { trigger: "manual", pre_tokens: 12000 },
            },
          };
          yield {
            type: "sdk_message" as const,
            payload: {
              type: "system" as const,
              subtype: "status",
              status: "compacting",
              compact_result: "success",
            },
          };
          yield {
            type: "sdk_message" as const,
            payload: { type: "result" as const, subtype: "success", session_id: opts.resume, modelUsage: {} },
          };
          return;
        }
        yield {
          type: "sdk_message" as const,
          payload: { type: "result" as const, subtype: "success", session_id: opts.resume, modelUsage: {} },
        };
        return;
      }
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "assistant" as const,
          message: { content: [{ type: "text", text: "local layered summary" }] },
        },
      };
      yield {
        type: "sdk_message" as const,
        payload: { type: "result" as const, subtype: "success", session_id: "local", modelUsage: {} },
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
let hashStableSystemPrompt: typeof import("../SessionManager.js").hashStableSystemPrompt;

class StubHub {
  sendToSession(_sessionId: string, _msg: Record<string, unknown>): void {}
  broadcast(_msg: Record<string, unknown>): void {}
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager, hashStableSystemPrompt } = await import("../SessionManager.js"));
});

beforeEach(() => {
  captured.length = 0;
  nativeCompactMode = "success";
  failNextUserPrompt = false;
});

async function seedTurns(agentId: string): Promise<void> {
  await prisma.message.create({
    data: {
      agentId,
      seq: 0,
      type: "user",
      payload: { type: "user", message: { role: "user", content: "fix the crop box" } },
    },
  });
  await prisma.message.create({
    data: {
      agentId,
      seq: 1,
      type: "assistant",
      payload: { type: "assistant", message: { content: [{ type: "text", text: "patched the inset" }] } },
    },
  });
}

describe("compact delegates to the native CLI when a session exists", () => {
  it.each(["anthropic-local", "openai-codex"])("persists the native id before %s is cancelled", async (kind) => {
    const provider = await prisma.provider.create({ data: { name: `cancel-${kind}`, kind, models: ["test-model"] } });
    const agent = await prisma.agent.create({ data: {
      name: `cancel-${kind}`, providerId: provider.id, model: "test-model",
      projectRoot: mkdtempSync(join(tmpdir(), "compact-cancel-")),
    } });
    const sessions = new SessionManager(new StubHub() as never);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const nativeId = "01a1576f-be4d-73f2-9dbe-e04a618fd87a";
    (sessions as any).runtimeResolver = () => ({
      async *query(opts: RuntimeOptions) {
        yield { type: "sdk_message", payload: { type: "system", subtype: "init", session_id: nativeId } };
        // SessionManager has consumed and persisted init before asking for the next event.
        ready();
        await new Promise<void>((resolve) => {
          if (opts.abortController.signal.aborted) resolve();
          else opts.abortController.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    const turn = sessions.sendMessage(agent.id, "start");
    await started;
    await sessions.cancel(agent.id);
    await turn;
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.metadata).toMatchObject({
      lastSessionId: nativeId,
    });
    await sessions.resetRuntimeSession(agent.id);
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.metadata).not.toHaveProperty("lastSessionId");
  });

  it("resumes the CLI with /compact and keeps lastSessionId", async () => {
    const root = mkdtempSync(join(tmpdir(), "compact-native-"));
    const agent = await prisma.agent.create({
      data: {
        name: "cli-compact",
        model: "deepseek-flash",
        projectRoot: root,
        metadata: { lastSessionId: "native-session-id", reasoningEffort: "high" },
      },
    });
    await seedTurns(agent.id);
    const sessions = new SessionManager(new StubHub() as never);
    const out = await sessions.compactAgent(agent.id);

    expect(out?.summary).toContain("CLI summary");
    expect(captured.length).toBe(1);
    expect(captured[0]?.prompt).toBe("/compact");
    expect(captured[0]?.resume).toBe("native-session-id");
    expect(captured[0]?.history).toEqual([]);

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<
      string,
      unknown
    >;
    expect(meta.lastSessionId).toBe("native-session-id");

    const rows = await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } });
    expect(rows.some((row) => JSON.stringify(row.payload).includes("patched the inset"))).toBe(true);
    expect(rows.some((row) => JSON.stringify(row.payload).includes("native context compacted"))).toBe(true);
    expect(await sessions.listArchivedGenerations(agent.id)).toEqual([]);
  });

  it("preserves history and rejects when the CLI does not confirm compaction", async () => {
    nativeCompactMode = "silent";
    const root = mkdtempSync(join(tmpdir(), "compact-no-fallback-"));
    const agent = await prisma.agent.create({
      data: { name: "cli-silent", projectRoot: root, metadata: { lastSessionId: "native-session-id" } },
    });
    await seedTurns(agent.id);
    const sessions = new SessionManager(new StubHub() as never);
    await expect(sessions.compactAgent(agent.id)).rejects.toThrow("without confirming compaction");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.prompt).toBe("/compact");
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.metadata).toMatchObject({ lastSessionId: "native-session-id" });
    expect(await sessions.listArchivedGenerations(agent.id)).toEqual([]);
  });

  it.each(["anthropic-local", "anthropic", "openai-codex"])("does not summarize locally for %s without a native session", async (kind) => {
    const provider = await prisma.provider.create({ data: { name: `missing-${kind}`, kind, models: ["test-model"] } });
    const agent = await prisma.agent.create({ data: {
      name: `missing-${kind}`, providerId: provider.id, projectRoot: mkdtempSync(join(tmpdir(), "compact-missing-")),
    } });
    await seedTurns(agent.id);
    const sessions = new SessionManager(new StubHub() as never);
    await expect(sessions.compactAgent(agent.id)).rejects.toThrow("native session is unavailable");
    expect(captured).toHaveLength(0);
    expect(await sessions.listArchivedGenerations(agent.id)).toEqual([]);
  });

  it.each(["openai-local", "openai-compat"])("keeps application compaction for %s", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "compact-openai-"));
    const provider = await prisma.provider.create({
      data: {
        name: `compact-${kind}`,
        kind,
        apiKey: "sk-test",
        models: ["gpt-4o"],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "openai-compact",
        model: "gpt-4o",
        providerId: provider.id,
        projectRoot: root,
        metadata: { lastSessionId: "not-a-cli-session" },
      },
    });
    await seedTurns(agent.id);
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.compactAgent(agent.id);
    expect(captured.every((opts) => opts.prompt !== "/compact")).toBe(true);
  });

  it("retries a Prompt-is-too-long turn after native /compact and keeps the session", async () => {
    failNextUserPrompt = true;
    const root = mkdtempSync(join(tmpdir(), "compact-overflow-"));
    const agent = await prisma.agent.create({
      data: {
        name: "cli-overflow",
        model: "deepseek-flash",
        projectRoot: root,
        systemPrompt: "You are a test agent.",
      },
    });
    const promptHash = hashStableSystemPrompt({
      permissionMode: "default",
      teamContext: "",
      baseSystemPrompt: agent.systemPrompt ?? "",
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: { metadata: { lastSessionId: "native-session-id", systemPromptHash: promptHash } },
    });
    await seedTurns(agent.id);
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "keep going");

    expect(captured.some((opts) => opts.prompt === "/compact")).toBe(true);
    expect(captured.some((opts) => opts.prompt === "keep going" && opts.resume === "native-session-id")).toBe(true);

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<
      string,
      unknown
    >;
    expect(meta.lastSessionId).toBe("native-session-id");
  });
});
