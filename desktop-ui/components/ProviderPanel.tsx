"use client";

import { useEffect, useState } from "react";
import {
  createProvider,
  deleteProvider,
  listProviders,
  migrateDeprecatedProvider,
  patchProvider,
  refreshProviderModels,
  type ProviderDTO,
  type ProviderKind,
  type SandboxMode,
} from "@/lib/provider-api";
import { PROVIDER_PRESETS } from "@/lib/provider-presets";
import { useT } from "@/i18n/useT";
import { getDialog } from "@/lib/dialog";
import { getCliSettings, type CliSettingsHealth } from "@/lib/settings-api";

// W16 Slice 1.3 + W20 Slice 5.4: form models a runtime+entry decision tree
// rather than the raw provider kind enum, mapping to kind on submit:
//   (claude, official) -> anthropic-local   (claude OAuth via local CLI)
//   (claude, compat)   -> anthropic         (third-party Anthropic-compat URL)
//   (openai, official) -> openai-local      (api.openai.com + sk-key)
//   (openai, codex)    -> openai-codex      (experimental codex CLI OAuth)
//   (openai, compat)   -> openai-compat     (custom OpenAI-compat baseUrl)
// Claude side only sees official/compat; OpenAI side sees three.
type Runtime = "claude" | "openai";
type Entry = "official" | "compat" | "codex";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

const parseModelsText = (s: string): string[] =>
  s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

const normalizeProviderBaseUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname) return null;
  return parsed.toString().replace(/\/$/, "");
};

const deriveRuntimeEntry = (p: ProviderDTO): { runtime: Runtime; entry: Entry } => {
  if (p.kind === "anthropic-local") return { runtime: "claude", entry: "official" };
  if (p.kind === "anthropic") return { runtime: "claude", entry: "compat" };
  if (p.kind === "openai-local") return { runtime: "openai", entry: "official" };
  if (p.kind === "openai-codex") return { runtime: "openai", entry: "codex" };
  // openai-compat
  return { runtime: "openai", entry: "compat" };
};

const kindFromRuntimeEntry = (runtime: Runtime, entry: Entry): ProviderKind => {
  if (runtime === "claude") return entry === "official" ? "anthropic-local" : "anthropic";
  if (entry === "official") return "openai-local";
  if (entry === "codex") return "openai-codex";
  return "openai-compat";
};

export function ProviderPanel() {
  const t = useT();
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState<Runtime>("claude");
  const [entry, setEntry] = useState<Entry>("official");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [manualModels, setManualModels] = useState("");
  // Commercial default for Codex provider creation. Users can still override
  // per provider or per agent.
  const [sandboxMode, setSandboxMode] = useState<SandboxMode | "">("danger-full-access");
  const [cliHealth, setCliHealth] = useState<CliSettingsHealth | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const [providerRows, cliRows] = await Promise.all([listProviders(), getCliSettings()]);
      setProviders(providerRows);
      setCliHealth(cliRows);
    } catch (err) {
      console.warn("listProviders failed", err);
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const resetForm = () => {
    setName("");
    setRuntime("claude");
    setEntry("official");
    setBaseUrl("");
    setApiKey("");
    setManualModels("");
    setSandboxMode("danger-full-access");
    setError(null);
  };

  // Auto-fill OpenAI official baseUrl when entering that combo. Compat clears
  // it so the user is forced to type their own.
  useEffect(() => {
    if (runtime === "openai" && entry === "official") {
      setBaseUrl(OPENAI_DEFAULT_BASE_URL);
    } else if (runtime === "openai" && entry === "compat" && baseUrl === OPENAI_DEFAULT_BASE_URL) {
      setBaseUrl("");
    } else if (runtime === "openai" && entry === "codex") {
      // W20: codex uses local CLI OAuth — no baseUrl/apiKey input.
      setBaseUrl("");
      setApiKey("");
    } else if (runtime === "claude" && entry === "official") {
      setBaseUrl("");
      setApiKey("");
    }
    // Codex is OpenAI-side only; if user switches to Claude with entry=codex
    // (state-carryover from a prior selection), snap entry back to official.
    if (runtime === "claude" && entry === "codex") {
      setEntry("official");
    }
    // intentionally exclude baseUrl/apiKey to avoid feedback loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, entry]);

  const onSubmitNew = async () => {
    if (!name.trim()) {
      setError(t("provider.err.nameRequired"));
      return;
    }
    const kind = kindFromRuntimeEntry(runtime, entry);
    const isLocal = kind === "anthropic-local";
    const isCodex = kind === "openai-codex";
    if (!isLocal && !isCodex && !baseUrl.trim()) {
      setError(t("provider.err.baseUrlRequired"));
      return;
    }
    const normalizedBaseUrl = isLocal || isCodex ? null : normalizeProviderBaseUrl(baseUrl);
    if (!isLocal && !isCodex && !normalizedBaseUrl) {
      setError(t("provider.err.baseUrlInvalid"));
      return;
    }
    if (isLocal) {
      const ok = await getDialog().confirm({ title: t("provider.confirmAddLocal") });
      if (!ok) return;
    }
    setError(null);
    try {
      const manualParsed = parseModelsText(manualModels);
      const created = await createProvider({
        name: name.trim(),
        kind,
        baseUrl: normalizedBaseUrl,
        apiKey: isLocal || isCodex ? null : apiKey.trim() || null,
        ...(manualParsed.length > 0 && !isLocal && !isCodex ? { models: manualParsed } : {}),
        ...(isCodex && sandboxMode ? { defaultSandbox: sandboxMode } : {}),
      });
      resetForm();
      setAdding(false);
      // Auto-discover models so the new row arrives populated. Skip when the
      // user pasted a manual list (don't clobber their choice); best-effort
      // otherwise — failures (no key, network, codex not logged in) stay
      // silent because the ↻ button on the row still works.
      const skipAutoRefresh = manualParsed.length > 0 && !isLocal && !isCodex;
      if (!skipAutoRefresh) {
        try {
          await refreshProviderModels(created.id);
        } catch {
          // intentionally swallowed
        }
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onSubmitEdit = async (id: string) => {
    const kind = kindFromRuntimeEntry(runtime, entry);
    const isLocal = kind === "anthropic-local";
    const isCodex = kind === "openai-codex";
    if (!isLocal && !isCodex && !baseUrl.trim()) {
      setError(t("provider.err.baseUrlRequired"));
      return;
    }
    const normalizedBaseUrl = isLocal || isCodex ? null : normalizeProviderBaseUrl(baseUrl);
    if (!isLocal && !isCodex && !normalizedBaseUrl) {
      setError(t("provider.err.baseUrlInvalid"));
      return;
    }
    setError(null);
    try {
      const manualParsed = parseModelsText(manualModels);
      await patchProvider(id, {
        name: name.trim() || undefined,
        ...(isCodex
          ? { defaultSandbox: sandboxMode || null }
          : {
              baseUrl: normalizedBaseUrl,
              apiKey: apiKey.trim() || undefined,
              ...(manualParsed.length > 0 ? { models: manualParsed } : {}),
            }),
      });
      setEditingId(null);
      resetForm();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const [refreshFlash, setRefreshFlash] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const onRefreshModels = async (p: ProviderDTO) => {
    setBusyId(p.id);
    setError(null);
    setRefreshFlash(null);
    try {
      const r = await refreshProviderModels(p.id);
      const count = r.discovered?.count ?? r.models.length;
      const src = r.discovered?.source ?? "default";
      setRefreshFlash({ id: p.id, ok: true, msg: `${count} models · ${src}` });
      await refresh();
    } catch (err) {
      setRefreshFlash({ id: p.id, ok: false, msg: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (p: ProviderDTO) => {
    const title =
      p.kind === "anthropic-local"
        ? t("provider.confirmDeleteLocal", { name: p.name })
        : t("provider.confirmDelete", { name: p.name });
    const ok = await getDialog().confirm({ title, danger: true });
    if (!ok) return;
    try {
      await deleteProvider(p.id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onMigrate = async (p: ProviderDTO) => {
    const ok = await getDialog().confirm({
      title: `Migrate "${p.name}" to openai-compat? The original baseUrl + key will be reused; the deprecated row will be deleted.`,
    });
    if (!ok) return;
    setBusyId(p.id);
    try {
      await migrateDeprecatedProvider(p.id, {});
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = (p: ProviderDTO) => {
    setEditingId(p.id);
    setAdding(false);
    const { runtime: rt, entry: en } = deriveRuntimeEntry(p);
    setName(p.name);
    setRuntime(rt);
    setEntry(en);
    setBaseUrl(p.baseUrl ?? "");
    setApiKey("");
    setManualModels(p.models.join("\n"));
    setSandboxMode((p.defaultSandbox as SandboxMode | null) ?? "");
    setError(null);
  };

  const applyPreset = (presetId: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    // Presets are runtime-tagged; default unknown to claude/compat.
    setRuntime(preset.runtime);
    setEntry("compat");
    setBaseUrl(preset.baseUrl);
    setManualModels(preset.models.join("\n"));
  };

  const deprecatedCount = providers.filter((p) => p.disabled).length;

  return (
    <div className="border-b border-[var(--border)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-3 py-2 flex items-center gap-2 text-xs hover:bg-[var(--bg-pane)]"
      >
        <span className="text-[var(--text-faint)]">{open ? "▾" : "▸"}</span>
        <span className="text-[var(--text-dim)] tracking-wider">{t("provider.label")}</span>
        <span className="text-[var(--text-faint)] ml-auto">{providers.length}</span>
      </button>
      {open && (
        <div className="px-2 pb-2 flex flex-col gap-1 text-[11px]">
          {/* W16: deprecation banner — surfaces auto-disabled bedrock/vertex/autoManaged
               rows from the v0.0.2 migration. Per-row migrate button reuses the
               original baseUrl + apiKey to mint a fresh openai-compat provider.
               Slice 6 removed the embedded musistudio gateway entirely; existing
               autoManaged rows are surfaced here for one-click migration. */}
          {deprecatedCount > 0 && (
            <div className="text-[10px] text-[var(--warn)] leading-snug px-2 py-1 border-l-2 border-[var(--warn)] pl-2 bg-[var(--bg-pane)]">
              {deprecatedCount} deprecated provider(s) disabled (bedrock / vertex / autoManaged are no longer supported). Click ⇪ on each to migrate to openai-compat.
            </div>
          )}

          {providers.length === 0 && (
            <div className="px-2 py-1 text-[var(--text-faint)]">{t("provider.empty")}</div>
          )}
          {providers.map((p) =>
            editingId === p.id ? (
              <ProviderForm
                key={p.id}
                t={t}
                title={t("provider.form.editTitle")}
                isEdit
                name={name}
                setName={setName}
                runtime={runtime}
                setRuntime={setRuntime}
                entry={entry}
                setEntry={setEntry}
                baseUrl={baseUrl}
                setBaseUrl={setBaseUrl}
                apiKey={apiKey}
                setApiKey={setApiKey}
                manualModels={manualModels}
                setManualModels={setManualModels}
                sandboxMode={sandboxMode}
                setSandboxMode={setSandboxMode}
                codexHealth={cliHealth?.codex ?? null}
                codexRuntime={p.currentRuntime ?? null}
                applyPreset={applyPreset}
                hasExistingKey={p.hasApiKey}
                onSubmit={() => onSubmitEdit(p.id)}
                onCancel={() => {
                  setEditingId(null);
                  resetForm();
                }}
                error={error}
              />
            ) : (
              <div
                key={p.id}
                className={`flex flex-col gap-1 px-1.5 py-1 border border-[var(--border)] bg-[var(--bg-pane)] ${
                  p.disabled ? "opacity-50" : ""
                }`}
              >
                <div className="flex items-center gap-1">
                  {p.isDefault && <span className="text-[var(--accent)] text-[10px]">★</span>}
                  {p.disabled && <span className="text-[var(--warn)] text-[10px]" title={p.deprecated ?? "deprecated"}>⚠</span>}
                  <span className="truncate flex-1" title={p.baseUrl ?? ""}>
                    {p.name}
                  </span>
                  <span className="text-[var(--text-faint)] text-[10px]">{p.kind}</span>
                  {p.disabled ? (
                    <button
                      onClick={() => onMigrate(p)}
                      disabled={busyId === p.id}
                      className="px-1 text-[var(--warn)] hover:text-[var(--accent)] disabled:opacity-30"
                      title="Migrate this deprecated provider to openai-compat"
                    >
                      ⇪
                    </button>
                  ) : (
                    <button
                      onClick={() => onRefreshModels(p)}
                      disabled={busyId === p.id}
                      className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)] disabled:opacity-30"
                      title={t("provider.refreshModels")}
                    >
                      ↻
                    </button>
                  )}
                  {!p.disabled && (
                    <button
                      onClick={() => startEdit(p)}
                      className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)]"
                      title={t("provider.edit")}
                    >
                      ✎
                    </button>
                  )}
                  <button
                    onClick={() => onDelete(p)}
                    className="px-1 text-[var(--text-dim)] hover:text-[var(--err)]"
                    title={t("provider.delete")}
                  >
                    ×
                  </button>
                </div>
                <div className="text-[10px] text-[var(--text-faint)] leading-tight">
                  {p.disabled
                    ? `${p.deprecatedReason ?? "deprecated"} · ${t("provider.modelsCount", { n: p.models.length })}`
                    : t("provider.modelsCount", { n: p.models.length })}
                  {p.hasApiKey ? ` · ${t("provider.hasKey")}` : ""}
                </div>
                {refreshFlash?.id === p.id && (
                  <pre
                    className={`text-[10px] leading-tight break-all whitespace-pre-wrap font-mono ${
                      refreshFlash.ok ? "text-[var(--ok)]" : "text-[var(--err)]"
                    }`}
                  >
                    {refreshFlash.ok ? "✓ " : "✗ "}
                    {refreshFlash.msg}
                  </pre>
                )}
                {p.codexCliMissing && (
                  <div className="text-[10px] text-[var(--err)] leading-snug pl-2 border-l-2 border-[var(--err)]">
                    codex CLI not found. Install: <code className="font-mono">{p.currentRuntime?.cliRecommendedInstallCommand ?? "npm install -g @openai/codex"}</code>
                  </div>
                )}
                {!p.codexCliMissing && p.authMissing && (
                  <div className="text-[10px] text-[var(--warn)] leading-snug pl-2 border-l-2 border-[var(--warn)] flex items-center gap-2">
                    <span>Not logged in.</span>
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(p.currentRuntime?.loginCommand ?? "codex login");
                          setRefreshFlash({ id: p.id, ok: true, msg: "copied `codex login`" });
                        } catch {
                          setRefreshFlash({ id: p.id, ok: false, msg: "clipboard unavailable" });
                        }
                      }}
                      className="px-2 py-0.5 border border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn)] hover:text-black font-mono"
                      title="Copy `codex login` to clipboard"
                    >
                      ⎘ codex login
                    </button>
                  </div>
                )}
                {!p.codexCliMissing && p.codexCliVersionTooOld && (
                  <div className="text-[10px] text-[var(--err)] leading-snug pl-2 border-l-2 border-[var(--err)] flex items-center gap-2 flex-wrap">
                    <span>
                      codex {p.codexCliVersion ?? "(unknown)"} too old; need{" "}
                      ≥ {p.codexCliMinSupportedVersion ?? "0.132.0"}.
                    </span>
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(p.currentRuntime?.cliRecommendedUpgradeCommand ?? "npm install -g @openai/codex@latest");
                          setRefreshFlash({ id: p.id, ok: true, msg: "copied upgrade command" });
                        } catch {
                          setRefreshFlash({ id: p.id, ok: false, msg: "clipboard unavailable" });
                        }
                      }}
                      className="px-2 py-0.5 border border-[var(--err)] text-[var(--err)] hover:bg-[var(--err)] hover:text-black font-mono"
                      title="Copy upgrade command"
                    >
                      ⎘ npm i -g @openai/codex@latest
                    </button>
                  </div>
                )}
                {!p.codexCliMissing && !p.codexCliVersionTooOld && p.codexCliVersion && (
                  <div className="text-[10px] text-[var(--text-faint)] leading-snug pl-2">
                    codex {p.codexCliVersion}
                  </div>
                )}
              </div>
            ),
          )}
          {error && !editingId && !adding && (
            <div className="px-2 py-1 text-[var(--err)] text-[10px]">{error}</div>
          )}
          {adding ? (
            <ProviderForm
              t={t}
              title={t("provider.form.newTitle")}
              isEdit={false}
              name={name}
              setName={setName}
              runtime={runtime}
              setRuntime={setRuntime}
              entry={entry}
              setEntry={setEntry}
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
              apiKey={apiKey}
              setApiKey={setApiKey}
              manualModels={manualModels}
              setManualModels={setManualModels}
              sandboxMode={sandboxMode}
              setSandboxMode={setSandboxMode}
              codexHealth={cliHealth?.codex ?? null}
              codexRuntime={null}
              applyPreset={applyPreset}
              hasExistingKey={false}
              onSubmit={onSubmitNew}
              onCancel={() => {
                setAdding(false);
                resetForm();
              }}
              error={error}
            />
          ) : (
            <button
              onClick={() => {
                setAdding(true);
                setEditingId(null);
                resetForm();
              }}
              className="px-2 py-0.5 mt-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
            >
              {t("provider.add")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ProviderForm({
  t,
  title,
  isEdit,
  name,
  setName,
  runtime,
  setRuntime,
  entry,
  setEntry,
  baseUrl,
  setBaseUrl,
  apiKey,
  setApiKey,
  manualModels,
  setManualModels,
  sandboxMode,
  setSandboxMode,
  codexHealth,
  codexRuntime,
  applyPreset,
  hasExistingKey,
  onSubmit,
  onCancel,
  error,
}: {
  t: (k: string, p?: Record<string, string | number>) => string;
  title: string;
  isEdit: boolean;
  name: string;
  setName: (s: string) => void;
  runtime: Runtime;
  setRuntime: (r: Runtime) => void;
  entry: Entry;
  setEntry: (e: Entry) => void;
  baseUrl: string;
  setBaseUrl: (s: string) => void;
  apiKey: string;
  setApiKey: (s: string) => void;
  manualModels: string;
  setManualModels: (s: string) => void;
  sandboxMode: SandboxMode | "";
  setSandboxMode: (s: SandboxMode | "") => void;
  codexHealth: CliSettingsHealth["codex"] | null;
  codexRuntime: ProviderDTO["currentRuntime"] | null;
  applyPreset: (id: string) => void;
  hasExistingKey: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  error: string | null;
}) {
  const isClaudeOfficial = runtime === "claude" && entry === "official";
  const isOpenaiOfficial = runtime === "openai" && entry === "official";
  const isOpenaiCodex = runtime === "openai" && entry === "codex";
  // Entries available per runtime — codex only exists on the OpenAI side.
  const visibleEntries: Entry[] = runtime === "openai" ? ["official", "compat", "codex"] : ["official", "compat"];
  // Filter presets by current runtime so users don't accidentally apply an
  // anthropic-compat preset under the OpenAI runtime (or vice versa).
  const visiblePresets = PROVIDER_PRESETS.filter((p) => p.runtime === runtime);
  const entryLabel = (e: Entry): string => (e === "official" ? "官方" : e === "codex" ? "Codex CLI" : "兼容");
  const entryTitle = (e: Entry): string => {
    if (e === "codex") return "Experimental local Codex CLI runtime; peer tools use Ensemble's stdio MCP bridge, but external CLI sessions may still be interrupted";
    if (e === "official") {
      return runtime === "claude"
        ? "Use local `claude login` OAuth credentials"
        : "Use https://api.openai.com/v1 with an OpenAI platform API key";
    }
    return "Use a third-party Anthropic-compatible (Claude) or OpenAI-compatible (OpenAI) baseUrl";
  };

  return (
    <div className="flex flex-col gap-1 mt-1 p-2 border border-[var(--border)] bg-[var(--bg-pane)]">
      <div className="text-[10px] tracking-wider text-[var(--text-faint)]">{title}</div>
      <input
        className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)]"
        placeholder={t("provider.form.namePh")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      {/* Runtime toggle */}
      <div className="flex gap-0 mt-1 border border-[var(--border)] bg-[var(--bg)]">
        {(["claude", "openai"] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => !isEdit && setRuntime(r)}
            disabled={isEdit}
            className={`flex-1 px-2 py-0.5 text-[10px] tracking-wider ${
              runtime === r ? "bg-[var(--accent)] text-black" : "text-[var(--text-dim)] hover:text-[var(--accent)]"
            } ${isEdit ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            {r === "claude" ? "Claude" : "OpenAI"}
          </button>
        ))}
      </div>

      {/* Entry toggle */}
      <div className="flex gap-0 border border-[var(--border)] bg-[var(--bg)]">
        {visibleEntries.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => !isEdit && setEntry(e)}
            disabled={isEdit}
            className={`flex-1 px-2 py-0.5 text-[10px] tracking-wider ${
              entry === e ? "bg-[var(--accent)] text-black" : "text-[var(--text-dim)] hover:text-[var(--accent)]"
            } ${isEdit ? "opacity-50 cursor-not-allowed" : ""}`}
            title={entryTitle(e)}
          >
            {entryLabel(e)}
          </button>
        ))}
      </div>

      {!isEdit && visiblePresets.length > 0 && (
        <select
          className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] text-[var(--text-dim)]"
          value=""
          onChange={(e) => {
            if (e.target.value) applyPreset(e.target.value);
            e.target.value = "";
          }}
          title={t("provider.form.presetHint")}
        >
          <option value="">{t("provider.form.presetPlaceholder")}</option>
          {visiblePresets.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      )}

      {isClaudeOfficial ? (
        <div className="text-[10px] text-[var(--text-dim)] leading-snug px-0.5 py-1 border-l-2 border-[var(--accent)] pl-2">
          {t("provider.form.localHint")}
        </div>
      ) : isOpenaiCodex ? (
        <CodexForm
          sandboxMode={sandboxMode}
          setSandboxMode={setSandboxMode}
          codexHealth={codexHealth}
          codexRuntime={codexRuntime}
        />
      ) : (
        <>
          <input
            className={`bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] ${
              isOpenaiOfficial ? "text-[var(--text-faint)]" : ""
            }`}
            placeholder={
              runtime === "claude"
                ? "https://api.deepseek.com/anthropic"
                : "https://api.openai.com/v1"
            }
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            readOnly={isOpenaiOfficial && !isEdit}
          />
          <input
            type="password"
            className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)]"
            placeholder={hasExistingKey ? t("provider.form.apiKeyKeepPh") : t("provider.form.apiKeyPh")}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {isOpenaiOfficial && (
            <div className="text-[10px] text-[var(--warn)] leading-snug px-0.5 py-1 border-l-2 border-[var(--warn)] pl-2">
              {t("provider.form.openaiLocalHint")}
            </div>
          )}
          <div className="text-[10px] tracking-wider text-[var(--text-faint)] mt-1">{t("provider.form.modelsLabel")}</div>
          <textarea
            className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] font-mono text-[10px] leading-tight resize-y min-h-[60px]"
            placeholder={t("provider.form.modelsPh")}
            value={manualModels}
            onChange={(e) => setManualModels(e.target.value)}
          />
          <div className="text-[10px] text-[var(--text-faint)] leading-snug">
            {t("provider.form.modelsHint")}
          </div>
        </>
      )}
      {error && <div className="text-[var(--err)] text-[10px]">{error}</div>}
      <div className="flex gap-1">
        <button
          onClick={onSubmit}
          className="flex-1 px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors"
        >
          {isEdit ? t("provider.form.save") : t("provider.form.add")}
        </button>
        <button
          onClick={onCancel}
          className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
        >
          {t("provider.form.cancel")}
        </button>
      </div>
    </div>
  );
}

// W20: codex-specific subform. The codex SDK uses ~/.codex/auth.json from
// local `codex login` — no baseUrl or apiKey to collect. Model selection is
// hidden behind the user's ChatGPT subscription tier (we surface kind=codex
// in the model picker as a placeholder). Sandbox is the only knob we own.
function CodexForm({
  sandboxMode,
  setSandboxMode,
  codexHealth,
  codexRuntime,
}: {
  sandboxMode: SandboxMode | "";
  setSandboxMode: (s: SandboxMode | "") => void;
  codexHealth: CliSettingsHealth["codex"] | null;
  codexRuntime: ProviderDTO["currentRuntime"] | null;
}) {
  const health = codexHealth;
  const cliMissing = health ? !health.found : codexRuntime ? !codexRuntime.cliPath : false;
  const codexAuthMissing = health ? health.authPresent === false : codexRuntime?.authPresent === false;
  const versionTooOld = health?.versionTooOld === true || codexRuntime?.cliVersionTooOld === true;
  const loginCommand = health?.loginCommand ?? codexRuntime?.loginCommand ?? "codex login";
  const installCommand = health?.recommendedInstallCommand ?? codexRuntime?.cliRecommendedInstallCommand ?? "npm install -g @openai/codex";
  const upgradeCommand = health?.recommendedUpgradeCommand ?? codexRuntime?.cliRecommendedUpgradeCommand ?? "npm install -g @openai/codex@latest";
  const onCopy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Clipboard may be unavailable in embedded contexts; the command is visible inline.
    }
  };
  const onCopyLogin = async () => {
    try {
      await navigator.clipboard.writeText("codex login");
    } catch {
      // Clipboard may be unavailable in some embedded contexts; fall back to
      // a textarea-select hack would be overkill — silently ignore. The
      // command is short enough to retype.
    }
  };
  return (
    <>
      <div className="text-[10px] text-[var(--text-dim)] leading-snug px-0.5 py-1 border-l-2 border-[var(--accent)] pl-2">
        Experimental Codex CLI provider. It uses ChatGPT-account OAuth via the local `codex` CLI (~/.codex/auth.json).
        Peer tools are exposed through Ensemble's stdio MCP bridge and have passed local smoke testing, but Codex can still affect external Codex CLI sessions.
      </div>
      {health && (
        <div className="text-[10px] text-[var(--text-faint)] leading-snug px-0.5 py-1 pl-2 break-all">
          executable: {health.path ?? "(not found)"}
          {health.version ? ` · version: ${health.version}` : ""}
          {health.configPath ? ` · config: ${health.configPath}` : ""}
          {health.authPath ? ` · auth: ${health.authPresent ? "ok" : "missing"} (${health.authPath})` : ""}
        </div>
      )}
      {cliMissing && (
        <div className="text-[10px] text-[var(--err)] leading-snug px-0.5 py-1 border-l-2 border-[var(--err)] pl-2 flex flex-col gap-1">
          <span>codex CLI not found. Install it first: <code className="font-mono">{installCommand}</code></span>
        </div>
      )}
      {!cliMissing && codexAuthMissing && (
        <div className="text-[10px] text-[var(--warn)] leading-snug px-0.5 py-1 border-l-2 border-[var(--warn)] pl-2 flex flex-col gap-1">
          <span>~/.codex/auth.json not found. Sign in with your ChatGPT account first:</span>
          <button
            type="button"
            onClick={() => void onCopy(loginCommand)}
            className="self-start px-2 py-0.5 border border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn)] hover:text-black transition-colors font-mono"
            title="Copy `codex login` to clipboard"
          >
            ⎘ codex login
          </button>
        </div>
      )}
      {!cliMissing && versionTooOld && (
        <div className="text-[10px] text-[var(--warn)] leading-snug px-0.5 py-1 border-l-2 border-[var(--warn)] pl-2 flex flex-col gap-1">
          <span>codex version is below the minimum supported version. Upgrade is recommended.</span>
          <button
            type="button"
            onClick={() => void onCopy(upgradeCommand)}
            className="self-start px-2 py-0.5 border border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn)] hover:text-black transition-colors font-mono"
            title="Copy upgrade command"
          >
            copy {upgradeCommand}
          </button>
        </div>
      )}
      <div className="text-[10px] tracking-wider text-[var(--text-faint)] mt-1">SANDBOX</div>
      <select
        className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] text-[var(--text-dim)]"
        value={sandboxMode}
        onChange={(e) => setSandboxMode(e.target.value as SandboxMode | "")}
      >
        <option value="">use Ensemble default</option>
        <option value="read-only">read-only · no writes, no network</option>
        <option value="workspace-write">workspace-write · writes in cwd, no network</option>
        <option value="danger-full-access">danger-full-access · unrestricted</option>
      </select>
      <div className="text-[10px] text-[var(--text-faint)] leading-snug">
        Ensemble defaults Codex providers to danger-full-access for MCP compatibility. Explicit choices apply to all turns from agents bound to this provider unless overridden by the agent metadata.
      </div>
    </>
  );
}
