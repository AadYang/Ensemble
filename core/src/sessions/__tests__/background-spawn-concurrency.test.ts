// Regression coverage for the "only one background task shows up / a hung
// background task blocks the next one" report.
//
// The invariant under test: spawnTaskSubagent(background:true) is DETACHED and
// PER-SPAWN. Neither a hung sibling nor a hung parent turn may prevent a second
// background task from being created, tagged and broadcast — otherwise the
// sidebar shows one BG node while every later spawn silently evaporates.

import { describe, it, expect, beforeAll } from "vitest";
import type { AgentRuntime } from "../runtimes/types.js";

// In-memory DB so the test never touches the user's real ~/.ensemble.
process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../../db.js").prisma;
let SessionManager: typeof import("../SessionManager.js").SessionManager;
let agentRowToSummary: typeof import("../SessionManager.js").agentRowToSummary;

type Broadcast = Record<string, unknown>;

class StubHub {
  broadcasts: Broadcast[] = [];
  sessionMessages: Array<{ sessionId: string; msg: Broadcast }> = [];
  size(): number { return 0; }
  add(): void {}
  remove(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  replayPendingFor(): void {}
  sendTo(): void {}
  sendToSession(sessionId: string, msg: Broadcast): void {
    this.sessionMessages.push({ sessionId, msg });
  }
  broadcast(msg: Broadcast): void {
    this.broadcasts.push(msg);
  }
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager, agentRowToSummary } = await import("../SessionManager.js"));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// The window covers "did the turn get dispatched at all", not how fast it was:
// the FIRST turn of an openai-compat provider may include the lazy /responses
// probe (bounded at 2.5s by capability/transport-probe.ts), which these fixtures
// reach with an unreachable base URL.
async function withTimeout<T>(promise: Promise<T>, label: string, ms = 6_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("background task spawn concurrency", () => {
  it("keeps spawning detached background tasks while an earlier one hangs", async () => {
    const provider = await prisma.provider.create({
      data: { name: "bgc-provider", kind: "openai-compat", baseUrl: "https://api.example.test", apiKey: "k", models: ["m"] },
    });
    const parent = await prisma.agent.create({
      data: { name: "bgc-parent", providerId: provider.id, model: "m" },
    });

    const hung = deferred<void>();
    const completed: string[] = [];
    const runtime: AgentRuntime = {
      async *query(opts) {
        yield { type: "sdk_message", payload: { type: "system", subtype: "init", session_id: opts.sessionId, model: opts.model } };
        if (opts.prompt.includes("HANG")) {
          hung.resolve(undefined);
          // Never resolves: this child is wedged for the rest of the test.
          await new Promise<never>(() => {});
          return;
        }
        completed.push(opts.sessionId);
        yield {
          type: "sdk_message",
          payload: { type: "assistant", session_id: opts.sessionId, message: { content: [{ type: "text", text: "done" }] } },
        };
        yield { type: "sdk_message", payload: { type: "result", subtype: "success", session_id: opts.sessionId } };
      },
    };

    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any, () => runtime);

    // 1) First background task wedges.
    const first = await withTimeout(
      sessions.spawnTaskSubagent(parent.id, "bg one", "HANG please", { background: true }),
      "spawn #1",
    );
    expect(first.background).toBe(true);
    await withTimeout(hung.promise, "first child actually started");

    // 2) + 3) Later spawns must still be created, tagged and broadcast even
    // though #1 is still live. This is the reported symptom's regression gate.
    const second = await withTimeout(
      sessions.spawnTaskSubagent(parent.id, "bg two", "do two", { background: true }),
      "spawn #2",
    );
    const third = await withTimeout(
      sessions.spawnTaskSubagent(parent.id, "bg three", "do three", { background: true }),
      "spawn #3",
    );

    const ids = [first.subagentId, second.subagentId, third.subagentId];
    expect(new Set(ids).size).toBe(3);

    const created = hub.broadcasts.filter((b) => b.type === "agent_created");
    expect(created).toHaveLength(3);
    for (const id of ids) {
      const row = await prisma.agent.findUnique({ where: { id } });
      expect(row).not.toBeNull();
      expect(agentRowToSummary(row!).subagentKind).toBe("background");
      expect(row!.parentId).toBe(parent.id);
    }

    // The two healthy siblings must actually run to completion — i.e. the hung
    // sibling neither queued nor starved them.
    await withTimeout(
      (async () => {
        while (completed.filter((id) => id !== parent.id).length < 2) {
          await new Promise((r) => setTimeout(r, 10));
        }
      })(),
      "siblings completed",
    );
    // The parent's own id can appear here: each settled child pushes a
    // `subagent-finished` notice turn to the (idle) parent, which runs through
    // this same stub runtime. The invariant is about the SIBLINGS.
    expect(completed.filter((id) => id !== parent.id).sort()).toEqual(
      [second.subagentId, third.subagentId].sort(),
    );
  });

  it("still spawns while the parent's own turn is in flight", async () => {
    const provider = await prisma.provider.create({
      data: { name: "bgc-provider-2", kind: "openai-compat", baseUrl: "https://api.example.test", apiKey: "k", models: ["m"] },
    });
    const parent = await prisma.agent.create({
      data: { name: "bgc-parent-2", providerId: provider.id, model: "m" },
    });

    const parentStarted = deferred<void>();
    const releaseParent = deferred<void>();
    const childDone = deferred<void>();
    const runtime: AgentRuntime = {
      async *query(opts) {
        yield { type: "sdk_message", payload: { type: "system", subtype: "init", session_id: opts.sessionId, model: opts.model } };
        if (opts.sessionId === parent.id) {
          parentStarted.resolve(undefined);
          await releaseParent.promise; // parent turn held open
        } else {
          childDone.resolve(undefined);
        }
        yield { type: "sdk_message", payload: { type: "result", subtype: "success", session_id: opts.sessionId } };
      },
    };

    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any, () => runtime);
    const parentTurn = sessions.sendMessage(parent.id, "parent work");
    await withTimeout(parentStarted.promise, "parent turn started");

    const child = await withTimeout(
      sessions.spawnTaskSubagent(parent.id, "bg child", "child work", { background: true }),
      "background spawn during parent turn",
    );
    expect(child.background).toBe(true);
    await withTimeout(childDone.promise, "child ran while parent turn was open");

    releaseParent.resolve(undefined);
    await withTimeout(parentTurn, "parent turn finished");
  });
});
