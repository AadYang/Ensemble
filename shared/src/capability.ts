// The capability/run-plan contract, shared between the core and every consumer
// of the resolved snapshot (`/status`, the UI, the SDK adapter). See AGENTS.md
// §2.3: a type that crosses the core↔UI boundary lives here, so the two sides
// cannot drift into two slightly different `ResolvedRunPlan`s.
//
// Stage 0 of docs/plans/model-capability-run-plan.md. The types are deliberately
// strict about one thing: "unknown" is a VALUE, not an absence. A capability we
// have not established must be representable and must stay unknown — the plan
// forbids silently falling back to another transport, another model family or a
// conservative hardcoded constant.
//
//   facts        what the model/runtime IS (evidence)
//   constraints  what the runtime proved it CANNOT do (evidence)
//   preferences  what the user WANTS (a choice, not evidence)
//
// A preference may fill a field the facts left unknown — that is the user's
// call. A preference may NOT overrule a constraint, because "I want Responses"
// is not evidence that the endpoint speaks Responses.

/** Where a capability fact came from. This is provenance, NOT priority — the
 *  ordering lives in the core's `CAPABILITY_PRIORITY` and is applied per field. */
export type CapabilityOrigin =
  | "runtime-observed"
  | "provider-discovered"
  | "catalog-confirmed"
  | "catalog-unverified"
  | "legacy-override"
  | "user-declared"
  | "unknown";

/** Confidence in a single field. `observed` (we saw the live runtime report
 *  it) outranks `confirmed` (a vendor documents it), which outranks
 *  `unverified`; `unknown` means we have nothing.
 *
 *  There is deliberately no "declared" rung: a user's wish is not evidence
 *  about the runtime, so a preference that was honoured is reported with
 *  `user-declared` + `unverified` — never `observed`. */
export type CapabilityConfidence =
  | "observed"
  | "confirmed"
  | "unverified"
  | "legacy"
  | "unknown";

/** One rung of the ladder, and what happened to it. Recording the rungs that
 *  LOST is the point: "we used X" without "we did not have Y" is exactly where
 *  a silent fallback hides. */
export interface ConsideredRung {
  origin: CapabilityOrigin;
  outcome: "used" | "absent" | "rejected" | "overruled";
  reason: string;
}

/** A single capability field. `value === undefined` means UNKNOWN, and that is
 *  a complete, honest answer — not a gap to be filled by a default.
 *
 *  This is the sole authority for the field: there is no separate group-level
 *  `source`/`confidence` that a consumer could consult instead and disagree
 *  with. */
export interface ResolvedCapability<T> {
  value: T | undefined;
  origin: CapabilityOrigin;
  confidence: CapabilityConfidence;
  /** Human-readable provenance for THIS field. */
  source: string;
  considered: ConsideredRung[];
}

/** What the runtime IS doing. A fact, or an honest "we have not established it". */
export type RunPlanTransport = "responses" | "chat-completions" | "native-cli" | "unknown";

/** What the user may ASK for: deliberately narrower than `RunPlanTransport`.
 *
 *  `native-cli` is a fact about a runtime we launch, not a transport anyone can
 *  request, and `unknown` is not a choice — so neither can be a preference, and
 *  an HTTP route can no longer end up carrying a `native-cli` identity just
 *  because someone typed it. `auto` asks for no particular transport; the plan
 *  then reports whatever the evidence establishes, which before phase 1
 *  discovery is `unknown` — the only honest answer, and not a contradiction. */
export type TransportPreference = "auto" | "responses" | "chat-completions";

/** Provider+transport+model identity a capability set is keyed by. The plan
 *  requires at least providerScope/runtime/transport/model/version, because
 *  two routes can serve the same model id with different real limits. */
export interface CapabilityScope {
  /** Stable provider record id. Two openai-compat providers can share a model
   *  id, so the model id alone does not identify a route. */
  providerId: string | null;
  providerScope: string;
  runtime: string;
  runtimeVersion: string | null;
  transport: RunPlanTransport;
  modelId: string;
}

/** Tool abilities are separate fields because they fail separately: an endpoint
 *  can call tools fine while refusing to run them in parallel, and built-in
 *  tool availability is a vendor/endpoint fact with nothing to do with either.
 *  Collapsing them into one `supportsTools` would force a guess about two of
 *  the three. */
export interface ToolCapabilities {
  toolCalling: ResolvedCapability<boolean>;
  parallelToolCalls: ResolvedCapability<boolean>;
  /** Vendor-side built-in tools (web search, file search, code interpreter).
   *  `string[]`, so the list itself is the value. */
  builtinTools: ResolvedCapability<string[]>;
  /** MCP servers are ours to attach, so this is about the runtime accepting
   *  them, not about the model. */
  mcp: ResolvedCapability<boolean>;
}

/** How the turn's transport was chosen, and what an automated switch may do.
 *
 *  The transport is BOTH a fact (what the endpoint speaks) and a decision (what
 *  this turn will send), and the two must not be confused: a user's explicit
 *  `responses` is honoured even against a probe that said otherwise, which is
 *  why the request and the fact are recorded side by side here. */
export interface RunPlanTransportPlan {
  /** What the user asked for. `null` = nothing was asked (`auto` is a value of
   *  its own and is preserved as such). */
  requested: TransportPreference | null;
  /** The transport this turn ATTEMPTS. Equals `facts.transport.value` — there is
   *  no second resolution. */
  resolved: RunPlanTransport;
  /** Provenance of `resolved`, copied from the one capability that established
   *  it. `unknown` here means the value is a starting point, not a finding. */
  origin: CapabilityOrigin;
  confidence: CapabilityConfidence;
  /** Whether an automated switch is permitted when the endpoint answers with an
   *  explicit "no such route". Only `auto` may switch: an explicit request is
   *  honoured exactly, including its failures. */
  fallbackAllowed: boolean;
  /** Where a permitted switch goes, `null` when none is permitted. */
  fallbackTarget: RunPlanTransport | null;
  /** Why fallback is or is not permitted. Never empty — the UI has to be able to
   *  explain a switch the user did not ask for. */
  fallbackReason: string;
}

/** What the model/runtime IS. Never contains a preference. */
export interface CapabilityFacts {
  scope: CapabilityScope;
  /** The transport fact for this route, with its provenance. `scope.transport`
   *  carries the same value for scoping/hashing; that one is assigned from this
   *  capability, never derived separately, so the two cannot drift. */
  transport: ResolvedCapability<RunPlanTransport>;
  advertisedContextWindow: ResolvedCapability<number>;
  runtimeEffectiveWindow: ResolvedCapability<number>;
  maxOutputTokens: ResolvedCapability<number>;
  reasoningLevels: ResolvedCapability<string[]>;
  defaultReasoningLevel: ResolvedCapability<string>;
  supportsServerConversation: ResolvedCapability<boolean>;
  supportsNativeCompaction: ResolvedCapability<boolean>;
  tools: ToolCapabilities;
}

/** A NEGATIVE fact the runtime established: this route cannot do X. Kept apart
 *  from positive facts because its role is different — a preference may fill an
 *  UNKNOWN, but it may never erase one of these.
 *
 *  `field` is a KEY OF `UserPreferences` and `forbids` is typed as the values OF
 *  THAT FIELD, because the failure mode here is an inert constraint that looks
 *  enforced: a free-string field plus `unknown[]` lets `"transport.responses"`
 *  (a dotted path, which never matches a preference), a misspelled field, or a
 *  string forbidden on a numeric field all type-check and then block nothing.
 *  With the field keyed, each of those is a compile error. */
export type RuntimeConstraint = {
  [F in keyof UserPreferences]-?: {
    /** The preference field the constraint is about. */
    field: F;
    /** The VALUES established as impossible, compared by identity (`Object.is`).
     *
     *  "Responses is unsupported" is not "no transport is supported": with
     *  `forbids: ["responses"]` a preference for `chat-completions` still applies
     *  on the very endpoint that rejected Responses. OMIT `forbids` only when the
     *  field itself is unusable at any value. */
    forbids?: readonly NonNullable<UserPreferences[F]>[];
    reason: string;
    origin: CapabilityOrigin;
  };
}[keyof UserPreferences];

/** What the user asked for. These are choices, so they are legitimately
 *  authoritative for the fields they name — but they are not evidence about
 *  what the route can do, which is why they cannot overrule a constraint. */
export interface UserPreferences {
  transport?: TransportPreference;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  contextBudget?: number;
  /** A WALL-CLOCK ceiling on one run, in milliseconds. `null` (or absent) means
   *  no ceiling at all, which is the default: silence is not evidence of death,
   *  so nothing but an explicit user decision may terminate a run for taking
   *  too long. When set, reaching it terminates the run with
   *  `RUNTIME_WALL_CLOCK_LIMIT` — a code whose meaning is "the user said so",
   *  never "we gave up". */
  maxRunDurationMs?: number | null;
}

/** Why a preference did not reach the plan. Declared once because the consumer
 *  that shows it (`/status`, the settings dialog) has to be able to tell the
 *  cases apart: "the route cannot do that at any value" is a different problem
 *  from "this model does not have that level", and both differ from a value
 *  clamped below what was asked. */
export type PreferenceRejectionCode =
  | "contradicts-runtime-constraint"
  | "contradicts-established-fact"
  | "contradicts-model-capability";

/** The outcome of intersecting a preference with the facts and constraints. */
export interface AppliedPreference<T> {
  field: string;
  requested: T;
  /** `applied`  — the value is in the plan; the binding that wrote it is the
   *               same call that reported this outcome.
   *  `rejected` — a constraint forbids it; `rejection` says which.
   *  `deferred` — honoured as a decision, but NOTHING consumes it yet. Saying
   *               "applied" here would be a lie the UI then repeats. */
  outcome: "applied" | "rejected" | "deferred";
  /** Present when rejected: a structured reason, never a silent drop.
   *
   *  `contradicts-runtime-constraint` — discovery proved the route cannot do it.
   *  `contradicts-established-fact`  — something already established bounds the
   *  field below what was asked (the runtime IS a native CLI; the model's
   *  published output cap is lower), and a preference does not change that.
   *  `contradicts-model-capability`  — a capability we HOLD says the model does
   *  not have this value (a reasoning level outside its ladder). Distinct from
   *  the first two because nothing was clamped and nothing was blocked: the
   *  request names something that does not exist, and the plan has the list that
   *  proves it. All three mean "the plan does not carry your value"; they differ
   *  in what the plan knows that the user did not. */
  rejection?: {
    code: PreferenceRejectionCode;
    detail: string;
  };
  /** Present when deferred: who will consume the value. `pendingPhase: null`
   *  means no phase is settled — an answer, not a gap, and never a placeholder
   *  phase number that would outlive the doc revision it guessed at. */
  deferred?: { pendingPhase: PendingPhase | null; reason: string };
}

export interface ResolutionDiagnostic {
  /** Dotted path of the fact (`facts.…`) or the preference (`preferences.…`). */
  field: string;
  /** `deferred` means the value is recorded but no consumer exists yet — the
   *  same state `DeferredPlanField` carries, so a UI has one word for it. */
  status: "resolved" | "unknown" | "degraded" | "rejected" | "deferred";
  origin: CapabilityOrigin;
  confidence: CapabilityConfidence;
  detail: string;
  considered?: ConsideredRung[];
}

// ── Liveness: the state machine's vocabulary ───────────────────────────────
//
// Phase 4. The states are shared (not core-internal) because `/status`, the WS
// protocol and the UI all have to name the SAME state for a run: a UI that
// invents its own word for "we stopped it because it was silent" is how a
// suspicion gets read as a verdict.
//
// The split that matters:
//   running / suspected-stall / health-check  — the run is (or may be) alive.
//     A stall is a WARNING. Nothing here is an error, and none of it may end a
//     run on its own.
//   awaiting-permission / awaiting-user-input — a human is being waited on.
//     Stall judgement is PAUSED: the runtime is not slow, it is blocked on us.
//   confirmed-dead / user-cancelled / completed / interrupted — terminal.
//     `confirmed-dead` requires hard evidence (a child process that exited, a
//     stream that closed abnormally, a wall-clock limit the user set). Silence,
//     a missing heartbeat or an unanswerable probe are NOT evidence, and an
//     `unknown` probe never becomes `dead`.

export type LivenessState =
  | "running"
  | "suspected-stall"
  | "health-check"
  | "awaiting-permission"
  | "awaiting-user-input"
  | "confirmed-dead"
  | "user-cancelled"
  | "completed"
  | "interrupted";

/** The states from which a run never moves again. */
export const LIVENESS_TERMINAL_STATES: readonly LivenessState[] = [
  "confirmed-dead",
  "user-cancelled",
  "completed",
  "interrupted",
];

/** Why a run ended. Structured, and never a phrase that could be mistaken for
 *  a different cause: "the process is gone" and "the user set a 30-minute cap"
 *  are different facts about the world. */
export type LivenessTerminalReason =
  | "completed"
  | "user-cancelled"
  /** Hard evidence: the child process exited, or the stream closed abnormally,
   *  while the run still had unfinished business. */
  | "RUNTIME_CONFIRMED_DEAD"
  /** The user configured `maxRunDurationMs` and the run reached it. */
  | "RUNTIME_WALL_CLOCK_LIMIT"
  /** The stream closed with background work still outstanding: not a clean
   *  completion, and not proof the process is gone. */
  | "RUNTIME_STREAM_CLOSED"
  /** Ensemble failed to durably append a turn message. Storage failure is not
   *  evidence that the provider stream died. */
  | "MESSAGE_PERSISTENCE_FAILED"
  /** The core process restarted while the run was open. The run did not
   *  finish; that it did not finish is a fact `/status` must keep showing. */
  | "RECOVERED_AFTER_RESTART";

/** What a probe answered. `unknown` is a complete answer — it means the runtime
 *  cannot observe the thing being asked about, and it may never be read as
 *  `dead`. */
export type LivenessProbeKind = "alive" | "dead" | "unknown";

/** What a runtime can actually observe for a run.
 *
 *  `process` — we launched a child process and hold its handle (Claude via
 *              `spawnClaudeCodeProcess`, Codex via its own spawn): exit is
 *              observable, so silence plus a dead process is real evidence.
 *  `stream`  — the runtime speaks HTTP and holds no process; a broken stream
 *              can be observed, but "no bytes for a while" cannot.
 *  `none`    — nothing is observable. Probe answers are `unknown` by
 *              construction. */
export type LivenessProbeCapability = "process" | "stream" | "none";

/** The signals a runtime can produce for this turn. Kept as a list so a plan
 *  can say what it will actually be able to see, instead of implying the full
 *  set. */
export type LivenessSignalName =
  | "model-event"
  | "network-event"
  | "tool-progress"
  | "child-process"
  | "permission-wait"
  | "user-input-wait";

// ── The wire projection of a run's liveness ────────────────────────────────
//
// What a `liveness_update` event carries. Deliberately a PROJECTION and not the
// snapshot: a snapshot holds the whole `LivenessSignals` document and the whole
// policy, and a client that received those would be free to re-derive "how
// quiet is this run" from its own clock — which is how one run ends up with two
// answers. Every value below is computed ONCE, by the core, against the core's
// own clock.
//
// Every field is required, and that is part of the contract: a client cannot
// tell an omitted field from an observed absence, so there is no such thing as
// an optional field here. A null (`terminalReason`, `hardDeadlineMs`) is a
// VALUE — "this run has no wall-clock ceiling" is an answer, not a gap.

/** One run's liveness as the server measured it. Built by `livenessUpdateOf`
 *  in the core; never recomputed by a consumer. */
export interface LivenessUpdate {
  runId: string;
  state: LivenessState;
  /** Why the run ended, or `null` while it is still live. */
  terminalReason: LivenessTerminalReason | null;
  /** The server's own sentence for this state — the SAME text `/status` shows
   *  (both come from `describeLiveness`), so a UI cannot describe a run
   *  differently from the report it is displaying. Never empty. */
  description: string;
  /** Silence in ms, measured by the server when it built this update. No client
   *  computes this: it is a difference between two clocks, and only one of them
   *  can see the run. */
  quietMs: number;
  /** The threshold `quietMs` is compared against — sent alongside it so the UI
   *  never carries its own copy of the number. */
  suspectedAfterMs: number;
  /** The user's wall-clock ceiling, or `null` for none. */
  hardDeadlineMs: number | null;
  probeCapability: LivenessProbeCapability;
  /** Whether THIS run actually registered a probe. Not the same as the
   *  capability, which only says what the route could observe in principle —
   *  `false` + capability `process` is a wiring bug, and saying so is the
   *  point. */
  probeRegistered: boolean;
  /** The signal channels that have actually delivered for this run. Empty means
   *  every number above is a default, not an observation. */
  fed: LivenessSignalName[];
  /** Epoch ms, from the server's clock. */
  updatedAt: number;
}

/** The turn's liveness policy: phase 4 turned this from a deferred placeholder
 *  into a decision with numbers. One policy per plan, so the watchdog, the
 *  health check and `/status` cannot disagree about when a run is "too quiet". */
export interface RunPlanLiveness {
  status: "resolved";
  reason: string;
  /** How long without a signal before the run is called a SUSPECTED stall.
   *  Reaching it produces a warning and a health check — never a termination. */
  suspectedAfterMs: number;
  /** Where that number came from. `env-compat` means the retired
   *  `ENSEMBLE_RUNTIME_IDLE_TIMEOUT_MS` / `ENSEMBLE_BG_TASK_IDLE_TIMEOUT_MS`
   *  variables were honoured — as suspicion thresholds only, what they now
   *  mean; they can no longer name a kill deadline. */
  suspectedAfterSource: "default" | "env-compat" | "background-task";
  /** How long a suspected stall may persist before the health check runs. */
  healthCheckGraceMs: number;
  /** The user's wall-clock ceiling, or `null` for none. `null` is the default
   *  and means NO wall-clock termination exists. */
  hardDeadlineMs: number | null;
  hardDeadlineSource: "unset" | "user-preference";
  probe: {
    capability: LivenessProbeCapability;
    reason: string;
  };
  /** Which signals this runtime/route can actually supply. */
  signals: LivenessSignalName[];
  diagnostics: string[];
}

// ── The per-turn snapshot ──────────────────────────────────────────────────
//
// `ResolvedRunPlan` is what every consumer reads. It resolves ONCE, at the
// start of the turn; anything downstream that re-derives a value has
// reintroduced the "four different answers in one turn" bug. The core
// deep-freezes it before returning, because "immutable" that only lives in a
// comment is exactly the kind of guarantee that erodes.

/** A plan field that carries an ANSWER instead of a configurable value.
 *
 *  `value` is always `null`, and for `maxModelTurns` that `null` IS the answer:
 *  no model-turn cap. `pendingPhase` names a phase only while machinery is
 *  genuinely still to come; `null` means nothing is owed — a settled record,
 *  never a missing one, and never a placeholder number that would outlive the
 *  doc revision it guessed at. The type name is kept for the shape it
 *  describes; do not read `pendingPhase: null` as "waiting". */
export interface DeferredPlanField {
  value: null;
  /** `null` = this field is settled and no phase is owed. Recorded as an
   *  answer rather than a guess, so a doc revision cannot silently invalidate
   *  it. */
  pendingPhase: PendingPhase | null;
  reason: string;
}

/** Why a project root could not be used. One vocabulary, shared by the write
 *  path (agent create/patch), the turn path (a bound root that vanished) and
 *  the UI, so the same failure reads the same way wherever it surfaces. */
export type ProjectRootErrorCode =
  | "PROJECT_ROOT_NOT_ABSOLUTE"
  | "PROJECT_ROOT_NOT_FOUND"
  | "PROJECT_ROOT_NOT_A_DIRECTORY"
  | "PROJECT_ROOT_UNREADABLE"
  | "PROJECT_ROOT_CONFLICT"
  | "SCRATCH_UNWRITABLE";

/** Where a turn's working directory comes from.
 *
 *  `bound` and `unbound` are different situations, not different spellings of
 *  one: a bound agent has a project the user chose, an unbound one has no
 *  project at all and gets scratch. That is why an unusable root is reported as
 *  `invalid` on a BOUND root instead of quietly degrading to `unbound` — moving
 *  a turn into scratch would write its files where nobody will look for them. */
export interface ResolvedProjectRoot {
  /** The absolute directory the runtimes and the tools actually use. `null`
   *  ONLY together with `invalid`: there is no directory to use, and the turn
   *  is refused rather than pointed somewhere else. */
  value: string | null;
  /** What the agent has configured, verbatim. `null` when the agent is unbound. */
  configuredPath: string | null;
  source: "agent" | "scratch";
  state: "bound" | "unbound";
  /** Set when a configured root failed inspection, or when an unbound agent had
   *  no scratch directory to fall back to. */
  invalid: { code: ProjectRootErrorCode; reason: string } | null;
}

/** What the caller knows about the agent's project root.
 *
 *  The planner itself never touches the filesystem: the caller inspects the
 *  path and reports the verdict, and the plan records it. That keeps the plan a
 *  pure function of its inputs (testable, freezable) and makes "the check ran
 *  once, in the turn that used it" true by construction. */
export interface ProjectRootInput {
  /** The agent's configured root, trimmed, plus the inspection verdict. */
  configured: { path: string; invalid: { code: ProjectRootErrorCode; reason: string } | null } | null;
  /** `DATA_DIR/agents/<agentId>/scratch` — the working directory an unbound
   *  agent uses. Never a guess: the caller owns the data dir. */
  scratchPath: string | null;
}

export interface RunPlanContext {
  /** The runtime's effective ceiling. A preference never writes here: this is
   *  what the session is ACTUALLY running under, not what was asked for. */
  effectiveWindow: number | null;
  /** Capacity value the policy layer permits a runtime adapter to DECLARE.
   *  This is deliberately separate from both the observed effective ceiling
   *  and the vendor-advertised display value. Only confirmed catalog facts on
   *  a runtime whose declaration key has verified semantics can appear here. */
  requestedRuntimeWindow: number | null;
  /** Vendor-advertised capacity, for display and diagnostics only. It must
   *  never drive runtime configuration or local history/token budgets. */
  advertisedContextWindow: number | null;
  /** Output tokens held back from the input budget. A user `maxOutputTokens`
   *  preference lowers it; it can never raise it above the model's published
   *  cap, which is a capability and not a wish. */
  outputReserve: number | null;
  compactionThreshold: number | null;
  /** The user's own ceiling on how many tokens of HISTORY to send, when they
   *  set one. It is a wish about our budget, not a claim about the model, so it
   *  is honoured exactly — it can only lower the derived budget, never raise it
   *  past the window. `null` when unasked. */
  contextBudget: number | null;
}

// ── History and skills: real plan fields, not deferred ones ────────────────
//
// Phase 3 removed the last two "we will figure this out later" placeholders.
// Both are now assembled ONCE, before dispatch, and read from the plan by every
// consumer, so the window the runtime was handed, the tokens the budget was
// measured against, and the numbers `/status` prints are the same numbers.

/** How the turn's prior conversation reaches the model.
 *
 *  `runtime-session`     — a native CLI resumes its own session; the local
 *                          transcript is NOT the context and must not pretend
 *                          to be (no local clipping may silently stand in).
 *  `server-conversation` — the API route reuses a server-side conversation id
 *                          we actually hold AND whose signature still matches.
 *  `local-rebuild`       — we send the transcript we assembled ourselves. */
export type RunPlanHistoryStrategy = "runtime-session" | "server-conversation" | "local-rebuild";

/** How a token number was obtained.
 *
 *  `exact`       — a real local tokenizer measured it.
 *  `estimated`   — the tokenizer was unavailable/returned 0, so the number is
 *                  the explicitly labelled UTF-8 byte upper bound. Never a
 *                  hidden character constant.
 *  `unmeasured`  — nothing was measured because nothing was supplied. */
export type RunPlanTokenCounting = "exact" | "estimated" | "unmeasured";

export interface RunPlanHistoryCounts {
  /** Turns carried verbatim into the model's context this turn. */
  included: number;
  /** Turns left out entirely because a summary covers them. */
  dropped: number;
  /** Turns covered by a ranged summary instead of verbatim. */
  summarized: number;
}

/** A compact generation this turn's context relies on. Recomputable: the
 *  archive holds the ordered originals whose content hash produces `sourceHash`. */
export interface RunPlanHistorySummaryRef {
  generation: number;
  fromSeq: number;
  toSeq: number;
  count: number;
  sourceHash: string;
  summaryVersion: number;
}

export interface RunPlanHistory {
  status: "resolved" | "unavailable";
  strategy: RunPlanHistoryStrategy | null;
  /** Why this strategy, in the user's words: "native resume", "the resume
   *  signature changed", "no server-side conversation id is held", … */
  reason: string;
  /** Tokens available to history after the window, the output reservation, the
   *  system prompt and the actual tool schema were subtracted. `null` when no
   *  window could be established — nothing is dropped on a guess. */
  tokenBudget: number | null;
  measuredTokens: number | null;
  /** What the INCLUDED turns actually cost — not an estimate of the whole
   *  transcript. Pinned turns are counted whatever the budget says (continuity
   *  may not be evicted), so this can exceed `tokenBudget`; that is exactly what
   *  `overBudget` reports. */
  actualIncludedTokens: number;
  /** True when `actualIncludedTokens > tokenBudget`: the turn as assembled does
   *  not fit the window, and dispatching it would send a request the model
   *  cannot hold. Set instead of quietly hoping the estimate was pessimistic. */
  overBudget: boolean;
  counting: RunPlanTokenCounting;
  counts: RunPlanHistoryCounts;
  includedRanges: Array<{ fromSeq: number; toSeq: number }>;
  /** What did NOT fit. Never a silent break: this range is what the ranged
   *  compact path has to cover before the turn can grow again. */
  overflow: { fromSeq: number; toSeq: number; count: number } | null;
  summaries: RunPlanHistorySummaryRef[];
  diagnostics: string[];
}

export interface RunPlanSkillEntry {
  name: string;
  source: string;
  tokens: number | null;
}

export interface RunPlanSkills {
  status: "resolved" | "unavailable";
  reason: string;
  /** Discovered in scope (all sources, before the disabled filter). */
  discovered: number;
  /** Candidates considered for auto-activation this turn. */
  selected: number;
  loaded: number;
  deferred: number;
  unavailable: number;
  loadedSkills: RunPlanSkillEntry[];
  /** Full body did not fit the turn's budget: injected as a short handle and
   *  loadable in full through `skill_invoke`. */
  deferredSkills: Array<RunPlanSkillEntry & { reason: string }>;
  unavailableSkills: Array<RunPlanSkillEntry & { code: string; reason: string }>;
  tokenCost: number | null;
  counting: RunPlanTokenCounting;
  diagnostics: string[];
}

export interface ResolvedRunPlan {
  identity: {
    providerId: string | null;
    providerScope: string;
    runtime: string;
    transport: CapabilityFacts["scope"]["transport"];
    modelId: string;
    runtimeVersion: string | null;
  };
  facts: CapabilityFacts;
  /** Requested vs resolved transport, provenance, and the fallback it permits.
   *  Part of the SAME snapshot as `identity.transport` — a consumer that wants
   *  to explain or override the transport reads it here, not by re-deriving it. */
  transport: RunPlanTransportPlan;
  execution: {
    /** `undefined` when nothing established it OR when the user's choice was
     *  rejected by a constraint. A rejected value must not survive here. */
    reasoningEffort: string | undefined;
    /** Settled: `value: null` means there is no model-turn cap to configure.
     *  The runtimes express it themselves — OpenAI passes `maxTurns: null`,
     *  Claude Code and Codex configure no turn limit. */
    maxModelTurns: DeferredPlanField;
    /** The one working directory the turn runs in — read by every runtime, by
     *  the file/Shell tools and by `/status`, so no consumer can disagree with
     *  another about where the agent is. */
    projectRoot: ResolvedProjectRoot;
  };
  context: RunPlanContext;
  /** The turn's history assembly: strategy, budget, what was included, what
   *  overflowed. Phase 3: a real structure, no longer a deferred placeholder. */
  history: RunPlanHistory;
  /** The turn's skill decision: discovered/selected/loaded/deferred/unavailable
   *  with a token cost each. Phase 3: a real structure. */
  skills: RunPlanSkills;
  /** Phase 4: the liveness policy this turn runs under — thresholds, the hard
   *  deadline (null by default), and what the runtime can actually observe.
   *  The dynamic state (which signal arrived when) is NOT part of the plan: it
   *  changes many times per run and belongs to the LivenessController, whose
   *  snapshot `/status` reports alongside this policy. */
  liveness: RunPlanLiveness;
  /** Per-field provenance + the outcome of every preference. This is the only
   *  authority for "why is this value what it is". */
  diagnostics: ResolutionDiagnostic[];
  preferences: AppliedPreference<unknown>[];
  planHash: string;
  resolvedAt: string;
}

// ── Turn-scoped observation ────────────────────────────────────────────────
//
// A turn id is NOT sufficient on its own. The Codex reader scans the tail of a
// rollout file for the newest `token_count` event; a turn that failed before
// issuing a model request finds no new event and would hand back the previous
// turn's `last_token_usage` — an event that carries no turn id at all, because
// the CLI wrote it for a different turn. Tagging the READER with a turn id
// would not change that; the reader has to know what the artifact looked like
// BEFORE the turn started.

/** What ONE artifact looked like when the turn began.
 *
 *  Two shapes, because the artifact a reading comes from is not always a file
 *  that already exists:
 *
 *    `file`         — we know the path. `size` is its byte length at turn start,
 *                     so an event at or above that offset is this turn's.
 *    `session-file` — the file does not exist yet and its exact name is not
 *                     knowable in advance, but the RUNTIME named it after its
 *                     own session: a fresh Codex rollout is
 *                     `<dir>/…/rollout-<ts>-<thread id>.jsonl`, and the thread
 *                     id arrives with `thread.started`, after the turn began.
 *
 *  A directory listing was tried here first and is NOT enough: without MCP,
 *  several agents share one `~/.codex/sessions`, so "a file that was not there
 *  before" is just as likely to be the rollout another run started in the same
 *  second. Ownership has to come from an identity, and the session id in the
 *  file name is one — it belongs to this run and to no other. */
export type ArtifactMark =
  | {
      kind: "file";
      path: string;
      /** Byte length when the turn began. An event whose `offset` — the byte
       *  where its line STARTS — is below this predates the turn; `offset ===
       *  size` is the first byte of the turn's own first append. */
      size: number;
    }
  | {
      kind: "session-file";
      /** Directory the artifact appears in. An event outside it is not ours. */
      directory: string;
      /** The runtime's own session/thread id for THIS run, as the artifact's
       *  file NAME carries it. */
      sessionId: string;
    };

export interface TurnWatermark {
  turnId: string;
  startedAt: string;
  marks: ArtifactMark[];
}

export interface RawObservationEvent {
  /** Present only when the artifact itself carries turn/run correlation. */
  turnId?: string | null;
  runId?: string | null;
  path: string;
  /** Byte offset of the START of the event within `path`. */
  offset: number;
  field: string;
  value: number | string | boolean;
  observedAt: string;
  source: "runtime-rollout" | "sdk-result" | "provider-response";
}

export interface RunObservation {
  turnId: string;
  field: string;
  value: number | string | boolean;
  observedAt: string;
  source: RawObservationEvent["source"];
}

export type ObservationRejection =
  | { code: "predates-watermark"; detail: string }
  | { code: "foreign-turn"; detail: string }
  | { code: "foreign-run"; detail: string }
  | { code: "no-turn-correlation"; detail: string };

export type ObservationVerdict =
  | { accepted: true; observation: RunObservation }
  | { accepted: false; rejection: ObservationRejection };

export interface RunTelemetry {
  runId: string;
  turnId: string;
  /** Stable hash of the resolved plan this telemetry belongs to. */
  planHash: string;
  resolvedAt: string;
  watermark: TurnWatermark;
  observations: RunObservation[];
  /** Every rejected reading, with why. A rejected observation is a fact about
   *  the run and must be visible, not swallowed. */
  rejections: { event: RawObservationEvent; rejection: ObservationRejection }[];
}

export interface ResolutionRequest {
  providerId?: string | null;
  runtime?: string | null;
  runtimeVersion?: string | null;
  model: string;
  vendor?: string | null;
  /** The transport fact for THIS route, established by whoever could observe the
   *  endpoint (a native CLI launch, the provider kind, or a cached/live probe).
   *  Omitted = not established, which stays `unknown` rather than defaulting to
   *  chat-completions. */
  transportFacts?: ResolvedCapability<RunPlanTransport> | null;
  /** Whether this route has been established as able to continue a
   *  conversation the SERVER stored. Omitted = not established, which stays
   *  `unknown` rather than defaulting to true: claiming a continuation nobody
   *  holds is how history gets dropped. The session layer supplies it because
   *  it is the only layer that knows which endpoint the provider points at and
   *  what the endpoint last said. */
  serverConversationFacts?: ResolvedCapability<boolean> | null;
  /** Live reading for THIS turn, already validated against the turn watermark. */
  sessionObservedWindow?: number | null;
  /** Window we asked the runtime to use, when we declared one. Only used to
   *  detect a clamp; never a source of the value itself. */
  requestedWindow?: number | null;
  preferences?: UserPreferences;
  /** Constraints the runtime established (e.g. discovery proved the endpoint
   *  rejects Responses). */
  constraints?: RuntimeConstraint[];
  /** The agent's working directory for this turn. Omitted = nothing was read,
   *  which the plan reports as an unbound agent without a scratch directory
   *  rather than defaulting to the process's own cwd. */
  projectRoot?: ProjectRootInput | null;
}

export type PendingPhase = 1 | 2 | 3 | 4 | 5;
