"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listProviders, type ProviderDTO } from "@/lib/provider-api";
import { useT } from "@/i18n/useT";

const FALLBACK_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

export function NewAgentDialog({
  defaultName,
  onClose,
  onSubmit,
}: {
  defaultName: string;
  onClose: () => void;
  onSubmit: (params: {
    name: string;
    providerId: string | null;
    model: string | null;
    codexWorkspace: string | null;
  }) => void;
}) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState(defaultName);
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listProviders()
      .then((rows) => {
        if (cancelled) return;
        setProviders(rows);
        const def = rows.find((p) => p.isDefault) ?? rows[0];
        if (def) setProviderId(def.id);
      })
      .catch((err) => console.warn("listProviders failed", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? null,
    [providers, providerId],
  );
  const isDefaultAnth =
    selectedProvider?.kind === "anthropic-local" ||
    (selectedProvider?.kind === "anthropic" && !selectedProvider.baseUrl);
  const availableModels: string[] = selectedProvider?.models.length
    ? selectedProvider.models
    : isDefaultAnth
      ? FALLBACK_MODELS
      : [];

  // Reset model to first option whenever provider changes.
  useEffect(() => {
    if (!selectedProvider) return;
    if (availableModels.length > 0 && !availableModels.includes(model)) {
      setModel(availableModels[0]!);
    }
    // intentionally exclude `model` to avoid clobbering manual choice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, providers]);

  useEffect(() => {
    if (mounted) nameInputRef.current?.select();
  }, [mounted]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted) return null;

  const onConfirm = () => {
    const trimmed = name.trim() || defaultName;
    onSubmit({
      name: trimmed,
      providerId: providerId ?? null,
      model: model || null,
      codexWorkspace: null,
    });
    onClose();
  };

  const dialog = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="tool-card bg-[var(--bg-elevated)] w-[420px] max-w-full text-xs shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[var(--accent)]">+</span>
          <span className="text-[var(--text-dim)] tracking-wider">{t("agent.new.title")}</span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            title={t("settings.closeDialog")}
            className="px-1.5 py-0.5 text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)] border border-[var(--border)] transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="p-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("agent.new.label.name")}
            </span>
            <input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onConfirm();
                }
              }}
              placeholder={defaultName}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("agent.new.label.provider")}
            </span>
            <select
              value={providerId ?? ""}
              onChange={(e) => setProviderId(e.target.value || null)}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
            >
              {providers.length === 0 && (
                <option value="" disabled>{t("agent.new.providerEmpty")}</option>
              )}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.kind}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("agent.new.label.model")}
            </span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={availableModels.length === 0}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] disabled:opacity-50"
            >
              {availableModels.length === 0 && (
                <option value="" disabled>{t("agent.new.modelEmpty")}</option>
              )}
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 pt-1">
            <button
              onClick={onConfirm}
              disabled={!providerId}
              className="flex-1 px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
            >
              {t("agent.new.create")}
            </button>
            <button
              onClick={onClose}
              className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
            >
              {t("settings.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
