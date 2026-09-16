// THE capability view-model: one object, three surfaces.
//
// The settings page, the `/status` text and the context bar all answer the same
// question — "what does this route actually do with the values on this agent?" —
// and before this module each of them read `RunPlanStatusView` its own way. The
// rows were shared (they come from `settingStatusRows` in run-plan-view), but
// every surface still did its own little interpretation on top: which field is a
// free-text path and which is a closed list, whether a disabled control has a
// reason to show, which value is a CHOICE the route refuses rather than a fact
// about the route. Three small interpretations of one contract is how the three
// surfaces start disagreeing again.
//
// This file does that interpretation ONCE and hands out:
//
//   • `fields`  — one row per setting, with the display decisions attached
//                 (`disabledReason`, `options`, `rejection`) and nothing else
//                 invented. Both the settings page and the `/status` text render
//                 these; `formatCapabilityFieldLines` below is the text renderer,
//                 so the two cannot print different `resolved` values for one
//                 field.
//   • `context` — the context bar's plan half, projected by `contextPlanFacts`.
//   • `header`  — the identity a header/title needs, from the plan and nowhere
//                 else (model id, project root, runtime).
//
// THE RULES:
//   1. No consumer derives anything from a provider kind, a model id or a name.
//      Everything comes off the plan's own view-model.
//   2. `unknown` is a value. A field the plan could not establish keeps `null`
//      and says so; nothing is filled with a plausible default.
//   3. A disabled control ALWAYS has a `disabledReason`. "Disabled" with no
//      explanation is the state this contract exists to prevent.
//   4. Only values the plan has PROVEN impossible are disabled (`rejection` /
//      `rejectedChoices`). A field whose value space is merely unknown stays
//      editable — the user's fix for a rejected value is to pick another one,
//      and hiding the control would trap them.
//
// Lives in `shared` (not in the UI) so the text/UI agreement can be tested:
// desktop-ui has no test runner.

import type { CapabilityConfidence } from "./capability.js";
// Extensionless, like every other specifier that survives bundling (see
// index.ts). tsc is on moduleResolution "Bundler" so both forms typecheck, but
// Turbopack does NOT map a literal "./x.js" onto "./x.ts" — it only ever broke
// on this line, because it is the one .js specifier in shared/src that imports a
// VALUE rather than a type (type-only imports are erased before resolution).
import { contextPlanFacts, type ContextPlanFacts } from "./context-bar-view";
import type {
  RejectedChoice,
  RunPlanSettingField,
  RunPlanSource,
  RunPlanStatusView,
  SettingOutcome,
  SettingStatusRow,
} from "./run-plan-view.js";

/** One setting, as every surface renders it. A verbatim superset of the plan's
 *  own `SettingStatusRow`: the plan's fields are copied unchanged, and the three
 *  display decisions are added here so no consumer has to make them. */
export interface CapabilityFieldView {
  field: RunPlanSettingField;
  /** Dotted path of the plan field this row projects. Printed by `/status` so a
   *  reader can find the same value in the raw snapshot. */
  path: string;
  requested: string | null;
  resolved: string | null;
  outcome: SettingOutcome;
  /** Human-readable provenance for THIS field, the plan's own sentence. */
  source: string;
  confidence: CapabilityConfidence;
  /** Why the outcome is what it is. Never empty. */
  reason: string;
  editable: boolean;
  /** Why the control is disabled. `null` exactly when `editable` is true — the
   *  plan's own `reason`, never a re-wording. */
  disabledReason: string | null;
  /** The values this field may be SET to, when the plan establishes a bounded
   *  set. `null` = the field is open (a path, a number) or its value space is
   *  unknown; in both cases the control stays usable. An EMPTY array means the
   *  route has no choice to make at all (a native CLI's transport). */
  options: string[] | null;
  /** The proposal's own value, when the plan PROVED this route cannot take it.
   *  `null` = nothing was rejected. A rejected value does NOT disable the
   *  control (see `rejectedChoices`); it is shown as-is so the user can see what
   *  they asked for, why it failed, and pick another. */
  rejection: RejectedChoice | null;
  /** Every value proven impossible for this route, with the server's reason. */
  rejectedChoices: RejectedChoice[];
}

/** The identity every header needs, read off the plan. */
export interface CapabilityHeaderView {
  providerId: string | null;
  providerScope: string;
  runtime: string;
  runtimeVersion: string | null;
  transport: string;
  modelId: string;
  planHash: string;
  resolvedAt: string;
}

export interface CapabilityViewModel {
  /** Where the plan behind this view came from. A `preview` is an uncommitted
   *  draft and must never be rendered like a running agent's plan. */
  runPlanSource: RunPlanSource;
  /** The plan this view was built from, verbatim. Consumers that need a detail
   *  no row carries read it here — they do not re-resolve anything. */
  planView: RunPlanStatusView | null;
  header: CapabilityHeaderView | null;
  fields: CapabilityFieldView[];
  /** The context bar's plan half. `null` when there is no plan at all. */
  context: ContextPlanFacts | null;
  /** Everything the plan could not establish, in the plan's own words. Empty is
   *  a complete answer. */
  degraded: string[];
}

/** The protocol's transport vocabulary, as a user CHOICE. `native-cli` is not in
 *  it: it is what a runtime IS, not something a user picks, which is why a
 *  native-CLI route reports `[]` here and `editable: false` on the row. */
const TRANSPORT_CHOICES: readonly string[] = ["auto", "responses", "chat-completions"];

/** The value space a field may be set within, from the plan alone.
 *
 *  `undefined` (returned as `null` by the caller) means "open or unknown" and
 *  leaves the control enabled — an unenumerated field is not a forbidden one. */
function optionsOf(field: RunPlanSettingField, plan: RunPlanStatusView): string[] | null {
  switch (field) {
    case "transport":
      return plan.identity.transport === "native-cli" ? [] : [...TRANSPORT_CHOICES];
    case "reasoning":
      // The model's ladder, verbatim. `null` (not established) is NOT an empty
      // ladder: the control stays open and the row says the levels are unknown.
      return plan.reasoning.levels === null ? null : [...plan.reasoning.levels];
    default:
      return null;
  }
}

function fieldViewOf(row: SettingStatusRow, plan: RunPlanStatusView): CapabilityFieldView {
  return {
    field: row.field,
    path: row.path,
    requested: row.requested,
    resolved: row.resolved,
    outcome: row.outcome,
    source: row.source,
    confidence: row.confidence,
    reason: row.reason,
    editable: row.editable,
    // A disabled control with no explanation is the failure mode this field
    // exists to remove, so it is derived here rather than left to each surface.
    disabledReason: row.editable ? null : row.reason,
    options: optionsOf(row.field, plan),
    rejection: row.rejectedChoices[0] ?? null,
    rejectedChoices: row.rejectedChoices,
  };
}

/** THE projection. Everything the three surfaces read is built here, once, from
 *  the plan's own view-model.
 *
 *  `runtimeObservedWindow` is the live denominator the context bar is rendering,
 *  when there is one. It is needed for exactly one thing: `context.effectiveSource`
 *  must name where the bar's denominator actually came from, and only the caller
 *  knows whether a live reading outranked the plan's window. */
export function capabilityView(
  planView: RunPlanStatusView | null | undefined,
  runtimeObservedWindow?: number | null,
): CapabilityViewModel {
  if (!planView) {
    return {
      runPlanSource: "none",
      planView: null,
      header: null,
      fields: [],
      context: null,
      degraded: [],
    };
  }
  const id = planView.identity;
  return {
    runPlanSource: planView.source,
    planView,
    header: {
      providerId: id.providerId,
      providerScope: id.providerScope,
      runtime: id.runtime,
      runtimeVersion: id.runtimeVersion ?? null,
      transport: id.transport,
      modelId: id.modelId,
      planHash: planView.planHash,
      resolvedAt: planView.resolvedAt,
    },
    // `settings` is the plan's own row list; this only attaches the display
    // decisions to it. Re-deriving the rows here would be the second resolver
    // this module exists to prevent.
    fields: planView.settings.map((row) => fieldViewOf(row, planView)),
    context: contextPlanFacts(planView, runtimeObservedWindow),
    degraded: planView.diagnostics
      .filter((d) => d.status === "unknown" || d.status === "degraded" || d.status === "rejected")
      .map((d) => `${d.field}: ${d.detail}`),
  };
}

/** One text line per field, as `/status` prints it.
 *
 *  The settings page renders `capability.fields` as rows and this renders the
 *  SAME array as text, so "what does this field resolve to" has one answer in
 *  both places — not two that agree by discipline. Kept here (rather than in the
 *  chat component) so the agreement is testable. */
export function formatCapabilityFieldLines(fields: readonly CapabilityFieldView[]): string[] {
  return fields.map((row) => {
    const parts = [
      `plan.setting=${row.field}`,
      `path:${row.path}`,
      `requested:${row.requested ?? "(none)"}`,
      `resolved:${row.resolved ?? "(none)"}`,
      `outcome:${row.outcome}`,
      `source:${row.source}`,
      `confidence:${row.confidence}`,
      `editable:${row.editable}`,
    ];
    if (row.disabledReason !== null) parts.push(`disabledReason:${row.disabledReason}`);
    if (row.options !== null) parts.push(`options:${row.options.join("|") || "(none)"}`);
    if (row.rejectedChoices.length > 0) {
      parts.push(
        `rejectedChoices:${row.rejectedChoices.map((rc) => `${rc.value}(${rc.code}: ${rc.detail})`).join("; ")}`,
      );
    }
    parts.push(`— ${row.reason}`);
    return parts.join(" ");
  });
}
