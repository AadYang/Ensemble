// Phase 4 gate, part 1: the pure transition.
//
// Everything here is a unit test because everything here is pure — the clock is
// an argument (`now`), so "seven silent minutes with a live process" is asserted
// in microseconds instead of being staged with real timers. This file is where
// the phase's central rule is pinned:
//
//   SILENCE WARNS, ONLY EVIDENCE TERMINATES.
//
// The cases are grouped by which of those two a reader might confuse.

import { describe, expect, it } from "vitest";
import {
  LIVENESS_DEFAULT_SUSPECTED_AFTER_MS,
  LIVENESS_LEGACY_SCHEMA_VERSION,
  LIVENESS_PROBE_FAILED_CODE,
  LIVENESS_SCHEMA_VERSION,
  LIVENESS_UNKNOWN_PROBE_RECHECK_MS,
  describeLiveness,
  evaluateLiveness,
  fedSignalsOf,
  newLivenessSignals,
  projectLivenessState,
  resolveLivenessPolicy,
  waitingStateOf,
  type LivenessSignals,
  type LivenessSnapshot,
} from "../liveness.js";
import type { RunPlanLiveness } from "../types.js";

const START = 1_000_000;

/** A policy, built the way production builds one.
 *
 *  Overriding `hardDeadlineMs` has to go back through the resolver rather than
 *  being spread on top of a resolved policy: `hardDeadlineSource` is DERIVED
 *  from the deadline, so a spread would hand the test a shape no caller can
 *  produce — a deadline that claims it was never set — and the assertions below
 *  would be checking the fixture instead of the rule. */
const policy = (overrides: Partial<RunPlanLiveness> = {}): RunPlanLiveness => ({
  ...resolveLivenessPolicy({
    runtime: "claude",
    hardDeadlineMs: overrides.hardDeadlineMs ?? null,
    ...(overrides.suspectedAfterMs !== undefined ? { suspectedAfterMs: overrides.suspectedAfterMs } : {}),
    ...(overrides.suspectedAfterSource !== undefined
      ? { suspectedAfterSource: overrides.suspectedAfterSource }
      : {}),
  }),
  ...overrides,
});

const signals = (overrides: Partial<LivenessSignals> = {}): LivenessSignals => ({
  ...newLivenessSignals(START),
  ...overrides,
});

const decide = (
  state: Parameters<typeof evaluateLiveness>[0]["state"],
  s: LivenessSignals,
  p: RunPlanLiveness,
  now: number,
) => evaluateLiveness({ state, signals: s, policy: p, now });

describe("silence does not end a run", () => {
  it("does nothing at all while the quiet is below the suspicion threshold", () => {
    const s = signals({ lastModelEventAt: START });
    expect(decide("running", s, policy(), START + 7 * 60 * 1000).action).toBe("none");
  });

  it("warns — and only warns — once the threshold is crossed", () => {
    const decision = decide("running", signals(), policy(), START + 20 * 60 * 1000);
    expect(decision.action).toBe("warn");
    // The warning must not be readable as a verdict: nothing about it says the
    // run is over, and the reason says so in words as well.
    expect(decision.action === "warn" && decision.reason).toContain("NOT stopped");
  });

  it("stays a warning when the suspicion has stood without being checked", () => {
    const decision = decide(
      "suspected-stall",
      signals({ lastStateChangeAt: START }),
      policy(),
      START + 30 * 60 * 1000,
    );
    // Past the grace the controller probes (see the next test); with no probe
    // due yet the answer is never `terminate`.
    expect(decision.action).not.toBe("terminate");
  });

  it("asks for a health check once the suspicion has stood past the grace", () => {
    const s = signals({ lastStateChangeAt: START });
    const decision = decide("suspected-stall", s, policy({ suspectedAfterMs: 0 }), START + 61 * 1000);
    expect(decision.action).toBe("probe");
  });

  it("does not re-probe faster than the bounded re-check interval", () => {
    // A probe that could not answer must not be hammered, and it must not be
    // escalated either: the answer will not have changed one second later.
    const s = signals({
      lastStateChangeAt: START,
      lastProbeAt: START + 2 * 60 * 1000,
      lastProbeResult: "unknown",
    });
    const decision = decide(
      "suspected-stall",
      s,
      policy({ suspectedAfterMs: 0 }),
      START + 2 * 60 * 1000 + 1_000,
    );
    expect(decision.action).toBe("none");
    // ...and once the interval HAS passed, it probes again.
    expect(
      decide("suspected-stall", s, policy({ suspectedAfterMs: 0 }), START + 5 * 60 * 1000).action,
    ).toBe("probe");
  });

  it("holds a health check that is already in flight", () => {
    const s = signals({ lastStateChangeAt: START });
    expect(
      decide("health-check", s, policy({ suspectedAfterMs: 0 }), START + 61 * 1000).action,
    ).toBe("none");
  });
});

describe("a wall-clock ceiling exists only if the user set one", () => {
  it("has no deadline by default, and none after 24 hours of silence", () => {
    const p = policy();
    expect(p.hardDeadlineMs).toBeNull();
    expect(p.hardDeadlineSource).toBe("unset");
    const decision = decide("running", signals(), p, START + 24 * 60 * 60 * 1000);
    expect(decision.action).not.toBe("terminate");
  });

  it("terminates exactly at the user's deadline, with the wall-clock code", () => {
    const p = policy({ hardDeadlineMs: 1_800_000 });
    expect(decide("running", signals(), p, START + 1_800_000 - 1).action).not.toBe("terminate");
    const decision = decide("running", signals(), p, START + 1_800_000);
    expect(decision.action).toBe("terminate");
    expect(decision.action === "terminate" && decision.code).toBe("RUNTIME_WALL_CLOCK_LIMIT");
  });

  it("marks where the deadline came from", () => {
    expect(policy({ hardDeadlineMs: 60_000 }).hardDeadlineSource).toBe("user-preference");
  });
});

describe("a human in the loop pauses stall judgement", () => {
  it("counts a permission dialog as waiting, not as quiet", () => {
    const s = signals({ lastModelEventAt: START, permissionWaitSince: START + 1_000 });
    expect(waitingStateOf(s)).toBe("awaiting-permission");
    const decision = decide("awaiting-permission", s, policy(), START + 24 * 60 * 60 * 1000);
    expect(decision.action).toBe("none");
    expect(projectLivenessState({ state: "running", signals: s, policy: policy(), now: START + 24 * 60 * 60 * 1000 })).toBe(
      "awaiting-permission",
    );
  });

  it("counts an open question as waiting too", () => {
    const s = signals({ userInputWaitSince: START });
    expect(waitingStateOf(s)).toBe("awaiting-user-input");
    expect(decide("awaiting-user-input", s, policy(), START + 24 * 60 * 60 * 1000).action).toBe("none");
  });

  it("resumes when the human answers", () => {
    const s = signals({ lastModelEventAt: START, permissionWaitSince: null });
    expect(
      projectLivenessState({ state: "awaiting-permission", signals: s, policy: policy(), now: START + 1_000 }),
    ).toBe("running");
  });
});

describe("hard evidence, and only hard evidence", () => {
  it("terminates when the child exited mid-turn", () => {
    const s = signals({
      childProcess: {
        pid: 42,
        started: true,
        alive: false,
        exited: true,
        exitCode: 1,
        exitSignal: null,
        exitAt: START + 1_000,
      },
    });
    const decision = decide("running", s, policy(), START + 1_001);
    expect(decision.action).toBe("terminate");
    expect(decision.action === "terminate" && decision.code).toBe("RUNTIME_CONFIRMED_DEAD");
  });

  it("does NOT terminate on an exit we asked for", () => {
    const s = signals({
      stopRequested: true,
      childProcess: {
        pid: 42,
        started: true,
        alive: false,
        exited: true,
        exitCode: null,
        exitSignal: "SIGTERM",
        exitAt: START + 1_000,
      },
    });
    expect(decide("running", s, policy(), START + 1_001).action).toBe("none");
  });

  it("does NOT terminate on an exit that lands after the model's own result", () => {
    const s = signals({
      sawResult: true,
      childProcess: {
        pid: 42,
        started: true,
        alive: false,
        exited: true,
        exitCode: 0,
        exitSignal: null,
        exitAt: START + 1_000,
      },
    });
    expect(decide("running", s, policy(), START + 1_001).action).toBe("none");
  });

  it("terminates on an abnormally closed stream", () => {
    const s = signals({ streamClosedAt: START + 500, streamClosedAbnormally: true });
    const decision = decide("running", s, policy(), START + 501);
    expect(decision.action).toBe("terminate");
    expect(decision.action === "terminate" && decision.code).toBe("RUNTIME_STREAM_CLOSED");
  });

  it("never calls a run dead for a probe that answered nothing", () => {
    // `unknown` — whether the route has no probe, the probe answered "I cannot
    // tell", or the probe itself failed. None of the three is evidence, and a
    // long silence behind any of them must not become a verdict.
    const s = signals({ lastProbeAt: START + 1_000, lastProbeResult: "unknown" });
    const decision = decide("suspected-stall", s, policy({ suspectedAfterMs: 0 }), START + 60 * 60 * 1000);
    expect(decision.action).not.toBe("terminate");
    // What it does instead is ask again, on the bounded interval.
    expect(decision.action).toBe("probe");
  });

  it("treats a failed probe as a failed CHECK, and says so with a code", () => {
    const failed = signals({
      lastProbeAt: START + 1_000,
      lastProbeResult: "unknown",
      lastProbeCode: LIVENESS_PROBE_FAILED_CODE,
    });
    // One second after the failed probe the re-check interval has not passed,
    // so the honest action is "do nothing yet" — not "end the run".
    const decision = decide("suspected-stall", failed, policy({ suspectedAfterMs: 0 }), START + 1_001);
    expect(decision.action).toBe("none");
    expect(LIVENESS_UNKNOWN_PROBE_RECHECK_MS).toBe(2 * 60 * 1000);
  });
});

describe("which signals a run has actually been fed", () => {
  it("reports none for a run nothing has touched", () => {
    expect(fedSignalsOf(newLivenessSignals(START))).toEqual([]);
  });

  it("names each channel as it is fed, and never guesses", () => {
    expect(fedSignalsOf(signals({ lastModelEventAt: START }))).toEqual(["model-event"]);
    expect(fedSignalsOf(signals({ lastToolProgressAt: START }))).toEqual(["tool-progress"]);
    const withChild = signals();
    withChild.childProcess = {
      pid: 7,
      started: true,
      alive: true,
      exited: false,
      exitCode: null,
      exitSignal: null,
      exitAt: null,
    };
    expect(fedSignalsOf(withChild)).toEqual(["child-process"]);
  });
});

describe("what /status says", () => {
  const snapshot = (overrides: Partial<LivenessSnapshot> = {}): LivenessSnapshot => ({
    runId: "run-1",
    agentId: "agent-1",
    state: "running",
    policy: policy(),
    signals: newLivenessSignals(START),
    fed: [],
    probeRegistered: true,
    startedAt: START,
    updatedAt: START,
    endedAt: null,
    terminalReason: null,
    persistedSchemaVersion: null,
    signalsMissing: null,
    ...overrides,
  });

  it("states the suspicion threshold and that there is no deadline", () => {
    const text = describeLiveness(snapshot(), START + 1_000);
    expect(text).toContain("running");
    expect(text).toContain("no wall-clock deadline");
  });

  it("states when no probe is registered instead of leaving it out", () => {
    // "This run has no health check" is a fact a reader needs; omitting it is
    // how a warning comes to look like a verdict waiting to happen.
    expect(describeLiveness(snapshot({ probeRegistered: false }), START)).toContain("NO probe registered");
  });

  it("reports a legacy record's missing fields instead of a default that reads as an observation", () => {
    const text = describeLiveness(
      snapshot({
        persistedSchemaVersion: LIVENESS_LEGACY_SCHEMA_VERSION,
        signalsMissing: ["lastProbeAt", "sawResult"],
      }),
      START,
    );
    expect(text).toContain("legacy record");
    expect(text).toContain("lastProbeAt");
  });

  it("names the terminal reason for a run that ended", () => {
    expect(
      describeLiveness(snapshot({ state: "interrupted", terminalReason: "RECOVERED_AFTER_RESTART" }), START),
    ).toContain("RECOVERED_AFTER_RESTART");
  });
});

describe("the policy is a fact about the route, not a hope", () => {
  it("uses the historical 20-minute default for the suspicion threshold", () => {
    expect(policy().suspectedAfterMs).toBe(LIVENESS_DEFAULT_SUSPECTED_AFTER_MS);
    expect(LIVENESS_DEFAULT_SUSPECTED_AFTER_MS).toBe(20 * 60 * 1000);
  });

  it("records where a non-default threshold came from", () => {
    const p = resolveLivenessPolicy({ runtime: "claude", hardDeadlineMs: null, suspectedAfterMs: 300_000, suspectedAfterSource: "background-task" });
    expect(p.suspectedAfterSource).toBe("background-task");
  });

  it("gives a process-holding runtime a process probe, and the HTTP route none", () => {
    expect(resolveLivenessPolicy({ runtime: "claude", hardDeadlineMs: null }).probe.capability).toBe("process");
    expect(resolveLivenessPolicy({ runtime: "codex", hardDeadlineMs: null }).probe.capability).toBe("process");
    expect(resolveLivenessPolicy({ runtime: "openai", hardDeadlineMs: null }).probe.capability).toBe("stream");
    expect(resolveLivenessPolicy({ runtime: "unknown", hardDeadlineMs: null }).probe.capability).toBe("none");
  });

  it("refuses to invent a deadline from a nonsensical number", () => {
    // The resolver is the last line of defence: the write path and the plan's
    // preference resolver both refuse these, and this is what stops one that
    // got in anyway from arming a clock. It must land on NO ceiling rather than
    // on a rounded-up one — a 1ms deadline would end every run instantly, which
    // is a far worse failure than having no deadline at all.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(resolveLivenessPolicy({ runtime: "claude", hardDeadlineMs: bad }).hardDeadlineMs).toBeNull();
    }
    // ...and a usable one is carried, floored to whole milliseconds.
    expect(resolveLivenessPolicy({ runtime: "claude", hardDeadlineMs: 1_500.7 }).hardDeadlineMs).toBe(1_500);
  });

  it("carries the document version the persistence layer writes", () => {
    expect(LIVENESS_SCHEMA_VERSION).toBe(1);
    expect(LIVENESS_LEGACY_SCHEMA_VERSION).toBe(0);
  });
});
