// The compact's summarize layers share ONE absolute deadline.
//
// Two things this pins down, both of them about a clock ending a run:
//
//   • With no user ceiling (`maxRunDurationMs` unset — the default), NOTHING
//     bounds a summary. The layer used to be handed a hardcoded 60 000 ms, so a
//     model that took 61 s to read a long transcript was aborted mid-summary and
//     the compact failed for a reason nobody asked for. The test advances a fake
//     clock 75 s inside every model call and asserts the call is still alive.
//   • With a ceiling, that ceiling is an INSTANT shared by every layer. Asking
//     the plan for its duration again per layer is how four layers under a 90 s
//     budget spent 360 s — each of them believing it had the full window. The
//     test drives the fake clock forward between layers and asserts the budget
//     each layer is handed is what is LEFT of the one deadline.

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOptions } from "../runtimes/types.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

/** Fake-clock ms a single model call "thinks" for. Set per test. */
let modelLatencyMs = 0;
/** What each summarize call was handed as its own deadline, in order. */
const passedDeadlines: Array<number | null> = [];
/** Whether the call's own abort signal had fired when the model answered. */
const abortedAtAnswer: boolean[] = [];

vi.mock("../runtimes/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimes/index.js")>()),
  chooseRuntime: () => ({
    async *query(opts: RuntimeOptions): AsyncGenerator<{ type: "sdk_message"; payload: unknown }> {
      // The model takes `modelLatencyMs` of FAKE time. Advancing the clock here
      // is what makes a silent `setTimeout` visible: the real timers (the
      // caller's deadline, the liveness controller's ticker's notion of `now`)
      // move forward exactly as they would have while the model was thinking.
      vi.advanceTimersByTime(modelLatencyMs);
      abortedAtAnswer.push(opts.abortController.signal.aborted);
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "assistant" as const,
          message: { content: [{ type: "text", text: "a summary of this layer" }] },
        },
      };
      yield {
        type: "sdk_message" as const,
        payload: { type: "result" as const, subtype: "success", session_id: "s", modelUsage: {} },
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
  passedDeadlines.length = 0;
  abortedAtAnswer.length = 0;
  modelLatencyMs = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A transcript big enough that one layer cannot cover it: at the 8 000-token
 *  fallback chunk budget, ~120 000 characters of readable text is several
 *  chunks plus the merge over them. */
async function seedConversation(agentId: string, turns: number, charsPerTurn: number): Promise<void> {
  const body = "the agent read a file, ran a command and explained what it found. ".repeat(
    Math.ceil(charsPerTurn / 66),
  );
  for (let i = 0; i < turns; i++) {
    await prisma.message.create({
      data: {
        agentId,
        seq: i * 2,
        type: "user",
        payload: { type: "user", message: { role: "user", content: `request ${i}: ${body}` } },
      },
    });
    await prisma.message.create({
      data: {
        agentId,
        seq: i * 2 + 1,
        type: "assistant",
        payload: { type: "assistant", message: { content: [{ type: "text", text: `answer ${i}: ${body}` }] } },
      },
    });
  }
}

async function newAgent(name: string, maxRunDurationMs?: number): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      name,
      model: "test-model",
      metadata: maxRunDurationMs === undefined ? {} : { maxRunDurationMs },
    },
  });
  return agent.id;
}

/** Wrap the instance's own quickQuery so the deadline each layer is handed is
 *  observable, then delegate to the REAL one — the arithmetic under test is
 *  quickQuery's, so a stub would assert nothing. */
function recordingSessions(sessions: InstanceType<typeof SessionManager>): void {
  const real = sessions.quickQuery.bind(sessions);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sessions as any).quickQuery = (agentId: string, prompt: string, abortMs: number | null = null) => {
    passedDeadlines.push(abortMs);
    return real(agentId, prompt, abortMs);
  };
}

describe("compact's summarize layers share one deadline", () => {
  it("does not abort a slow summary at the old 60-second mark when no ceiling is set", async () => {
    const id = await newAgent("compact-no-deadline");
    await seedConversation(id, 6, 2_000);
    const sessions = new SessionManager(new StubHub() as never);
    recordingSessions(sessions);

    // Every model call sits on the clock for 75 s. Under the hardcoded 60 000 ms
    // this layer used to carry, the first one would have been aborted long
    // before it answered.
    modelLatencyMs = 75_000;
    const out = await sessions.compactAgent(id);

    expect(out).not.toBeNull();
    // Nothing was handed a deadline, so nothing installed a timer to fire.
    expect(passedDeadlines.length).toBeGreaterThan(0);
    expect(passedDeadlines.every((ms) => ms === null)).toBe(true);
    // And the proof that no OTHER clock ended it: the model answered every call
    // with the clock already 75 s further on, and no abort had fired.
    expect(abortedAtAnswer.every((aborted) => aborted === false)).toBe(true);
    expect(vi.getMockedSystemTime()).not.toBeNull();

    const rows = await prisma.message.findMany({ where: { agentId: id }, orderBy: { seq: "asc" } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.payload)).toContain("compact");
  }, 60_000);

  it("hands each layer what is LEFT of the user's deadline, never a fresh full window", async () => {
    const id = await newAgent("compact-shared-deadline", 90_000);
    await seedConversation(id, 30, 4_000);
    const sessions = new SessionManager(new StubHub() as never);
    recordingSessions(sessions);

    // 30 s a layer against a 90 s total: the first layer may spend the whole
    // window, the second only what is left, the third only what is left of
    // THAT, and a fourth gets nothing rather than a new 90 s.
    modelLatencyMs = 30_000;
    let failure: unknown = null;
    try {
      await sessions.compactAgent(id);
    } catch (err) {
      failure = err;
    }

    expect(passedDeadlines.length).toBeGreaterThanOrEqual(2);
    // The first layer is the ONLY one that may see the full ceiling.
    expect(passedDeadlines[0]).toBeLessThanOrEqual(90_000);
    expect(passedDeadlines[0]).toBeGreaterThan(60_000);
    // Every later layer sees strictly less — a re-granted full window would show
    // up here as a second value near 90 000.
    for (let i = 1; i < passedDeadlines.length; i++) {
      const previous = passedDeadlines[i - 1]!;
      const current = passedDeadlines[i]!;
      expect(current).toBeLessThan(previous);
    }
    // 30 s of model time passed between the first two layers, so the second one
    // is the remainder — this is the number that used to be the full 60 000 ms.
    expect(passedDeadlines[1]!).toBeLessThanOrEqual(60_000);
    expect(passedDeadlines[1]!).toBeGreaterThan(0);

    // The layers ran out rather than restarting: whatever ended the compact
    // named the deadline, and no layer was handed a fresh full window.
    if (failure !== null) {
      expect(`${(failure as Error).message}${(failure as { code?: string }).code ?? ""}`).toContain(
        "RUNTIME_WALL_CLOCK_LIMIT",
      );
    }
    expect(passedDeadlines.every((ms) => ms === null || ms <= 90_000)).toBe(true);
  }, 60_000);
});
