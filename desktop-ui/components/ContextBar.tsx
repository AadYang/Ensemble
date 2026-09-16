"use client";

import type { CapabilityViewModel, ContextUsage } from "@agentorch/shared";
import { contextBarView, CONTEXT_BAR_SEGMENTS } from "@agentorch/shared";
import { useT } from "@/i18n/useT";

const TONE_COLOR: Record<string, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  err: "var(--err)",
  dim: "var(--text-dim)",
};

const EMPTY_GLYPH = `▕${"░".repeat(CONTEXT_BAR_SEGMENTS)}`;

export function ContextBar({
  context,
  capability,
}: {
  context: ContextUsage | null;
  capability?: CapabilityViewModel | null;
}) {
  const t = useT();
  const view = contextBarView(context, capability?.planView ?? null);
  const planWindow = capability?.context?.effectiveWindowText ?? null;

  if (view.kind === "bar") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap" title={t(view.tipKey, view.tipParams)}>
        <span className="font-mono" style={{ color: TONE_COLOR[view.tone] }}>
          {view.glyph}
        </span>
        <span className="text-[var(--text-dim)]">{view.percentText}</span>
        <span className="text-[var(--text-dim)]">
          {view.usedText}/{view.windowText}
        </span>
      </span>
    );
  }

  if (view.kind === "count-only") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-[var(--text-dim)]" title={t(view.tipKey, view.tipParams)}>
        {view.usedText}
      </span>
    );
  }

  if (planWindow) {
    return (
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap text-[var(--text-dim)]"
        title={t("pane.context.tip", { used: "0", window: planWindow, percent: 0 })}
      >
        <span className="font-mono" style={{ color: TONE_COLOR.dim }}>
          {EMPTY_GLYPH}
        </span>
        <span>0%</span>
        <span>0/{planWindow}</span>
      </span>
    );
  }

  return null;
}
