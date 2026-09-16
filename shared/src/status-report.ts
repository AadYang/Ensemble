// THE `/status` contract, in one place.
//
// This type used to be declared twice: verbatim inside `core`'s
// `SessionManager.getStatusReport` return annotation, and again — by hand, and
// only partially — in `desktop-ui/lib/agent-api.ts`. The two drifted the way two
// hand-copied declarations always do: the core grew fields (`planView`,
// `runPlanSource`, `history`, `liveness`, `archivedGenerations`, `diagnostics`)
// and the UI copy silently kept the subset somebody had needed at the time, so a
// consumer could not tell "the server does not report this" from "this copy of
// the type never heard about it".
//
// So the report lives here, once, and BOTH sides import it:
//
//   core          `getStatusReport` returns `AgentStatusReport | null`
//   desktop-ui    `lib/agent-api.ts` re-exports it; every consumer (the chat
//                 pane, the settings dialog, the skill panel) reads this object
//                 rather than casting a `Response.json()` to a shape it invented
//
// A `keyof`-level parity assertion in `core` (`__tests__/status-dto-parity.ts`)
// makes the two sides mutually assignable, so the NEXT field the core adds is a
// compile error here instead of a value a surface quietly drops on the floor.
//
// Two leaf shapes are declared structurally below (`StatusLivenessSnapshot`,
// `StatusTransportFallback`) rather than imported, because their owning modules
// are core-internal and moving them would drag `LivenessSignals` and
// `TransportErrorClass` across the boundary with them. They are NOT a second
// source of truth: the parity assertion requires them to be mutually assignable
// with the core's own types in both directions, which is exactly the check that
// makes a duplicate declaration safe to hold.

import type {
  ContextUsage,
  PermissionMode,
  SandboxMode,
} from "./protocol.js";
import type { ReasoningEffort } from "./reasoning.js";
import type {
  LivenessSignalName,
  LivenessState,
  LivenessTerminalReason,
  ResolvedRunPlan,
  RunPlanHistory,
  RunPlanLiveness,
  RunPlanSkills,
  RunPlanTransport,
  TransportPreference,
} from "./capability.js";
import type { ReasoningReport, RunPlanStatusView } from "./run-plan-view.js";

/** One automatic transport switch, as the runtime that made it reported it.
 *  Structural twin of the core's `TransportFallbackInfo` — see the header. */
export interface StatusTransportFallback {
  from: RunPlanTransport;
  to: RunPlanTransport;
  /** Why the switch was permitted at all (from the plan). */
  policyReason: string;
  httpStatus: number | null;
  upstreamCode: string | null;
  upstreamType: string | null;
  classification:
    | "unsupported"
    | "auth"
    | "rate-limit"
    | "network"
    | "server"
    | "request"
    | "unknown";
  at: string;
}

/** A child process the runtime spawned, as far as it can observe it. */
export interface StatusChildProcess {
  pid: number | null;
  started: boolean;
  alive: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  exitAt: number | null;
}

/** Every liveness signal, recorded separately — they fail apart, so they are
 *  reported apart. Structural twin of the core's `LivenessSignals`. */
export interface StatusLivenessSignals {
  startedAt: number;
  lastModelEventAt: number | null;
  lastNetworkEventAt: number | null;
  lastToolProgressAt: number | null;
  lastChildProcessAliveAt: number | null;
  permissionWaitSince: number | null;
  userInputWaitSince: number | null;
  lastStateChangeAt: number;
  lastProbeAt: number | null;
  lastProbeResult: "alive" | "dead" | "unknown" | null;
  lastProbeReason: string | null;
  lastProbeCode: string | null;
  childProcess: StatusChildProcess;
  streamClosedAt: number | null;
  streamClosedAbnormally: boolean;
  sawResult: boolean;
  stopRequested: boolean;
}

/** One run's liveness as the server measured it. Structural twin of the core's
 *  `LivenessSnapshot` — see the header. `runId`/`agentId` are present so a
 *  consumer never has to guess which run a rendered state belongs to. */
export interface StatusLivenessSnapshot {
  runId: string;
  agentId: string;
  state: LivenessState;
  policy: RunPlanLiveness;
  signals: StatusLivenessSignals;
  /** Which signal channels actually delivered for this run. An empty list means
   *  every number above it is a default rather than an observation. */
  fed: LivenessSignalName[];
  probeRegistered: boolean;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  terminalReason: LivenessTerminalReason | null;
  persistedSchemaVersion: number | null;
  /** Signal fields a persisted record did not carry. Non-empty means this is a
   *  legacy row: what it shows for these fields is a default, and it says so
   *  instead of reading as complete. */
  signalsMissing: string[] | null;
}

/** Everything `GET /agents/:id/status` returns, for one agent.
 *
 *  `null` (the route's answer for an unknown id) is a complete answer and is NOT
 *  modelled here: the HTTP layer distinguishes "no such agent" from "here is the
 *  report", and a field that only ever held `null` would blur the two. */
export interface AgentStatusReport {
  name: string;
  providerId: string | null;
  providerName: string | null;
  providerKind: string | null;
  model: string;
  roleSource: "team" | "base" | "empty";
  teamId: string | null;
  roleWeak: boolean;
  permissionMode: PermissionMode;
  sandboxMode: SandboxMode | null;
  effectiveSandboxMode: SandboxMode | null;
  /** Where the effective sandbox came from. `n/a` is the SERVER saying the field
   *  does not apply on this route — a surface that needs to know whether to show
   *  a sandbox at all reads THIS, not the provider kind. */
  sandboxSource: "agent" | "provider" | "default" | "n/a";
  reasoningEffort: ReasoningEffort | null;
  /** Present when the stored value cannot be used (hand-edited / legacy
   *  metadata). Nothing is sent and the stored value is not rewritten — this
   *  only lets the UI say so rather than showing the unusable setting as a
   *  deliberate "inherit". */
  storedReasoningUnusable: { raw: unknown; reason: string } | null;
  /** The agent's configured project root, or null when it is unbound. */
  projectRoot: string | null;
  /** Compatibility echo of `projectRoot` (never the retired column). */
  codexWorkspace: string | null;
  /** The absolute directory the runtimes and tools use. Null only when a
   *  configured root is unusable — `projectRootState.invalid` then carries the
   *  code and the reason, so a bad configuration is REPORTED, not fatal. */
  runtimeCwd: string | null;
  /** The plan's project-root half: configured path, where the value came from
   *  (agent | scratch) and whether the agent is bound. `null` when no plan could
   *  be resolved at all. An absent root is NOT rendered as "unbound": a plan that
   *  never resolved is a different situation from an agent the user left unbound. */
  projectRootState: {
    value: string | null;
    configuredPath: string | null;
    source: "agent" | "scratch";
    state: "bound" | "unbound";
    invalid: { code: string; reason: string } | null;
  } | null;
  systemPromptHash: string;
  storedSystemPromptHash: string | null;
  systemPromptHashMatchesStored: boolean;
  hasResumeInfo: boolean;
  hasCodexResumeSignature: boolean;
  hasCodexUsageSnapshot: boolean;
  closed: boolean;
  messages: number;
  enabledMcpServers: number;
  contextUsage: ContextUsage | null;
  /** THE capability/run-plan view-model, and the only one. `planView` carries
   *  the whole snapshot — identity, transport, reasoning, projectRoot, context,
   *  history, skills, liveness, preferences, diagnostics and the settings rows —
   *  as one object, so a consumer projects it instead of picking fields out of
   *  the flat echo below and inferring the rest from a provider kind or a model
   *  prefix. `null` when no plan could be resolved for this agent (an unknown
   *  provider kind), which is a complete answer.
   *
   *  Built by `runPlanStatusView` in `shared`, never in a consumer: the UI and
   *  the core read the same function, so they cannot drift. */
  planView: RunPlanStatusView | null;
  /** @deprecated Compatibility echo of `planView`, kept so an older client keeps
   *  working. The values below are the SAME objects `planView` holds — not a
   *  second derivation — but a new consumer must read `planView`. */
  runPlan: {
    transport: string;
    transportOrigin: string;
    transportConfidence: string;
    transportSource: string;
    requestedTransport: TransportPreference | null;
    fallbackAllowed: boolean;
    fallbackTarget: string | null;
    fallbackReason: string;
    runtime: string;
    runtimeVersion: string | null;
    reasoning: ReasoningReport;
    planHash: string;
    resolvedAt: string;
    diagnostics: ResolvedRunPlan["diagnostics"];
  } | null;
  /** True when `planView` is a live resolution rather than a turn's own plan —
   *  the two are not equally strong evidence, and the surfaces say which one
   *  they are showing. */
  runPlanSource: "last-turn" | "fresh-resolution" | "none";
  lastTransportFallback: StatusTransportFallback | null;
  /** The turn's history decision, verbatim from the plan: who holds the
   *  conversation, the budget it was measured against, how the numbers were
   *  obtained (exact / estimated / unmeasured), what was included and what
   *  overflowed. Read from `plan.history` — the same object the runtime acted on
   *  — never recomputed here. */
  history: RunPlanHistory | null;
  /** This turn's skill state from `plan.skills`, plus the agent's configured
   *  enable/disable lists. Both come from the SAME sources the turn used, so the
   *  panel cannot show a skill as enabled that selection never saw. */
  skills: {
    turn: RunPlanSkills | null;
    /** `disabledSkills` — never auto-activated. */
    blocked: string[];
    /** `forcedSkills` — always loaded in full, budget or not. */
    forced: string[];
    /** Discovered in this agent's scope (project root included). */
    discovered: number;
    autoActivationEnabled: boolean;
  };
  /** Phase 4: what the liveness controller knows about this agent's run — the
   *  same object the controller acts on and the same one the record keeps, never
   *  a re-derivation from `running` or from the DB status. `live` is the run
   *  happening now (null when there is none); `last` is the most recent
   *  PERSISTED run, which is how `/status` can still say the previous run ended
   *  abnormally after a restart. `description` is the one-line summary, computed
   *  from the same snapshot and never re-worded by a consumer. */
  liveness: {
    live: StatusLivenessSnapshot | null;
    last: StatusLivenessSnapshot | null;
    description: string | null;
    /** The policy the LAST-TURN plan resolved, for the numbers behind the state
     *  above. Present even when `live` is null (there is no run), which is what
     *  makes "what would a stall even mean here" answerable. */
    policy: RunPlanLiveness | null;
  };
  /** The compact generations this agent's history was archived into, newest
   *  first — the read index. Phase 5 shows them read-only: a compacted history
   *  whose originals are invisible reads as data the user lost. */
  archivedGenerations: Array<{
    generation: number;
    fromSeq: number;
    toSeq: number;
    count: number;
    sourceHash: string;
    /** UNIX SECONDS — the unit the archive table stores and the one
     *  `message-archive.ts` reads back (`archivedAtSeconds`). A consumer that
     *  feeds this straight to `new Date()` prints 1970. */
    archivedAt: number;
  }>;
}
