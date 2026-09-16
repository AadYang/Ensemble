// Mid-turn context occupancy: the pane bar must move while the runtime is
// still streaming, not only when the turn's result lands.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOptions } from "../runtimes/types.js";
import { __setSkillsForTest } from "../../skills/index.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

const capturedRuntimeOptions: RuntimeOptions[] = [];

let gate: { promise: Promise<void>; open: () => void } = {
  promise: Promise.resolve(),
  open: () => {},
};
function armGate(): void {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  gate = { promise, open };
}

const STREAM_CHUNK = "the occupancy numerator must move while this text is still streaming. ";

vi.mock("../runtimes/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimes/index.js")>()),
  chooseRuntime: () => ({
    async *query(opts: RuntimeOptions) {
      capturedRuntimeOptions.push(opts);
      yield {
        type: "sdk_message" as const,
        payload: { type: "system" as const, subtype: "init", session_id: "live-ctx", model: opts.model },
      };
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "stream_event" as const,
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: STREAM_CHUNK.repeat(8) },
          },
        },
      };
      await gate.promise;
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "assistant" as const,
          message: {
            content: [{ type: "text", text: "done" }],
            usage: { input_tokens: 1_200, cache_read_input_tokens: 0, output_tokens: 80 },
          },
        },
      };
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "result" as const,
          subtype: "success",
          session_id: "live-ctx",
          modelUsage: { [opts.model]: { contextWindow: 200_000 } },
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
  events: Array<{ kind: "session" | "broadcast"; msg: Record<string, unknown> }> = [];
  sendToSession(_sessionId: string, msg: Record<string, unknown>): void {
    this.events.push({ kind: "session", msg });
  }
  broadcast(msg: Record<string, unknown>): void {
    this.events.push({ kind: "broadcast", msg });
  }
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager } = await import("../SessionManager.js"));
});

beforeEach(() => {
  capturedRuntimeOptions.length = 0;
  __setSkillsForTest([]);
  armGate();
});

async function waitForTurnStart(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (capturedRuntimeOptions.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (capturedRuntimeOptions.length === 0) throw new Error("the runtime was never dispatched");
  await new Promise((resolve) => setTimeout(resolve, 40));
}

function contextUsages(hub: StubHub): Array<{ usedTokens: number; contextWindow?: number }> {
  return hub.events
    .filter((e) => e.msg.type === "context_usage")
    .map((e) => e.msg.usage as { usedTokens: number; contextWindow?: number } | null)
    .filter((u): u is { usedTokens: number; contextWindow?: number } => u !== null && u.usedTokens > 0);
}

describe("live context occupancy", () => {
  it("publishes a rising usedTokens while the turn is still streaming", async () => {
    const provider = await prisma.provider.create({
      data: { name: "live-ctx-provider", kind: "anthropic-local", models: ["claude-sonnet-4-6"] },
    });
    const agent = await prisma.agent.create({
      data: { name: "live-ctx", providerId: provider.id, model: "claude-sonnet-4-6" },
    });
    const hub = new StubHub();
    const sessions = new SessionManager(hub as never);

    const turn = sessions.sendMessage(agent.id, "please stream a long answer");
    await waitForTurnStart();

    const mid = contextUsages(hub);
    expect(mid.length).toBeGreaterThanOrEqual(2);
    expect(mid[0]!.usedTokens).toBeGreaterThan(0);
    expect(mid[mid.length - 1]!.usedTokens).toBeGreaterThan(mid[0]!.usedTokens);

    gate.open();
    await turn;

    const after = contextUsages(hub);
    const last = after[after.length - 1]!;
    expect(last.usedTokens).toBeGreaterThanOrEqual(1_280);
    expect(last.contextWindow).toBe(200_000);
  }, 30_000);
});
