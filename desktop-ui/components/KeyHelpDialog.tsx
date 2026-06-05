"use client";

import { useEffect } from "react";
import { useT } from "@/i18n/useT";
import { useStore } from "@/store/agents";

interface Row { keys: string; descKey: string; }

const PANE_KEYS: Row[] = [
  { keys: "%", descKey: "help.key.splitH" },
  { keys: '"', descKey: "help.key.splitV" },
  { keys: "x", descKey: "help.key.closePane" },
  { keys: "o · Tab", descKey: "help.key.focusCycle" },
  { keys: "↑ ↓ ← →", descKey: "help.key.focusDir" },
  { keys: "H · J · K · L", descKey: "help.key.resize" },
];

const WIN_KEYS: Row[] = [
  { keys: "c", descKey: "help.key.newWindow" },
  { keys: "n", descKey: "help.key.nextWindow" },
  { keys: "p", descKey: "help.key.prevWindow" },
  { keys: "1 – 9", descKey: "help.key.jumpWindow" },
  { keys: ",", descKey: "help.key.renameWindow" },
  { keys: "&", descKey: "help.key.closeWindow" },
];

const MODE_KEYS: Row[] = [
  { keys: ":", descKey: "help.key.palette" },
  { keys: "?", descKey: "help.key.help" },
];

export function KeyHelpDialog() {
  const open = useStore((s) => s.helpOpen);
  const setOpen = useStore((s) => s.setHelpOpen);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="tool-card max-w-3xl w-full bg-[var(--bg-elevated)]">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2 text-xs">
          <span className="text-[var(--accent)] tracking-wider">{t("help.title")}</span>
          <span className="flex-1" />
          <span className="text-[var(--text-faint)]">
            {t("help.subtitle", { prefix: "Ctrl+B" })}
          </span>
        </div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-6 text-xs">
          <Group title={t("help.group.pane")} rows={PANE_KEYS} t={t} />
          <Group title={t("help.group.window")} rows={WIN_KEYS} t={t} />
          <Group title={t("help.group.mode")} rows={MODE_KEYS} t={t} />
        </div>
        <div className="px-3 py-2 border-t border-[var(--border)] text-[10px] text-[var(--text-faint)] tracking-wider">
          {t("help.note")}
        </div>
      </div>
    </div>
  );
}

function Group({
  title,
  rows,
  t,
}: {
  title: string;
  rows: Row[];
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] tracking-[0.18em] text-[var(--text-faint)] uppercase mb-1">
        {title}
      </div>
      {rows.map((r) => (
        <div key={r.keys} className="flex items-center gap-3">
          <span className="text-[var(--accent)] font-mono w-32 truncate">{r.keys}</span>
          <span className="text-[var(--text-dim)]">{t(r.descKey)}</span>
        </div>
      ))}
    </div>
  );
}
