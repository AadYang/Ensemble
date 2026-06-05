"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TeamSummary } from "@agentorch/shared";
import { patchTeam } from "@/lib/team-api";
import { useT } from "@/i18n/useT";

export function TeamSettingsDialog({
  team,
  onClose,
}: {
  team: TeamSummary;
  onClose: () => void;
}) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSave = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("team.settings.err.name"));
      return;
    }
    const trimmedDesc = description.trim();
    const curDesc = (team.description ?? "").trim();
    const patch: { name?: string; description?: string | null } = {};
    if (trimmedName !== team.name) patch.name = trimmedName;
    if (trimmedDesc !== curDesc) patch.description = trimmedDesc.length === 0 ? null : trimmedDesc;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await patchTeam(team.id, patch);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (!mounted) return null;

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="tool-card bg-[var(--bg-elevated)] w-full max-w-[560px] flex flex-col text-xs">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[var(--text-dim)] tracking-wider">
            {t("team.settings.title")}
          </span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)]"
          >
            ✕
          </button>
        </div>

        <div className="p-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("team.settings.label.name")}
            </span>
            <input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder={t("team.new.placeholder.name")}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("team.settings.label.description")}
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("team.new.placeholder.description")}
              rows={4}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] font-mono text-[11px] resize-y min-h-[64px]"
            />
            <span className="text-[10px] text-[var(--text-faint)]">
              {t("team.settings.hint.description")}
            </span>
          </label>
          {error && <div className="text-[var(--err)]">{error}</div>}
        </div>

        <div className="px-3 py-2 border-t border-[var(--border)] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            {t("team.settings.cancel")}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={busy}
            className="px-3 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
          >
            {t("team.settings.save")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
