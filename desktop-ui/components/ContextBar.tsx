"use client";

import type { ContextUsage } from "@agentorch/shared";
import { useT } from "@/i18n/useT";

// W22: agent-pane context-usage bar (merged from the Ensemble working tree).
//
// Thresholds are the context-rot QUALITY-DEGRADATION bands (user decision),
// not window-fullness: ≤20% green, 20–40% yellow, >40% red. Past 40% the
// context is deep enough that answer quality measurably degrades — a prompt to
// /compact early rather than wait for overflow.

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

function ctxColor(percent: number): string {
  if (percent <= 20) return "var(--ok)";
  if (percent <= 40) return "var(--warn)";
  return "var(--err)";
}

export function ContextBar({ context }: { context: ContextUsage | null }) {
  const t = useT();

  if (!context) {
    return (
      <span className="text-[var(--text-dim)] whitespace-nowrap" title={t("pane.context.unknownTip")}>
        {t("pane.context.unknown")}
      </span>
    );
  }

  const filled = Math.max(0, Math.min(10, Math.round(context.percent / 10)));
  const glyph = `▕${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  const color = ctxColor(context.percent);
  const tip = t("pane.context.tip", {
    used: fmtTokens(context.usedTokens),
    window: fmtTokens(context.contextWindow),
    percent: context.percent,
  });

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={tip}>
      <span className="font-mono" style={{ color }}>
        {glyph}
      </span>
      <span className="text-[var(--text-dim)]">{context.percent}%</span>
      <span className="text-[var(--text-dim)]">
        {fmtTokens(context.usedTokens)}/{fmtTokens(context.contextWindow)}
      </span>
    </span>
  );
}
