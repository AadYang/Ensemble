"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { listProviders, type ProviderDTO } from "@/lib/provider-api";
import { createTeam } from "@/lib/team-api";
import { getWS } from "@/lib/ws";
import { useT } from "@/i18n/useT";

// Same fallback that AgentSettings uses. anthropic-local provider rows live
// in the DB with empty `models[]` because the actual model id list comes from
// the local claude CLI's own catalog, which we don't enumerate at provider
// creation. AgentSettings hardcodes these three so users can pick something
// sensible without an explicit refresh; NewTeamDialog should do the same.
const FALLBACK_MODELS = [
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

interface MemberDraft {
  role: string;
  systemPrompt: string;
  providerId: string | null;
  model: string;
}

function emptyMember(): MemberDraft {
  return {
    role: "",
    systemPrompt: "",
    providerId: null,
    model: "",
  };
}

function memberWithDefaults(providers: ProviderDTO[]): MemberDraft {
  const def = providers.find((p) => p.isDefault) ?? providers[0];
  if (!def) return emptyMember();
  const models = availableModelsFor(def);
  return {
    role: "",
    systemPrompt: "",
    providerId: def.id,
    model: models[0] ?? "",
  };
}

export function NewTeamDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [teamName, setTeamName] = useState("");
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<MemberDraft[]>(() => [emptyMember(), emptyMember()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    void listProviders()
      .then((rows) => setProviders(rows.filter((p) => !p.disabled)))
      .catch((err) => console.warn("listProviders failed", err));
  }, []);

  // Group providers by kind for the dropdown — makes "pick a different model
  // for each role" feel like a first-class action rather than an afterthought.
  const providersByKind = useMemo(() => {
    const groups: Record<string, ProviderDTO[]> = {};
    for (const p of providers) {
      (groups[p.kind] ??= []).push(p);
    }
    return groups;
  }, [providers]);

  // Auto-fill: when a member has no provider selected yet, default to the
  // default provider once it loads. Each member is independent — no
  // cross-talk so users can freely mix Claude / OpenAI / Codex per role.
  // Re-runs on every providers change, so members added BEFORE providers
  // load also get filled when they arrive.
  useEffect(() => {
    if (providers.length === 0) return;
    const def = providers.find((p) => p.isDefault) ?? providers[0];
    if (!def) return;
    const defModels = availableModelsFor(def);
    setMembers((prev) =>
      prev.map((m) =>
        m.providerId == null ? { ...m, providerId: def.id, model: defModels[0] ?? "" } : m,
      ),
    );
  }, [providers]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const updateMember = (idx: number, patch: Partial<MemberDraft>) => {
    setMembers((prev) =>
      prev.map((m, i) => {
        if (i !== idx) return m;
        const next = { ...m, ...patch };
        // When provider changes:
        //   1. Reset model to the new provider's first available (with the
        //      anthropic-local FALLBACK_MODELS treatment, otherwise the
        //      dropdown shows nothing).
        //   2. Clear codexWorkspace if the new provider isn't codex —
        //      otherwise the stale path tags along on submit and the server
        //      rejects with "codexWorkspace is only valid for openai-codex"
        //      → that member silently fails to create.
        if (patch.providerId !== undefined && patch.providerId !== m.providerId) {
          const p = providers.find((pr) => pr.id === patch.providerId);
          next.model = availableModelsFor(p)[0] ?? "";
        }
        return next;
      }),
    );
  };

  const addMember = () =>
    setMembers((prev) => [...prev, providers.length > 0 ? memberWithDefaults(providers) : emptyMember()]);
  const removeMember = (idx: number) => setMembers((prev) => prev.filter((_, i) => i !== idx));

  const handleSubmit = async () => {
    setError(null);
    if (!teamName.trim()) {
      setError(t("team.err.nameRequired"));
      return;
    }
    if (members.length === 0) {
      setError(t("team.err.atLeastOne"));
      return;
    }
    for (const [i, m] of members.entries()) {
      if (!m.role.trim()) {
        setError(t("team.err.roleRequired", { idx: i + 1 }));
        return;
      }
      if (!m.providerId) {
        setError(t("team.err.providerRequired", { idx: i + 1 }));
        return;
      }
      if (!m.model.trim()) {
        setError(t("team.err.modelRequired", { idx: i + 1 }));
        return;
      }
    }

    setBusy(true);
    try {
      const { id: teamId } = await createTeam({
        name: teamName.trim(),
        description: description.trim() || undefined,
      });
      const ws = getWS();
      for (const m of members) {
        // Defensive: even if the codex workspace input is hidden when the
        // current provider isn't codex, the underlying state may carry a
        // stale value from a previous provider selection. Only send it
        // when the SELECTED provider is codex; otherwise the server's
        // strict "codexWorkspace requires openai-codex" check would silently
        // drop this agent.
        ws.send({
          type: "create_agent",
          name: m.role.trim(),
          systemPrompt: m.systemPrompt.trim() || undefined,
          providerId: m.providerId ?? undefined,
          model: m.model.trim() || undefined,
          teamId,
          codexWorkspace: undefined,
        });
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!mounted) return null;

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="tool-card bg-[var(--bg-elevated)] w-full max-w-[760px] max-h-[92vh] flex flex-col text-xs">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[var(--text-dim)] tracking-wider">{t("team.new.title")}</span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)]"
          >
            ✕
          </button>
        </div>

        <div className="p-3 flex-1 overflow-y-auto flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("team.new.label.name")}
            </span>
            <input
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder={t("team.new.placeholder.name")}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("team.new.label.description")}
            </span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("team.new.placeholder.description")}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
            />
          </label>

          <div className="flex flex-col gap-2 mt-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
                {t("team.new.members")}
              </span>
              <span className="text-[10px] text-[var(--text-faint)]">
                {t("team.new.membersHint")}
              </span>
            </div>
            {members.map((m, idx) => {
              const p = providers.find((pp) => pp.id === m.providerId);
              const availableModels = availableModelsFor(p);
              return (
                <div
                  key={idx}
                  className="flex flex-col gap-1 border border-[var(--border)] bg-[var(--bg-pane)] p-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[var(--text-faint)] w-12">
                      {t("team.new.member", { idx: idx + 1 })}
                    </span>
                    <input
                      value={m.role}
                      onChange={(e) => updateMember(idx, { role: e.target.value })}
                      placeholder={t("team.new.placeholder.role")}
                      className="flex-1 bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)]"
                    />
                    {members.length > 1 && (
                      <button
                        onClick={() => removeMember(idx)}
                        className="px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)]"
                        title={t("team.new.removeMember")}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <div className="flex items-stretch gap-1">
                    <select
                      value={m.providerId ?? ""}
                      onChange={(e) => updateMember(idx, { providerId: e.target.value || null })}
                      className="flex-1 bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] text-[var(--text-dim)]"
                    >
                      {Object.entries(providersByKind).map(([kind, list]) => (
                        <optgroup key={kind} label={kind}>
                          {list.map((pp) => (
                            <option key={pp.id} value={pp.id}>
                              {pp.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <select
                      value={m.model}
                      onChange={(e) => updateMember(idx, { model: e.target.value })}
                      className="flex-1 bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] text-[var(--text-dim)]"
                    >
                      {availableModels.length === 0 && <option value="">{t("team.new.noModels")}</option>}
                      {availableModels.map((mm) => (
                        <option key={mm} value={mm}>
                          {mm}
                        </option>
                      ))}
                    </select>
                  </div>
                  <textarea
                    value={m.systemPrompt}
                    onChange={(e) => updateMember(idx, { systemPrompt: e.target.value })}
                    placeholder={t("team.new.placeholder.systemPrompt")}
                    rows={4}
                    className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] font-mono text-[11px] resize-y min-h-[60px]"
                  />
                </div>
              );
            })}
            <button
              onClick={addMember}
              className="self-start px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
            >
              + {t("team.new.addMember")}
            </button>
          </div>

          {error && <div className="text-[var(--err)]">{error}</div>}
        </div>

        <div className="px-3 py-2 border-t border-[var(--border)] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            {t("team.new.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={busy}
            className="px-3 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
          >
            {t("team.new.create")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
