// Phase 4 gate, part 2: the controller.
//
// Part 1 pins the pure transition. This file pins the object that owns it: one
// controller per process, its single tick, its persistence, and its recovery of
// runs that were open when the process died.
//
// Everything is driven through the REAL path — a started controller, its own
// ticker, its own signals. Nothing here calls a test-only entry point, because
// a green suite that exercised an entry point production never uses is exactly
// how a phase looks finished while it is not wired. The clock is injected and
// advanced, so "twenty minutes" costs a few milliseconds.
//
// The clock is injected but the TICKER is real: the tick reads the fake clock,
// so advancing it is what makes a minute pass.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.AGENTORCH_DB_PATH = ":memory:";

let LivenessController: typeof import("../liveness-controller.js").LivenessController;
let resolveLivenessPolicy: typeof import("../capability/liveness.js").resolveLivenessPolicy;
let newLivenessSignals: typeof import("../capability/liveness.js").newLivenessSignals;
let sqliteDb: typeof import("../db.js").sqliteDb;
type LivenessSnapshot = import("../capability/liveness.js").LivenessSnapshot;
type RunPlanLiveness = import("../capability/types.js").RunPlanLiveness;

const START = 1_700_000_000_000;

beforeAll(async () => {
  ({ LivenessController } = await import("../liveness-controller.js"));
  ({ resolveLivenessPolicy, newLivenessSignals } = await import("../capability/liveness.js"));
  ({ sqliteDb } = await import("../db.js"));
});

beforeEach(() => {
  sqliteDb.prepare("DELETE FROM RunLiveness").run();
});

const running: Array<InstanceType<typeof LivenessController>> = [];
afterEach(() => {
  for (const controller of running.splice(0)) controller.stop();
});

/** A policy with the health-check grace removed.
 *
 *  The grace exists so a real suspicion is not checked the instant it is raised.
 *  Here the clock is advanced by hand, so a nonzero grace would simply mean "no
 *  probe happens", and every assertion would be about the warn state instead of
 *  about what the check concluded. The grace itself is asserted on its own. */
const policy = (overrides: Partial<RunPlanLiveness> = {}): RunPlanLiveness => ({
  ...resolveLivenessPolicy({ runtime: "claude", hardDeadlineMs: null }),
  healthCheckGraceMs: 0,
  ...overrides,
});

function makeController() {
  let now = START;
  const terminated: Array<{ code: string; reason: string; snapshot: LivenessSnapshot }> = [];
  const controller = new LivenessController({
    now: () => now,
    tickMs: 2,
    onTerminate: (t) => {
      terminated.push({ code: t.code, reason: t.reason, snapshot: t.snapshot });
    },
  });
  running.push(controller);
  return {
    controller,
    terminated,
    advance: (ms: number) => {
      now += ms;
    },
    /** Let the controller's own ticker look at every run. The fake clock is
     *  advanced BEFORE this is called, so the ticks see the new time. */
    tick: async () => {
      controller.start();
      await new Promise((resolve) => setTimeout(resolve, 40));
      controller.stop();
    },
  };
}

describe("silence is a warning, not a verdict", () => {
  it("keeps a silent run whose process is alive, and records the probe", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-alive";
    controller.begin({ runId, agentId: "agent-1", policy: policy(), hooks: { probe: () => "alive" } });

    // Seven silent minutes. The process is there, and the only thing that may
    // happen is a warning followed by a check that says so.
    advance(7 * 60 * 1000);
    await tick();

    const snapshot = controller.snapshot(runId);
    expect(terminated).toEqual([]);
    expect(snapshot).not.toBeNull();
    // The probe was registered, so nothing can later claim "there was never a
    // probe on this route" — the wiring is on the snapshot, not only in a test.
    expect(snapshot!.probeRegistered).toBe(true);
  });

  it("warns, checks, and comes back to running when the check says alive", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-recovers";
    controller.begin({ runId, agentId: "agent-2", policy: policy(), hooks: { probe: () => "alive" } });

    advance(21 * 60 * 1000);
    await tick();

    const snapshot = controller.snapshot(runId);
    expect(terminated).toEqual([]);
    expect(snapshot!.state).toBe("running");
    expect(snapshot!.signals.lastProbeResult).toBe("alive");
    expect(snapshot!.signals.lastProbeReason).toBeTruthy();
  });

  it("keeps a run it cannot observe, and never calls it dead", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-unknown";
    controller.begin({
      runId,
      agentId: "agent-3",
      // A route with no handle to hold. NOT registering a probe is the honest
      // answer here, and the snapshot has to say so rather than leave a reader
      // to guess whether a check ever ran.
      policy: policy({ probe: { capability: "stream", reason: "no handle on this route" } }),
    });

    advance(45 * 60 * 1000);
    await tick();

    const snapshot = controller.snapshot(runId);
    expect(terminated).toEqual([]);
    expect(snapshot?.state).toBe("suspected-stall");
    expect(snapshot?.signals.lastProbeResult).toBe("unknown");
    expect(snapshot?.probeRegistered).toBe(false);
    expect(snapshot?.policy.probe.capability).toBe("stream");
  });

  it("confirms death only when the probe reports the process is gone", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-dead";
    controller.begin({ runId, agentId: "agent-4", policy: policy(), hooks: { probe: () => "dead" } });

    advance(30 * 60 * 1000);
    await tick();

    expect(terminated.map((t) => t.code)).toEqual(["RUNTIME_CONFIRMED_DEAD"]);
    expect(terminated[0]!.reason).toContain("health-check probe reported dead");
    expect(controller.snapshot(runId)).toBeNull();
  });

  it("records a probe that threw as a failed CHECK, not a dead run", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-probe-throws";
    controller.begin({
      runId,
      agentId: "agent-5",
      policy: policy(),
      hooks: {
        probe: () => {
          throw new Error("probe exploded");
        },
      },
    });

    advance(30 * 60 * 1000);
    await tick();

    const snapshot = controller.snapshot(runId);
    expect(terminated).toEqual([]);
    expect(snapshot?.signals.lastProbeResult).toBe("unknown");
    expect(snapshot?.signals.lastProbeCode).toBe("LIVENESS_PROBE_FAILED");
    expect(snapshot?.signals.lastProbeReason).toContain("probe exploded");
  });

  it("waits out the grace before checking, and never escalates on its own", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-grace";
    controller.begin({
      runId,
      agentId: "agent-6",
      policy: { ...policy(), healthCheckGraceMs: 60 * 1000 },
      hooks: { probe: () => "alive" },
    });

    // Past the suspicion threshold but INSIDE the grace: the run is warned
    // about and nothing has been asked yet.
    advance(20 * 60 * 1000 + 1_000);
    await tick();
    expect(controller.snapshot(runId)?.state).toBe("suspected-stall");
    expect(controller.snapshot(runId)?.signals.lastProbeResult).toBeNull();
    expect(terminated).toEqual([]);

    // Past the grace: the check runs, and its answer is what moves the state.
    advance(61 * 1000);
    await tick();
    expect(controller.snapshot(runId)?.signals.lastProbeResult).toBe("alive");
    expect(terminated).toEqual([]);
  });

  it("has no wall-clock deadline unless the user asked for one", async () => {
    const { controller, terminated, advance, tick } = makeController();
    controller.begin({ runId: "run-null-deadline", agentId: "agent-7", policy: policy() });
    expect(controller.snapshot("run-null-deadline")?.policy.hardDeadlineMs).toBeNull();

    advance(24 * 60 * 60 * 1000);
    await tick();

    // A day of silence with no ceiling: warned, checked, still running.
    expect(terminated).toEqual([]);
    expect(controller.snapshot("run-null-deadline")).not.toBeNull();
  });

  it("terminates at the user's deadline with the wall-clock code", async () => {
    const { controller, terminated, advance, tick } = makeController();
    controller.begin({
      runId: "run-deadline",
      agentId: "agent-8",
      policy: policy({ hardDeadlineMs: 60_000 }),
      // A live process does not save a run whose OWNER asked for a ceiling.
      hooks: { probe: () => "alive" },
    });

    advance(59_000);
    await tick();
    expect(terminated).toEqual([]);

    advance(2_000);
    await tick();
    expect(terminated.map((t) => t.code)).toEqual(["RUNTIME_WALL_CLOCK_LIMIT"]);
  });

  it("does not judge stall while a human is being waited on", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-waiting";
    controller.begin({
      runId,
      agentId: "agent-9",
      // Zero threshold on purpose: if the wait did not pause stall judgement,
      // this run would be warned about on the very first tick.
      policy: policy({ suspectedAfterMs: 0 }),
    });

    controller.notePermissionWait(runId, START);
    expect(controller.snapshot(runId)?.state).toBe("awaiting-permission");

    advance(24 * 60 * 60 * 1000);
    await tick();

    expect(terminated).toEqual([]);
    expect(controller.snapshot(runId)?.state).toBe("awaiting-permission");

    // The human answered: the wait is over, and the run is judged by its
    // signals again rather than being killed for having waited.
    //
    // "Judged again" is all this can assert at a ZERO threshold: the moment the
    // run stops waiting it is (correctly) suspected, because zero silence is
    // still not less than zero. What matters here is that the answer is what
    // moved it — `awaiting-permission` is gone and nothing was terminated —
    // and the default-threshold test below is where "resumes as running" is
    // read.
    controller.notePermissionWait(runId, null);
    expect(controller.snapshot(runId)?.signals.permissionWaitSince).toBeNull();
    expect(controller.snapshot(runId)?.state).not.toBe("awaiting-permission");
    expect(terminated).toEqual([]);
  });

  it("returns to running when the human answers, at a real threshold", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-answered";
    controller.begin({ runId, agentId: "agent-11", policy: policy() });
    controller.notePermissionWait(runId, START);

    advance(20 * 60 * 1000);
    await tick();
    expect(controller.snapshot(runId)?.state).toBe("awaiting-permission");

    // The answer feeds a network signal, so the run is quiet for 0ms against a
    // 7-minute threshold — a suspicion that has been answered is over.
    controller.notePermissionWait(runId, null);
    expect(controller.snapshot(runId)?.state).toBe("running");
    expect(terminated).toEqual([]);
  });

  it("treats an open question the same way", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-question";
    controller.begin({ runId, agentId: "agent-10", policy: policy({ suspectedAfterMs: 0 }) });
    controller.noteUserInputWait(runId, START);

    advance(3 * 60 * 60 * 1000);
    await tick();

    expect(terminated).toEqual([]);
    expect(controller.snapshot(runId)?.state).toBe("awaiting-user-input");
  });

  it("reports which channels have actually been fed", async () => {
    const { controller } = makeController();
    const runId = "run-fed";
    controller.begin({ runId, agentId: "agent-11", policy: policy() });
    // Nothing has been fed yet: this is the answer that tells a reader the run
    // has no instrumentation, as opposed to "nothing is happening".
    expect(controller.snapshot(runId)?.fed).toEqual([]);

    controller.noteModelEvent(runId);
    controller.noteToolProgress(runId);
    expect(controller.snapshot(runId)?.fed).toEqual(["model-event", "network-event", "tool-progress"]);
    expect(controller.snapshot(runId)?.signals.lastToolProgressAt).toBe(START);
  });

  it("scopes a suspicion to its own run, not to the agent", () => {
    const { controller } = makeController();
    controller.begin({ runId: "old-run", agentId: "agent-12", policy: policy() });
    expect(controller.snapshot("old-run")).not.toBeNull();
    // A new run for the same agent must not inherit the old one's entry.
    controller.begin({ runId: "new-run", agentId: "agent-12", policy: policy() });
    controller.end("old-run", "user-cancelled", "user-cancelled");
    expect(controller.snapshot("old-run")).toBeNull();
    expect(controller.snapshot("new-run")?.state).toBe("running");
    expect(controller.liveRunIds()).toEqual(["new-run"]);
  });
});

describe("a cancelled run is recorded as cancelled, never as dead", () => {
  it("keeps the user's reason apart from the evidence codes", () => {
    const { controller } = makeController();
    controller.begin({ runId: "run-cancel", agentId: "agent-13", policy: policy() });
    controller.end("run-cancel", "user-cancelled", "user-cancelled");

    const last = controller.lastPersistedForAgent("agent-13");
    expect(last?.state).toBe("user-cancelled");
    expect(last?.terminalReason).toBe("user-cancelled");
    expect(last?.endedAt).not.toBeNull();
  });

  it("does not let a stop we asked for become evidence of death", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-stop";
    controller.begin({ runId, agentId: "agent-14", policy: policy() });
    controller.noteStopRequested(runId);
    // The child exits AFTER we asked it to. That is a consequence, not evidence.
    controller.noteChildProcess(runId, { kind: "exited", pid: 4, exitCode: null, signal: "SIGTERM" });

    advance(60 * 60 * 1000);
    await tick();
    expect(terminated).toEqual([]);
    expect(controller.snapshot(runId)?.state).not.toBe("confirmed-dead");
  });

  it("does not turn an exit that ends a completed turn into a death", async () => {
    const { controller, terminated, advance, tick } = makeController();
    const runId = "run-completed-exit";
    controller.begin({ runId, agentId: "agent-15", policy: policy() });
    controller.noteResultSeen(runId);
    controller.noteChildProcess(runId, { kind: "exited", pid: 9, exitCode: 0, signal: null });

    advance(60 * 60 * 1000);
    await tick();
    expect(terminated).toEqual([]);
  });
});

describe("persistence and restart", () => {
  it("writes the document version into the persisted record", () => {
    const { controller } = makeController();
    controller.begin({ runId: "run-versioned", agentId: "agent-16", policy: policy() });
    const row = sqliteDb.prepare("SELECT * FROM RunLiveness WHERE runId = ?").get("run-versioned") as {
      policy: string;
      signals: string;
    };
    expect(JSON.parse(row.policy).schemaVersion).toBe(1);
    expect(JSON.parse(row.signals).schemaVersion).toBe(1);
  });

  it("reads a legacy row without pretending it is complete", () => {
    const { controller } = makeController();
    // A row as an older build would have written it: no schemaVersion, and only
    // the fields that existed then.
    sqliteDb
      .prepare(
        `INSERT INTO RunLiveness (runId, agentId, state, policy, signals, startedAt, updatedAt, endedAt, terminalReason)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        "run-legacy",
        "agent-17",
        "completed",
        JSON.stringify({ suspectedAfterMs: 1, probe: { capability: "process", reason: "old" } }),
        JSON.stringify({ startedAt: START, lastModelEventAt: START + 5 }),
        START,
        START + 10,
      );

    const last = controller.lastPersistedForAgent("agent-17");
    expect(last?.persistedSchemaVersion).toBe(0);
    expect(last?.signalsMissing).toContain("sawResult");
    expect(last?.signalsMissing).toContain("childProcess");
    // What it DID carry is believed, not discarded.
    expect(last?.signals.lastModelEventAt).toBe(START + 5);
    // The defaults are there so a reader cannot crash, and the missing list is
    // what stops them reading as observations.
    expect(last?.signals.lastProbeResult).toBeNull();
  });

  it("closes a run the process died under as recovered, keeping its signals", () => {
    const { controller } = makeController();
    const signals = { ...newLivenessSignals(START), lastModelEventAt: START + 500 };
    sqliteDb
      .prepare(
        `INSERT INTO RunLiveness (runId, agentId, state, policy, signals, startedAt, updatedAt, endedAt, terminalReason)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        "run-orphan",
        "agent-18",
        "running",
        JSON.stringify({ schemaVersion: 1, ...policy() }),
        JSON.stringify({ schemaVersion: 1, ...signals }),
        START,
        START + 600,
      );

    const recovered = controller.recoverOrphans();
    expect(recovered).toEqual([{ runId: "run-orphan", agentId: "agent-18" }]);

    const last = controller.lastPersistedForAgent("agent-18");
    // NOT "completed": the run did not finish, and IDLE alone is true and
    // useless as a record of that.
    expect(last?.state).toBe("interrupted");
    expect(last?.terminalReason).toBe("RECOVERED_AFTER_RESTART");
    expect(last?.endedAt).not.toBeNull();
    // The last known signals survive the recovery, under their own key.
    const signalsJson = JSON.parse(
      (sqliteDb.prepare("SELECT signals FROM RunLiveness WHERE runId = ?").get("run-orphan") as { signals: string })
        .signals,
    ) as { lastKnown?: { lastModelEventAt?: number }; recoveryReason?: string };
    expect(signalsJson.lastKnown?.lastModelEventAt).toBe(START + 500);
    expect(signalsJson.recoveryReason).toContain("restarted");
  });

  it("leaves a finished run alone", () => {
    const { controller } = makeController();
    controller.begin({ runId: "run-finished", agentId: "agent-19", policy: policy() });
    controller.end("run-finished", "completed", "completed");
    expect(controller.recoverOrphans()).toEqual([]);
    expect(controller.lastPersistedForAgent("agent-19")?.terminalReason).toBe("completed");
  });
});
