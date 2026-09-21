import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOptions } from "../runtimes/types.js";
import { __setSkillsForTest } from "../../skills/index.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

const capturedRuntimeOptions: RuntimeOptions[] = [];
let deltaBudget = 8_000;
let deltasEmitted = 0;

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

vi.mock("../runtimes/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimes/index.js")>()),
  chooseRuntime: () => ({
    async *query(opts: RuntimeOptions) {
      capturedRuntimeOptions.push(opts);
      yield {
        type: "sdk_message" as const,
        payload: { type: "system" as const, subtype: "init", session_id: "loop-yield", model: opts.model },
      };
      for (let i = 0; i < deltaBudget; i++) {
        deltasEmitted++;
        yield {
          type: "sdk_message" as const,
          payload: {
            type: "stream_event" as const,
            event: {
              type: "content_block_delta",
              delta: { type: "thinking_delta", thinking: "x" },
            },
          },
        };
      }
      await gate.promise;
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "result" as const,
          subtype: "success",
          session_id: "loop-yield",
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
  sendToSession(_sessionId: string, _msg: Record<string, unknown>): void {}
  broadcast(_msg: Record<string, unknown>): void {}
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager } = await import("../SessionManager.js"));
});

beforeEach(() => {
  capturedRuntimeOptions.length = 0;
  deltaBudget = 8_000;
  deltasEmitted = 0;
  __setSkillsForTest([]);
  armGate();
});

describe("event loop yield during thinking", () => {
  it("lets createAgent finish while another agent is still streaming 1-char deltas", async () => {
    const provider = await prisma.provider.create({
      data: { name: "loop-yield-provider", kind: "anthropic-local", models: ["claude-sonnet-4-6"] },
    });
    const thinker = await prisma.agent.create({
      data: { name: "thinker", providerId: provider.id, model: "claude-sonnet-4-6" },
    });
    const sessions = new SessionManager(new StubHub() as never);

    const turn = sessions.sendMessage(thinker.id, "think for a while");
    for (let i = 0; i < 400; i++) {
      if (deltasEmitted > 80) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(deltasEmitted).toBeGreaterThan(80);

    const seen = deltasEmitted;
    const started = Date.now();
    const createdId = await sessions.createAgent({ name: "new-member", providerId: provider.id });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(200);
    expect(createdId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(seen).toBeGreaterThan(80);
    expect(deltasEmitted).toBeLessThan(deltaBudget);

    gate.open();
    await turn;
  }, 30_000);
});
