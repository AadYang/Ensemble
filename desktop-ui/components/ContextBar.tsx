"use client";

import type { CapabilityViewModel, ContextUsage } from "@agentorch/shared";
import { contextBarView } from "@agentorch/shared";
import type { ContextPlanFacts } from "@agentorch/shared";
import { useT } from "@/i18n/useT";
import type { TranslateFn } from "@/i18n/useT";

// W22: agent-pane context-usage bar (merged from the Ensemble working tree).
//
// All the display RULES live in `@agentorch/shared` `contextBarView` (pure,
// unit-tested — this package has no test runner). This component only maps that
// view-model onto markup and i18n keys:
//   • the denominator is the runtime's EFFECTIVE window, never the model max;
//   • a known advertised maximum is still shown when the live ceiling is not;
//   • a clamped window ("Codex 可用 828.4K" vs "模型官方上限 1.05M") is labelled.
//
// Phase 5 adds the plan's half: the effective window the plan established, the
// advertised figure (labelled as what it is), the output reserve, the
// history/compaction state, how the token numbers were counted, and a degraded
// marker. `advertisedText` NEVER moves into the slot `windowText` occupies — the
// one thing this bar must never do is present an advertised cap as the window in
// force.

const TONE_COLOR: Record<string, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  err: "var(--err)",
  dim: "var(--text-dim)",
};

/** The plan's own sentences, joined for the tooltip. Nothing is re-worded here:
 *  `reason` fields come from the server, and a paraphrase would be a second
 *  answer to a question the server already answered. */
function planTipLines(
  t: TranslateFn,
  view: ReturnType<typeof contextBarView>,
  p: ContextPlanFacts | null,
): string[] {
  if (!p) return [];
  const lines = [t("pane.context.plan.tipHeader")];
  lines.push(
    p.effectiveWindowText === null
      ? t("pane.context.plan.tipEffectiveUnknown", { source: p.effectiveSource })
      : t("pane.context.plan.tipEffective", { window: p.effectiveWindowText, source: p.effectiveSource }),
  );
  if (view.advertisedText) {
    lines.push(t("pane.context.plan.tipAdvertised", { advertised: view.advertisedText }));
  }
  lines.push(
    p.outputReserveText === null
      ? t("pane.context.plan.tipReserveUnknown")
      : t("pane.context.plan.tipReserve", { reserve: p.outputReserveText }),
  );
  if (p.history) {
    lines.push(
      t("pane.context.plan.tipHistory", {
        strategy: p.history.strategy ?? t("pane.context.plan.noStrategy"),
        summarised: p.history.summarised,
        dropped: p.history.dropped,
        compacted: p.history.compacted ? t("pane.context.plan.yes") : t("pane.context.plan.no"),
        overBudget: p.history.overBudget ? t("pane.context.plan.yes") : t("pane.context.plan.no"),
      }),
    );
    lines.push(p.history.reason);
  }
  lines.push(t("pane.context.plan.tipCounting", { counting: t(countingKey(p.counting)) }));
  if (p.degraded && p.degradedReason) {
    lines.push(t("pane.context.plan.tipDegraded", { reason: p.degradedReason }));
  }
  return lines;
}

function countingKey(counting: string | null): string {
  switch (counting) {
    case "exact":
      return "pane.context.plan.countingExact";
    case "estimated":
      return "pane.context.plan.countingEstimated";
    case "unmeasured":
      return "pane.context.plan.countingUnmeasured";
    default:
      return "pane.context.plan.countingUnknown";
  }
}

/** The compact inline suffix for the plan half. Kept short on purpose — the
 *  detail belongs in the tooltip until the visual pass lands. */
function PlanInline({ t, p }: { t: TranslateFn; p: ContextPlanFacts | null }) {
  if (!p) return null;
  return (
    <>
      <span className="text-[var(--text-dim)] opacity-70">
        ·
        {p.effectiveWindowText === null
          ? t("pane.context.plan.effectiveUnknown")
          : t("pane.context.plan.effective", { window: p.effectiveWindowText })}
      </span>
      {p.outputReserveText && (
        <span className="text-[var(--text-dim)] opacity-70">
          {t("pane.context.plan.reserve", { reserve: p.outputReserveText })}
        </span>
      )}
      {p.history?.compacted && (
        <span className="text-[var(--text-dim)] opacity-70">
          {t("pane.context.plan.compacted", {
            summarised: p.history.summarised,
            dropped: p.history.dropped,
          })}
        </span>
      )}
      {p.history?.overBudget && (
        <span className="text-[var(--warn)]">{t("pane.context.plan.overBudget")}</span>
      )}
      {/* How the numbers were obtained. `estimated` is a byte upper bound, not a
          measurement, and it must not look like one. */}
      {p.counting !== "exact" && (
        <span className="text-[var(--text-dim)] opacity-70">
          {t(countingKey(p.counting))}
        </span>
      )}
      {p.degraded && <span className="text-[var(--warn)]">{t("pane.context.plan.degraded")}</span>}
    </>
  );
}

export function ContextBar({
  context,
  capability,
}: {
  context: ContextUsage | null;
  /** The agent's capability view-model, built once by the pane from the plan in
   *  the store. Absent = nothing has run yet; the bar then shows the
   *  runtime-observed half only and invents no limits.
   *
   *  The plan half comes from `capability.context` and NOT from a second call to
   *  `contextPlanFacts` here: two projections of the same plan is how the bar
   *  and the settings page would start reporting different effective windows. */
  capability?: CapabilityViewModel | null;
}) {
  const t = useT();
  // The plan goes IN, so `view.plan` is populated rather than permanently null.
  // It is the same `planView` the pane built `capability` from and with the same
  // live window, so this is one projection of one plan, not a second opinion:
  // `view.plan` and `capability.context` are equal by construction.
  //
  // What is RENDERED still comes from `capability.context` — the pane's own
  // capability view-model, which `/status` reads too, so the two surfaces cannot
  // disagree.
  const view = contextBarView(context, capability?.planView ?? null);
  const plan = capability?.context ?? null;

  // An unverified / legacy-migrated maximum must not read as settled fact: the
  // marker is the visible part, the note carries the migration hint.
  const caveat = view.advertisedCaveatKey ? t(view.advertisedCaveatKey) : undefined;
  const tip = [t(view.tipKey, view.tipParams), ...planTipLines(t, view, plan), caveat, view.advertisedSource]
    .filter(Boolean)
    .join("\n");
  // "max" claims the vendor documents this number; an unverified snapshot or a
  // legacy-migrated value must not inherit that claim.
  const maxLabelKey = view.advertisedIsConfirmed
    ? "pane.context.max"
    : "pane.context.maxUnverified";

  if (view.kind === "no-data") {
    return (
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap text-[var(--text-dim)]"
        title={tip}
      >
        <span>{t("pane.context.unknown")}</span>
        <PlanInline t={t} p={plan} />
      </span>
    );
  }

  if (view.kind === "count-only") {
    return (
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap text-[var(--text-dim)]"
        title={tip}
      >
        <span>{t("pane.context.usedOnly", { used: view.usedText })}</span>
        {view.showAdvertised && view.advertisedText && (
          <span className="opacity-70">
            ({t(maxLabelKey, { advertised: view.advertisedText })}
            {view.advertisedCaveatKey && " ⚠"})
          </span>
        )}
        <PlanInline t={t} p={plan} />
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={tip}>
      <span className="font-mono" style={{ color: TONE_COLOR[view.tone] }}>
        {view.glyph}
      </span>
      <span className="text-[var(--text-dim)]">{view.percentText}</span>
      <span className="text-[var(--text-dim)]">
        {view.usedText}/{view.windowText}
      </span>
      {view.showAdvertised && view.advertisedText && (
        <span className="text-[var(--text-dim)] opacity-70">
          ({t(maxLabelKey, { advertised: view.advertisedText })}
          {view.advertisedCaveatKey && " ⚠"})
        </span>
      )}
      <PlanInline t={t} p={plan} />
    </span>
  );
}
