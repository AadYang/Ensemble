"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { listProviders, type ProviderDTO } from "@/lib/provider-api";
import { getWS } from "@/lib/ws";
import { useT } from "@/i18n/useT";

// Same FALLBACK_MODELS treatment NewTeamDialog uses — anthropic-local rows
// have empty `models[]` in the DB; without this fallback the model dropdown
// shows nothing.
const FALLBACK_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

function isDefaultAnthropic(p: ProviderDTO | undefined): boolean {
  if (!p) return false;
  return p.kind === "anthropic-local" || (p.kind === "anthropic" && !p.baseUrl);
}

function availableModelsFor(p: ProviderDTO | undefined): string[] {
  if (!p) return [];
  if (p.models.length > 0) return p.models;
  return isDefaultAnthropic(p) ? FALLBACK_MODELS : [];
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const providersByKind = useMemo(() => {
    const groups: Record<string, ProviderDTO[]> = {};
    for (const p of providers) (groups[p.kind] ??= []).push(p);
    return groups;
  }, [providers]);

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
    setBusy(true);
    const expectedName = role.trim();
    const wsClient = getWS();

    // Defensive close: wait for the server's agent_created (matching teamId
    // + role name) before dismissing the dialog. If the WS frame got dropped
    // or the server rejected the create_agent payload, we'd otherwise close
    // the dialog and the user would think it succeeded.
    let settled = false;
    const unsub = wsClient.subscribe((msg) => {
      if (settled) return;
      if (msg.type === "agent_created" && msg.agent.teamId === teamId && msg.agent.name === expectedName) {
        settled = true;
        unsub();
        clearTimeout(timeoutId);
        onClose();
      } else if (msg.type === "error") {
        settled = true;
        unsub();
        clearTimeout(timeoutId);
        setError(msg.message);
        setBusy(false);
      }
    });
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      setError(t("team.add.err.timeout"));
      setBusy(false);
    }, 4000);

    wsClient.send({
      type: "create_agent",
      name: expectedName,
      systemPrompt: systemPrompt.trim() || undefined,
      providerId,
      model: model.trim(),
      teamId,
      codexWorkspace: undefined,
    });
  };

  if (!mounted) return null;

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="tool-card bg-[var(--bg-elevated)] w-full max-w-[560px] flex flex-col text-xs">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[var(--text-dim)] tracking-wider">
            {t("team.add.title", { team: teamName })}
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
            <select
              value={providerId ?? ""}
              onChange={(e) => onProviderChange(e.target.value)}
              className="flex-1 bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] text-[var(--text-dim)]"
            >
              {Object.entries(providersByKind).map(([kind, list]) => (
                <optgroup key={kind} label={kind}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="flex-1 bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] text-[var(--text-dim)]"
            >
              {availableModels.length === 0 && <option value="">{t("team.new.noModels")}</option>}
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
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
            onClick={onClose}
            className="px-3 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            {t("team.add.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={busy}
            className="px-3 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
          >
            {t("team.add.create")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
