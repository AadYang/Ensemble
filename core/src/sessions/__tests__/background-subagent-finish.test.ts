// Terminal-state handoff for DETACHED subagents.
//
// Before this, a background subagent had nobody listening: the parent got
// `{background:true, subagentId}` and the child's death/completion was only
// visible in the sidebar. These tests pin the replacement contract:
//   • the parent gets a durable `system.background_subagent_finished` row, plus
//   • a real notice turn — run immediately when the parent is idle, queued (and
//     coalesced) when it is busy, never an interrupt, and
//   • exactly once per child, and nothing queued for a closed parent.

import { describe, it, expect, beforeAll } from "vitest";
import type { AgentRuntime } from "../runtimes/types.js";

// In-memory DB so the test never touches the user's real ~/.ensemble.
process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../../db.js").prisma;
let SessionManager: typeof import("../SessionManager.js").SessionManager;

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
  ({ SessionManager } = await import("../SessionManager.js"));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(check: () => Promise<boolean>, label: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    if (await check()) return;
    last = label;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${last}`);
}

const payloadOf = (m: { payload: unknown }) => m.payload as Record<string, unknown>;

const messagesOf = (agentId: string) =>
  prisma.message.findMany({ where: { agentId }, orderBy: { seq: "asc" } });

const finishedRecords = async (agentId: string) =>
  (await messagesOf(agentId)).filter((m) => payloadOf(m).subtype === "background_subagent_finished");

/** The model-facing notice turn persisted on the parent (a `user` message). */
const noticeTurns = async (agentId: string, needle = "<subagent-finished") =>
  (await messagesOf(agentId)).filter(
    (m) => payloadOf(m).type === "user" && String((payloadOf(m).message as { content?: unknown })?.content ?? "").includes(needle),
  );

const queuedFor = (agentId: string) => prisma.pendingTurn.findMany({ where: { agentId } });

async function makeParent(name: string, metadata: Record<string, unknown> = {}) {
  const provider = await prisma.provider.create({
    data: { name: `${name}-provider`, kind: "openai-compat", baseUrl: "https://api.example.test", apiKey: "k", models: ["m"] },
  });
  return await prisma.agent.create({ data: { name, providerId: provider.id, model: "m", metadata } });
}

/** Children fail when their prompt contains FAIL, otherwise succeed. */
function runtimeFor(hold?: { release: Promise<void>; onStart?: () => void }): AgentRuntime {
  return {
    async *query(opts) {
      yield { type: "sdk_message", payload: { type: "system", subtype: "init", session_id: opts.sessionId, model: opts.model } };
      hold?.onStart?.();
      if (hold) await hold.release;
      if (opts.prompt.includes("FAIL")) throw new Error("child blew up");
      yield {
        type: "sdk_message",
        payload: {
          type: "assistant",
          session_id: opts.sessionId,
          message: { content: [{ type: "text", text: `output for ${opts.prompt}` }] },
        },
      };
      yield { type: "sdk_message", payload: { type: "result", subtype: "success", session_id: opts.sessionId } };
    },
  };
}

describe("detached subagent terminal notification", () => {
  it("delivers a durable record plus a notice turn to an idle parent", async () => {
    const parent = await makeParent("finish-parent");
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any, () => runtimeFor());

    const child = await sessions.spawnTaskSubagent(parent.id, "bg audit", "FAIL please", { background: true });
    expect(child.background).toBe(true);

    await waitUntil(async () => (await finishedRecords(parent.id)).length > 0, "parent finished-record");

    const record = payloadOf((await finishedRecords(parent.id))[0]!);
    expect(record.status).toBe("ERROR");
    expect(record.subagent_id).toBe(child.subagentId);
    expect(record.description).toBe("bg audit");
    expect(String(record.text)).toContain("subagent failed");

    // The model-facing channel: an idle parent runs the notice as a real turn,
    // so the text lands in its own transcript.
    await waitUntil(async () => (await noticeTurns(parent.id)).length > 0, "notice turn on the parent");
    const noticeText = String(
      (payloadOf((await noticeTurns(parent.id))[0]!).message as { content: string }).content,
    );
    expect(noticeText).toContain("Status: ERROR");
    expect(noticeText).toContain("child blew up");
    expect(noticeText).toContain("Task(background=true)");

    // Marked settled so a later terminal can't re-notify.
    const childRow = await prisma.agent.findUnique({ where: { id: child.subagentId } });
    expect((childRow!.metadata as Record<string, unknown>).subagentTerminalNotified).toBe(true);
  });

  it("notifies exactly once even if the child runs again", async () => {
    const parent = await makeParent("once-parent");
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any, () => runtimeFor());

    const child = await sessions.spawnTaskSubagent(parent.id, "bg once", "FAIL once", { background: true });
    await waitUntil(async () => (await finishedRecords(parent.id)).length > 0, "first notification");

    // A second run of the same child (e.g. the user typing in its pane) must not
    // re-notify the parent.
    await sessions.sendMessage(child.subagentId, "FAIL again");
    await sleep(150);

    expect(await finishedRecords(parent.id)).toHaveLength(1);
  });

  it("queues and coalesces notices while the parent is busy, then delivers one turn", async () => {
    const parent = await makeParent("busy-parent");
    const hub = new StubHub();
    const parentStarted = deferred<void>();
    const release = deferred<void>();
    let holdFirst = true;
    const runtime: AgentRuntime = {
      async *query(opts) {
        yield { type: "sdk_message", payload: { type: "system", subtype: "init", session_id: opts.sessionId, model: opts.model } };
        if (opts.sessionId === parent.id && holdFirst) {
          holdFirst = false;
          parentStarted.resolve(undefined);
          await release.promise;
        }
        if (opts.prompt.includes("FAIL")) throw new Error("child blew up");
        yield { type: "sdk_message", payload: { type: "result", subtype: "success", session_id: opts.sessionId } };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any, () => runtime);

    const parentTurn = sessions.sendMessage(parent.id, "parent is working");
    await parentStarted.promise;

    await sessions.spawnTaskSubagent(parent.id, "bg one", "FAIL one", { background: true });
    await sessions.spawnTaskSubagent(parent.id, "bg two", "FAIL two", { background: true });

    // Both children settle while the parent is busy → ONE coalesced queued turn.
    await waitUntil(async () => {
      const queued = await queuedFor(parent.id);
      return queued.length > 0 && (queued[0]!.userInput.match(/<subagent-finished/g) ?? []).length === 2;
    }, `coalesced queued notice (queued=${(await queuedFor(parent.id)).length})`);
    expect(await queuedFor(parent.id)).toHaveLength(1);

    // The queue drains once the parent's turn ends, and delivers a single turn.
    release.resolve(undefined);
    await parentTurn;
    await sleep(300);
    expect(await queuedFor(parent.id)).toHaveLength(0);
    expect(await noticeTurns(parent.id)).toHaveLength(1);
  });

  it("tells the parent when a detached child is CANCELLED mid-run", async () => {
    const parent = await makeParent("cancel-parent");
    const hub = new StubHub();
    const childStarted = deferred<void>();
    const runtime: AgentRuntime = {
      async *query(opts) {
        yield { type: "sdk_message", payload: { type: "system", subtype: "init", session_id: opts.sessionId, model: opts.model } };
        if (opts.sessionId === parent.id) {
          yield { type: "sdk_message", payload: { type: "result", subtype: "success", session_id: opts.sessionId } };
          return;
        }
        childStarted.resolve(undefined);
        // Hold like a long-running child, then blow up when the run is cancelled.
        await new Promise<void>((resolve) => {
          if (opts.abortController.signal.aborted) return resolve();
          opts.abortController.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted by user");
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any, () => runtime);

    const child = await sessions.spawnTaskSubagent(parent.id, "bg cancel", "long work", { background: true });
    await childStarted.promise;
    // cancel() deletes the running entry synchronously, so a settlement that
    // lived inside the owner guard would never fire — the parent would be left
    // believing the child is still running forever.
    await sessions.cancel(child.subagentId);

    await waitUntil(async () => (await finishedRecords(parent.id)).length > 0, "cancel notice");
    const record = payloadOf((await finishedRecords(parent.id))[0]!);
    expect(record.status).toBe("IDLE");
    expect(String(record.text)).toContain("interrupted");
    expect(await noticeTurns(parent.id)).toHaveLength(1);
  });

  it("records the outcome but queues nothing for a closed parent", async () => {
    const parent = await makeParent("closed-parent", { closed: true });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any, () => runtimeFor());

    const child = await sessions.spawnTaskSubagent(parent.id, "bg closed", "FAIL closed", { background: true });
    await waitUntil(async () => (await finishedRecords(parent.id)).length > 0, "record for closed parent");

    expect(await queuedFor(parent.id)).toHaveLength(0);
    expect(await noticeTurns(parent.id)).toHaveLength(0);
    const childRow = await prisma.agent.findUnique({ where: { id: child.subagentId } });
    expect((childRow!.metadata as Record<string, unknown>).subagentTerminalNotified).toBe(true);
  });

  it("stays silent when the parent is hard-deleted mid-run", async () => {
    const parent = await makeParent("gone-parent");
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any, () => runtimeFor());

    const child = await sessions.spawnTaskSubagent(parent.id, "bg orphan", "FAIL orphan", { background: true });
    // Agent.parentId cascades, so a hard delete takes the child with it and
    // there is nobody left to notify (the child's own run then errors out on a
    // vanished row — pre-existing behaviour for a hard delete mid-run).
    await prisma.agent.delete({ where: { id: parent.id } });
    await sleep(250);

    expect(await prisma.agent.findUnique({ where: { id: child.subagentId } })).toBeNull();
    expect(await finishedRecords(parent.id)).toHaveLength(0);
  });
});
