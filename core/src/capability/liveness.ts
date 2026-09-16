// Phase 4: the liveness POLICY — the numbers and the vocabulary — plus the pure
// transition function the controller and the tests both call.
//
// What this module replaces: SessionManager used to hold a timer whose expiry
// called forceStopRun with `RUNTIME_IDLE_TIMEOUT`. Silence — nothing else — was
// enough to abort a 20-minute turn (5 for a detached subagent) and persist it as
// an ERROR. A model that was thinking, a tool that was building, a child process
// that was very much alive: all of it could be killed by a clock, and nothing in
// the result said the decision had been "we heard nothing for a while".
//
// The rule now:
//
//   silence  → suspicion (a warning anyone can see) → health check
//   evidence → termination, and only evidence
//
// "Evidence" is a closed list: the child process EXITED, the stream closed
// abnormally, or the user's own wall-clock ceiling was reached. An `unknown`
// probe is not evidence. Neither is a missing heartbeat, a long model call, or
// a background task that has not printed anything for seven minutes.
//
// Everything here is pure: given the same snapshot, the same policy and the
// same clock, it returns the same transition. That is what makes the phase gate
// ("fake clock, seven silent minutes, process alive") a unit test rather than a
// stunt with real timers.

import type {
  LivenessProbeCapability,
  LivenessProbeKind,
  LivenessSignalName,
  LivenessState,
  LivenessTerminalReason,
  LivenessUpdate,
  RunPlanLiveness,
} from "./types.js";

/** Silence this long → suspected stall. 20 minutes is the historical
 *  `ENSEMBLE_RUNTIME_IDLE_TIMEOUT_MS` default, kept as the SUSPICION threshold
 *  it always should have been. */
export const LIVENESS_DEFAULT_SUSPECTED_AFTER_MS = 20 * 60 * 1000;

/** A detached background subagent has nobody watching it, so it is suspected
 *  sooner — again only suspected. */
export const LIVENESS_BACKGROUND_SUSPECTED_AFTER_MS = 5 * 60 * 1000;

/** How long a suspicion may stand before the controller actually probes. Kept
 *  short: the probe is cheap and its answer is what decides the next state. */
export const LIVENESS_DEFAULT_HEALTH_CHECK_GRACE_MS = 60 * 1000;

/** How long to wait between probe attempts while the answer is `unknown`.
 *  Bounded, so a runtime that cannot be observed is re-checked on a schedule
 *  instead of either being trusted blindly or being called dead. */
export const LIVENESS_UNKNOWN_PROBE_RECHECK_MS = 2 * 60 * 1000;

/** A probe that does not answer within this long DID NOT ANSWER. Recorded as
 *  `unknown` with a code, never as `dead`. */
export const LIVENESS_PROBE_TIMEOUT_MS = 15 * 1000;

/** The code a probe failure is recorded under. Distinct from a negative
 *  answer: "I could not run the check" is not "the check said no". */
export const LIVENESS_PROBE_FAILED_CODE = "LIVENESS_PROBE_FAILED";

/** The shape of a persisted `RunLiveness.signals` / `.policy` document.
 *
 *  Written INTO the JSON rather than kept as a column, because the two documents
 *  are what changes shape and a reader has to be able to tell "this row predates
 *  the field" from "this field was observed to be absent". A row with no
 *  `schemaVersion` at all reads as {@link LIVENESS_LEGACY_SCHEMA_VERSION}: every
 *  field it does carry is believed, and every field it does NOT carry is
 *  reported as unknown rather than filled in with a default that looks like an
 *  observation (see `readPersistedSignals` in liveness-controller.ts). */
export const LIVENESS_SCHEMA_VERSION = 1;

/** Rows written before versioning existed. Readable, never assumed complete. */
export const LIVENESS_LEGACY_SCHEMA_VERSION = 0;

/** What each runtime can actually observe, and why.
 *
 *  Keyed by `facts.scope.runtime` — the same string the plan's identity carries
 *  — so the policy cannot describe one runtime while another runs. */
export function runtimeLivenessCapability(runtime: string): {
  capability: LivenessProbeCapability;
  reason: string;
  signals: LivenessSignalName[];
} {
  const base: LivenessSignalName[] = ["model-event", "network-event", "tool-progress"];
  if (runtime === "claude" || runtime === "codex") {
    return {
      capability: "process",
      reason:
        `${runtime} runs as a child process we spawn and hold a handle for, so exit is directly observable — ` +
        "silence plus an exited process is real evidence, and silence alone is not",
      signals: [...base, "child-process", "permission-wait", "user-input-wait"],
    };
  }
  if (runtime === "openai") {
    return {
      capability: "stream",
      reason:
        "the OpenAI route speaks HTTP through the SDK and exposes no socket or process handle to this host, so a " +
        "broken stream is observable but a quiet one proves nothing — probes answer `unknown`, and unknown is never `dead`",
      signals: [...base, "permission-wait", "user-input-wait"],
    };
  }
  return {
    capability: "none",
    reason: `no probe capability is known for runtime "${runtime}", so liveness probes answer \`unknown\``,
    signals: base,
  };
}

/** The turn's liveness policy, from facts + the user's ceiling. */
export function resolveLivenessPolicy(input: {
  runtime: string;
  /** From the `maxRunDurationMs` preference; `null` = nothing set. */
  hardDeadlineMs: number | null;
  suspectedAfterMs?: number;
  suspectedAfterSource?: RunPlanLiveness["suspectedAfterSource"];
}): RunPlanLiveness {
  const probe = runtimeLivenessCapability(input.runtime);
  const suspectedAfterMs = input.suspectedAfterMs ?? LIVENESS_DEFAULT_SUSPECTED_AFTER_MS;
  // An unusable number becomes NO ceiling, not a rounded-up one. The write path
  // and the plan's preference resolver both refuse these, so reaching this line
  // with one means a caller built a policy by hand — and the only safe answer
  // is the one nobody can be killed by. Coercing a 0 or a NaN into a small
  // positive deadline would invent a clock that ends runs the user never asked
  // to have ended, which is the exact behaviour this phase removes.
  const hardDeadlineMs =
    input.hardDeadlineMs === null ||
    !Number.isFinite(input.hardDeadlineMs) ||
    input.hardDeadlineMs <= 0
      ? null
      : Math.floor(input.hardDeadlineMs);
  const diagnostics = [
    `suspected-stall after ${suspectedAfterMs}ms of silence — this is a WARNING with a health check behind it, not a deadline`,
    hardDeadlineMs === null
      ? "no wall-clock deadline: only hard evidence (an exited child process or an abnormally closed stream) can end this run"
      : `wall-clock deadline ${hardDeadlineMs}ms, set by the user (maxRunDurationMs) — reaching it ends the run with RUNTIME_WALL_CLOCK_LIMIT`,
    `probe capability: ${probe.capability} — ${probe.reason}`,
  ];
  return {
    status: "resolved",
    reason:
      `phase 4 liveness: silence warns (${suspectedAfterMs}ms), a health check follows, and only evidence terminates`,
    suspectedAfterMs,
    suspectedAfterSource: input.suspectedAfterSource ?? "default",
    healthCheckGraceMs: LIVENESS_DEFAULT_HEALTH_CHECK_GRACE_MS,
    hardDeadlineMs,
    hardDeadlineSource: hardDeadlineMs === null ? "unset" : "user-preference",
    probe: { capability: probe.capability, reason: probe.reason },
    signals: probe.signals,
    diagnostics,
  };
}

// ── the running state ──────────────────────────────────────────────────────

/** One child process the runtime spawned for this run. `alive`/`exited` are
 *  observations, not inferences: a process that was never spawned is `null`
 *  (unknown), which is different from one that exited. */
export interface ChildProcessLiveness {
  pid: number | null;
  started: boolean;
  alive: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  exitAt: number | null;
}

export const EMPTY_CHILD_PROCESS: ChildProcessLiveness = {
  pid: null,
  started: false,
  alive: false,
  exited: false,
  exitCode: null,
  exitSignal: null,
  exitAt: null,
};

/** Every signal, recorded separately. Kept apart because they fail apart: a
 *  tool can be working while the model says nothing, and a healthy network can
 *  carry no tool progress for minutes. */
export interface LivenessSignals {
  /** Run start, epoch ms. */
  startedAt: number;
  lastModelEventAt: number | null;
  lastNetworkEventAt: number | null;
  lastToolProgressAt: number | null;
  lastChildProcessAliveAt: number | null;
  /** Set while a permission dialog / ask_user question is open. Stall
   *  judgement is PAUSED for as long as these are non-null: the runtime is
   *  blocked on a human, which is not a stall. */
  permissionWaitSince: number | null;
  userInputWaitSince: number | null;
  lastStateChangeAt: number;
  /** Most recent probe: when, what it answered, why, and under which code. */
  lastProbeAt: number | null;
  lastProbeResult: LivenessProbeKind | null;
  lastProbeReason: string | null;
  lastProbeCode: string | null;
  childProcess: ChildProcessLiveness;
  /** The run's own stream ended (normally or not). Set by the session layer. */
  streamClosedAt: number | null;
  streamClosedAbnormally: boolean;
  /** A terminal `result` message was seen: the model finished its turn. */
  sawResult: boolean;
  /** The session asked the run to stop (user cancel / peer interrupt / a
   *  confirmed-dead decision). A child exiting after this is NOT evidence. */
  stopRequested: boolean;
}

export function newLivenessSignals(startedAt: number): LivenessSignals {
  return {
    startedAt,
    lastModelEventAt: null,
    lastNetworkEventAt: null,
    lastToolProgressAt: null,
    lastChildProcessAliveAt: null,
    permissionWaitSince: null,
    userInputWaitSince: null,
    lastStateChangeAt: startedAt,
    lastProbeAt: null,
    lastProbeResult: null,
    lastProbeReason: null,
    lastProbeCode: null,
    childProcess: { ...EMPTY_CHILD_PROCESS },
    streamClosedAt: null,
    streamClosedAbnormally: false,
    sawResult: false,
    stopRequested: false,
  };
}

/** The most recent moment ANY signal said "this run is doing something". */
export function lastActivityAt(signals: LivenessSignals): number {
  return Math.max(
    signals.startedAt,
    signals.lastModelEventAt ?? 0,
    signals.lastNetworkEventAt ?? 0,
    signals.lastToolProgressAt ?? 0,
    signals.lastChildProcessAliveAt ?? 0,
  );
}

/** Which channels this run has actually delivered on.
 *
 *  Derived from the signals, never stored beside them — a second copy of the
 *  same fact is a second thing that can be wrong. This is the answer to the
 *  question a green test suite cannot answer for you: "is ANYTHING feeding this
 *  run's liveness, or is the status just the default empty state?" An empty
 *  list means every number below it is a default rather than an observation. */
export function fedSignalsOf(signals: LivenessSignals): LivenessSignalName[] {
  const fed: LivenessSignalName[] = [];
  if (signals.lastModelEventAt !== null) fed.push("model-event");
  if (signals.lastNetworkEventAt !== null) fed.push("network-event");
  if (signals.lastToolProgressAt !== null) fed.push("tool-progress");
  if (signals.childProcess.started || signals.childProcess.exited) fed.push("child-process");
  if (signals.permissionWaitSince !== null) fed.push("permission-wait");
  if (signals.userInputWaitSince !== null) fed.push("user-input-wait");
  return fed;
}

export interface LivenessSnapshot {
  runId: string;
  agentId: string;
  state: LivenessState;
  policy: RunPlanLiveness;
  signals: LivenessSignals;
  /** Which signal channels have been fed for this run so far. See
   *  {@link fedSignalsOf}. */
  fed: LivenessSignalName[];
  /** Whether the runtime registered a probe for THIS run.
   *
   *  Not the same as the policy's capability: the capability says what the
   *  runtime can observe in principle, this says what it actually wired up.
   *  `false` + capability `process` is a wiring bug worth seeing, while `false`
   *  + capability `stream` is the honest answer for a route with no handle —
   *  and in both cases a health check answers `unknown`, never `dead`. */
  probeRegistered: boolean;
  /** Epoch ms. */
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  terminalReason: LivenessTerminalReason | null;
  /** The schema of the persisted record this snapshot was rebuilt from, or
   *  `null` for a live snapshot that was observed directly. */
  persistedSchemaVersion: number | null;
  /** Signal fields a persisted record did not carry. Non-empty means this is a
   *  legacy row: what it shows for these fields is a default, not an
   *  observation, and it says so instead of reading as complete. */
  signalsMissing: string[] | null;
}

export type LivenessAction =
  | { action: "none"; reason: string }
  | { action: "warn"; state: "suspected-stall"; reason: string }
  | { action: "probe"; reason: string }
  | { action: "terminate"; state: "confirmed-dead"; code: LivenessTerminalReason; reason: string };

export function isTerminalState(state: LivenessState): boolean {
  return (
    state === "confirmed-dead" ||
    state === "user-cancelled" ||
    state === "completed" ||
    state === "interrupted"
  );
}

/** Waiting on a human: the run is alive and blocked, and the stall clock is
 *  suspended. */
export function waitingStateOf(signals: LivenessSignals): LivenessState | null {
  if (signals.permissionWaitSince !== null) return "awaiting-permission";
  if (signals.userInputWaitSince !== null) return "awaiting-user-input";
  return null;
}

/** The pure transition.
 *
 *  Read it as the answer to "given everything we know and the time, what should
 *  happen next?" — where "terminate" is reachable ONLY through the three
 *  evidence branches:
 *
 *    1. the user's wall-clock ceiling was reached;
 *    2. the child process exited while the run still had work outstanding, and
 *       the exit was not something we asked for;
 *    3. the stream closed abnormally while the run had work outstanding.
 *
 *  A probe is what a suspicion turns into; it never terminates by itself, and
 *  `unknown` returns the run to a warned-but-running suspicion with a bounded
 *  re-check rather than to a verdict. */
export function evaluateLiveness(input: {
  state: LivenessState;
  signals: LivenessSignals;
  policy: RunPlanLiveness;
  now: number;
}): LivenessAction {
  const { state, signals, policy, now } = input;

  if (isTerminalState(state)) return { action: "none", reason: `run is terminal (${state})` };

  // 1. The user's own ceiling. `null` (the default) means no such check exists.
  if (policy.hardDeadlineMs !== null && now - signals.startedAt >= policy.hardDeadlineMs) {
    return {
      action: "terminate",
      state: "confirmed-dead",
      code: "RUNTIME_WALL_CLOCK_LIMIT",
      reason:
        `the user configured maxRunDurationMs=${policy.hardDeadlineMs}ms and the run reached it ` +
        `(${now - signals.startedAt}ms elapsed); this is the user's ceiling, not a silence verdict`,
    };
  }

  // 2. Hard evidence: the child process is gone and the run had not finished.
  //    An exit after we asked it to stop is not evidence — it is what we asked
  //    for. Neither is an exit that lands after the model's own terminal result.
  if (
    signals.childProcess.exited &&
    !signals.stopRequested &&
    !signals.sawResult &&
    signals.streamClosedAt === null
  ) {
    return {
      action: "terminate",
      state: "confirmed-dead",
      code: "RUNTIME_CONFIRMED_DEAD",
      reason:
        `the runtime's child process exited (code=${signals.childProcess.exitCode ?? "n/a"}, ` +
        `signal=${signals.childProcess.exitSignal ?? "n/a"}) without producing a result for this run`,
    };
  }

  // 3. Hard evidence: the stream closed abnormally with work outstanding.
  if (signals.streamClosedAbnormally && !signals.stopRequested) {
    return {
      action: "terminate",
      state: "confirmed-dead",
      code: "RUNTIME_STREAM_CLOSED",
      reason: "the runtime's event stream closed abnormally before this run produced a result",
    };
  }

  // 4. A human is being waited on. Not a stall, and not a reason to count
  //    silence: the next move is theirs.
  const waiting = waitingStateOf(signals);
  if (waiting !== null) return { action: "none", reason: `blocked on a human (${waiting}); stall judgement is paused` };

  const quietFor = now - lastActivityAt(signals);

  // 5. Quiet for long enough to be suspicious.
  if (quietFor >= policy.suspectedAfterMs) {
    if (state === "running") {
      return {
        action: "warn",
        state: "suspected-stall",
        reason:
          `${quietFor}ms without a model, network, tool or process signal (threshold ${policy.suspectedAfterMs}ms). ` +
          "This run is NOT stopped: it is warned about, and the reason is visible",
      };
    }
    if (state === "suspected-stall" && now - signals.lastStateChangeAt >= policy.healthCheckGraceMs) {
      // A probe that could not answer is not a licence to probe again
      // immediately: the answer will not have changed in a second, and the
      // re-check interval is what keeps an unobservable runtime questioned on a
      // schedule instead of hammered. This is the ONE place the interval is
      // enforced — the controller's own re-check timer agrees with it rather
      // than the other way round.
      const sinceProbe = signals.lastProbeAt === null ? Infinity : now - signals.lastProbeAt;
      if (sinceProbe < LIVENESS_UNKNOWN_PROBE_RECHECK_MS) {
        return {
          action: "none",
          reason:
            `the last health check answered ${signals.lastProbeResult ?? "nothing"} ${sinceProbe}ms ago; ` +
            `the next re-check is due ${LIVENESS_UNKNOWN_PROBE_RECHECK_MS}ms after it`,
        };
      }
      return {
        action: "probe",
        reason:
          `suspected stall has stood for ${now - signals.lastStateChangeAt}ms ` +
          `(grace ${policy.healthCheckGraceMs}ms); checking whether the process is actually alive`,
      };
    }
    if (state === "health-check") {
      // A probe is already outstanding; nothing to do until it answers. The
      // controller re-probes on a bounded interval when the answer is unknown.
      return { action: "none", reason: "health check in flight" };
    }
    return { action: "none", reason: `quiet for ${quietFor}ms; already in ${state}` };
  }

  // 6. A signal arrived. Any non-terminal state goes back to running — and the
  //    snapshot keeps the warning trail in `lastProbe*`/diagnostics, so the
  //    recovery is explainable rather than silent.
  if (state !== "running") {
    return {
      action: "none",
      reason: `a signal arrived ${quietFor}ms ago, below the ${policy.suspectedAfterMs}ms suspicion threshold; back to running`,
    };
  }
  return { action: "none", reason: `last signal ${quietFor}ms ago` };
}

/** The state the run should be in right now, from the same inputs. Kept
 *  separate from the ACTION so a snapshot refresh (no side effects) and a
 *  controller tick (which may probe or terminate) can share the reasoning. */
export function projectLivenessState(input: {
  state: LivenessState;
  signals: LivenessSignals;
  policy: RunPlanLiveness;
  now: number;
}): LivenessState {
  const { state, signals, policy, now } = input;
  if (isTerminalState(state)) return state;
  if (signals.childProcess.exited && !signals.stopRequested && !signals.sawResult) return "confirmed-dead";
  if (signals.streamClosedAbnormally && !signals.stopRequested) return "confirmed-dead";
  if (signals.stopRequested) return state;
  const waiting = waitingStateOf(signals);
  if (waiting !== null) return waiting;
  if (state === "awaiting-permission" || state === "awaiting-user-input") return "running";
  const quietFor = now - lastActivityAt(signals);
  if (quietFor < policy.suspectedAfterMs) {
    // A signal arrived: a suspicion that has been answered by activity is over.
    return state === "suspected-stall" || state === "health-check" ? "running" : state;
  }
  return state === "running" ? "suspected-stall" : state;
}

/** One line for `/status`: what the run is doing and what the last probe said.
 *  Never a summary that could be read as a verdict on a suspicion. */
export function describeLiveness(snapshot: LivenessSnapshot, now: number): string {
  const quiet = now - lastActivityAt(snapshot.signals);
  const parts = [
    `${snapshot.state} (quiet ${quiet}ms; suspicion threshold ${snapshot.policy.suspectedAfterMs}ms)`,
  ];
  if (snapshot.policy.hardDeadlineMs === null) parts.push("no wall-clock deadline");
  else parts.push(`wall-clock deadline ${snapshot.policy.hardDeadlineMs}ms`);
  parts.push(`probe=${snapshot.policy.probe.capability}`);
  const probe = snapshot.signals.lastProbeResult;
  if (probe !== null) parts.push(`last probe=${probe}${snapshot.signals.lastProbeCode ? ` (${snapshot.signals.lastProbeCode})` : ""}`);
  // `false` is stated rather than omitted: "this run has no health check" is a
  // fact a reader needs, and leaving it out is how a warning looks like a
  // verdict waiting to happen.
  parts.push(snapshot.probeRegistered ? "probe registered" : "NO probe registered (health checks answer unknown)");
  if (snapshot.fed.length > 0) parts.push(`signals fed: ${snapshot.fed.join(", ")}`);
  else parts.push("no signal has been fed yet");
  if (snapshot.terminalReason) parts.push(`ended: ${snapshot.terminalReason}`);
  // A record written by an older schema is readable, and it says what it could
  // not tell us instead of presenting a default as an observation.
  if (snapshot.signalsMissing && snapshot.signalsMissing.length > 0) {
    parts.push(
      `restored from a legacy record (schema < ${LIVENESS_SCHEMA_VERSION}); ` +
        `never recorded: ${snapshot.signalsMissing.join(", ")}`,
    );
  }
  return parts.join("; ");
}

/** The wire projection of a snapshot: exactly what a `liveness_update` carries.
 *
 *  Built HERE — once — from the same snapshot `/status` reads and the same
 *  sentence `describeLiveness` prints for it. That is the whole reason it is a
 *  function in this module rather than a few fields assembled at the call site:
 *  a second assembly is a second derivation, and the second one drifts. The
 *  client is handed the CONCLUSION (state, description, quiet for how long)
 *  rather than the inputs, because it holds neither the signals nor the clock
 *  that could see the run. */
export function livenessUpdateOf(snapshot: LivenessSnapshot, now: number): LivenessUpdate {
  return {
    runId: snapshot.runId,
    state: snapshot.state,
    terminalReason: snapshot.terminalReason,
    description: describeLiveness(snapshot, now),
    quietMs: now - lastActivityAt(snapshot.signals),
    suspectedAfterMs: snapshot.policy.suspectedAfterMs,
    hardDeadlineMs: snapshot.policy.hardDeadlineMs,
    probeCapability: snapshot.policy.probe.capability,
    probeRegistered: snapshot.probeRegistered,
    // Copied, not aliased: the snapshot's array belongs to the snapshot, and a
    // projection that shares it is a projection that can change after the fact.
    fed: [...snapshot.fed],
    updatedAt: snapshot.updatedAt,
  };
}
