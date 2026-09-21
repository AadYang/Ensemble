"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listProviders, type ProviderDTO } from "@/lib/provider-api";
import { getWS } from "@/lib/ws";
import { useT } from "@/i18n/useT";
import { DEFAULT_ANTHROPIC_MODELS } from "@/lib/default-models";
import { MenuSelect } from "./MenuSelect";

// Same FALLBACK_MODELS treatment NewTeamDialog uses — anthropic-local rows
// have empty `models[]` in the DB; without this fallback the model dropdown
// shows nothing.
function isDefaultAnthropic(p: ProviderDTO | undefined): boolean {
  if (!p) return false;
  return p.kind === "anthropic-local" || (p.kind === "anthropic" && !p.baseUrl);
}

function availableModelsFor(p: ProviderDTO | undefined): string[] {
  if (!p) return [];
  if (p.models.length > 0) return p.models;
  return isDefaultAnthropic(p) ? DEFAULT_ANTHROPIC_MODELS : [];
}

export function AddTeamMemberDialog({
  teamId,
  teamName,
  onClose,
}: {
  teamId: string;
  teamName: string;
  onClose: () => void;
}) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [role, setRole] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  // Empty = unbound project (the member works in its own scratch dir).
  const [projectRoot, setProjectRoot] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    void listProviders()
      .then((rows) => {
        const enabled = rows.filter((p) => !p.disabled);
        setProviders(enabled);
        const def = enabled.find((p) => p.isDefault) ?? enabled[0];
        if (def) {
          setProviderId(def.id);
          setModel(availableModelsFor(def)[0] ?? "");
        }
      })
      .catch((err) => console.warn("listProviders failed", err));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectedProvider = providers.find((p) => p.id === providerId);
  const availableModels = availableModelsFor(selectedProvider);

  const onProviderChange = (id: string) => {
    setProviderId(id || null);
    const p = providers.find((pp) => pp.id === id);
    setModel(availableModelsFor(p)[0] ?? "");
    // Clear codex workspace when switching to a non-codex provider —
    // otherwise the stale path tags along on submit and the server rejects.
  };

  const handleSubmit = () => {
    setError(null);
    if (!role.trim()) {
      setError(t("team.add.err.role"));
      return;
    }
    if (!providerId) {
      setError(t("team.add.err.provider"));
      return;
    }
    if (!model.trim()) {
      setError(t("team.add.err.model"));
      return;
    }
    const wsClient = getWS();
    if (!wsClient.isOpen()) {
      setError(t("team.add.err.ws"));
      return;
    }
    wsClient.send({
      type: "create_agent",
      name: role.trim(),
      systemPrompt: systemPrompt.trim() || undefined,
      providerId,
      model: model.trim(),
      teamId,
      ...(projectRoot.trim() ? { projectRoot: projectRoot.trim() } : {}),
    });
    onClose();
  };

  if (!mounted) return null;

  const dialog = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="tool-card bg-[var(--bg-elevated)] w-full max-w-[560px] max-h-[92vh] flex flex-col text-xs">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[var(--text-dim)] tracking-wider">
            {t("team.add.title", { team: teamName })}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)]"
          >
            ✕
          </button>
        </div>

        <div className="p-3 flex-1 overflow-y-auto flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("team.add.label.role")}
            </span>
            <input
              value={role}
              autoFocus
              onChange={(e) => setRole(e.target.value)}
              placeholder={t("team.new.placeholder.role")}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
            />
          </label>
          <div className="flex gap-1">
            <MenuSelect
              className="flex-1"
              value={providerId ?? ""}
              onChange={onProviderChange}
              items={providers.map((p) => ({
                value: p.id,
                label: p.name,
                group: p.kind,
              }))}
            />
            <MenuSelect
              className="flex-1"
              value={model}
              onChange={setModel}
              placeholder={t("team.new.noModels")}
              items={availableModels.map((m) => ({ value: m, label: m }))}
            />
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("project.label")}
            </span>
            <input
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              placeholder={t("project.placeholder")}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
            />
            <span className="text-[10px] text-[var(--text-faint)]">
              {projectRoot.trim() ? projectRoot.trim() : t("project.unbound.hint")}
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("team.add.label.systemPrompt")}
            </span>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("team.new.placeholder.systemPrompt")}
              rows={5}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] font-mono text-[11px] resize-y min-h-[80px]"
            />
          </label>
          {error && <div className="text-[var(--err)]">{error}</div>}
        </div>

        <div className="px-3 py-2 border-t border-[var(--border)] flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            {t("team.add.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="px-3 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors"
          >
            {t("team.add.create")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
