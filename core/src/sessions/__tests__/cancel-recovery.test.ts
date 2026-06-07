// Regression tests for the "codex agent stuck in RUNNING forever" bug.
//
// Two paths needed fixing:
//
// 1. `cancel()` was a no-op on the DB — it only signalled the in-memory
//    AbortController and trusted sendMessage's finally block to flip the
//    DB row back to IDLE. When a wedged codex CLI kept its grandchild
//    MCP processes alive (Windows: duplicated stdio handles pin the
//    parent's pipes open even after TerminateProcess on the immediate
//    child), sendMessage stayed suspended on `await closePromise` for
//    hours and the agent was visibly "running" with no way to recover
//    short of restarting Ensemble. cancel() now force-resets the DB
//    state regardless of whether the runtime cleans up.
//
// 2. After a core process crash mid-turn, the Agent row stayed at
//    RUNNING / AWAITING_PERMISSION / AWAITING_USER_INPUT. With no
//    in-memory run to abort, the user had no way out — even a click on
//    Cancel did nothing (the old cancel() bailed when `this.running`
//    didn't have the id). `recoverStaleSessions()` now fires once at
//    startup and resets every such row to IDLE.

import { describe, it, expect, beforeAll } from "vitest";

// In-memory DB so the test doesn't touch the user's real ~/.ensemble.
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

describe("SessionManager cancel + stale-session recovery", () => {
  it("cancel() force-resets DB status to IDLE even when no in-memory run exists", async () => {
    // Simulate the wedge: an agent row is in RUNNING state but the in-memory
    // SessionManager has no live entry (e.g., after the runtime hung and
    // sendMessage's finally block never executed, then Ensemble was restarted).
    const agent = await prisma.agent.create({
      data: { name: "wedged-codex-agent" },
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "RUNNING" } });
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe("RUNNING");

    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);

    await sessions.cancel(agent.id);

    // The agent row must be IDLE again. Pre-fix: stayed RUNNING because cancel
    // bailed early on `if (r)` and never touched the DB.
    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(after?.status).toBe("IDLE");

    // The UI sync path runs through hub.broadcast — confirm the status flip
    // was actually announced so connected clients re-render.
    const updateEvent = hub.broadcasts.find(
      (b) => b.type === "agent_updated" && (b.agent as { id?: string })?.id === agent.id,
    );
    expect(updateEvent).toBeDefined();
    expect((updateEvent?.agent as { status?: string })?.status).toBe("idle");
  });

  it("recoverStaleSessions() flips every RUNNING/AWAITING_* agent back to IDLE", async () => {
    const a = await prisma.agent.create({ data: { name: "stale-running" } });
    const b = await prisma.agent.create({ data: { name: "stale-awaiting-perm" } });
    const c = await prisma.agent.create({ data: { name: "stale-awaiting-user" } });
    const d = await prisma.agent.create({ data: { name: "healthy-idle" } });
    await prisma.agent.update({ where: { id: a.id }, data: { status: "RUNNING" } });
    await prisma.agent.update({ where: { id: b.id }, data: { status: "AWAITING_PERMISSION" } });
    await prisma.agent.update({ where: { id: c.id }, data: { status: "AWAITING_USER_INPUT" } });
    // d stays IDLE — recoverStaleSessions must NOT touch healthy rows.

    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);

    await sessions.recoverStaleSessions();

    expect((await prisma.agent.findUnique({ where: { id: a.id } }))?.status).toBe("IDLE");
    expect((await prisma.agent.findUnique({ where: { id: b.id } }))?.status).toBe("IDLE");
    expect((await prisma.agent.findUnique({ where: { id: c.id } }))?.status).toBe("IDLE");
    expect((await prisma.agent.findUnique({ where: { id: d.id } }))?.status).toBe("IDLE");

    // Broadcasts: exactly one agent_updated per stale row, none for the healthy one.
    const updatedIds = hub.broadcasts
      .filter((br) => br.type === "agent_updated")
      .map((br) => (br.agent as { id?: string })?.id);
    expect(updatedIds).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    expect(updatedIds).not.toContain(d.id);
  });

  it("runtime timeout force-stops only the matching run", async () => {
    const stuck = await prisma.agent.create({ data: { name: "bad-provider-agent" } });
    const other = await prisma.agent.create({ data: { name: "other-agent" } });
    await prisma.agent.update({ where: { id: stuck.id }, data: { status: "RUNNING" } });
    await prisma.agent.update({ where: { id: other.id }, data: { status: "RUNNING" } });

    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(stuck.id, {
      id: stuck.id,
      runId: "run-a",
      abort,
      seq: 0,
      autoAllowedTools: new Set<string>(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sessions as any).forceStopRun(stuck.id, {
      expectedRunId: "run-a",
      dbStatus: "ERROR",
      protoStatus: "error",
      logPrefix: "test-timeout",
      error: { code: "PROVIDER_TIMEOUT", message: "provider timed out" },
    });

    expect(abort.signal.aborted).toBe(true);
    expect((await prisma.agent.findUnique({ where: { id: stuck.id } }))?.status).toBe("ERROR");
    expect((await prisma.agent.findUnique({ where: { id: other.id } }))?.status).toBe("RUNNING");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).running.has(stuck.id)).toBe(false);
    expect(hub.sessionMessages.some((m) => m.sessionId === stuck.id && m.msg.code === "PROVIDER_TIMEOUT")).toBe(true);
  });

  it("runtime idle completion force-stops only the matching run as DONE", async () => {
    const stuck = await prisma.agent.create({ data: { name: "finished-but-open-stream" } });
    const other = await prisma.agent.create({ data: { name: "other-running-agent" } });
    await prisma.agent.update({ where: { id: stuck.id }, data: { status: "RUNNING" } });
    await prisma.agent.update({ where: { id: other.id }, data: { status: "RUNNING" } });

    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(stuck.id, {
      id: stuck.id,
      runId: "run-done",
      abort,
      seq: 0,
      autoAllowedTools: new Set<string>(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sessions as any).forceStopRun(stuck.id, {
      expectedRunId: "run-done",
      dbStatus: "DONE",
      protoStatus: "done",
      logPrefix: "test-idle-done",
    });

    expect(abort.signal.aborted).toBe(true);
    expect((await prisma.agent.findUnique({ where: { id: stuck.id } }))?.status).toBe("DONE");
    expect((await prisma.agent.findUnique({ where: { id: other.id } }))?.status).toBe("RUNNING");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).running.has(stuck.id)).toBe(false);
    expect(hub.sessionMessages.some((m) => m.sessionId === stuck.id && m.msg.status === "done")).toBe(true);
  });

  it("sendMessage recovers from provider validation errors after entering RUNNING", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "missing-key-provider",
        kind: "openai-compat",
        baseUrl: "https://api.example.test",
        apiKey: null,
        models: ["example-model"],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "bad-provider-agent",
        providerId: provider.id,
        model: "example-model",
      },
    });

    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);

    const result = await sessions.sendMessage(agent.id, "hello");

    expect(result).toBeNull();
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe("ERROR");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).running.has(agent.id)).toBe(false);
    const statusBroadcasts = hub.broadcasts
      .filter((b) => b.type === "agent_updated" && (b.agent as { id?: string })?.id === agent.id)
      .map((b) => (b.agent as { status?: string })?.status);
    expect(statusBroadcasts).toEqual(expect.arrayContaining(["running", "error"]));
    expect(
      hub.sessionMessages.some(
        (m) =>
          m.sessionId === agent.id &&
          m.msg.code === "QUERY_FAILED" &&
          String(m.msg.message).includes("missing an API key"),
      ),
    ).toBe(true);
  });
});
