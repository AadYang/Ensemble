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
let isResumeScopedStreamFailure: typeof import("../SessionManager.js").isResumeScopedStreamFailure;
let isRuntimeResumeRecoverySignal: typeof import("../SessionManager.js").isRuntimeResumeRecoverySignal;
let runtimeHistoryFromCompletedTurns: typeof import("../SessionManager.js").runtimeHistoryFromCompletedTurns;

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
  ({ SessionManager, isResumeScopedStreamFailure, isRuntimeResumeRecoverySignal, runtimeHistoryFromCompletedTurns } = await import("../SessionManager.js"));
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

  it("runtime force-stop only affects the matching run", async () => {
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
      userInput: "run a request",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sessions as any).forceStopRun(stuck.id, {
      expectedRunId: "run-a",
      dbStatus: "ERROR",
      protoStatus: "error",
      logPrefix: "test-force-stop",
      error: { code: "RUNTIME_STOPPED", message: "runtime stopped" },
    });

    expect(abort.signal.aborted).toBe(true);
    expect((await prisma.agent.findUnique({ where: { id: stuck.id } }))?.status).toBe("ERROR");
    expect((await prisma.agent.findUnique({ where: { id: other.id } }))?.status).toBe("RUNNING");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).running.has(stuck.id)).toBe(false);
    expect(hub.sessionMessages.some((m) => m.sessionId === stuck.id && m.msg.code === "RUNTIME_STOPPED")).toBe(true);
  });

  it("runtime idle timeout aborts the active run and reports ERROR", async () => {
    const agent = await prisma.agent.create({ data: { name: "idle-timeout-agent" } });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "RUNNING" } });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "finish idle task" } },
      },
    });

    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(agent.id, {
      id: agent.id,
      runId: "run-timeout",
      abort,
      seq: 1,
      userInput: "finish idle task",
      startedSeq: 0,
      userMessageSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).recordLiveTranscript(agent.id, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial idle work" } },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stopped = await (sessions as any).handleRuntimeIdleTimeout(agent.id, "run-timeout", 1_000);

    expect(stopped).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe("ERROR");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).running.has(agent.id)).toBe(false);
    expect(
      hub.sessionMessages.some(
        (m) =>
          m.sessionId === agent.id &&
          m.msg.type === "error" &&
          m.msg.code === "RUNTIME_IDLE_TIMEOUT" &&
          String(m.msg.message).includes("automatically stopped this turn"),
      ),
    ).toBe(true);
    const interrupted = await prisma.message.findFirst({
      where: { agentId: agent.id, type: "system" },
      orderBy: { seq: "desc" },
    });
    expect(JSON.stringify(interrupted?.payload)).toContain("interrupted_turn");
    expect(JSON.stringify(interrupted?.payload)).toContain("finish idle task");
    expect(JSON.stringify(interrupted?.payload)).toContain("partial idle work");
    expect(
      hub.sessionMessages.some(
        (m) => m.sessionId === agent.id && m.msg.type === "status" && m.msg.status === "error",
      ),
    ).toBe(true);
  });

  it("runtime idle timeout ignores a stale run id after a new run owns the session", async () => {
    const agent = await prisma.agent.create({ data: { name: "idle-timeout-stale-run" } });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "RUNNING" } });

    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(agent.id, {
      id: agent.id,
      runId: "new-run",
      abort,
      seq: 0,
      userInput: "new active request",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stopped = await (sessions as any).handleRuntimeIdleTimeout(agent.id, "old-run", 1_000);

    expect(stopped).toBe(false);
    expect(abort.signal.aborted).toBe(false);
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe("RUNNING");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).running.get(agent.id)?.runId).toBe("new-run");
    expect(hub.sessionMessages.some((m) => m.sessionId === agent.id && m.msg.code === "RUNTIME_IDLE_TIMEOUT")).toBe(false);
  });

  it("cancel persists interrupted_turn so continue can recover the active request", async () => {
    const agent = await prisma.agent.create({ data: { name: "cancel-interrupted-agent" } });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "RUNNING" } });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "implement feature after disconnect" } },
      },
    });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(agent.id, {
      id: agent.id,
      runId: "run-cancel-interrupt",
      abort,
      seq: 1,
      userInput: "implement feature after disconnect",
      startedSeq: 0,
      userMessageSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).recordLiveTranscript(agent.id, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "I changed file A and was about to test" } },
    });

    await sessions.cancel(agent.id);

    const systemRows = await prisma.message.findMany({ where: { agentId: agent.id, type: "system" } });
    expect(systemRows).toHaveLength(1);
    const payloadText = JSON.stringify(systemRows[0]!.payload);
    expect(payloadText).toContain("interrupted_turn");
    expect(payloadText).toContain("implement feature after disconnect");
    expect(payloadText).toContain("I changed file A");

    const history = runtimeHistoryFromCompletedTurns(
      await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } }),
    );
    const historyText = JSON.stringify(history);
    expect(historyText).toContain("Previous Ensemble turn was interrupted");
    expect(historyText).toContain("implement feature after disconnect");
    expect(historyText).toContain("continue that interrupted request");
  });

  it("sendMessage queues input while the agent is already running", async () => {
    const agent = await prisma.agent.create({ data: { name: "queue-target" } });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(agent.id, {
      id: agent.id,
      runId: "run-active",
      abort,
      seq: 0,
      userInput: "active request",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    const queued = sessions.sendMessage(agent.id, "queued while running");

    await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).queuedTurns.get(agent.id).size).toBe(1);
    expect(await prisma.pendingTurn.count({ where: { agentId: agent.id } })).toBe(1);
    expect(hub.sessionMessages.some((m) => m.sessionId === agent.id && m.msg.code === "BUSY")).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).clearQueuedTurns(agent.id);
    await expect(queued).resolves.toBeNull();
  });

  it("cancel() aborts the active run but keeps queued input for the next turn", async () => {
    const agent = await prisma.agent.create({ data: { name: "cancel-queue-target" } });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "RUNNING" } });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(agent.id, {
      id: agent.id,
      runId: "run-active",
      abort,
      seq: 0,
      userInput: "active request",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    const queued = sessions.sendMessage(agent.id, "queued after cancel");
    await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).queuedTurns.get(agent.id).size).toBe(1);
    expect(await prisma.pendingTurn.count({ where: { agentId: agent.id } })).toBe(1);
    let drained: { sessionId: string; text: string } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).runMessageNow = async (sessionId: string, text: string) => {
      drained = { sessionId, text };
      return null;
    };

    await sessions.cancel(agent.id);

    expect(abort.signal.aborted).toBe(true);
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe("IDLE");
    await expect(queued).resolves.toBeNull();
    expect(drained).toEqual({ sessionId: agent.id, text: "queued after cancel" });
    expect(await prisma.pendingTurn.count({ where: { agentId: agent.id } })).toBe(0);
  });

  it("runtime force-stop releases the execution slot and drains queued input", async () => {
    const agent = await prisma.agent.create({ data: { name: "force-stop-queue-target" } });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "RUNNING" } });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(agent.id, {
      id: agent.id,
      runId: "run-active",
      abort,
      seq: 0,
      userInput: "active request",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });
    // Simulate the outer sendMessage call still awaiting a wedged runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).drainingQueues.set(agent.id, "outer-run");

    const queued = sessions.sendMessage(agent.id, "queued after timeout");
    await Promise.resolve();
    expect(await prisma.pendingTurn.count({ where: { agentId: agent.id } })).toBe(1);
    let drained: { sessionId: string; text: string } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).runMessageNow = async (sessionId: string, text: string) => {
      drained = { sessionId, text };
      return null;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sessions as any).forceStopRun(agent.id, {
      expectedRunId: "run-active",
      dbStatus: "ERROR",
      protoStatus: "error",
      logPrefix: "test-force-stop",
      error: { code: "RUNTIME_STOPPED", message: "runtime stopped" },
    });

    expect(abort.signal.aborted).toBe(true);
    expect(drained).toEqual({ sessionId: agent.id, text: "queued after timeout" });
    await expect(queued).resolves.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).drainingQueues.has(agent.id)).toBe(false);
    expect(await prisma.pendingTurn.count({ where: { agentId: agent.id } })).toBe(0);
  });

  it("peer_send queues for a running target instead of failing busy", async () => {
    const source = await prisma.agent.create({ data: { name: "queue-source" } });
    const target = await prisma.agent.create({ data: { name: "queue-peer" } });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(target.id, {
      id: target.id,
      runId: "run-peer",
      abort,
      seq: 0,
      userInput: "target is busy",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    const result = await sessions.sendPeerMessage(source.id, target.name, "please continue", "raw");

    expect(result).toContain("queued for");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sessions as any).queuedTurns.get(target.id).size).toBe(1);
    expect(await prisma.pendingTurn.count({ where: { agentId: target.id } })).toBe(1);
    expect(result).not.toContain("busy");
  });

  it("peer_send embeds running source live output instead of stale completed assistant text", async () => {
    const source = await prisma.agent.create({ data: { name: "running-source" } });
    const target = await prisma.agent.create({ data: { name: "snapshot-target-running" } });
    await prisma.message.create({
      data: {
        agentId: source.id,
        seq: 0,
        type: "assistant",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "old completed answer" }] } },
      },
    });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(source.id, {
      id: source.id,
      runId: "source-run",
      abort,
      seq: 1,
      userInput: "current source request",
      startedSeq: 1,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(target.id, {
      id: target.id,
      runId: "target-busy",
      abort: new AbortController(),
      seq: 0,
      userInput: "target busy",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).recordLiveTranscript(source.id, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "live source output" } },
    });

    const result = await sessions.sendPeerMessage(source.id, target.name, "review latest", "review");
    await Promise.resolve();

    expect(result).toContain("queued for");
    const queued = await prisma.pendingTurn.findFirst({ where: { agentId: target.id } });
    const text = queued?.userInput ?? "";
    expect(text).toContain("Source state: running");
    expect(text).toContain("current source request");
    expect(text).toContain("live source output");
    expect(text).not.toContain("old completed answer");
  });

  it("peer_send embeds interrupted source context after timeout instead of older output", async () => {
    const source = await prisma.agent.create({ data: { name: "interrupted-source" } });
    const target = await prisma.agent.create({ data: { name: "snapshot-target-interrupted" } });
    await prisma.message.create({
      data: {
        agentId: source.id,
        seq: 0,
        type: "assistant",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "older completed output" }] } },
      },
    });
    await prisma.message.create({
      data: {
        agentId: source.id,
        seq: 1,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "interrupted source request" } },
      },
    });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(source.id, {
      id: source.id,
      runId: "source-timeout",
      abort,
      seq: 2,
      userInput: "interrupted source request",
      startedSeq: 1,
      userMessageSeq: 1,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).recordLiveTranscript(source.id, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial interrupted output" } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sessions as any).handleRuntimeIdleTimeout(source.id, "source-timeout", 1_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(target.id, {
      id: target.id,
      runId: "target-busy",
      abort: new AbortController(),
      seq: 0,
      userInput: "target busy",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    await sessions.sendPeerMessage(source.id, target.name, "continue latest", "continue");
    await Promise.resolve();

    const queued = await prisma.pendingTurn.findFirst({ where: { agentId: target.id } });
    const text = queued?.userInput ?? "";
    expect(text).toContain("Source state: interrupted");
    expect(text).toContain("interrupted source request");
    expect(text).toContain("partial interrupted output");
    expect(text).not.toContain("older completed output");
  });

  it("peer_send uses newer completed output instead of older interrupted context", async () => {
    const source = await prisma.agent.create({ data: { name: "resolved-source" } });
    const target = await prisma.agent.create({ data: { name: "resolved-target" } });
    await prisma.message.create({
      data: {
        agentId: source.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "old interrupted request" } },
      },
    });
    await prisma.message.create({
      data: {
        agentId: source.id,
        seq: 1,
        type: "system",
        payload: {
          type: "system",
          subtype: "interrupted_turn",
          reason: "cancelled",
          runId: "old-run",
          userSeq: 0,
          userRequest: "old interrupted request",
          partialAssistantText: "old interrupted partial",
          interruptedAt: new Date().toISOString(),
        },
      },
    });
    await prisma.message.create({
      data: {
        agentId: source.id,
        seq: 2,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "new completed request" } },
      },
    });
    await prisma.message.create({
      data: {
        agentId: source.id,
        seq: 3,
        type: "assistant",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "new completed output" }] } },
      },
    });
    await prisma.message.create({
      data: {
        agentId: source.id,
        seq: 4,
        type: "result",
        payload: { type: "result", subtype: "success" },
      },
    });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(target.id, {
      id: target.id,
      runId: "target-busy",
      abort: new AbortController(),
      seq: 0,
      userInput: "target busy",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    await sessions.sendPeerMessage(source.id, target.name, "review latest", "review");
    await Promise.resolve();

    const queued = await prisma.pendingTurn.findFirst({ where: { agentId: target.id } });
    const text = queued?.userInput ?? "";
    expect(text).toContain("Source state: completed");
    expect(text).toContain("new completed output");
    expect(text).not.toContain("old interrupted partial");
  });

  it("peer_send reports running source with no live output instead of falling back to old context", async () => {
    const source = await prisma.agent.create({ data: { name: "running-no-live-source" } });
    const target = await prisma.agent.create({ data: { name: "running-no-live-target" } });
    await prisma.message.create({
      data: {
        agentId: source.id,
        seq: 0,
        type: "assistant",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "stale completed output" }] } },
      },
    });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(source.id, {
      id: source.id,
      runId: "source-running-no-live",
      abort: new AbortController(),
      seq: 1,
      userInput: "brand new request before first token",
      startedSeq: 1,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(target.id, {
      id: target.id,
      runId: "target-busy",
      abort: new AbortController(),
      seq: 0,
      userInput: "target busy",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    await sessions.sendPeerMessage(source.id, target.name, "review latest", "review");
    await Promise.resolve();

    const queued = await prisma.pendingTurn.findFirst({ where: { agentId: target.id } });
    const text = queued?.userInput ?? "";
    expect(text).toContain("Source state: running");
    expect(text).toContain("brand new request before first token");
    expect(text).toContain("(none yet)");
    expect(text).not.toContain("stale completed output");
  });

  it("peer_query includes live assistant output from a running target", async () => {
    const source = await prisma.agent.create({ data: { name: "observer" } });
    const target = await prisma.agent.create({ data: { name: "visible-peer" } });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).recordLiveTranscript(target.id, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "live progress" },
      },
    });

    const history = await sessions.fetchPeerHistory(source.id, target.name, 5);

    expect(history).toContain("target is currently running");
    expect(history).toContain("live progress");
  });

  it("classifies websocket disconnects as resume-scoped recovery only when resume was used", () => {
    const msg =
      "Reconnecting... 2/5 (stream disconnected before completion: failed to send websocket request: " +
      "IO error: software on your host aborted an established connection. (os error 10053))";

    expect(isResumeScopedStreamFailure(msg, "codex-thread-id")).toBe(true);
    expect(isResumeScopedStreamFailure(msg, null)).toBe(false);
    expect(isResumeScopedStreamFailure("provider is missing an API key", "codex-thread-id")).toBe(false);
  });

  it("classifies structured runtime resume interruption without parsing provider text", () => {
    expect(isRuntimeResumeRecoverySignal("RESUME_TURN_INTERRUPTED", true, true, "codex-thread-id")).toBe(true);
    expect(isRuntimeResumeRecoverySignal("RESUME_TURN_INTERRUPTED", true, true, null)).toBe(false);
    expect(isRuntimeResumeRecoverySignal("RESUME_TURN_INTERRUPTED", false, true, "codex-thread-id")).toBe(false);
    expect(isRuntimeResumeRecoverySignal("QUERY_FAILED", true, true, "codex-thread-id")).toBe(false);
  });

  it("cancel() clears Codex native resume metadata for the aborted run", async () => {
    const provider = await prisma.provider.create({
      data: { name: "cancel-codex-provider", kind: "openai-codex", models: ["gpt-5.5"] },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "cancel-codex-agent",
        providerId: provider.id,
        model: "gpt-5.5",
        metadata: {
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "runtime-shape",
        },
      },
    });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);
    const abort = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).running.set(agent.id, {
      id: agent.id,
      runId: "run-codex",
      abort,
      seq: 0,
      userInput: "codex request",
      startedSeq: 0,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
      clearResumeOnAbort: true,
    });

    await sessions.cancel(agent.id);

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(after?.status).toBe("IDLE");
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
  });

  it("Codex history reconstruction drops an unfinished trailing user turn", () => {
    const history = runtimeHistoryFromCompletedTurns([
      { type: "user", payload: { type: "user", message: { content: "A" } } },
      { type: "assistant", payload: { type: "assistant", message: { content: [{ type: "text", text: "done A" }] } } },
      { type: "result", payload: { type: "result", subtype: "success" } },
      { type: "user", payload: { type: "user", message: { content: "B cancelled" } } },
    ]);

    expect(history.map((m) => m.type)).toEqual(["user", "assistant"]);
    expect(String((history[0] as { message?: { content?: unknown } }).message?.content)).toBe("A");
    expect(JSON.stringify(history)).not.toContain("B cancelled");
  });

  it("patchAgent clears native resume metadata when the model changes", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "codex-model-change-provider",
        kind: "openai-codex",
        models: ["gpt-5.4", "gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "codex-model-change-agent",
        providerId: provider.id,
        model: "gpt-5.4",
        metadata: {
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "old-runtime-shape",
        },
      },
    });
    const hub = new StubHub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = new SessionManager(hub as any);

    await sessions.patchAgent(agent.id, { model: "gpt-5.5" });

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(after?.model).toBe("gpt-5.5");
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
  });

  it("patchAgent preserves permissionMode while clearing resume metadata for model+permission changes", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "codex-model-permission-change-provider",
        kind: "openai-codex",
        models: ["gpt-5.4", "gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "codex-model-permission-change-agent",
        providerId: provider.id,
        model: "gpt-5.4",
        metadata: {
          permissionMode: "default",
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "old-runtime-shape",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { model: "gpt-5.5", permissionMode: "plan" });

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(after?.model).toBe("gpt-5.5");
    expect(meta.permissionMode).toBe("plan");
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
  });

  it("patchAgent clears resume metadata for provider-only changes", async () => {
    const sourceProvider = await prisma.provider.create({
      data: {
        name: "provider-only-source",
        kind: "openai-codex",
        models: ["gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const targetProvider = await prisma.provider.create({
      data: {
        name: "provider-only-target",
        kind: "openai-codex",
        models: ["gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "provider-only-change-agent",
        providerId: sourceProvider.id,
        model: "gpt-5.5",
        metadata: {
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "old-runtime-shape",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { providerId: targetProvider.id });

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(after?.providerId).toBe(targetProvider.id);
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
  });

  it("patchAgent preserves permissionMode while clearing resume metadata for provider+permission changes", async () => {
    const sourceProvider = await prisma.provider.create({
      data: {
        name: "provider-permission-source",
        kind: "openai-codex",
        models: ["gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const targetProvider = await prisma.provider.create({
      data: {
        name: "provider-permission-target",
        kind: "openai-codex",
        models: ["gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "provider-permission-change-agent",
        providerId: sourceProvider.id,
        model: "gpt-5.5",
        metadata: {
          permissionMode: "default",
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "old-runtime-shape",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { providerId: targetProvider.id, permissionMode: "bypassPermissions" });

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(after?.providerId).toBe(targetProvider.id);
    expect(meta.permissionMode).toBe("bypassPermissions");
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
  });

  it("patchAgent clears resume metadata for permissionMode-only changes", async () => {
    const agent = await prisma.agent.create({
      data: {
        name: "permission-only-change-agent",
        metadata: {
          permissionMode: "default",
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "old-runtime-shape",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { permissionMode: "dontAsk" });

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(meta.permissionMode).toBe("dontAsk");
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
  });

  it("patchAgent preserves reasoning effort while clearing resume metadata for systemPrompt+reasoning changes", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "system-reasoning-provider",
        kind: "openai-codex",
        models: ["gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "system-reasoning-change-agent",
        providerId: provider.id,
        model: "gpt-5.5",
        systemPrompt: "old role",
        metadata: {
          reasoningEffort: "low",
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "old-runtime-shape",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { systemPrompt: "new role", reasoningEffort: "max" });

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(after?.systemPrompt).toBe("new role");
    expect(meta.reasoningEffort).toBe("max");
    expect(meta.lastSessionId).toBeUndefined();
    expect(meta.codexUsageSnapshot).toBeUndefined();
    expect(meta.codexResumeSignature).toBeUndefined();
  });

  it("deleteTeam clears resume metadata for all former members while preserving local settings", async () => {
    const team = await prisma.team.create({
      data: { name: "delete-team-resume", description: "mission before delete" },
    });
    const teamId = team.id;
    const provider = await prisma.provider.create({
      data: {
        name: "delete-team-provider",
        kind: "openai-codex",
        models: ["gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const first = await prisma.agent.create({
      data: {
        name: "delete-team-first",
        teamId,
        providerId: provider.id,
        model: "gpt-5.5",
        metadata: {
          permissionMode: "plan",
          reasoningEffort: "max",
          sandboxMode: "workspace-write",
          lastSessionId: "first-native-session",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "first-runtime-shape",
        },
      },
    });
    const second = await prisma.agent.create({
      data: {
        name: "delete-team-second",
        teamId,
        providerId: provider.id,
        model: "gpt-5.5",
        metadata: {
          permissionMode: "dontAsk",
          reasoningEffort: "xhigh",
          sandboxMode: "danger-full-access",
          lastSessionId: "second-native-session",
          codexUsageSnapshot: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
          codexResumeSignature: "second-runtime-shape",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.deleteTeam(teamId);

    for (const [agentId, expected] of [
      [first.id, { permissionMode: "plan", reasoningEffort: "max", sandboxMode: "workspace-write" }],
      [second.id, { permissionMode: "dontAsk", reasoningEffort: "xhigh", sandboxMode: "danger-full-access" }],
    ] as const) {
      const after = await prisma.agent.findUnique({ where: { id: agentId } });
      const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
      expect(after?.teamId).toBeNull();
      expect(meta.lastSessionId).toBeUndefined();
      expect(meta.codexUsageSnapshot).toBeUndefined();
      expect(meta.codexResumeSignature).toBeUndefined();
      expect(meta.permissionMode).toBe(expected.permissionMode);
      expect(meta.reasoningEffort).toBe(expected.reasoningEffort);
      expect(meta.sandboxMode).toBe(expected.sandboxMode);
    }
  });

  it("patchAgent name change clears resume metadata for self and teammates while preserving local settings", async () => {
    const team = await prisma.team.create({
      data: { name: "rename-team-resume", description: "mission before rename" },
    });
    const teamId = team.id;
    const provider = await prisma.provider.create({
      data: {
        name: "rename-team-provider",
        kind: "openai-codex",
        models: ["gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const renamed = await prisma.agent.create({
      data: {
        name: "old teammate name",
        teamId,
        providerId: provider.id,
        model: "gpt-5.5",
        metadata: {
          permissionMode: "acceptEdits",
          reasoningEffort: "high",
          sandboxMode: "workspace-write",
          lastSessionId: "renamed-native-session",
          codexUsageSnapshot: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          codexResumeSignature: "renamed-runtime-shape",
        },
      },
    });
    const teammate = await prisma.agent.create({
      data: {
        name: "observer teammate",
        teamId,
        providerId: provider.id,
        model: "gpt-5.5",
        metadata: {
          permissionMode: "plan",
          reasoningEffort: "max",
          sandboxMode: "danger-full-access",
          lastSessionId: "teammate-native-session",
          codexUsageSnapshot: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
          codexResumeSignature: "teammate-runtime-shape",
        },
      },
    });
    const outside = await prisma.agent.create({
      data: {
        name: "outside team",
        providerId: provider.id,
        model: "gpt-5.5",
        metadata: {
          lastSessionId: "outside-native-session",
          codexUsageSnapshot: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 },
          codexResumeSignature: "outside-runtime-shape",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(renamed.id, { name: "new teammate name" });

    const renamedAfter = await prisma.agent.findUnique({ where: { id: renamed.id } });
    const renamedMeta = (renamedAfter?.metadata && typeof renamedAfter.metadata === "object" ? renamedAfter.metadata : {}) as Record<string, unknown>;
    expect(renamedAfter?.name).toBe("new teammate name");
    expect(renamedMeta.lastSessionId).toBeUndefined();
    expect(renamedMeta.codexUsageSnapshot).toBeUndefined();
    expect(renamedMeta.codexResumeSignature).toBeUndefined();
    expect(renamedMeta.permissionMode).toBe("acceptEdits");
    expect(renamedMeta.reasoningEffort).toBe("high");
    expect(renamedMeta.sandboxMode).toBe("workspace-write");

    const teammateAfter = await prisma.agent.findUnique({ where: { id: teammate.id } });
    const teammateMeta = (teammateAfter?.metadata && typeof teammateAfter.metadata === "object" ? teammateAfter.metadata : {}) as Record<string, unknown>;
    expect(teammateMeta.lastSessionId).toBeUndefined();
    expect(teammateMeta.codexUsageSnapshot).toBeUndefined();
    expect(teammateMeta.codexResumeSignature).toBeUndefined();
    expect(teammateMeta.permissionMode).toBe("plan");
    expect(teammateMeta.reasoningEffort).toBe("max");
    expect(teammateMeta.sandboxMode).toBe("danger-full-access");

    const outsideAfter = await prisma.agent.findUnique({ where: { id: outside.id } });
    const outsideMeta = (outsideAfter?.metadata && typeof outsideAfter.metadata === "object" ? outsideAfter.metadata : {}) as Record<string, unknown>;
    expect(outsideMeta.lastSessionId).toBe("outside-native-session");
    expect(outsideMeta.codexResumeSignature).toBe("outside-runtime-shape");
  });

  it("patchAgent provider switch preserves explicit model and supported reasoning effort", async () => {
    const sourceProvider = await prisma.provider.create({
      data: {
        name: "codex-provider-preserve-source",
        kind: "openai-codex",
        models: ["gpt-5.5"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const targetProvider = await prisma.provider.create({
      data: {
        name: "codex-provider-preserve-target",
        kind: "openai-codex",
        models: ["gpt-5.6"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "provider-switch-preserve-agent",
        providerId: sourceProvider.id,
        model: "user-explicit-model",
        metadata: { reasoningEffort: "max" },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { providerId: targetProvider.id });

    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<string, unknown>;
    expect(after?.providerId).toBe(targetProvider.id);
    expect(after?.model).toBe("user-explicit-model");
    expect(meta.reasoningEffort).toBe("max");
  });

  it("recoverStaleSessions drains persisted pending turns after resetting stale state", async () => {
    const agent = await prisma.agent.create({ data: { name: "persisted-queue-agent" } });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "RUNNING" } });
    await prisma.pendingTurn.create({
      data: { agentId: agent.id, userInput: "persisted queued input", opts: {} },
    });
    const sessions = new SessionManager(new StubHub() as never);
    let drained: { sessionId: string; text: string } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sessions as any).runMessageNow = async (sessionId: string, text: string) => {
      drained = { sessionId, text };
      return null;
    };

    await sessions.recoverStaleSessions();
    await Promise.resolve();

    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.status).toBe("IDLE");
    expect(drained).toEqual({ sessionId: agent.id, text: "persisted queued input" });
    expect(await prisma.pendingTurn.count({ where: { agentId: agent.id } })).toBe(0);
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

  it("keeps compact summaries in runtime history and drops incomplete trailing user turns", () => {
    const history = runtimeHistoryFromCompletedTurns([
      {
        type: "system",
        payload: { type: "system", subtype: "compact", text: "important compact summary" },
      },
      {
        type: "user",
        payload: { type: "user", message: { role: "user", content: "old question" } },
      },
      {
        type: "assistant",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "old answer" }] } },
      },
      {
        type: "result",
        payload: { type: "result", subtype: "success" },
      },
      {
        type: "user",
        payload: { type: "user", message: { role: "user", content: "incomplete current prompt" } },
      },
    ]);

    expect(JSON.stringify(history)).toContain("important compact summary");
    expect(JSON.stringify(history)).toContain("old answer");
    expect(JSON.stringify(history)).not.toContain("incomplete current prompt");
  });

  it("keeps latest interrupted_turn alongside compact summary under long history budget", () => {
    const rows: Array<{ type: string; payload: unknown; seq?: number }> = [
      {
        type: "system",
        seq: 0,
        payload: { type: "system", subtype: "compact", text: "critical compact summary" },
      },
    ];
    for (let i = 1; i <= 70; i++) {
      rows.push({
        type: i % 2 === 0 ? "assistant" : "user",
        seq: i,
        payload:
          i % 2 === 0
            ? { type: "assistant", message: { content: [{ type: "text", text: `answer ${i} ${"a".repeat(900)}` }] } }
            : { type: "user", message: { role: "user", content: `question ${i} ${"q".repeat(900)}` } },
      });
    }
    rows.push({
      type: "user",
      seq: 71,
      payload: { type: "user", message: { role: "user", content: "latest interrupted request" } },
    });
    rows.push({
      type: "system",
      seq: 72,
      payload: {
        type: "system",
        subtype: "interrupted_turn",
        reason: "RUNTIME_IDLE_TIMEOUT",
        runId: "run-budget",
        userSeq: 71,
        userRequest: "latest interrupted request",
        partialAssistantText: "important partial output",
        interruptedAt: new Date().toISOString(),
      },
    });

    const history = runtimeHistoryFromCompletedTurns(rows);
    const text = JSON.stringify(history);

    expect(text).toContain("critical compact summary");
    expect(text).toContain("latest interrupted request");
    expect(text).toContain("important partial output");
    expect(text).not.toContain("question 1");
    expect(text.length).toBeLessThan(25_000);
  });

  it("does not keep interrupted_turn as current resume target after a later result resolves it", () => {
    const history = runtimeHistoryFromCompletedTurns([
      {
        type: "user",
        seq: 0,
        payload: { type: "user", message: { role: "user", content: "interrupted request" } },
      },
      {
        type: "system",
        seq: 1,
        payload: {
          type: "system",
          subtype: "interrupted_turn",
          reason: "cancelled",
          runId: "resolved-run",
          userSeq: 0,
          userRequest: "interrupted request",
          partialAssistantText: "old partial",
          interruptedAt: new Date().toISOString(),
        },
      },
      {
        type: "user",
        seq: 2,
        payload: { type: "user", message: { role: "user", content: "continue resolved request" } },
      },
      {
        type: "assistant",
        seq: 3,
        payload: { type: "assistant", message: { content: [{ type: "text", text: "resolved answer" }] } },
      },
      {
        type: "result",
        seq: 4,
        payload: { type: "result", subtype: "success" },
      },
    ]);

    const text = JSON.stringify(history);
    expect(text).toContain("resolved answer");
    expect(text).not.toContain("Previous Ensemble turn was interrupted");
    expect(text).not.toContain("old partial");
  });

  it("caps runtime history to precise recent context instead of full transcript", () => {
    const rows: Array<{ type: string; payload: unknown }> = Array.from({ length: 80 }, (_, i) => ({
      type: i % 2 === 0 ? "user" : "assistant",
      payload:
        i % 2 === 0
          ? { type: "user", message: { role: "user", content: `question ${i}` } }
          : { type: "assistant", message: { content: [{ type: "text", text: `answer ${i}` }] } },
    }));
    rows.push({ type: "result", payload: { type: "result", subtype: "success" } });

    const history = runtimeHistoryFromCompletedTurns(rows);

    expect(history.length).toBeLessThanOrEqual(28);
    expect(JSON.stringify(history)).toContain("answer 79");
    expect(JSON.stringify(history)).not.toContain("question 0");
  });
});
