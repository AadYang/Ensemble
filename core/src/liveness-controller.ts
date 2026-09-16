// Phase 4: THE liveness controller.
//
// One object owns "is this run alive?" for every run in the process. Runtime
// events, the watchdog, the cancellation path and `/status` all read and write
// it — there is deliberately no second place where a component can form its own
// opinion. The bug this replaces was not a wrong threshold: it was that the
// session layer decided by itself (a timer → forceStopRun), the runtime knew
// nothing about it, and `/status` could not say what had happened.
//
// Responsibilities:
//   * hold the per-run state and its signals (see capability/liveness.ts);
//   * persist them, so a restart can still say HOW the previous run ended;
//   * run the single watchdog tick that turns silence into a warning, a warning
//     into a health check, and only hard evidence into a termination;
//   * expose a snapshot for `/status` and for the terminal report.
//
// Non-responsibilities: it never touches the DB rows of agents, never calls
// into a runtime, and never decides anything the pure transition function in
// capability/liveness.ts did not decide. Termination is a REQUEST to the owner
// (`onTerminate`), which is where the abort/kill tree lives.

import {
  LIVENESS_LEGACY_SCHEMA_VERSION,
  LIVENESS_PROBE_FAILED_CODE,
  LIVENESS_PROBE_TIMEOUT_MS,
  LIVENESS_SCHEMA_VERSION,
  LIVENESS_UNKNOWN_PROBE_RECHECK_MS,
  describeLiveness,
  evaluateLiveness,
  fedSignalsOf,
  isTerminalState,
  lastActivityAt,
  livenessUpdateOf,
  newLivenessSignals,
  projectLivenessState,
  type LivenessSnapshot,
  type LivenessSignals,
} from "./capability/liveness.js";
import { sqliteDb } from "./db.js";
import type {
  LivenessProbeKind,
  LivenessState,
  LivenessTerminalReason,
  LivenessUpdate,
  RunPlanLiveness,
} from "./capability/types.js";

/** What the owner is told when the controller concludes a run is dead. */
export interface LivenessTermination {
  runId: string;
  agentId: string;
  code: LivenessTerminalReason;
  reason: string;
  snapshot: LivenessSnapshot;
}

/** What the owner must be able to answer for the controller to check a run. */
export interface LivenessRunHooks {
  /** "Is this run still alive?" — `unknown` when the runtime cannot observe it.
   *  Omitting this hook is the same as an `unknown` answer: the controller will
   *  keep warning and re-checking, never terminate. A synchronous probe is
   *  allowed because the honest ones are (a child handle's exit state needs no
   *  I/O). */
  probe?: () => LivenessProbeKind | Promise<LivenessProbeKind>;
}

interface RunEntry {
  runId: string;
  agentId: string;
  policy: RunPlanLiveness;
  signals: LivenessSignals;
  state: LivenessState;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  terminalReason: LivenessTerminalReason | null;
  hooks: LivenessRunHooks;
  /** In-flight probe, so a tick cannot stack probes. */
  probing: boolean;
  /** Last time the entry was written to SQLite (signal-only updates are
   *  throttled; a state change always writes). */
  persistedAt: number;
  /** Set once `onTerminate` has been asked, so a tick cannot ask twice. */
  terminationRequested: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface LivenessControllerOptions {
  /** Called when the controller concludes the run is over. The owner performs
   *  the abort/kill and the DB/UI updates. */
  onTerminate: (t: LivenessTermination) => void | Promise<void>;
  /** Called on every state change, so the UI can show a warning as it happens.
   *  Never called for signal-only updates. */
  onStateChange?: (snapshot: LivenessSnapshot, previous: LivenessState) => void;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number;
  /** How often the controller looks at every run. 1s: fine-grained enough for
   *  a threshold in the minutes, cheap enough to be irrelevant. */
  tickMs?: number;
  /** Persist signal-only updates at most this often. */
  persistEveryMs?: number;
}

export class LivenessController {
  private readonly runs = new Map<string, RunEntry>();
  private readonly byAgent = new Map<string, Set<string>>();
  private readonly opts: LivenessControllerOptions;
  private readonly now: () => number;
  private readonly persistEveryMs: number;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(opts: LivenessControllerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.persistEveryMs = opts.persistEveryMs ?? 10_000;
  }

  /** The single watchdog. One interval for the whole process, not one timer per
   *  run: a run's escalation is computed from its own clocks, so the tick only
   *  has to be frequent enough to notice. */
  start(): void {
    if (this.ticker) return;
    const ms = this.opts.tickMs ?? 1_000;
    this.ticker = setInterval(() => this.tick(), ms);
    const t = this.ticker as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  begin(input: {
    runId: string;
    agentId: string;
    policy: RunPlanLiveness;
    hooks?: LivenessRunHooks;
    startedAt?: number;
  }): LivenessSnapshot {
    const startedAt = input.startedAt ?? this.now();
    const entry: RunEntry = {
      runId: input.runId,
      agentId: input.agentId,
      policy: input.policy,
      signals: newLivenessSignals(startedAt),
      state: "running",
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
      terminalReason: null,
      hooks: input.hooks ?? {},
      probing: false,
      persistedAt: 0,
      terminationRequested: false,
      timer: null,
    };
    this.runs.set(entry.runId, entry);
    let forAgent = this.byAgent.get(entry.agentId);
    if (!forAgent) {
      forAgent = new Set();
      this.byAgent.set(entry.agentId, forAgent);
    }
    forAgent.add(entry.runId);
    this.persist(entry, true);
    console.log(
      `[liveness] begin run=${entry.runId.slice(0, 8)} agent=${entry.agentId.slice(0, 8)} ` +
        `suspectedAfter=${entry.policy.suspectedAfterMs}ms hardDeadline=${entry.policy.hardDeadlineMs ?? "none"} ` +
        `probe=${entry.policy.probe.capability}`,
    );
    return this.snapshot(entry.runId)!;
  }

  /** Mark a run finished. `reason` is the structured code — `completed` for a
   *  turn that finished, `user-cancelled` for a user stop, and the evidence
   *  codes for a run the controller (or the runtime) found dead. */
  end(
    runId: string,
    reason: LivenessTerminalReason,
    state: Extract<LivenessState, "completed" | "user-cancelled" | "confirmed-dead" | "interrupted">,
  ): LivenessSnapshot | null {
    const entry = this.runs.get(runId);
    if (!entry) return null;
    if (isTerminalState(entry.state)) return this.snapshot(runId);
    const now = this.now();
    entry.state = state;
    entry.terminalReason = reason;
    entry.endedAt = now;
    entry.signals.lastStateChangeAt = now;
    this.persist(entry, true);
    this.opts.onStateChange?.(this.snapshot(entry.runId)!, state);
    console.log(
      `[liveness] end run=${runId.slice(0, 8)} agent=${entry.agentId.slice(0, 8)} state=${state} reason=${reason}`,
    );
    this.forget(runId);
    return this.snapshotFrom(entry);
  }

  /** Drop the in-memory entry once the run is over. The ROW stays: "how did the
   *  last run end" has to survive the run itself. */
  private forget(runId: string): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.runs.delete(runId);
    const set = this.byAgent.get(entry.agentId);
    if (set) {
      set.delete(runId);
      if (set.size === 0) this.byAgent.delete(entry.agentId);
    }
  }

  // ── signals ──────────────────────────────────────────────────────────────

  private touch(runId: string, mutate: (s: LivenessSignals) => void): void {
    const entry = this.runs.get(runId);
    if (!entry || isTerminalState(entry.state)) return;
    mutate(entry.signals);
    const now = this.now();
    entry.updatedAt = now;
    this.persist(entry, false);
    this.evaluate(entry);
  }

  noteModelEvent(runId: string): void {
    this.touch(runId, (s) => {
      const now = this.now();
      s.lastModelEventAt = now;
      // A model event is also an event on the wire: the transport delivered it.
      s.lastNetworkEventAt = now;
    });
  }

  noteNetworkEvent(runId: string): void {
    this.touch(runId, (s) => {
      s.lastNetworkEventAt = this.now();
    });
  }

  noteToolProgress(runId: string): void {
    this.touch(runId, (s) => {
      // Tool progress travels on the network too, so it is evidence of both.
      const now = this.now();
      s.lastToolProgressAt = now;
      s.lastNetworkEventAt = now;
    });
  }

  noteChildProcess(
    runId: string,
    info: {
      kind: "started" | "alive" | "exited" | "error";
      pid: number | null;
      exitCode?: number | null;
      signal?: string | null;
    },
  ): void {
    this.touch(runId, (s) => {
      const now = this.now();
      if (info.kind === "started") {
        s.childProcess = {
          pid: info.pid,
          started: true,
          alive: true,
          exited: false,
          exitCode: null,
          exitSignal: null,
          exitAt: null,
        };
        s.lastChildProcessAliveAt = now;
        return;
      }
      if (info.kind === "alive") {
        s.childProcess.alive = true;
        s.lastChildProcessAliveAt = now;
        return;
      }
      // exited / error: an OBSERVATION, recorded as one. Whether it is evidence
      // of death is decided by the transition function, not here.
      s.childProcess = {
        ...s.childProcess,
        pid: info.pid ?? s.childProcess.pid,
        alive: false,
        exited: true,
        exitCode: info.exitCode ?? null,
        exitSignal: info.signal ?? null,
        exitAt: now,
      };
    });
  }

  notePermissionWait(runId: string, since: number | null): void {
    this.touch(runId, (s) => {
      s.permissionWaitSince = since;
      if (since === null) s.lastNetworkEventAt = this.now();
    });
    this.applyWaitingState(runId);
  }

  noteUserInputWait(runId: string, since: number | null): void {
    this.touch(runId, (s) => {
      s.userInputWaitSince = since;
      if (since === null) s.lastNetworkEventAt = this.now();
    });
    this.applyWaitingState(runId);
  }

  /** The run's own stream ended. `abnormal` means it closed without the
   *  terminal `result` the runtime was asked for. */
  noteStreamClosed(runId: string, abnormal: boolean): void {
    this.touch(runId, (s) => {
      s.streamClosedAt = this.now();
      s.streamClosedAbnormally = abnormal;
    });
  }

  noteResultSeen(runId: string): void {
    this.touch(runId, (s) => {
      const now = this.now();
      s.sawResult = true;
      // The turn is finishing normally; a child exit from here on is expected
      // and must not read as evidence (see evaluateLiveness step 2).
      s.lastModelEventAt = now;
    });
  }

  /** The owner asked this run to stop (user cancel, peer interrupt, a
   *  confirmed-dead decision). Anything the runtime does afterwards is a
   *  consequence, not evidence. */
  noteStopRequested(runId: string): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    entry.signals.stopRequested = true;
    entry.updatedAt = this.now();
    this.persist(entry, false);
  }

  // ── state plumbing ───────────────────────────────────────────────────────

  private setState(entry: RunEntry, next: LivenessState, reason: string): void {
    if (entry.state === next) return;
    const previous = entry.state;
    entry.state = next;
    entry.signals.lastStateChangeAt = this.now();
    entry.updatedAt = this.now();
    this.persist(entry, true);
    console.log(
      `[liveness] run=${entry.runId.slice(0, 8)} agent=${entry.agentId.slice(0, 8)} ${previous} → ${next}: ${reason}`,
    );
    const snap = this.snapshotFrom(entry);
    this.opts.onStateChange?.(snap, previous);
  }

  private applyWaitingState(runId: string): void {
    const entry = this.runs.get(runId);
    if (!entry || isTerminalState(entry.state)) return;
    const next = projectLivenessState({
      state: entry.state,
      signals: entry.signals,
      policy: entry.policy,
      now: this.now(),
    });
    if (next !== entry.state) {
      this.setState(entry, next, `wait state changed (${next})`);
    }
  }

  /** The one place a transition is applied. Called after every signal update and
   *  on every tick, so the state cannot depend on which one happened first. */
  private evaluate(entry: RunEntry): void {
    if (isTerminalState(entry.state)) return;
    const now = this.now();
    const decision = evaluateLiveness({
      state: entry.state,
      signals: entry.signals,
      policy: entry.policy,
      now,
    });
    if (decision.action === "terminate") {
      this.terminate(entry, decision.code, decision.reason);
      return;
    }
    if (decision.action === "warn") {
      this.setState(entry, "suspected-stall", decision.reason);
      return;
    }
    if (decision.action === "probe") {
      void this.probe(entry, decision.reason);
      return;
    }
    // No action: the state may still need to follow the signals (a waiting
    // state, or a recovery from a suspicion that activity has answered).
    const projected = projectLivenessState({
      state: entry.state,
      signals: entry.signals,
      policy: entry.policy,
      now,
    });
    if (projected !== entry.state && !isTerminalState(projected)) {
      this.setState(entry, projected, decision.reason);
    }
  }

  private async probe(entry: RunEntry, because: string): Promise<void> {
    if (entry.probing || isTerminalState(entry.state)) return;
    entry.probing = true;
    if (entry.state !== "health-check") this.setState(entry, "health-check", because);
    const answer = await this.runProbe(entry);
    entry.probing = false;
    if (isTerminalState(entry.state)) return;

    const now = this.now();
    entry.signals.lastProbeAt = now;
    entry.signals.lastProbeResult = answer.kind;
    entry.signals.lastProbeReason = answer.reason;
    entry.signals.lastProbeCode = answer.code;
    entry.updatedAt = now;
    this.persist(entry, true);

    if (answer.kind === "dead") {
      // The probe is not the evidence — the probe REPORTS evidence (an exited
      // process, a terminated connection). A probe that cannot distinguish
      // answers `unknown` and never arrives here.
      this.terminate(
        entry,
        "RUNTIME_CONFIRMED_DEAD",
        `health-check probe reported dead: ${answer.reason}`,
      );
      return;
    }
    if (answer.kind === "alive") {
      entry.signals.lastChildProcessAliveAt = now;
      this.setState(entry, "running", `health-check probe found the run alive: ${answer.reason}`);
      return;
    }
    // unknown: stay warned, keep the run, re-check on a bounded interval.
    console.warn(
      `[liveness] run=${entry.runId.slice(0, 8)} agent=${entry.agentId.slice(0, 8)} probe=unknown ` +
        `(${answer.code ?? "no-code"}): ${answer.reason} — the run is NOT terminated`,
    );
    if (entry.state !== "suspected-stall") {
      this.setState(entry, "suspected-stall", `probe unknown; staying warned: ${answer.reason}`);
    }
    this.armRecheck(entry);
  }

  private armRecheck(entry: RunEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    const delay = Math.max(1_000, LIVENESS_UNKNOWN_PROBE_RECHECK_MS);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const live = this.runs.get(entry.runId);
      if (!live || isTerminalState(live.state)) return;
      const quiet = this.now() - lastActivityAt(live.signals);
      if (quiet < live.policy.suspectedAfterMs) {
        this.evaluate(live);
        return;
      }
      void this.probe(live, `scheduled re-check after an unanswerable probe (${delay}ms)`);
    }, delay);
    const t = entry.timer as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  private async runProbe(entry: RunEntry): Promise<{
    kind: LivenessProbeKind;
    reason: string;
    code: string | null;
  }> {
    if (!entry.hooks.probe) {
      return {
        kind: "unknown",
        reason: `runtime "${entry.policy.probe.capability}" exposes no probe on this route (${entry.policy.probe.reason})`,
        code: null,
      };
    }
    try {
      const kind = await Promise.race([
        entry.hooks.probe(),
        new Promise<LivenessProbeKind>((resolve) => {
          const timer = setTimeout(() => resolve("unknown"), LIVENESS_PROBE_TIMEOUT_MS);
          const t = timer as { unref?: () => void };
          if (typeof t.unref === "function") t.unref();
        }),
      ]);
      if (kind === "alive" || kind === "dead" || kind === "unknown") {
        return { kind, reason: `probe answered ${kind}`, code: null };
      }
      return {
        kind: "unknown",
        reason: `probe returned ${JSON.stringify(kind)}, which is not an answer this controller accepts`,
        code: LIVENESS_PROBE_FAILED_CODE,
      };
    } catch (err) {
      // A probe that threw is a FAILED probe, not a dead run.
      return {
        kind: "unknown",
        reason: `the liveness probe itself failed: ${err instanceof Error ? err.message : String(err)}`,
        code: LIVENESS_PROBE_FAILED_CODE,
      };
    }
  }

  private terminate(entry: RunEntry, code: LivenessTerminalReason, reason: string): void {
    if (entry.terminationRequested || isTerminalState(entry.state)) return;
    entry.terminationRequested = true;
    const now = this.now();
    const previous = entry.state;
    entry.state = "confirmed-dead";
    entry.terminalReason = code;
    entry.endedAt = now;
    entry.signals.lastStateChangeAt = now;
    this.persist(entry, true);
    const snapshot = this.snapshotFrom(entry);
    console.warn(`[liveness] TERMINATE run=${entry.runId.slice(0, 8)} code=${code}: ${reason}`);
    this.opts.onStateChange?.(snapshot, previous);
    try {
      this.opts.onTerminate({
        runId: entry.runId,
        agentId: entry.agentId,
        code,
        reason,
        snapshot,
      });
    } finally {
      this.forget(entry.runId);
    }
  }

  private tick(): void {
    for (const entry of [...this.runs.values()]) this.evaluate(entry);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  snapshot(runId: string): LivenessSnapshot | null {
    const entry = this.runs.get(runId);
    return entry ? this.snapshotFrom(entry) : null;
  }

  /** The snapshot for an agent's live run, or null when it has none. */
  snapshotForAgent(agentId: string): LivenessSnapshot | null {
    const ids = this.byAgent.get(agentId);
    if (!ids || ids.size === 0) return null;
    for (const id of ids) {
      const entry = this.runs.get(id);
      if (entry) return this.snapshotFrom(entry);
    }
    return null;
  }

  /** The most recent PERSISTED run for an agent, live or not. This is what lets
   *  `/status` say "the last run did not finish normally" after a restart. */
  lastPersistedForAgent(agentId: string): LivenessSnapshot | null {
    const row = sqliteDb
      .prepare("SELECT * FROM RunLiveness WHERE agentId = ? ORDER BY updatedAt DESC LIMIT 1")
      .get(agentId) as Record<string, unknown> | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  /** Everything the UI needs about an agent in one object. */
  report(agentId: string): {
    live: LivenessSnapshot | null;
    last: LivenessSnapshot | null;
    description: string | null;
  } {
    const live = this.snapshotForAgent(agentId);
    const last = this.lastPersistedForAgent(agentId);
    const subject = live ?? last;
    return {
      live,
      last,
      description: subject ? describeLiveness(subject, this.now()) : null,
    };
  }

  /** The wire projection of a snapshot, taken against THIS controller's clock.
   *
   *  It lives here rather than at the broadcast site because the clock does: a
   *  caller with its own `Date.now()` would put a different `quietMs` on the
   *  wire than the one `/status` prints, and a test that advances the injected
   *  clock would advance nothing. The derivation itself is the one in
   *  capability/liveness.ts — this only supplies the time. */
  updateFor(snapshot: LivenessSnapshot): LivenessUpdate {
    return livenessUpdateOf(snapshot, this.now());
  }

  liveRunIds(): string[] {
    return [...this.runs.keys()];
  }

  /** Startup recovery. A run that was OPEN when the process died did NOT
   *  complete, and saying so is the whole point: an agent may go back to IDLE
   *  (nothing is running), but the record must keep showing that the previous
   *  run ended abnormally, with the signals it had. */
  recoverOrphans(): Array<{ runId: string; agentId: string }> {
    const rows = sqliteDb
      .prepare(
        "SELECT runId, agentId, state, signals, startedAt, updatedAt FROM RunLiveness " +
          "WHERE endedAt IS NULL ORDER BY startedAt ASC",
      )
      .all() as Array<Record<string, unknown>>;
    const recovered: Array<{ runId: string; agentId: string }> = [];
    const now = this.now();
    for (const row of rows) {
      const runId = String(row.runId);
      const agentId = String(row.agentId);
      const signals = JSON.parse(String(row.signals ?? "{}")) as Partial<LivenessSignals>;
      const lastKnown = {
        lastModelEventAt: signals.lastModelEventAt ?? null,
        lastNetworkEventAt: signals.lastNetworkEventAt ?? null,
        lastToolProgressAt: signals.lastToolProgressAt ?? null,
        lastChildProcessAliveAt: signals.lastChildProcessAliveAt ?? null,
        permissionWaitSince: signals.permissionWaitSince ?? null,
        userInputWaitSince: signals.userInputWaitSince ?? null,
        childProcess: signals.childProcess ?? null,
      };
      sqliteDb
        .prepare(
          "UPDATE RunLiveness SET state = ?, terminalReason = ?, endedAt = ?, updatedAt = ?, signals = ? WHERE runId = ?",
        )
        .run(
          "interrupted",
          "RECOVERED_AFTER_RESTART",
          now,
          now,
          JSON.stringify({
            ...signals,
            // The recovered document is written in the CURRENT schema, and it
            // keeps a copy of every signal it had under `lastKnown`: the live
            // fields are re-read on the next boot through the same versioned
            // reader, so a row that started life under an older schema does not
            // get a version it did not earn.
            schemaVersion: LIVENESS_SCHEMA_VERSION,
            recoveredAt: now,
            lastKnown,
            recoveryReason:
              "the core process restarted while this run was open; the run did not finish, and the signals above are the last ones recorded",
          }),
          runId,
        );
      recovered.push({ runId, agentId });
    }
    if (recovered.length > 0) {
      console.warn(
        `[liveness] recovered ${recovered.length} unfinished run(s) as interrupted/recovered: ` +
          recovered.map((r) => `${r.agentId.slice(0, 8)}/${r.runId.slice(0, 8)}`).join(", "),
      );
    }
    return recovered;
  }

  private snapshotFrom(entry: RunEntry): LivenessSnapshot {
    const signals = { ...entry.signals, childProcess: { ...entry.signals.childProcess } };
    return {
      runId: entry.runId,
      agentId: entry.agentId,
      state: entry.state,
      policy: entry.policy,
      signals,
      // Both are DERIVED here rather than stored: they describe what this run
      // has actually wired up, and a stored copy is a copy that can drift.
      fed: fedSignalsOf(signals),
      probeRegistered: typeof entry.hooks.probe === "function",
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      endedAt: entry.endedAt,
      terminalReason: entry.terminalReason,
      persistedSchemaVersion: null,
      signalsMissing: null,
    };
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private persist(entry: RunEntry, force: boolean): void {
    const now = this.now();
    if (!force && now - entry.persistedAt < this.persistEveryMs) return;
    entry.persistedAt = now;
    try {
      sqliteDb
        .prepare(
          `INSERT INTO RunLiveness (runId, agentId, state, policy, signals, startedAt, updatedAt, endedAt, terminalReason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(runId) DO UPDATE SET
             state = excluded.state,
             signals = excluded.signals,
             updatedAt = excluded.updatedAt,
             endedAt = excluded.endedAt,
             terminalReason = excluded.terminalReason`,
        )
        .run(
          entry.runId,
          entry.agentId,
          entry.state,
          // The version travels INSIDE the document: the shape is what changes,
          // and a reader has to be able to tell "this row predates the field"
          // from "the field was observed to be absent".
          JSON.stringify({ schemaVersion: LIVENESS_SCHEMA_VERSION, ...entry.policy }),
          JSON.stringify({ schemaVersion: LIVENESS_SCHEMA_VERSION, ...entry.signals }),
          entry.startedAt,
          now,
          entry.endedAt,
          entry.terminalReason,
        );
    } catch (err) {
      // A liveness record that cannot be written must not take the run down
      // with it — but it is reported, because a silent loss here is what makes
      // a restart's story wrong.
      console.warn(`[liveness] failed to persist run=${entry.runId.slice(0, 8)}: ${(err as Error).message}`);
    }
  }
}

/** Every field a `LivenessSignals` document is expected to carry.
 *
 *  Written out rather than derived from a sample object so that ADDING a field
 *  makes an old row report it as missing instead of silently inheriting
 *  whatever `newLivenessSignals` happens to default to — which is the whole
 *  point of versioning the document. */
const SIGNAL_FIELDS = [
  "startedAt",
  "lastModelEventAt",
  "lastNetworkEventAt",
  "lastToolProgressAt",
  "lastChildProcessAliveAt",
  "permissionWaitSince",
  "userInputWaitSince",
  "lastStateChangeAt",
  "lastProbeAt",
  "lastProbeResult",
  "lastProbeReason",
  "lastProbeCode",
  "childProcess",
  "streamClosedAt",
  "streamClosedAbnormally",
  "sawResult",
  "stopRequested",
] as const;

/** Read a persisted `signals` document WITHOUT pretending it is complete.
 *
 *  A row written by the current schema is believed field for field. A row with
 *  no `schemaVersion` (or an older one) is read field by field too, and every
 *  field it does not carry is (a) given the neutral default so a reader does not
 *  crash on `undefined` and (b) named in `missing`, so `/status` can say "the
 *  record never had this" instead of showing a default that reads like an
 *  observation. */
function readPersistedSignals(raw: unknown, fallbackStartedAt: number): {
  signals: LivenessSignals;
  schemaVersion: number;
  missing: string[];
} {
  const parsed = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const version =
    typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : LIVENESS_LEGACY_SCHEMA_VERSION;
  const missing = SIGNAL_FIELDS.filter((field) => !(field in parsed));
  const base = newLivenessSignals(
    typeof parsed.startedAt === "number" ? parsed.startedAt : fallbackStartedAt,
  );
  const signals: LivenessSignals = {
    ...base,
    ...(parsed as Partial<LivenessSignals>),
    childProcess: {
      ...base.childProcess,
      ...((parsed.childProcess as Partial<LivenessSignals["childProcess"]> | undefined) ?? {}),
    },
  };
  return { signals, schemaVersion: version, missing: [...missing] };
}

function rowToSnapshot(row: Record<string, unknown>): LivenessSnapshot {
  const startedAt = Number(row.startedAt);
  const read = readPersistedSignals(
    (() => {
      try {
        return JSON.parse(String(row.signals ?? "{}"));
      } catch {
        return {};
      }
    })(),
    startedAt,
  );
  let policy: RunPlanLiveness;
  try {
    policy = JSON.parse(String(row.policy ?? "{}")) as RunPlanLiveness;
  } catch {
    policy = JSON.parse("{}") as RunPlanLiveness;
  }
  return {
    runId: String(row.runId),
    agentId: String(row.agentId),
    state: String(row.state) as LivenessState,
    policy,
    signals: read.signals,
    fed: fedSignalsOf(read.signals),
    // A persisted row cannot tell us whether a probe was registered — that is a
    // fact about a process that no longer exists. Reported as `false` with the
    // missing-fields note rather than guessed.
    probeRegistered: false,
    startedAt,
    updatedAt: Number(row.updatedAt),
    endedAt: row.endedAt == null ? null : Number(row.endedAt),
    terminalReason: row.terminalReason == null ? null : (String(row.terminalReason) as LivenessTerminalReason),
    persistedSchemaVersion: read.schemaVersion,
    signalsMissing: read.missing,
  };
}
