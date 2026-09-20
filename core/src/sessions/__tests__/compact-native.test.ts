// /compact asks the native CLI to compact when a session exists. Ensemble
// archives the live rows and writes the CLI's summary; it does not summarize
// the transcript itself on that path.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeOptions } from "../runtimes/types.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

const captured: RuntimeOptions[] = [];
let nativeCompactMode: "success" | "silent" = "success";

vi.mock("../runtimes/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimes/index.js")>()),
  chooseRuntime: () => ({
    async *query(opts: RuntimeOptions): AsyncGenerator<{ type: "sdk_message"; payload: unknown }> {
      captured.push(opts);
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

class StubHub {
  sendToSession(_sessionId: string, _msg: Record<string, unknown>): void {}
  broadcast(_msg: Record<string, unknown>): void {}
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager } = await import("../SessionManager.js"));
});

beforeEach(() => {
  captured.length = 0;
  nativeCompactMode = "success";
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
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.payload)).toContain("CLI summary");
    const payload = rows[0]?.payload as { generation?: number; diagnostics?: string[] };
    const archived = await sessions.readArchivedGeneration(agent.id, payload.generation as number, null);
    expect(archived?.records).toHaveLength(3);
    expect(archived?.text).toContain("patched the inset");
    expect(payload.diagnostics?.some((d) => d.includes("native claude CLI"))).toBe(true);
  });

  it("falls back to a local summary when the CLI does not compact", async () => {
    nativeCompactMode = "silent";
    const root = mkdtempSync(join(tmpdir(), "compact-fallback-"));
    const agent = await prisma.agent.create({
      data: {
        name: "cli-silent",
        projectRoot: root,
        metadata: { lastSessionId: "native-session-id" },
      },
    });
    await seedTurns(agent.id);
    const sessions = new SessionManager(new StubHub() as never);
    const out = await sessions.compactAgent(agent.id);

    expect(out?.summary).toContain("local layered summary");
    expect(captured.some((opts) => opts.prompt === "/compact")).toBe(true);
    expect(captured.some((opts) => opts.prompt !== "/compact")).toBe(true);
    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<
      string,
      unknown
    >;
    expect(meta.lastSessionId).toBeUndefined();
  });

  it("does not send /compact to an OpenAI in-process agent even if lastSessionId is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "compact-openai-"));
    const provider = await prisma.provider.create({
      data: {
        name: "openai-local-test",
        kind: "openai-local",
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
});
