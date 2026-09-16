// Phase 4 gate, part 3 — the ANTI-gate.
//
// Parts 1 and 2 test the liveness code in isolation. Both would stay green if
// nothing in production ever constructed a controller, registered a run or fed
// it a signal — which is precisely the state the phase started from, and a green
// suite in that state is worse than no suite, because it certifies a behaviour
// no user can have.
//
// So this file proves the WIRING, from the outside, through a real
// `sendMessage` turn:
//   * a run is registered with the one controller and is visible on `/status`;
//   * the runtime is handed a real liveness reporter (not `undefined`, and not
//     an empty object — calling it moves the run's signals);
//   * the session layer itself feeds signals as the turn progresses;
//   * the run is recorded as finished, with the reason the turn actually ended.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOptions } from "../runtimes/types.js";
import type { LivenessUpdate } from "../../capability/types.js";
import { __setSkillsForTest } from "../../skills/index.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

const capturedRuntimeOptions: RuntimeOptions[] = [];

/** Holds the runtime INSIDE the turn.
 *
 *  A run that finishes before the test can look at it proves nothing about its
 *  live state, so the turn is parked after its first event and released at the
 *  end. The parked moment is exactly the one a health check would be asked in. */
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
        payload: { type: "system" as const, subtype: "init", session_id: "liveness-thread", model: opts.model },
      };
      await gate.promise;
      // A real model event AFTER the parked moment. This is the shape the P0
      // race needed: the liveness warning was committed while the turn still
      // held its own local `seq`, and the next payload the turn persisted
      // landed on top of it.
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "assistant" as const,
          message: { content: [{ type: "text", text: "still here" }] },
        },
      };
      yield {
        type: "sdk_message" as const,
        payload: { type: "result" as const, subtype: "success", session_id: "liveness-thread", modelUsage: {} },
      };
    },
  }),
}));

vi.mock("../../cli-config.js", () => ({
  getClaudeCliPath: vi.fn(async () => "mock-claude"),
  getCodexCliPath: vi.fn(async () => "mock-codex"),
}));

let prisma: typeof import("../../db.js").prisma;
let sqliteDb: typeof import("../../db.js").sqliteDb;
let SessionManager: typeof import("../SessionManager.js").SessionManager;

class StubHub {
  events: Array<{ kind: "session" | "broadcast"; msg: Record<string, unknown> }> = [];
  /** Messages addressed to ONE socket — what a fresh subscription receives. */
  socketMessages: Record<string, unknown>[] = [];
  sendTo(_socket: unknown, msg: Record<string, unknown>): void {
    this.socketMessages.push(msg);
  }
  sendToSession(_sessionId: string, msg: Record<string, unknown>): void {
    this.events.push({ kind: "session", msg });
  }
  broadcast(msg: Record<string, unknown>): void {
    this.events.push({ kind: "broadcast", msg });
  }
}

beforeAll(async () => {
  ({ prisma, sqliteDb } = await import("../../db.js"));
  ({ SessionManager } = await import("../SessionManager.js"));
});

beforeEach(() => {
  capturedRuntimeOptions.length = 0;
  __setSkillsForTest([]);
  armGate();
});

/** Wait until the mocked runtime has been handed its options, then let the
 *  consumer process the first yielded event. */
async function waitForTurnStart(): Promise<RuntimeOptions> {
  for (let i = 0; i < 200; i++) {
    if (capturedRuntimeOptions.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const opts = capturedRuntimeOptions[0];
  if (!opts) throw new Error("the runtime was never dispatched");
  // A couple of macrotasks so the consumer's loop body has run for the event
  // the runtime already yielded.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return opts;
}

/** Every `liveness_update` the hub was handed, in arrival order.
 *
 *  This event is the ONLY live channel for a run's liveness now: the transcript
 *  carries no `liveness_status` row to fall back on, so "the UI never heard"
 *  would be a silent failure, not a degraded one. */
function livenessUpdates(hub: StubHub): Array<{ sessionId: string; liveness: LivenessUpdate }> {
  return hub.events
    .filter((e) => e.msg.type === "liveness_update")
    .map((e) => e.msg as unknown as { sessionId: string; liveness: LivenessUpdate });
}

/** Wait for an update the predicate accepts.
 *
 *  Nothing here reaches into the controller: the suspicion threshold is driven
 *  through the production env override (`ENSEMBLE_RUNTIME_IDLE_TIMEOUT_MS`,
 *  honoured as a suspicion threshold only), so the tick that raises the warning
 *  is the controller's own. */
async function waitForLiveness(
  hub: StubHub,
  predicate: (l: LivenessUpdate) => boolean,
  timeoutMs = 15_000,
): Promise<LivenessUpdate | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = livenessUpdates(hub)
      .map((u) => u.liveness)
      .find(predicate);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function makeAgent(name: string) {
  const provider = await prisma.provider.create({
    data: { name: `liveness-provider-${name}`, kind: "anthropic-local", models: ["test-model"] },
  });
  return prisma.agent.create({
    data: { name, providerId: provider.id, model: "test-model" },
  });
}

describe("a real turn is registered with the one liveness controller", () => {
  it("registers the run, hands the runtime a working reporter, and records the ending", async () => {
    const agent = await makeAgent("liveness-wired");
    const sessions = new SessionManager(new StubHub() as never);

    // Nothing has run: /status has no live snapshot to show, and says so.
    expect(sessions.livenessReportFor(agent.id).live).toBeNull();

    const turn = sessions.sendMessage(agent.id, "say something");
    const opts = await waitForTurnStart();

    // 1. The runtime was handed a reporter. `undefined` here is the exact
    //    failure mode that makes every downstream observation a no-op.
    expect(opts.liveness).toBeDefined();
    expect(opts.runPlan.liveness.status).toBe("resolved");

    // 2. The controller is holding this run, and `/status` reads it from there.
    //    `live` non-null is the controller's own map answering — the same map
    //    `liveRunIds()` walks — not a re-derivation from the session bookkeeping.
    const live = sessions.livenessReportFor(agent.id).live;
    expect(live).not.toBeNull();
    expect(live!.runId).toBeTruthy();
    expect(live!.state).toBe("running");
    expect(live!.policy.hardDeadlineMs).toBeNull();
    expect(sessions.livenessReportFor(agent.id).description).toBeTruthy();

    // 3. The run was persisted as OPEN, which is what makes the next boot able
    //    to say it did not finish.
    const row = sqliteDb.prepare("SELECT * FROM RunLiveness WHERE runId = ?").get(live!.runId) as
      | { endedAt: number | null; agentId: string; policy: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.endedAt).toBeNull();
    expect(row!.agentId).toBe(agent.id);

    // 4. Signals are being fed, by two different routes. The session layer fed
    //    one as it consumed the runtime's first event...
    expect(live!.fed).toContain("model-event");
    //    ...and the reporter it handed over is functional, not an empty object.
    opts.liveness!.toolProgress();
    const afterReporter = sessions.livenessReportFor(agent.id).live;
    expect(afterReporter!.fed).toContain("tool-progress");
    // A live run has no probe registered by the MOCK runtime (it never calls
    // registerProbe) — the snapshot must say so rather than imply a check ran.
    expect(afterReporter!.probeRegistered).toBe(false);

    // Let the turn finish.
    gate.open();
    await turn;

    // The run is gone from the live set, and its ending is on the record — as
    // `completed`, not as any of the evidence codes.
    expect(sessions.livenessReportFor(agent.id).live).toBeNull();
    const last = sessions.livenessReportFor(agent.id).last;
    expect(last?.terminalReason).toBe("completed");
    expect(last?.state).toBe("completed");
    expect(last?.endedAt).not.toBeNull();
  });

  it("reports the run's suspicions through the same snapshot /status reads", async () => {
    const agent = await makeAgent("liveness-suspicion");
    const sessions = new SessionManager(new StubHub() as never);

    const turn = sessions.sendMessage(agent.id, "sit quietly");
    await waitForTurnStart();

    // The warning path is observable without waiting twenty minutes: the run's
    // snapshot is the same object the state machine writes, so its probe result
    // and policy are readable while the turn is still parked.
    const live = sessions.livenessReportFor(agent.id).live!;
    expect(live.state).toBe("running");
    expect(live.signals.lastProbeResult).toBeNull();
    expect(live.policy.probe.capability).toBe("process");

    gate.open();
    await turn;
  });
});

describe("the wall-clock ceiling travels from the agent to the running policy", () => {
  it("resolves a patched maxRunDurationMs into the plan the runtime is handed", async () => {
    const agent = await makeAgent("liveness-deadline");
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { maxRunDurationMs: 1_800_000 });

    const turn = sessions.sendMessage(agent.id, "bounded turn");
    const opts = await waitForTurnStart();

    // The plan, the policy the controller holds and /status must all agree: the
    // runtime reads `opts.runPlan`, the controller reads the same field, and the
    // report reads the controller.
    expect(opts.runPlan.liveness.hardDeadlineMs).toBe(1_800_000);
    expect(opts.runPlan.liveness.hardDeadlineSource).toBe("user-preference");
    const live = sessions.livenessReportFor(agent.id).live!;
    expect(live.policy.hardDeadlineMs).toBe(1_800_000);
    expect(sessions.livenessReportFor(agent.id).description).toContain("wall-clock deadline");

    gate.open();
    await turn;
  });

  it("carries no deadline when the user never set one, and a cleared one disappears", async () => {
    const agent = await makeAgent("liveness-no-deadline");
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.patchAgent(agent.id, { maxRunDurationMs: 60_000 });
    await sessions.patchAgent(agent.id, { maxRunDurationMs: null });
    // The metadata no longer carries the key at all, which is the state that
    // means "no clock may end this run".
    const row = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect((row!.metadata as Record<string, unknown> | null)?.maxRunDurationMs).toBeUndefined();

    const turn = sessions.sendMessage(agent.id, "unbounded turn");
    const opts = await waitForTurnStart();
    expect(opts.runPlan.liveness.hardDeadlineMs).toBeNull();

    gate.open();
    await turn;
  });

  it("refuses a nonsensical deadline instead of inventing one", async () => {
    const agent = await makeAgent("liveness-bad-deadline");
    const sessions = new SessionManager(new StubHub() as never);

    await expect(sessions.patchAgent(agent.id, { maxRunDurationMs: 0 })).rejects.toThrow(/maxRunDurationMs/);
    await expect(sessions.patchAgent(agent.id, { maxRunDurationMs: -5 })).rejects.toThrow(/maxRunDurationMs/);
    const row = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect((row!.metadata as Record<string, unknown> | null)?.maxRunDurationMs).toBeUndefined();
  });
});

// The P0: a liveness broadcast used to be delivered as a `liveness_status`
// system MESSAGE, written with a seq read straight from the DB
// (`nextMessageSeq`) while the live turn held its own local seq for the same
// agent. The warning therefore consumed the number the turn's next event was
// about to persist, and that write hit the `(agentId, seq)` unique index.
//
// The regression tests below provoke exactly that interleaving — a warning while
// the turn is parked mid-stream, then another model event and the result — and
// pin the two halves of the fix: no message row from liveness, and a typed
// update on the wire for every transition.

describe("a liveness verdict never enters the transcript", () => {
  it("warns through a typed update, then finishes the turn with unique message seqs", async () => {
    // 1.5s of silence is enough to be suspected, when the process is asked to
    // suspect that soon. Same production code path as the 20-minute default.
    process.env.ENSEMBLE_RUNTIME_IDLE_TIMEOUT_MS = "1500";
    try {
      const agent = await makeAgent("liveness-warning-race");
      const hub = new StubHub();
      const sessions = new SessionManager(hub as never);

      const turn = sessions.sendMessage(agent.id, "keep going");
      await waitForTurnStart();

      // The warning is raised by the controller's own tick, while the turn is
      // parked and still holding the seq it will persist the next event with.
      const warned = await waitForLiveness(hub, (l) => l.state === "suspected-stall");
      expect(warned).not.toBeNull();
      expect(warned!.runId).toBeTruthy();
      expect(warned!.description).toBeTruthy();
      expect(warned!.terminalReason).toBeNull();
      // The silence was measured by the process that can see the run.
      expect(warned!.quietMs).toBeGreaterThanOrEqual(1500);
      expect(warned!.suspectedAfterMs).toBe(1500);
      expect(warned!.probeCapability).toBe("process");
      expect(warned!.probeRegistered).toBe(false);
      expect(Array.isArray(warned!.fed)).toBe(true);

      // A warning is not a verdict: the run is still the live one.
      expect(sessions.livenessReportFor(agent.id).live).not.toBeNull();

      gate.open();
      await turn;

      // (a) The turn completed, and every row it wrote owns its seq. Before the
      //     fix the warning had already taken the number the assistant row was
      //     persisted with, and this is where that surfaced as a P2002.
      const rows = await prisma.message.findMany({
        where: { agentId: agent.id },
        orderBy: { seq: "asc" },
      });
      const seqs = rows.map((r) => r.seq);
      expect(seqs.length).toBeGreaterThan(1);
      expect(new Set(seqs).size).toBe(seqs.length);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      }

      // (b) No liveness verdict was written as a message. `RunLiveness` is the
      //     durable record; a second copy in the transcript is what raced.
      const verdictRows = rows.filter(
        (r) => (r.payload as { subtype?: unknown } | null)?.subtype === "liveness_status",
      );
      expect(verdictRows).toEqual([]);

      // (c) The same channel carried the ending, with the reason the turn
      //     actually ended with.
      const terminal = await waitForLiveness(hub, (l) => l.state === "completed");
      expect(terminal).not.toBeNull();
      expect(terminal!.terminalReason).toBe("completed");
      expect(terminal!.description).toBeTruthy();
      // The run's identity did not change between the warning and the ending.
      expect(terminal!.runId).toBe(warned!.runId);
    } finally {
      delete process.env.ENSEMBLE_RUNTIME_IDLE_TIMEOUT_MS;
    }
  }, 30_000);

  it("broadcasts the terminal update even when the run never warned", async () => {
    const agent = await makeAgent("liveness-terminal-only");
    const hub = new StubHub();
    const sessions = new SessionManager(hub as never);

    const turn = sessions.sendMessage(agent.id, "quick turn");
    await waitForTurnStart();
    gate.open();
    await turn;

    const events = livenessUpdates(hub);
    expect(events.length).toBeGreaterThan(0);
    const terminal = await waitForLiveness(hub, (l) => l.state === "completed");
    expect(terminal).not.toBeNull();
    expect(terminal!.terminalReason).toBe("completed");
    expect(terminal!.runId).toBeTruthy();
    expect(terminal!.description.length).toBeGreaterThan(0);
    // The update is addressed to the session it describes, which is what lets
    // the client store it per agent without guessing.
    expect(events.every((e) => e.sessionId === agent.id)).toBe(true);

    // The transcript is still free of verdict rows on this path.
    const rows = await prisma.message.findMany({ where: { agentId: agent.id } });
    expect(
      rows.some((r) => (r.payload as { subtype?: unknown } | null)?.subtype === "liveness_status"),
    ).toBe(false);
  });
});

// The plan half of the context bar is SERVER-OWNED state, and these two are the
// ways it used to go missing: a plan broadcast before the turn's own history and
// skills were attached (which every client rendered as degraded), and a
// reconnect that never got the last one back (which left the plan half — and
// everything `planView` feeds, `/status` included — empty until the next turn).
describe("the run plan is broadcast once, and resynced to a fresh subscriber", () => {
  it("sends the plan the runtime was DISPATCHED with, and re-sends it on subscribe", async () => {
    const agent = await makeAgent("resync-run-plan");
    const hub = new StubHub();
    const sessions = new SessionManager(hub as never);

    const turn = sessions.sendMessage(agent.id, "size some history");
    const opts = await waitForTurnStart();
    gate.open();
    await turn;

    // (a) One broadcast, and it is the dispatched plan — not the pre-history
    //     placeholder, whose `history`/`skills` are not attached yet. Every
    //     `run_plan` for this turn must carry the same hash the runtime held.
    const broadcastHashes = hub.events
      .filter((e) => e.msg.type === "run_plan")
      .map((e) => (e.msg.plan as { planHash: string }).planHash);
    expect(broadcastHashes.length).toBeGreaterThan(0);
    expect(new Set(broadcastHashes)).toEqual(new Set([opts.runPlan.planHash]));

    // (b) The client drops its plan when the connection goes (a finished turn's
    //     limits must not read as the next turn's), so a fresh subscription has
    //     to get it back from the server — it holds no copy and cannot derive
    //     one.
    hub.socketMessages.length = 0;
    await sessions.replaySubscriptionStateFor(agent.id, {} as never);

    const types = hub.socketMessages.map((m) => m.type);
    expect(types).toContain("run_plan");
    const plan = hub.socketMessages.find((m) => m.type === "run_plan")!.plan as {
      source: string;
      planHash: string;
      context: unknown;
      history: unknown;
    };
    expect(plan.source).toBe("last-turn");
    expect(plan.planHash).toBe(opts.runPlan.planHash);
    // The plan half the bar renders is populated, not a hollow object: these two
    // are what the ContextBar's effective-window / counting / compaction display
    // reads, and what stays null until the NEXT turn without this replay.
    expect(plan.context).toBeTypeOf("object");
    expect(plan.history).toBeTypeOf("object");
  }, 30_000);

  it("sends no plan at all for an agent that has never been dispatched", async () => {
    const agent = await makeAgent("never-dispatched");
    const hub = new StubHub();
    const sessions = new SessionManager(hub as never);

    await sessions.replaySubscriptionStateFor(agent.id, {} as never);

    // "Resolved nothing" and "resolved an empty route" are different states, and
    // only the first one is true here — inventing a plan would give the UI a
    // route to render that no turn ever ran under.
    expect(hub.socketMessages.map((m) => m.type)).not.toContain("run_plan");
    // The rest of the resync still happens.
    expect(hub.socketMessages.map((m) => m.type)).toContain("context_usage");
  });
});
