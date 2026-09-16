// Phase 0: the per-turn immutable snapshot.
//
// A run resolves ONCE, at the start of the turn, and every consumer — the
// runtime, the SDK adapter, the history builder, `/status`, the UI — reads that
// same object. `resolveRunPlan` is therefore the only place allowed to consult
// the capability layers during a run; anything downstream that re-derives a
// value has reintroduced the "four different answers in one turn" bug.
//
// IMMUTABILITY IS ENFORCED, NOT DOCUMENTED. The plan is deep-frozen before it
// is returned, because "immutable" that only lives in a comment is exactly the
// kind of guarantee that erodes: a consumer that mutates the snapshot would
// silently change what a later consumer sees in the same turn.
//
// THE PLANNER INTERSECTS THREE DIFFERENT KINDS OF INPUT:
//
//   facts        what the model/runtime IS (evidence)
//   constraints  what the runtime proved it CANNOT do (evidence)
//   preferences  what the user WANTS (a choice, not evidence)
//
// A preference may fill a field the facts left unknown — that is the user's
// call. A preference may NOT overrule a constraint, because "I want Responses"
// is not evidence that the endpoint speaks Responses. Merging the three into a
// single priority chain (`user explicit > observed`) would let a wish fabricate
// a capability, which is the class of bug this plan exists to remove. A
// rejected preference is a structured, visible diagnostic — never a silent
// drop, and never a silent substitution.
//
// PHASE 0 IS SCAFFOLD-ONLY. The plan carries the fields phases 1-4 will act on
// but leaves the ones whose values are not yet established as explicit
// unknowns naming the phase that will fill them.

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { requestedRuntimeWindow, vendorScopeForModel } from "../context-window.js";

// The reasoning token rule is a VALUE, and it is consumed here, at the HTTP
// schema, at the metadata reader and in the runtime adapters. One definition
// (`@agentorch/shared`), so a level that types cleanly cannot be one the
// planner refuses or the Codex adapter would quote differently.
import { parseReasoningChoice } from "@agentorch/shared";

import { resolveModelCapabilities } from "./model-capabilities.js";
import { unavailablePlanHistory } from "./history-budget.js";
import { resolveLivenessPolicy } from "./liveness.js";
import { siblingTransport } from "./transport-errors.js";
// `ResolvedRunPlan` and the plan shapes it is built from are re-exported from
// `@agentorch/shared` (AGENTS.md §2.3): `/status` and the UI resolve against the
// same object the runtime executes, so the shape is declared once.
import type {
  AppliedPreference,
  ArtifactMark,
  CapabilityConfidence,
  CapabilityFacts,
  CapabilityOrigin,
  DeferredPlanField,
  ObservationVerdict,
  PendingPhase,
  PreferenceRejectionCode,
  ProjectRootInput,
  RawObservationEvent,
  ResolutionDiagnostic,
  ResolutionRequest,
  ResolvedCapability,
  ResolvedProjectRoot,
  ResolvedRunPlan,
  RunObservation,
  RunPlanHistory,
  RunPlanLiveness,
  RunPlanSkills,
  RunPlanTokenCounting,
  RunPlanTransport,
  RunPlanTransportPlan,
  RuntimeConstraint,
  RunTelemetry as Telemetry,
  TransportPreference,
  TurnWatermark,
  UserPreferences,
} from "./types.js";

function deferred(phase: PendingPhase | null, reason: string): DeferredPlanField {
  return { value: null, pendingPhase: phase, reason };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** Canonical JSON: keys sorted, so the hash depends on the CONTENT and not on
 *  property insertion order. Without this a refactor that reorders fields would
 *  invalidate every stored hash for no reason. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function hashPlan(plan: Omit<ResolvedRunPlan, "planHash">): string {
  return createHash("sha256").update(canonical(plan)).digest("hex");
}

/** What a consumer binding resolved to: the value the PLAN carries for that
 *  field, and whether that value is what the user asked for. */
interface PreferenceResolution {
  value: unknown;
  /** False when the plan's value is NOT the one requested. The value still goes
   *  into the plan — the plan has to carry something — but the preference is
   *  reported as rejected, because reporting `applied` for a value the user did
   *  not ask for is the silent substitution this planner exists to remove. */
  honoured: boolean;
  /** Why the plan does not carry the request, or a caveat worth showing when it
   *  does (`auto` resolving to nothing, say). */
  note?: string;
  /** Which structured rejection this is. Defaults to
   *  `contradicts-established-fact`, which is right for a value that was
   *  clamped by a fact the plan already had; a binding that refuses for a
   *  different reason names it, so the reasons stay distinguishable downstream
   *  instead of collapsing into one "rejected" string. */
  rejectionCode?: PreferenceRejectionCode;
}

/** How a preference reaches the plan.
 *
 *  A binding is the WRITE itself, not a label describing one: it returns the
 *  value the plan puts in that field, and the planner reads the value from the
 *  same call. So there is no way to report `applied` for a field nothing
 *  consumes — a binding that does not exist produces no value, and the field
 *  would be empty. (`PREFERENCE_BINDINGS` is keyed by `UserPreferences`, so a
 *  new preference cannot be added without answering this question.) */
type PreferenceBinding =
  | { kind: "consumer"; resolve: (requested: unknown, facts: CapabilityFacts) => PreferenceResolution }
  | {
      /** Nothing consumes this preference yet. It is accepted and VISIBLE, but
       *  it is not applied; `pendingPhase` says who will pick it up, and is
       *  `null` until that is settled. */
      kind: "deferred";
      pendingPhase: PendingPhase | null;
      reason: string;
    };

const REQUESTABLE_TRANSPORTS: readonly TransportPreference[] = [
  "auto",
  "responses",
  "chat-completions",
];

/** The transport the plan runs under.
 *
 *  A fact the runtime established wins: a native CLI is spoken to by launching
 *  it, and no preference changes that. Otherwise the user's choice fills an
 *  unknown — that is their call on a compat endpoint whose capabilities we have
 *  not probed. `auto` chooses nothing, which is a complete answer and the only
 *  honest one before phase 1 discovery, so it is honoured by definition. */
function resolveTransport(requested: unknown, facts: CapabilityFacts): PreferenceResolution {
  const fact = facts.transport.value ?? "unknown";
  const pref = REQUESTABLE_TRANSPORTS.includes(requested as TransportPreference)
    ? (requested as TransportPreference)
    : undefined;

  // A value outside `TransportPreference` can still arrive — a config file, a
  // cast, an older client. Refusing it is what keeps `runtime: "openai"` with
  // `transport: "native-cli"` unbuildable even when the type system is bypassed.
  if (requested !== undefined && pref === undefined) {
    return {
      value: fact,
      honoured: false,
      note: `"${String(requested)}" is not a transport a user can request; it is a fact about the runtime, or the absence of one`,
    };
  }
  if (fact !== "unknown") {
    if (pref === undefined || pref === "auto" || pref === fact) return { value: fact, honoured: true };
    return {
      value: fact,
      honoured: false,
      note: `the runtime is already "${fact}"; a preference does not change what it is`,
    };
  }
  if (pref === undefined || pref === "auto") {
    return {
      value: "unknown",
      honoured: true,
      // The fact carries why it is unknown; repeating it here would be a second
      // explanation of one state, and the two would drift.
      note: "no transport has been established for this route yet, and this is not a default",
    };
  }
  return { value: pref, honoured: true };
}

/** The reasoning level: three different questions, three different answers.
 *
 *  1. SYNTAX. A level is interpolated into Codex's TOML, into `-c key="…"`
 *     argv and into a JSON body, so an illegal token is refused here even when
 *     it arrived from a hand-edited metadata file or an older client. The
 *     refusal is structured and visible — never a silent drop.
 *  2. MEMBERSHIP, when the model's ladder is KNOWN. Inside the ladder the value
 *     is applied; outside it the plan does NOT carry it and the rejection names
 *     the requested level, the supported levels, the model and the source.
 *     Silently substituting a supported level would be the exact class of
 *     "helpful" fallback this plan exists to remove.
 *  3. MEMBERSHIP, when the ladder is UNKNOWN. An open, syntactically valid token
 *     is allowed through as user-declared/unverified — the honest answer, since
 *     we cannot say the model lacks it. `unknown` must never be read as
 *     "unsupported".
 *
 *  `undefined` (nothing asked, or an explicit "inherit" — the same state) sends
 *  no parameter at all and is always honoured. */
function resolveReasoningEffort(requested: unknown, facts: CapabilityFacts): PreferenceResolution {
  if (requested === undefined) {
    return {
      value: undefined,
      honoured: true,
      note: 'inherit: no reasoning parameter is sent, so the runtime/provider default applies',
    };
  }
  const parsed = parseReasoningChoice(requested);
  if (parsed.kind === "invalid") {
    return { value: undefined, honoured: false, note: parsed.reason };
  }
  if (parsed.kind === "clear") {
    return { value: undefined, honoured: true, note: parsed.reason };
  }
  const known = facts.reasoningLevels.value;
  const model = facts.scope.modelId;
  if (known === undefined) {
    return {
      value: parsed.level,
      honoured: true,
      note:
        `the reasoning levels of "${model}" are not established ` +
        `(${facts.reasoningLevels.source}), so this is carried as user-declared and ` +
        "sent unverified — not as a supported level",
    };
  }
  if (known.includes(parsed.level)) {
    return { value: parsed.level, honoured: true };
  }
  return {
    value: undefined,
    honoured: false,
    rejectionCode: "contradicts-model-capability",
    note:
      `model "${model}" supports ${known.join(", ")} (${facts.reasoningLevels.source}); ` +
      `"${parsed.level}" is not one of them`,
  };
}

/** The reservation held back for output.
 *
 *  The published cap is a FACT about the model; the reservation is a REQUEST. A
 *  user may ask for less, or fill in a cap we do not know — but never for more
 *  than the model can emit. Asking for more is not honoured: the plan carries
 *  the cap, and the clamp is the reason the preference is reported rejected. */
function resolveOutputReserve(requested: unknown, facts: CapabilityFacts): PreferenceResolution {
  const cap = facts.maxOutputTokens.value;
  if (requested === undefined) return { value: cap ?? null, honoured: true };
  const asked = requested as number;
  if (cap === undefined) return { value: asked, honoured: true };
  if (asked > cap) {
    return {
      value: cap,
      honoured: false,
      note: `the model's published output cap is ${cap} tokens, so the reservation is clamped to it`,
    };
  }
  return { value: asked, honoured: true };
}

/** The user's own ceiling on the history we send.
 *
 *  Nothing to clamp against: this is a request about our own budget, so it is
 *  carried verbatim and applied by the history resolver as an upper bound. A
 *  preference that cannot be contradicted by a fact does not need a rejection
 *  path — inventing one would report a conflict where there is none. */
function resolveContextBudget(requested: unknown): PreferenceResolution {
  if (requested === undefined) return { value: null, honoured: true };
  const asked = Number(requested);
  if (!Number.isFinite(asked) || asked <= 0) {
    return {
      value: null,
      honoured: false,
      rejectionCode: "contradicts-established-fact",
      note: `a history budget must be a positive token count; ${JSON.stringify(requested)} is not one, so no budget was carried`,
    };
  }
  return { value: Math.floor(asked), honoured: true };
}

/** The user's wall-clock ceiling on a single run.
 *
 *  `null`/absent means NO ceiling, which is the default and the point of the
 *  phase-4 rule: silence is not evidence, so nothing but an explicit user
 *  decision may end a run for taking too long. A value has to be a positive
 *  number of milliseconds to be honoured; anything else is rejected rather than
 *  coerced, because a deadline the user did not type is worse than no deadline.
 *  (The HTTP/WS layer validates the same shape on write; this is the planner's
 *  own guarantee that what it carries came from the user.) */
function resolveMaxRunDuration(requested: unknown): PreferenceResolution {
  if (requested === undefined || requested === null) return { value: null, honoured: true };
  const asked = Number(requested);
  if (!Number.isFinite(asked) || asked <= 0) {
    return {
      value: null,
      honoured: false,
      rejectionCode: "contradicts-established-fact",
      note:
        `a run deadline must be a positive number of milliseconds or null; ` +
        `${JSON.stringify(requested)} is neither, so no wall-clock deadline was carried`,
    };
  }
  return { value: Math.floor(asked), honoured: true };
}

const PREFERENCE_BINDINGS: Record<keyof UserPreferences, PreferenceBinding> = {
  transport: { kind: "consumer", resolve: resolveTransport },
  reasoningEffort: { kind: "consumer", resolve: resolveReasoningEffort },
  maxOutputTokens: { kind: "consumer", resolve: resolveOutputReserve },
  // Phase 3 gave the token budget an owner, so this preference finally has a
  // consumer: the history budget resolver takes the SMALLER of the window it
  // derived and this request. It is a wish about how much history WE send, not a
  // claim about what the model can hold, so nothing here can contradict a fact.
  contextBudget: { kind: "consumer", resolve: resolveContextBudget },
  // Phase 4: a run may be ended for taking too long ONLY because the user said
  // so. Nothing else reads this value — no idle timer, no watchdog — and
  // `null` (the default) is a complete, honoured answer meaning "no ceiling".
  maxRunDurationMs: { kind: "consumer", resolve: resolveMaxRunDuration },
};

/** Does this constraint forbid THIS value?
 *
 *  A constraint that names values must not take the whole field down with it:
 *  "this endpoint does not speak Responses" leaves Chat Completions perfectly
 *  available, and rejecting both would be the same class of silent
 *  over-constraint as inventing a capability. `forbids` omitted means the field
 *  itself is unusable at any value. */
function forbidsValue(constraint: RuntimeConstraint, requested: unknown): boolean {
  // Widened deliberately: the constraint's values are narrowed to the field it
  // names, and the request here is `unknown` until the field has been matched.
  const forbids: readonly unknown[] | undefined = constraint.forbids;
  if (forbids === undefined) return true;
  return forbids.some((forbidden) => Object.is(forbidden, requested));
}

/** Turn one preference outcome into a diagnostic.
 *
 *  `note` carries what the planner had to do to the value — a decision the user
 *  cannot see is a decision they cannot correct. */
function preferenceDiagnostic(
  applied: AppliedPreference<unknown>,
  note?: string,
): ResolutionDiagnostic {
  const suffix = note ? `; ${note}` : "";
  if (applied.outcome === "rejected") {
    return {
      field: `preferences.${applied.field}`,
      status: "rejected",
      origin: "user-declared",
      confidence: "unknown",
      detail: applied.rejection!.detail,
    };
  }
  if (applied.outcome === "deferred") {
    // No "(phase N)" when no phase is settled — naming one would be the exact
    // guess this deferred record exists to avoid.
    const phase = applied.deferred!.pendingPhase;
    const when = phase === null ? "" : ` (phase ${phase})`;
    return {
      field: `preferences.${applied.field}`,
      status: "deferred",
      origin: "user-declared",
      confidence: "unverified",
      detail: `accepted, but ${applied.deferred!.reason}${when}`,
    };
  }
  // `unverified`, never `observed`: the user asked, we honoured it, and that is
  // still not evidence about what the route can do.
  return {
    field: `preferences.${applied.field}`,
    status: "resolved",
    origin: "user-declared",
    confidence: "unverified",
    detail: `the user asked for ${JSON.stringify(applied.requested)}${suffix}`,
  };
}

/** Whether an automated transport switch is permitted, and why.
 *
 *  The rule is short: ONLY `auto` may switch. A user who asked for `responses`
 *  gets `responses`, and if the endpoint has no such route they get the
 *  structured failure — silently sending it somewhere else is the exact
 *  substitution the plan exists to remove. A `native-cli` route has no sibling,
 *  and `unknown` is not a transport to switch away from. */
function transportPolicy(
  requested: unknown,
  resolved: RunPlanTransport,
  provenance: { origin: CapabilityOrigin; confidence: CapabilityConfidence },
): RunPlanTransportPlan {
  const asked = REQUESTABLE_TRANSPORTS.includes(requested as TransportPreference)
    ? (requested as TransportPreference)
    : null;
  const auto = asked === null || asked === "auto";
  const target = siblingTransport(resolved);
  const fallbackAllowed = auto && target !== null;
  // The transport this turn runs under is the RESOLVED value — the very one
  // `identity.transport` carries — never a second read of the fact. Recomputing
  // it here is how a user's explicit choice used to survive into `identity` while
  // the runtime (which reads THIS field) was handed "unknown" and refused the
  // turn: two answers to one question, one of them unusable. Provenance is
  // passed in by the caller, which is the only place that knows whether the
  // value came from the user's declaration or from the endpoint.
  let fallbackReason: string;
  if (!auto) {
    fallbackReason = `the user asked for "${asked}"; an explicit transport is honoured exactly, including its failures, so no automatic switch is permitted`;
  } else if (target === null) {
    fallbackReason = `"${resolved}" has no sibling HTTP transport to switch to`;
  } else {
    fallbackReason = `the user asked for no particular transport, so an explicit "this endpoint has no such route" answer may switch ${resolved} → ${target}`;
  }
  return {
    requested: asked,
    resolved,
    origin: provenance.origin,
    confidence: provenance.confidence,
    fallbackAllowed,
    fallbackTarget: fallbackAllowed ? target : null,
    fallbackReason,
  };
}

/** Resolve the turn's working directory from what the caller inspected.
 *
 *  Exported because it is a rule, not an implementation detail: "a bound root
 *  that cannot be used is NOT the same as an unbound agent" is exactly the
 *  distinction a caller would otherwise re-invent (and get wrong by falling
 *  back to scratch). */
export function resolveProjectRoot(input: ProjectRootInput | null | undefined): ResolvedProjectRoot {
  const configured = input?.configured ?? null;
  if (configured) {
    return {
      value: configured.invalid ? null : configured.path,
      configuredPath: configured.path,
      source: "agent",
      state: "bound",
      invalid: configured.invalid,
    };
  }
  const scratch = input?.scratchPath ?? null;
  if (scratch === null) {
    return {
      value: null,
      configuredPath: null,
      source: "scratch",
      state: "unbound",
      invalid: {
        code: "SCRATCH_UNWRITABLE",
        reason:
          "the agent is not bound to a project root and no scratch directory was resolved for it; " +
          "a turn must not run in the process's own working directory",
      },
    };
  }
  return { value: scratch, configuredPath: null, source: "scratch", state: "unbound", invalid: null };
}

export interface ResolveRunPlanOptions extends ResolutionRequest {
  runId?: string;
  turnId?: string;
  compactionThreshold?: number | null;
  /** The silence threshold, when a compatibility entry point
   *  (`ENSEMBLE_RUNTIME_IDLE_TIMEOUT_MS` / `ENSEMBLE_BG_TASK_IDLE_TIMEOUT_MS`)
   *  supplies one. It reaches the plan as a SUSPICION threshold and nothing
   *  else: crossing it warns and starts a health check, and it can never end a
   *  run. Typed as an object rather than a number so the source travels with the
   *  value and `/status` can say where the number came from. */
  livenessSuspectedAfterMs?: { value: number; source: RunPlanLiveness["suspectedAfterSource"] };
  now?: () => Date;
}

export function resolveRunPlan(opts: ResolveRunPlanOptions): ResolvedRunPlan {
  const { facts, diagnostics: factDiagnostics } = resolveModelCapabilities(opts);
  const now = opts.now ?? (() => new Date());
  const constraints = opts.constraints ?? [];
  const prefs: UserPreferences = opts.preferences ?? {};

  const fields = Object.keys(PREFERENCE_BINDINGS) as (keyof UserPreferences)[];

  // A constraint wins outright: discovery proved the route cannot do it. One
  // predicate, used for both the label and the VALUE below, so a refused request
  // cannot leak into the plan through the back door.
  const blockingConstraint = (
    field: keyof UserPreferences,
    requested: unknown,
  ): RuntimeConstraint | undefined =>
    constraints.find((c) => c.field === field && forbidsValue(c, requested));

  // Every consumer binding is resolved ONCE: the plan reads its value from here,
  // so no path exists on which a field is labelled from one value and carries
  // another. A blocked request is resolved as if the user had asked for nothing
  // — otherwise the plan would carry the very value it just refused.
  const resolutions = new Map<keyof UserPreferences, PreferenceResolution>();
  for (const field of fields) {
    const binding = PREFERENCE_BINDINGS[field];
    if (binding.kind !== "consumer") continue;
    const requested = blockingConstraint(field, prefs[field]) ? undefined : prefs[field];
    resolutions.set(field, binding.resolve(requested, facts));
  }
  const valueOf = <T>(field: keyof UserPreferences): T => resolutions.get(field)!.value as T;

  const preferences: AppliedPreference<unknown>[] = [];
  for (const field of fields) {
    const requested = prefs[field];
    if (requested === undefined) continue;
    const blocking = blockingConstraint(field, requested);
    if (blocking) {
      preferences.push({
        field,
        requested,
        outcome: "rejected",
        rejection: {
          code: "contradicts-runtime-constraint",
          detail: `${blocking.reason} (established by ${blocking.origin})`,
        },
      });
      continue;
    }
    const binding = PREFERENCE_BINDINGS[field];
    if (binding.kind === "deferred") {
      preferences.push({
        field,
        requested,
        outcome: "deferred",
        deferred: { pendingPhase: binding.pendingPhase, reason: binding.reason },
      });
      continue;
    }
    const resolution = resolutions.get(field)!;
    preferences.push(
      resolution.honoured
        ? { field, requested, outcome: "applied" }
        : {
            field,
            requested,
            outcome: "rejected",
            rejection: {
              code: resolution.rejectionCode ?? "contradicts-established-fact",
              detail: resolution.note ?? "the plan does not carry the requested value",
            },
          },
    );
  }

  const plan = {
    identity: {
      providerId: facts.scope.providerId,
      providerScope: facts.scope.providerScope,
      runtime: facts.scope.runtime,
      transport: valueOf<RunPlanTransport>("transport"),
      modelId: facts.scope.modelId,
      runtimeVersion: facts.scope.runtimeVersion,
    },
    facts,
    // Read from the SAME capability `identity.transport` was written from, so
    // the requested/resolved pair and the fallback it permits describe the turn
    // that actually runs.
    // Same value this plan's `identity.transport` carries, read from the same
    // binding resolution — one answer, two views of it.
    transport: transportPolicy(
      prefs.transport,
      valueOf<RunPlanTransport>("transport"),
      // Who supplied that value. The fact, whenever it has one — including the
      // compat baseline, which is `unknown`/`unknown` and must not read as a
      // user's decision. Only when the fact has NO value can an explicit,
      // requestable choice be what filled it, and a user's word is `unverified`
      // by construction: asking for Responses never proves the endpoint speaks
      // it.
      facts.transport.value === undefined && valueOf<RunPlanTransport>("transport") !== "unknown"
        ? { origin: "user-declared", confidence: "unverified" }
        : { origin: facts.transport.origin, confidence: facts.transport.confidence },
    ),
    execution: {
      // Read from the same call that decided the preference's outcome: a
      // rejected `reasoningEffort` cannot survive here, because the value comes
      // from the binding, not from `prefs`.
      reasoningEffort: valueOf<string | undefined>("reasoningEffort"),
      // SETTLED, not waiting on a phase: the plan's answer for model turns is
      // "no cap". `value: null` is that answer — not a placeholder a later
      // phase fills — and `pendingPhase: null` says no phase is owed. Each
      // runtime says it in its own vocabulary: OpenAI passes `maxTurns: null`
      // explicitly (leaving it undefined lets the SDK substitute its own
      // DEFAULT_MAX_TURNS = 10), while Claude Code and Codex configure no turn
      // limit at all. What bounds a runaway run is cancellation, loop
      // detection, the liveness policy and the optional hard deadline — never
      // a model-turn number.
      maxModelTurns: deferred(
        null,
        "no model-turn cap: the OpenAI runtime passes maxTurns: null explicitly, and the Claude Code and Codex runtimes configure no turn limit; termination is the liveness policy's and the optional hard deadline's business",
      ),
      projectRoot: resolveProjectRoot(opts.projectRoot),
    },
    context: {
      effectiveWindow: facts.runtimeEffectiveWindow.value ?? null,
      requestedRuntimeWindow: requestedRuntimeWindow(opts.model, {
        runtime: facts.scope.runtime,
        vendor: opts.vendor?.trim() || vendorScopeForModel(opts.model),
        runtimeVersion: facts.scope.runtimeVersion,
        providerId: facts.scope.providerId,
      }),
      advertisedContextWindow: facts.advertisedContextWindow.value ?? null,
      outputReserve: valueOf<number | null>("maxOutputTokens"),
      compactionThreshold: opts.compactionThreshold ?? null,
      contextBudget: valueOf<number | null>("contextBudget"),
    },
    // Both of these are filled by the turn before any consumer sees the plan
    // (see attachPlanHistory / attachPlanSkills). Resolving them here would
    // mean the planner reading the message table and the skill registry, which
    // is exactly the kind of I/O the planner is forbidden to do; leaving them
    // as deferred placeholders now would mean the turn could run without a
    // budget and nothing would say so. `unavailable` is the honest third state:
    // a real structure that names what is missing.
    history: unavailablePlanHistory(
      "the turn has not supplied its history facts yet; the session layer resolves the budget and attaches it before dispatch",
    ),
    skills: unavailablePlanSkills(
      "the turn has not supplied its skill candidates yet; the session layer selects them and attaches the decision before dispatch",
    ),
    // Phase 4: the POLICY (thresholds, the probe the runtime can offer, the
    // user's ceiling) is resolved here, alongside every other number the run
    // obeys. The live STATE — running / suspected-stall / health-check — is
    // deliberately NOT in the plan: it changes many times per minute, and a plan
    // that carried it would have to be rebuilt (and re-hashed) on every stream
    // chunk. The LivenessController owns that, and `/status` reads its snapshot.
    liveness: resolveLivenessPolicy({
      runtime: facts.scope.runtime,
      hardDeadlineMs: valueOf<number | null>("maxRunDurationMs"),
      suspectedAfterMs: opts.livenessSuspectedAfterMs?.value,
      suspectedAfterSource: opts.livenessSuspectedAfterMs?.source,
    }),
    diagnostics: [
      ...factDiagnostics,
      ...preferences.map((p) =>
        preferenceDiagnostic(
          p,
          p.outcome === "applied" ? resolutions.get(p.field as keyof UserPreferences)?.note : undefined,
        ),
      ),
    ],
    preferences,
    resolvedAt: now().toISOString(),
  } satisfies Omit<ResolvedRunPlan, "planHash">;

  return deepFreeze({ ...plan, planHash: hashPlan(plan) });
}

/** A plan field the turn has not filled yet.
 *
 *  Distinct from a deferred field: nothing about it is undecided, it is simply
 *  not this module's to know. The turn attaches the real value (or the plan
 *  keeps saying "unavailable", which is a fact a reader can act on) before the
 *  runtime is dispatched. */
export function unavailablePlanSkills(reason: string): RunPlanSkills {
  return {
    status: "unavailable",
    reason,
    discovered: 0,
    selected: 0,
    loaded: 0,
    deferred: 0,
    unavailable: 0,
    loadedSkills: [],
    deferredSkills: [],
    unavailableSkills: [],
    tokenCost: null,
    counting: "unmeasured",
    diagnostics: [reason],
  };
}

/** The shape the skills layer produces, structurally typed so this module can
 *  record the decision without depending on the registry's implementation. */
export interface SkillSelectionLike {
  discovered: number;
  selected: number;
  tokens: number;
  counting: RunPlanTokenCounting;
  diagnostics: string[];
  loaded: Array<{ name: string; source: string; tokens: number | null }>;
  deferred: Array<{ name: string; source: string; reason: string; tokenCost: number | null }>;
  unavailable: Array<{
    name: string;
    source: string;
    code: string;
    reason: string;
    /** Present on SKILL_BUDGET_EXCEEDED: what the body would have cost. A
     *  refusal without the number is a refusal nobody can act on. */
    tokenCost?: number;
    availableBudget?: number;
  }>;
}

/** Record a turn's skill decision in the plan. Pure mapping — one place where
 *  "what the picker decided" becomes "what /status prints". */
export function planSkillsFromSelection(sel: SkillSelectionLike, reason: string): RunPlanSkills {
  return {
    status: "resolved",
    reason,
    discovered: sel.discovered,
    selected: sel.selected,
    loaded: sel.loaded.length,
    deferred: sel.deferred.length,
    unavailable: sel.unavailable.length,
    loadedSkills: sel.loaded.map((s) => ({ name: s.name, source: s.source, tokens: s.tokens })),
    deferredSkills: sel.deferred.map((s) => ({
      name: s.name,
      source: s.source,
      tokens: s.tokenCost,
      reason: s.reason,
    })),
    unavailableSkills: sel.unavailable.map((s) => ({
      name: s.name,
      source: s.source,
      // The cost the body WOULD have had, when the refusal was about its size.
      tokens: s.tokenCost ?? null,
      code: s.code,
      reason:
        s.availableBudget === undefined
          ? s.reason
          : `${s.reason} (available budget ${s.availableBudget} tokens)`,
    })),
    tokenCost: sel.tokens,
    counting: sel.counting,
    diagnostics: sel.diagnostics,
  };
}

/** Return the same plan with the turn's skill decision attached.
 *
 *  The plan is resolved once and then EXTENDED once, before dispatch — never
 *  re-derived by a consumer. The object stays deeply frozen and `planHash` is
 *  recomputed over the value that is actually executed, so a hash taken from
 *  the plan the runtime received matches the plan the UI can print. */
export function attachPlanSkills(plan: ResolvedRunPlan, skills: RunPlanSkills): ResolvedRunPlan {
  if (plan.skills.status === "resolved") {
    throw new Error("attachPlanSkills: this plan's skills are already resolved");
  }
  const { planHash: _previous, ...rest } = plan;
  const next = { ...rest, skills };
  return deepFreeze({ ...next, planHash: hashPlan(next) });
}

/** Return the same plan with the turn's history budget attached. See
 *  `attachPlanSkills` for why this is an extension of one resolution rather
 *  than a second resolution. */
export function attachPlanHistory(plan: ResolvedRunPlan, history: RunPlanHistory): ResolvedRunPlan {
  if (plan.history.status === "resolved") {
    throw new Error("attachPlanHistory: this plan's history is already resolved");
  }
  const { planHash: _previous, ...rest } = plan;
  const next = { ...rest, history };
  return deepFreeze({ ...next, planHash: hashPlan(next) });
}

/** Read a required capability, or throw with the field's own provenance. A
 *  consumer that cannot proceed without a value must say WHICH fact it lacked
 *  and why — a bare `undefined` at a call site is how an unknown turns into an
 *  accidental default. */
export function requireCapability<T>(field: string, capability: ResolvedCapability<T>): T {
  if (capability.value === undefined) {
    throw new Error(
      `capability "${field}" is unknown: ${capability.source} ` +
        `(considered: ${capability.considered.map((c) => `${c.origin}=${c.outcome}`).join(", ") || "nothing"})`,
    );
  }
  return capability.value;
}

/** The plan's answer for how many model turns a run may take: `null`, meaning
 *  "no cap". This is a settled answer rather than a marked unknown, and it is
 *  not a second place to configure a cap — the plan deliberately carries no
 *  number, so no consumer can impose one. */
export function planMaxModelTurns(plan: ResolvedRunPlan): number | null {
  return plan.execution.maxModelTurns.value;
}

// ── Telemetry ──────────────────────────────────────────────────────────────
//
// Observations are validated against a WATERMARK, not merely tagged with a turn
// id. The Codex reader scans the tail of a rollout file for the newest
// `token_count` event; a turn that failed before issuing a model request finds
// no new event and would hand back the previous turn's `last_token_usage` —
// which carries no turn id at all, because the CLI wrote it for a different
// turn. Tagging the reader with a turn id does not change that. What does
// change it is knowing the artifact's state BEFORE the turn began: any event
// below the mark predates the turn and is rejected.
//
// The artifact is not always a file that already exists, either. A fresh Codex
// thread's rollout is created by the CLI and named after a thread id we only
// learn from `thread.started`, so a mark can instead be the SESSION the file
// belongs to: same directory, and the run's own session id in the file name.
// Directory listings do not work here — without MCP several agents share one
// `~/.codex/sessions`, so "a file that was not there before" may well be
// another run's rollout, and copying its reading into this turn is precisely
// the stale-value bug this mechanism exists to prevent.

export function emptyTelemetry(
  plan: ResolvedRunPlan,
  runId: string,
  watermark: TurnWatermark,
): Telemetry {
  return {
    runId,
    turnId: watermark.turnId,
    planHash: plan.planHash,
    resolvedAt: plan.resolvedAt,
    watermark,
    observations: [],
    rejections: [],
  };
}

/** The mark that covers the artifact an event came from, if any.
 *
 *  A `file` mark is a path match on the CANONICAL path — `..` collapsed first,
 *  so a path that reads as inside cannot resolve outside. A `session-file` mark
 *  covers a file the runtime created during this turn and named after ITS
 *  session — the only correlation available for an artifact that did not exist
 *  (and whose name we could not know) when the turn began.
 *
 *  A mark never vouches by proximity alone. "A new file appeared in this
 *  directory" is not ownership: several agents share one `~/.codex/sessions`, so
 *  that rule would hand another run's rollout to this one. */
/** Windows paths are case-insensitive per volume; POSIX paths are not.
 *  Comparing raw strings gets a Windows path wrong in both directions — it
 *  rejects `c:\temp\x.jsonl` against `C:\Temp\x.jsonl`, which is the same file. */
const CASE_INSENSITIVE_PATHS = process.platform === "win32";

/** A path reduced to the form two spellings of the same location share. `resolve`
 *  collapses `..`, `.` and duplicate separators BEFORE anything is compared. */
function comparablePath(path: string): string {
  const resolved = resolve(path);
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

/** Real containment, asked of the path RESOLVER rather than of a prefix.
 *
 *  `dir/f.jsonl`.startsWith(`dir/`) is a lexically true, physically false
 *  answer for `dir/../outside/f.jsonl` — a name that reads as inside and
 *  resolves outside. `relative` after `resolve` is asked the actual question:
 *  is the candidate below the directory once both are canonical? A different
 *  volume (or a sibling whose relative path climbs) answers with `..` or an
 *  absolute path, and neither is inside. */
function isInsideDirectory(directory: string, candidate: string): boolean {
  const rel = relative(comparablePath(directory), comparablePath(candidate));
  if (rel.length === 0 || isAbsolute(rel)) return false;
  // A climb is `..` or `..<sep>…`. A bare `startsWith("..")` also rejects a
  // legal child directory that merely begins with those characters (`..cache`).
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** The file name an event path ends in, whichever separator the platform used:
 *  a mark and an event can disagree about separators without disagreeing about
 *  the file. */
function fileNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Does a session mark vouch for this event's artifact?
 *
 *  The mark must name something that can BE a file name: an empty or
 *  separator-bearing session id identifies no artifact, so such a mark covers
 *  nothing. Left unchecked, an empty id matches every path in the directory —
 *  the same "vouch by proximity" failure the mark exists to prevent, arriving
 *  from the other side. */
function sessionMarkCovers(
  mark: Extract<ArtifactMark, { kind: "session-file" }>,
  eventPath: string,
): boolean {
  const sessionId = mark.sessionId.trim();
  if (sessionId.length === 0) return false;
  if (sessionId.includes("/") || sessionId.includes("\\")) return false;
  if (!isInsideDirectory(mark.directory, eventPath)) return false;
  // The same convention the runtime uses to find a thread's rollout
  // (`findCodexSessionFile`): the file NAME carries the thread id.
  return fileNameOf(eventPath).includes(sessionId);
}

function markFor(marks: readonly ArtifactMark[], eventPath: string): ArtifactMark | undefined {
  // Exact first, whatever order the caller built the list in: a file mark
  // carries the offset the turn began at, a session mark carries none, so the
  // specific one has to win.
  const exact = marks.find((m) => m.kind === "file" && samePath(m.path, eventPath));
  if (exact) return exact;
  return marks.find((m) => m.kind === "session-file" && sessionMarkCovers(m, eventPath));
}

/** The mark that covers this artifact path, if any — the same question
 *  `judgeObservation` asks, exposed so a runtime reading an artifact AFTER a
 *  turn checks it against the SAME containment/session-id rules instead of
 *  re-implementing a path comparison of its own. */
export function markCoversPath(
  marks: readonly ArtifactMark[],
  eventPath: string,
): ArtifactMark | undefined {
  return markFor(marks, eventPath);
}

/** Judge a raw event against the turn watermark. Exported so the runtime-side
 *  readers can be tested without a rollout file.
 *
 *  `runId` is required rather than optional: an event can name the run it came
 *  from, and a check that a caller can forget to pass is not a check. */
export function judgeObservation(
  watermark: TurnWatermark,
  event: RawObservationEvent,
  runId: string,
): ObservationVerdict {
  // The artifact itself correlated the event to a different turn.
  if (event.turnId && event.turnId !== watermark.turnId) {
    return {
      accepted: false,
      rejection: {
        code: "foreign-turn",
        detail: `event belongs to turn ${event.turnId}, not ${watermark.turnId}`,
      },
    };
  }
  // ...or to a different run entirely. A watermark only ever vouches for the
  // run it was taken for.
  if (event.runId && event.runId !== runId) {
    return {
      accepted: false,
      rejection: {
        code: "foreign-run",
        detail: `event belongs to run ${event.runId}, not ${runId}`,
      },
    };
  }
  const mark = markFor(watermark.marks, event.path);
  // `offset` is where the event STARTS, and a mark's `size` was the file's byte
  // length before the turn — so the first byte this turn appended sits AT the
  // mark, not below it. `<=` here would throw away every turn's first event.
  if (mark?.kind === "file" && event.offset < mark.size) {
    return {
      accepted: false,
      rejection: {
        code: "predates-watermark",
        detail: `event at offset ${event.offset} in ${event.path} predates this turn (watermark ${mark.size})`,
      },
    };
  }
  // No correlation anywhere: neither the artifact nor the watermark can place
  // this event. Accepting it would be assuming it is ours.
  if (!event.turnId && !mark) {
    return {
      accepted: false,
      rejection: {
        code: "no-turn-correlation",
        detail: `${event.path} is not among this turn's marked artifacts and the event carries no turn id`,
      },
    };
  }
  return {
    accepted: true,
    observation: {
      turnId: watermark.turnId,
      field: event.field,
      value: event.value,
      observedAt: event.observedAt,
      source: event.source,
    },
  };
}

/** Record a reading, or record WHY it was rejected. A rejected observation is a
 *  fact about the run and stays visible; dropping it silently would leave the
 *  consumer reading a stale value with no way to notice. */
export function recordObservation(
  telemetry: Telemetry,
  event: RawObservationEvent,
): Telemetry {
  const verdict = judgeObservation(telemetry.watermark, event, telemetry.runId);
  if (!verdict.accepted) {
    return { ...telemetry, rejections: [...telemetry.rejections, { event, rejection: verdict.rejection }] };
  }
  return { ...telemetry, observations: [...telemetry.observations, verdict.observation] };
}

/** The newest observation for `field` in THIS turn, or undefined. A stale
 *  reading must resolve to unknown, never to the previous turn's number. */
export function observationForTurn(
  telemetry: Telemetry,
  turnId: string,
  field: string,
): RunObservation | undefined {
  let found: RunObservation | undefined;
  for (const obs of telemetry.observations) {
    if (obs.turnId !== turnId || obs.field !== field) continue;
    if (!found || obs.observedAt >= found.observedAt) found = obs;
  }
  return found;
}
