"use client";

import { useEffect, useMemo, useState } from "react";
import {
  deletePricingOverride,
  fetchPricing,
  savePricingModel,
  type PricingModelRow,
  type PricingTableDTO,
} from "@/lib/pricing-api";

interface Props {
  initialModel?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

interface Draft {
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  source: string;
}

const emptyDraft = (model = ""): Draft => ({
  model,
  input: "",
  output: "",
  cacheRead: "",
  cacheWrite: "",
  source: "",
});

const draftFromRow = (row: PricingModelRow): Draft => ({
  model: row.model,
  input: String(row.input),
  output: String(row.output),
  cacheRead: row.cacheRead == null ? "" : String(row.cacheRead),
  cacheWrite: row.cacheWrite == null ? "" : String(row.cacheWrite),
  source: row.source ?? "",
});

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) throw new Error("prices must be non-negative numbers");
  return n;
}

function parseRequiredNumber(raw: string, label: string): number {
  const n = parseOptionalNumber(raw);
  if (n == null) throw new Error(`${label} price is required`);
  return n;
}

export function PricingSettingsDialog({ initialModel, onClose, onSaved }: Props) {
  const [table, setTable] = useState<PricingTableDTO | null>(null);
  const [filter, setFilter] = useState(initialModel ?? "");
  const [draft, setDraft] = useState<Draft>(emptyDraft(initialModel ?? ""));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchPricing()
      .then((next) => {
        setTable(next);
        if (initialModel) {
          const row = next.models.find((m) => m.model === initialModel);
          setDraft(row ? draftFromRow(row) : emptyDraft(initialModel));
        }
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const models = table?.models ?? [];
    if (!q) return models;
    return models.filter((row) => row.model.toLowerCase().includes(q) || row.source?.toLowerCase().includes(q));
  }, [filter, table]);

  const save = async () => {
    setError(null);
    setMessage(null);
    const model = draft.model.trim();
    if (!model) {
      setError("model id is required");
      return;
    }
    let payload;
    try {
      payload = {
        model,
        input: parseRequiredNumber(draft.input, "input"),
        output: parseRequiredNumber(draft.output, "output"),
        cacheRead: parseOptionalNumber(draft.cacheRead),
        cacheWrite: parseOptionalNumber(draft.cacheWrite),
        source: draft.source.trim() || null,
      };
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setSaving(true);
    try {
      const result = await savePricingModel(payload);
      setMessage(`saved; recomputed ${result.recomputed} usage row(s)`);
      await fetchPricing().then(setTable);
      onSaved?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const resetOverride = async (model: string) => {
    setError(null);
    setMessage(null);
    setSaving(true);
    try {
      const result = await deletePricingOverride(model);
      setMessage(`override removed; recomputed ${result.recomputed} usage row(s)`);
      const next = await fetchPricing();
      setTable(next);
      const row = next.models.find((m) => m.model === model);
      setDraft(row ? draftFromRow(row) : emptyDraft(model));
      onSaved?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-hidden bg-black/70 backdrop-blur-sm p-6">
      <div className="tool-card flex w-full max-w-5xl max-h-[calc(100dvh-3rem)] flex-col overflow-hidden bg-[var(--bg-elevated)]">
        <div className="flex shrink-0 items-center gap-2 mb-3 text-xs">
          <span className="text-[var(--accent)] tracking-wider">pricing</span>
          {table && <span className="text-[var(--text-faint)]">version {table.version}</span>}
          <span className="flex-1" />
          <button
            onClick={onClose}
            className="px-1.5 py-0.5 text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)] border border-[var(--border)] transition-colors"
          >
            x
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-3">
          <div className="min-h-0 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter models..."
                className="flex-1 bg-[var(--bg-pane)] border border-[var(--border)] px-2 py-1 outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={() => {
                  setDraft(emptyDraft(filter.trim()));
                  setMessage(null);
                  setError(null);
                }}
                className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
              >
                new
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto border border-[var(--border)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[var(--bg-pane)] text-[var(--text-faint)]">
                  <tr>
                    <th className="text-left px-2 py-1 font-normal">model</th>
                    <th className="text-right px-2 py-1 font-normal">input / 1M</th>
                    <th className="text-right px-2 py-1 font-normal">output / 1M</th>
                    <th className="text-right px-2 py-1 font-normal">cache read</th>
                    <th className="text-right px-2 py-1 font-normal">cache write</th>
                    <th className="text-left px-2 py-1 font-normal">scope</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <td colSpan={6} className="px-2 py-8 text-center text-[var(--text-faint)]">
                        loading...
                      </td>
                    </tr>
                  )}
                  {!loading && rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-2 py-8 text-center text-[var(--text-faint)]">
                        no models
                      </td>
                    </tr>
                  )}
                  {rows.map((row) => {
                    const selected = draft.model === row.model;
                    return (
                      <tr
                        key={row.model}
                        onClick={() => setDraft(draftFromRow(row))}
                        className={`cursor-pointer border-t border-[var(--border)] hover:bg-[var(--bg-pane)] ${
                          selected ? "bg-[var(--bg-pane)] text-[var(--accent)]" : ""
                        }`}
                      >
                        <td className="px-2 py-1 font-mono">{row.model}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{row.input}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{row.output}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{row.cacheRead ?? "-"}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{row.cacheWrite ?? "-"}</td>
                        <td className="px-2 py-1">
                          {row.overridden ? "override" : row.builtIn ? "built-in" : "custom"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="min-h-0 overflow-auto border border-[var(--border)] bg-[var(--bg-pane)] p-3 text-xs">
            <div className="mb-3 text-[var(--text-faint)] tracking-wider">model price</div>
            <FormField label="model">
              <input
                value={draft.model}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                className="w-full bg-[var(--bg-elevated)] border border-[var(--border)] px-2 py-1 outline-none focus:border-[var(--accent)] font-mono"
              />
            </FormField>
            <div className="grid grid-cols-2 gap-2">
              <FormField label="input / 1M">
                <NumberInput value={draft.input} onChange={(input) => setDraft((d) => ({ ...d, input }))} />
              </FormField>
              <FormField label="output / 1M">
                <NumberInput value={draft.output} onChange={(output) => setDraft((d) => ({ ...d, output }))} />
              </FormField>
              <FormField label="cache read">
                <NumberInput value={draft.cacheRead} onChange={(cacheRead) => setDraft((d) => ({ ...d, cacheRead }))} />
              </FormField>
              <FormField label="cache write">
                <NumberInput value={draft.cacheWrite} onChange={(cacheWrite) => setDraft((d) => ({ ...d, cacheWrite }))} />
              </FormField>
            </div>
            <FormField label="source">
              <input
                value={draft.source}
                onChange={(e) => setDraft((d) => ({ ...d, source: e.target.value }))}
                placeholder="optional note"
                className="w-full bg-[var(--bg-elevated)] border border-[var(--border)] px-2 py-1 outline-none focus:border-[var(--accent)]"
              />
            </FormField>
            <div className="mt-3 text-[10px] leading-relaxed text-[var(--text-faint)]">
              Prices are USD per 1M tokens. Saving writes a user override and recomputes existing usage rows for this model.
            </div>
            {table?.overridesPath && (
              <div className="mt-2 break-all text-[10px] text-[var(--text-faint)]">
                override file: {table.overridesPath}
              </div>
            )}
            {message && <div className="mt-3 text-[10px] text-[var(--accent)]">{message}</div>}
            {error && <div className="mt-3 text-[10px] text-[var(--err)]">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              {table?.models.find((row) => row.model === draft.model && row.overridden) && (
                <button
                  onClick={() => void resetOverride(draft.model)}
                  disabled={saving}
                  className="px-3 py-1 border border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn)] hover:text-black disabled:opacity-30"
                >
                  reset
                </button>
              )}
              <button
                onClick={() => void save()}
                disabled={saving}
                className="px-3 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30"
              >
                {saving ? "saving..." : "save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block">
      <div className="mb-1 text-[10px] text-[var(--text-faint)]">{label}</div>
      {children}
    </label>
  );
}

function NumberInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="number"
      min="0"
      step="0.000001"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-[var(--bg-elevated)] border border-[var(--border)] px-2 py-1 outline-none focus:border-[var(--accent)] tabular-nums"
    />
  );
}
