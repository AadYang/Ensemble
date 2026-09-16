// THE view-model for the capability/run-plan surface, and the ONLY one.
//
// Why this file exists at all: before it, every consumer re-derived what it
// needed from whatever happened to be in the `/status` payload. The settings
// page decided from a provider KIND whether a field applied; the chat pane
// printed a hand-picked subset; the context bar had its own idea of which number
// was the denominator. One run therefore had several answers, and the one the
// user read depended on which surface they looked at.
//
// The rules, and they are the whole point of this module:
//
//   1. EVERY field is a verbatim projection of the resolved plan. Nothing here
//      inspects a provider kind, a model id, a prefix or a name to decide what a
//      value means — a consumer that does that has reintroduced a second
//      resolver, and the plan is supposed to be the only one.
//   2. `unknown` is a VALUE. A field the plan could not establish is projected
//      as `undefined`/`null` with `confidence: "unknown"` — never filled with a
//      conservative default that would render exactly like a finding.
//   3. A row's `reason` is NEVER empty. A UI that has to explain itself cannot
//      be handed a blank.
//   4. The projection is pure. It reads the plan and returns a new object; it
//      does not resolve, probe, fetch or re-measure. `/status`, the settings
//      page and the context bar all read the object this produced for the same
//      plan, which is what makes them agree by construction.
//
// Lives in `shared` (not in the core) because the type crosses the core↔UI
// boundary: two declarations of this shape on either side of a JSON boundary is
// how the two sides drift.

import type {
  AppliedPreference,
  CapabilityConfidence,
  CapabilityOrigin,
  ResolutionDiagnostic,
  ResolvedProjectRoot,
  ResolvedRunPlan,
  RunPlanContext,
  RunPlanHistory,
  RunPlanLiveness,
  RunPlanSkills,
  RunPlanTransportPlan,
} from "./capability.js";

/** Where the plan behind this view came from. `fresh-resolution` is a
 *  PREDICTION a status read made because no turn had run yet in this process —
 *  weaker evidence than a turn's own snapshot, and it says so.
 *
 *  `preview` is weaker still and is named separately for that reason: it is the
 *  plan a PROPOSED settings change would resolve to. Nothing has been written,
 *  no probe was allowed to run, and the configuration it was resolved from is a
 *  draft the user has not committed — so it must never render like a plan an
 *  agent is running under. */
export type RunPlanSource = "last-turn" | "fresh-resolution" | "preview" | "none";

/** The settings surface's field list. One vocabulary, shared by the server that
 *  produces the rows and the UI that renders them.
 *
 *  `sandbox` is here but has no row in `settingStatusRows`: a per-agent Codex
 *  sandbox override is not part of the run plan (it is a launch parameter, not a
 *  capability), so there is nothing in the plan to project it from. It still
 *  needs a name, because a provider switch is exactly what INVALIDATES it, and
 *  the confirmation prompt has to be able to say which field it is losing. */
export type RunPlanSettingField =
  | "transport"
  | "reasoning"
  | "project"
  | "context"
  | "outputReserve"
  | "history"
  | "liveness"
  | "sandbox";

/** What happened to the value this row is about.
 *
 *  `inherit` — nothing was requested; the plan carries whatever it resolved.
 *  `unknown` — the plan could not establish a value, and that is the answer. */
export type SettingOutcome = "applied" | "rejected" | "deferred" | "inherit" | "unknown";

/** A value the plan established this route cannot take, and why.
 *
 *  Disabling the whole control for one bad value would trap the user; disabling
 *  exactly the values listed here does not. The reason travels with the value so
 *  the UI never has to phrase a rejection itself. */
export interface RejectedChoice {
  value: string;
  code: string;
  detail: string;
}

/** One line of the settings surface: requested vs resolved, with provenance and
 *  the outcome. Uniform across every field so the UI has ONE row shape to
 *  render, and so "why is this what it is" is answered the same way everywhere.
 *
 *  Every value is a STRING or null on purpose: this row is a display contract,
 *  not a second source of numbers. The numbers live in the verbatim projections
 *  below (`context`, `history`, `liveness`), and a row that re-typed them would
 *  be one more place for them to disagree. */
export interface SettingStatusRow {
  field: RunPlanSettingField;
  /** Dotted path of the plan field this row projects (`transport`,
   *  `execution.projectRoot`, `context.effectiveWindow`, …). Printed by
   *  `/status` so a reader can find the same value in the raw snapshot. */
  path: string;
  /** What the user asked for. `null` = nothing was asked. */
  requested: string | null;
  /** What the plan carries. `null` = the plan has no value for this field. */
  resolved: string | null;
  outcome: SettingOutcome;
  /** Human-readable provenance for THIS field — the same sentence the plan's
   *  own capability carries, never a summary of it. */
  source: string;
  confidence: CapabilityConfidence;
  /** Why the outcome is what it is. Never empty. */
  reason: string;
  /** FALSE ⇒ the control is disabled and `reason` is what the user reads.
   *  True unless the plan carries hard evidence that NO value of this field can
   *  be set on this route — a rejected VALUE stays editable (see
   *  `rejectedChoices`), because the user's fix is to choose another one. */
  editable: boolean;
  /** Values PROVEN impossible for this route, with the server's reason. The UI
   *  disables exactly these. */
  rejectedChoices: RejectedChoice[];
}

/** The reasoning half of `/status`, read off the SAME plan the runtime is given.
 *
 *  `resolved` is literally `plan.execution.reasoningEffort` — the field the
 *  adapters consume — so a UI rendering this cannot display a level the SDK was
 *  not handed. Provenance comes with it: "we sent `ultra` because the model's
 *  ladder (from the vendor's catalog) says it exists" and "we sent `ultra`
 *  because the user asked and we have no ladder" are different claims and must
 *  not render identically. */
export interface ReasoningReport {
  requested: string | null;
  resolved: string | null;
  outcome: "applied" | "rejected" | "inherit";
  levels: string[] | null;
  /** Provenance of the LADDER (not of the level above): where the list came
   *  from and how much it is worth. An unknown ladder is `unknown` here, which
   *  is a different claim from "the list is empty". */
  levelsOrigin: CapabilityOrigin;
  levelsConfidence: CapabilityConfidence;
  levelsSource: string;
  rejection: { code: string; detail: string } | null;
}

export function reasoningReport(plan: ResolvedRunPlan): ReasoningReport {
  const pref = plan.preferences.find((p) => p.field === "reasoningEffort");
  return {
    requested: pref ? String(pref.requested) : null,
    resolved: plan.execution.reasoningEffort ?? null,
    outcome: pref === undefined ? "inherit" : pref.outcome === "rejected" ? "rejected" : "applied",
    levels: plan.facts.reasoningLevels.value ?? null,
    levelsOrigin: plan.facts.reasoningLevels.origin,
    levelsConfidence: plan.facts.reasoningLevels.confidence,
    levelsSource: plan.facts.reasoningLevels.source,
    rejection: pref?.rejection ?? null,
  };
}

/** How many diagnostics are in each state. Derived here so the two surfaces that
 *  summarise them (`/status` text and the settings page) count the same list. */
export type DiagnosticCounts = Record<ResolutionDiagnostic["status"], number>;

export function countDiagnostics(diagnostics: readonly ResolutionDiagnostic[]): DiagnosticCounts {
  const counts: DiagnosticCounts = { resolved: 0, unknown: 0, degraded: 0, rejected: 0, deferred: 0 };
  for (const d of diagnostics) counts[d.status] += 1;
  return counts;
}

/** The whole capability/run-plan surface for ONE agent, as the UI consumes it.
 *
 *  Every field below is the plan's own value, unchanged. Nothing is flattened
 *  into a shape that only carries the part some component needed, because that
 *  is how the omitted part becomes "the UI does not know". */
export interface RunPlanStatusView {
  source: RunPlanSource;
  planHash: string;
  resolvedAt: string;
  /** providerId, providerScope, runtime, runtimeVersion, transport, modelId. */
  identity: ResolvedRunPlan["identity"];
  /** Requested vs resolved transport, plus the fallback policy. */
  transport: RunPlanTransportPlan;
  /** Provenance sentence for the transport fact itself (`transport.origin` /
   *  `.confidence` are on `transport`; this is the human-readable source). */
  transportSource: string;
  reasoning: ReasoningReport;
  projectRoot: ResolvedProjectRoot;
  context: RunPlanContext;
  history: RunPlanHistory;
  skills: RunPlanSkills;
  liveness: RunPlanLiveness;
  preferences: AppliedPreference<unknown>[];
  diagnostics: ResolutionDiagnostic[];
  diagnosticCounts: DiagnosticCounts;
  settings: SettingStatusRow[];
}

/** The ONE projection. `source` is passed in rather than derived here: only the
 *  caller knows whether the plan it holds is a turn's own snapshot or one this
 *  status read just resolved. */
export function runPlanStatusView(args: {
  plan: ResolvedRunPlan;
  source: RunPlanSource;
}): RunPlanStatusView {
  const plan = args.plan;
  return {
    source: args.source,
    planHash: plan.planHash,
    resolvedAt: plan.resolvedAt,
    identity: plan.identity,
    transport: plan.transport,
    transportSource: plan.facts.transport.source,
    reasoning: reasoningReport(plan),
    projectRoot: plan.execution.projectRoot,
    context: plan.context,
    history: plan.history,
    skills: plan.skills,
    liveness: plan.liveness,
    preferences: plan.preferences,
    diagnostics: plan.diagnostics,
    diagnosticCounts: countDiagnostics(plan.diagnostics),
    settings: settingStatusRows(plan),
  };
}

function prefOf(plan: ResolvedRunPlan, field: string): AppliedPreference<unknown> | undefined {
  return plan.preferences.find((p) => p.field === field);
}

function outcomeOf(pref: AppliedPreference<unknown> | undefined): SettingOutcome {
  return pref === undefined ? "inherit" : pref.outcome;
}

/** The values the plan established this route cannot take. A preference that
 *  came back `rejected` is exactly that: the plan holds the proof and the reason
 *  in the same object, so the UI never phrases a rejection itself. */
function rejectedChoicesOf(pref: AppliedPreference<unknown> | undefined): RejectedChoice[] {
  if (pref === undefined || pref.outcome !== "rejected" || pref.rejection === undefined) return [];
  return [{ value: String(pref.requested), code: pref.rejection.code, detail: pref.rejection.detail }];
}

/** A number the plan may or may not have established, as the display row wants
 *  it: a string, or null with the reason already written by the caller. */
function numberText(n: number | null | undefined): string | null {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : null;
}

function transportReason(plan: ResolvedRunPlan): string {
  const t = plan.transport;
  if (t.requested === null) {
    return (
      `nothing was requested, so this turn sends what the evidence establishes (${t.resolved}, ${t.confidence}) — ` +
      t.fallbackReason
    );
  }
  if (t.requested === t.resolved) {
    return `you asked for ${t.requested} and the route is ${t.resolved} (${t.confidence})`;
  }
  return (
    `you asked for ${t.requested} and this turn sends ${t.resolved} (${t.confidence}) — ${t.fallbackReason}`
  );
}

function reasoningReason(plan: ResolvedRunPlan, r: ReasoningReport): string {
  if (r.outcome === "rejected" && r.rejection !== null) {
    return `${r.rejection.code}: ${r.rejection.detail}`;
  }
  if (r.requested === null) {
    return (
      "nothing was requested, so the runtime's own default applies" +
      (r.levels === null ? "; this model's ladder is unknown, so no level is claimed to be supported" : "")
    );
  }
  if (r.levels === null) {
    return `${r.requested} was sent as asked; this model's ladder is unknown (${r.levelsSource}), so "sent" is not "supported"`;
  }
  return `${r.requested} is in this model's ladder (${r.levelsOrigin}/${r.levelsConfidence})`;
}

function contextReason(plan: ResolvedRunPlan): string {
  const ctx = plan.context;
  if (ctx.effectiveWindow === null) {
    return "no effective window could be established for this route, so nothing is dropped on a guess";
  }
  const parts = [`this session runs with an effective window of ${ctx.effectiveWindow} tokens`];
  if (ctx.advertisedContextWindow !== null && ctx.advertisedContextWindow !== ctx.effectiveWindow) {
    parts.push(`the model advertises ${ctx.advertisedContextWindow}`);
  }
  if (ctx.contextBudget !== null) parts.push(`your own history ceiling is ${ctx.contextBudget}`);
  return parts.join("; ");
}

function outputReserveReason(plan: ResolvedRunPlan): string {
  const reserve = plan.context.outputReserve;
  const cap = plan.facts.maxOutputTokens;
  if (reserve === null) {
    return "no output reservation was established for this route";
  }
  if (cap.value !== undefined && cap.value !== reserve) {
    return `${reserve} tokens are held back for output; the model's own cap is ${cap.value} (${cap.confidence})`;
  }
  return `${reserve} tokens are held back from the input budget for the model's answer`;
}

function historyReason(h: RunPlanHistory): string {
  // The plan's own sentence first: it was written where the decision was made.
  return h.reason;
}

function livenessReason(l: RunPlanLiveness): string {
  return l.reason;
}

/** The settings surface's rows: one per field, each carrying requested /
 *  resolved / outcome / source / confidence / reason, plus which values the
 *  route has been proven to reject.
 *
 *  Pure over the plan. This is the ONLY place those rows are built, so the
 *  settings page and `/status` cannot render two different answers for one
 *  field. */
export function settingStatusRows(plan: ResolvedRunPlan): SettingStatusRow[] {
  const transport = prefOf(plan, "transport");
  const context = prefOf(plan, "contextBudget");
  const output = prefOf(plan, "maxOutputTokens");
  const reasoning = reasoningReport(plan);
  const pr = plan.execution.projectRoot;
  const ctx = plan.context;
  const h = plan.history;
  const l = plan.liveness;

  return [
    {
      field: "transport",
      path: "transport",
      requested: plan.transport.requested,
      resolved: plan.transport.resolved,
      outcome: outcomeOf(transport),
      source: plan.facts.transport.source,
      confidence: plan.transport.confidence,
      reason: transportReason(plan),
      // A native CLI's transport is what the runtime IS, not a setting: there is
      // no value the user could choose here, so the control is disabled and the
      // reason says which fact makes it so. An explicit request that the route
      // refused keeps the control enabled — the fix is another value.
      editable: plan.identity.transport !== "native-cli",
      rejectedChoices: rejectedChoicesOf(transport),
    },
    {
      field: "reasoning",
      path: "execution.reasoningEffort",
      requested: reasoning.requested,
      resolved: reasoning.resolved,
      outcome: reasoning.outcome,
      source: reasoning.levelsSource,
      confidence: reasoning.levelsConfidence,
      reason: reasoningReason(plan, reasoning),
      // A ladder we do not have is not a ladder that forbids anything: the
      // control stays usable and the row says the levels are unknown.
      editable: true,
      rejectedChoices: rejectedChoicesOf(prefOf(plan, "reasoningEffort")),
    },
    {
      field: "project",
      path: "execution.projectRoot",
      requested: pr.configuredPath,
      resolved: pr.value,
      outcome: pr.invalid !== null ? "rejected" : pr.state === "bound" ? "applied" : "unknown",
      source:
        pr.source === "agent"
          ? "the agent's configured projectRoot, inspected for this plan"
          : "the agent has no project and no scratch directory was available",
      // The verdict comes from inspecting the real directory, which is an
      // observation — not from a guess about what the path probably is.
      confidence: pr.source === "agent" ? "observed" : "unknown",
      reason:
        pr.invalid !== null
          ? `${pr.invalid.code}: ${pr.invalid.reason}`
          : pr.value !== null
            ? `turns and tools run in ${pr.value}`
            : "this agent is unbound: no project root is configured and none was used",
      // A broken root is reported, not locked: the user's fix is to point the
      // agent at a directory that exists.
      editable: true,
      rejectedChoices:
        pr.invalid !== null && pr.configuredPath !== null
          ? [{ value: pr.configuredPath, code: pr.invalid.code, detail: pr.invalid.reason }]
          : [],
    },
    {
      field: "context",
      path: "context.effectiveWindow",
      requested: ctx.contextBudget === null ? null : String(ctx.contextBudget),
      resolved: numberText(ctx.effectiveWindow),
      outcome: ctx.effectiveWindow === null ? "unknown" : "applied",
      source: "the runtime's effective window for this session",
      confidence: ctx.effectiveWindow === null ? "unknown" : "observed",
      reason: contextReason(plan),
      editable: true,
      rejectedChoices: rejectedChoicesOf(context),
    },
    {
      field: "outputReserve",
      path: "context.outputReserve",
      requested: output === undefined ? null : String(output.requested),
      resolved: numberText(ctx.outputReserve),
      outcome: ctx.outputReserve === null ? "unknown" : outcomeOf(output),
      source: plan.facts.maxOutputTokens.source,
      confidence: plan.facts.maxOutputTokens.confidence,
      reason: outputReserveReason(plan),
      // The model's published cap is a fact, not a wish: a user value can lower
      // the reserve and never raise it past the cap. Changing the CAP is not a
      // setting at all, so a rejected request is the only disabled state.
      editable: true,
      rejectedChoices: rejectedChoicesOf(output),
    },
    {
      field: "history",
      path: "history",
      requested: null,
      resolved: h.strategy,
      outcome: h.status === "resolved" ? "applied" : "unknown",
      source: "the plan's own history assembly for the last turn",
      // `exact` means a real tokenizer measured it. Anything else is labelled
      // as what it is — a byte upper bound or nothing measured at all — and is
      // never rendered as a measured number.
      confidence: h.counting === "exact" ? "observed" : h.counting === "estimated" ? "unverified" : "unknown",
      reason: historyReason(h),
      editable: true,
      rejectedChoices: [],
    },
    {
      field: "liveness",
      path: "liveness",
      requested: l.hardDeadlineMs === null ? null : String(l.hardDeadlineMs),
      resolved: l.hardDeadlineMs === null ? null : String(l.hardDeadlineMs),
      outcome: "applied",
      source: l.hardDeadlineSource === "unset" ? "no user ceiling is configured" : "the user's maxRunDurationMs",
      confidence: "observed",
      reason: livenessReason(l),
      editable: true,
      rejectedChoices: [],
    },
  ];
}

// ── Confirm-on-invalidate ──────────────────────────────────────────────────
//
// Changing a model or a provider can make a value the agent already holds
// impossible on the new route: a Codex sandbox override on a provider that is
// not Codex, a reasoning level the new model's ladder does not contain, a
// project root that no longer exists. The rule is that the user is TOLD which
// fields are affected and why, and confirms BEFORE anything is written — the
// value is never quietly dropped, and the server still does the final
// validation when the confirmed write arrives.

/** One stored value a proposed change would invalidate. */
export interface SettingInvalidation {
  field: RunPlanSettingField;
  /** What the agent holds now, verbatim. */
  current: string;
  /** What the change would leave. `null` = the value would be CLEARED, which is
   *  the case the confirmation exists for. */
  next: string | null;
  /** Same vocabulary as a rejected choice (`REASONING_EFFORT_UNSUPPORTED`,
   *  `PROJECT_ROOT_NOT_FOUND`, …), so the dialog and the settings rows agree. */
  code: string;
  /** The server's sentence. Never empty. */
  reason: string;
}

/** A proposed change, as the settings form would submit it. `undefined` means
 *  "not part of this change" — the same rule `patchAgent` follows, so a
 *  proposal is the patch it would apply. */
export interface SettingsImpactRequest {
  providerId?: string | null;
  model?: string;
  reasoningEffort?: string | null;
  maxRunDurationMs?: number | null;
  projectRoot?: string | null;
  sandboxMode?: string | null;
}

/** A proposal this server would REFUSE, in the same vocabulary the write path
 *  uses.
 *
 *  It exists so the settings form can say "this value cannot be set, and here is
 *  the code the API would answer with" BEFORE it submits: a structured 400 the
 *  UI can only discover by trying is a 400 the user reads as a failure rather
 *  than as a rule. `code` is the very code `PATCH /agents/:id` returns
 *  (`REASONING_EFFORT_UNSUPPORTED`, `PROJECT_ROOT_NOT_FOUND`, …), so the preview
 *  and the write cannot phrase the same refusal differently. */
export interface SettingsImpactRejection {
  field: RunPlanSettingField;
  code: string;
  /** The server's sentence. Never empty. */
  detail: string;
}

/** What a proposed change would cost, computed WITHOUT writing anything.
 *
 *  This is the read-only PREVIEW entry as well as the invalidation probe: the
 *  plan it returns was resolved through the same `resolveRunPlan` chain a turn
 *  uses, with `allowProbe: false`, and nothing was written or fetched. `nextPlan`
 *  therefore carries `source: "preview"` — the settings form refreshes it as the
 *  draft changes, and labels it as a prediction about an uncommitted change. */
export interface SettingsImpactReport {
  /** The values the change would invalidate. EMPTY is a complete answer: nothing
   *  is affected, and the write may proceed without a prompt. */
  invalidated: SettingInvalidation[];
  /** True when `invalidated` is non-empty — the form must ask before writing. */
  requiresConfirmation: boolean;
  /** The view the proposal would resolve to, when it resolves at all. Present so
   *  the dialog can show the outcome, not just the loss. `source` is always
   *  `"preview"`. */
  nextPlan: RunPlanStatusView | null;
  /** Why no plan could be resolved for the proposal. `null` when one resolved.
   *  A proposal that cannot resolve is NOT the same as one that changes nothing:
   *  it is refused with this sentence. */
  resolutionError: string | null;
  /** The proposal's own refusal, when the plan proved it cannot be applied —
   *  structured, so the form shows the code the write would return instead of
   *  letting the user submit and read a 400. `null` = nothing in this proposal
   *  was rejected. A rejection here means DO NOT WRITE. */
  rejection: SettingsImpactRejection | null;
}
