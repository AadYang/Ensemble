"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PermissionMode, ReasoningEffort, SandboxMode } from "@agentorch/shared";
import {
  closeAgent,
  deleteAgent,
  patchAgent,
  restartAgent,
} from "@/lib/agent-api";
import { listProviders, type ProviderDTO } from "@/lib/provider-api";
import { getWS } from "@/lib/ws";
import { useStore } from "@/store/agents";
import { useT } from "@/i18n/useT";
import { getDialog } from "@/lib/dialog";
import { SuggestSubagentDialog } from "./SuggestSubagentDialog";
import { DEFAULT_ANTHROPIC_MODELS } from "@/lib/default-models";

const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
];

const REASONING_EFFORTS: ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function AgentSettings({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const agent = useStore((s) => s.agents[agentId]);
  const teams = useStore((s) => s.teams);
  const [name, setName] = useState(agent?.summary.name ?? "");
  const [model, setModel] = useState(agent?.summary.model ?? DEFAULT_ANTHROPIC_MODELS[0]!);
  const [providerId, setProviderId] = useState<string | null>(agent?.summary.providerId ?? null);
  const [systemPrompt, setSystemPrompt] = useState(agent?.summary.systemPrompt ?? "");
  // "" = ungrouped; otherwise team id.
  const [teamId, setTeamId] = useState<string>(agent?.summary.teamId ?? "");
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    agent?.summary.permissionMode ?? "default",
  );
  // "" = inherit from provider.defaultSandbox; otherwise per-agent override.
  const [sandboxMode, setSandboxMode] = useState<SandboxMode | "">(
    agent?.summary.sandboxMode ?? "",
  );
  // "" = inherit from the runtime/provider default; otherwise per-agent override.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(
    agent?.summary.reasoningEffort ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  // Draggable position. null until first mount → uses centered fallback inline.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  // W14: subagent suggestion dialog visibility.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Portal target: only available on the client.
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    void listProviders()
      .then((rows) => {
        setProviders(rows);
        setProvidersError(null);
      })
      .catch((err) => {
        console.warn("listProviders failed", err);
        setProvidersError((err as Error).message);
      });
  }, []);

  // Reset model when the active provider changes to one that doesn't list the
  // current value. Without this the dropdown's stale-model fallback option
  // mixes claude-opus-4-8 (or whatever the agent had) into the codex/openai
  // model list — and "Apply" would PATCH that incompatible model upstream.
  useEffect(() => {
    const sp = providers.find((p) => p.id === providerId);
    if (!sp) return;
    const isDefaultAnth =
      sp.kind === "anthropic-local" || (sp.kind === "anthropic" && !sp.baseUrl);
    const avail = sp.models.length
      ? sp.models
      : isDefaultAnth ? DEFAULT_ANTHROPIC_MODELS : [];
    if (!avail.includes(model)) {
      setModel(avail[0] ?? "");
    }
    // model intentionally excluded — only re-evaluate when provider changes,
    // not when the user manually picks a value within the same provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, providers]);

  // Center after the dialog actually mounts (ref is null on the first effect pass
  // because we early-return until `mounted`).
  useEffect(() => {
    if (!mounted || pos !== null) return;
    const el = dialogRef.current;
    const w = el?.offsetWidth ?? 420;
    const h = el?.offsetHeight ?? 600;
    setPos({
      x: Math.max(8, Math.floor((window.innerWidth - w) / 2)),
      y: Math.max(8, Math.floor((window.innerHeight - h) / 2)),
    });
  }, [mounted, pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onMove = (e: MouseEvent) => {
      const off = dragOffsetRef.current;
      if (!off) return;
      e.preventDefault();
      e.stopPropagation();
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 60, e.clientX - off.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 30, e.clientY - off.dy)),
      });
    };
    const onUp = () => {
      dragOffsetRef.current = null;
    };
    // capture phase so react-resizable-panels can't swallow the events first.
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousemove", onMove, { capture: true });
    document.addEventListener("mouseup", onUp, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousemove", onMove, { capture: true });
      document.removeEventListener("mouseup", onUp, { capture: true });
    };
  }, [onClose]);

  if (!agent) return null;

  const onHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // left button only
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = dialogRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.preventDefault();
    e.stopPropagation();
  };

  const summary = agent.summary;
  const selectedProvider = providers.find((p) => p.id === providerId);
  const providerCapabilityKnown = providerId === null || selectedProvider !== undefined;
  const selectedProviderKind = selectedProvider?.kind ?? (providerId === null ? "anthropic-local" : null);
  const isCodexProvider = selectedProvider?.kind === "openai-codex";
  const selectedRuntime = selectedProvider?.currentRuntime ?? null;
  const providerCliMissing =
    selectedProvider?.kind === "openai-codex" || selectedProvider?.kind === "anthropic-local"
      ? selectedRuntime?.cliPath === null || selectedRuntime?.cliFound === false
      : false;
  const providerCliVersionTooOld = selectedRuntime?.cliVersionTooOld === true;
  const providerAuthMissing = selectedProvider?.kind === "openai-codex" && selectedRuntime?.authPresent === false;
  const supportsThinkingMode =
    selectedProviderKind === "anthropic-local" ||
    selectedProviderKind === "anthropic" ||
    selectedProviderKind === "openai-codex";
  // Only the local-OAuth Claude provider (anthropic-local) and the legacy
  // built-in default (kind=anthropic + no baseUrl) get the hardcoded model
  // fallback. For 3rd-party Anthropic-compat providers we MUST show only the
  // models the user actually discovered via ProviderPanel ↻ — falling back to
  // opus/sonnet would silently let the user pick a model the upstream rejects.
  const isDefaultAnthropic =
    selectedProvider?.kind === "anthropic-local" ||
    (selectedProvider?.kind === "anthropic" && !selectedProvider.baseUrl);
  const availableModels: string[] =
    selectedProvider?.models.length
      ? selectedProvider.models
      : isDefaultAnthropic
        ? DEFAULT_ANTHROPIC_MODELS
        : [];
  const effectiveSandbox: SandboxMode | null = isCodexProvider ? (sandboxMode || null) : null;
  const effectiveReasoningEffort: ReasoningEffort | null | undefined = providerCapabilityKnown
    ? supportsThinkingMode
      ? (reasoningEffort || null)
      : null
    : undefined;
  const effectiveSystemPrompt: string | null = systemPrompt.trim() ? systemPrompt : null;
  const effectiveTeamId: string | null = teamId || null;
  const dirty =
    name.trim() !== summary.name ||
    model !== summary.model ||
    (providerId ?? null) !== (summary.providerId ?? null) ||
    permissionMode !== summary.permissionMode ||
    effectiveSandbox !== (summary.sandboxMode ?? null) ||
    (effectiveReasoningEffort !== undefined && effectiveReasoningEffort !== (summary.reasoningEffort ?? null)) ||
    effectiveSystemPrompt !== (summary.systemPrompt ?? null) ||
    effectiveTeamId !== (summary.teamId ?? null);

  const guard = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onApply = () =>
    guard(() =>
      patchAgent(agentId, {
        name: name.trim() !== summary.name ? name.trim() : undefined,
        model: model !== summary.model ? model : undefined,
        providerId:
          (providerId ?? null) !== (summary.providerId ?? null) ? providerId : undefined,
        permissionMode: permissionMode !== summary.permissionMode ? permissionMode : undefined,
        sandboxMode:
          effectiveSandbox !== (summary.sandboxMode ?? null) ? effectiveSandbox : undefined,
        reasoningEffort:
          effectiveReasoningEffort !== undefined && effectiveReasoningEffort !== (summary.reasoningEffort ?? null)
            ? effectiveReasoningEffort
            : undefined,
        systemPrompt:
          effectiveSystemPrompt !== (summary.systemPrompt ?? null) ? effectiveSystemPrompt : undefined,
        teamId: effectiveTeamId !== (summary.teamId ?? null) ? effectiveTeamId : undefined,
      }),
    );

  const onCloseAgent = () => guard(() => closeAgent(agentId));
  const onRestart = () => guard(() => restartAgent(agentId));
  const onDelete = async () => {
    const ok = await getDialog().confirm({
      title: t("settings.delete.confirm", { name: summary.name }),
      danger: true,
    });
    if (!ok) return;
    void guard(() => deleteAgent(agentId));
  };
  const onSpawnChild = async () => {
    const childName = await getDialog().prompt({
      title: t("settings.spawnChild.prompt"),
      defaultValue: t("settings.spawnChild.default"),
    });
    if (!childName?.trim()) return;
    getWS().send({
      type: "create_agent",
      name: childName.trim(),
      parentId: agentId,
    });
    onClose();
  };

  if (!mounted) return null;

  const dialog = (
    <div
      ref={dialogRef}
      className="tool-card bg-[var(--bg-elevated)] w-[420px] max-w-full text-xs shadow-2xl shadow-black/50"
      style={{
        position: "fixed",
        zIndex: 9999,
        left: pos?.x ?? "50%",
        top: pos?.y ?? "15vh",
        transform: pos ? undefined : "translateX(-50%)",
      }}
    >
      <div
        onMouseDown={onHeaderMouseDown}
        className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2 cursor-move select-none"
        title={t("settings.dragHint")}
      >
        <span className="text-[var(--text-faint)]">⋮⋮</span>
        <span className="text-[var(--text-dim)] tracking-wider">{t("settings.title")}</span>
        {summary.closed && (
          <span className="text-[var(--warn)] text-[10px] tracking-wider">{t("settings.closed")}</span>
        )}
        <span className="flex-1" />
        <span className="text-[var(--text-faint)] truncate max-w-[30%]">{summary.id.slice(0, 8)}</span>
        <button
          onClick={onClose}
          title={t("settings.closeDialog")}
          className="px-1.5 py-0.5 text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)] border border-[var(--border)] transition-colors cursor-pointer"
        >
          ✕
        </button>
      </div>
      <div className="p-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("settings.label.name")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("settings.label.provider")}</span>
          <select
            value={providerId ?? ""}
            onChange={(e) => setProviderId(e.target.value || null)}
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
          >
            {providerId && !providers.some((p) => p.id === providerId) && (
              <option value={providerId}>
                Current provider ({providerId.slice(0, 8)})
              </option>
            )}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.kind}
              </option>
            ))}
          </select>
          {providersError && (
            <span className="text-[10px] text-[var(--err)] leading-tight">
              Provider list failed to load: {providersError}
            </span>
          )}
          {(providerCliMissing || providerCliVersionTooOld || providerAuthMissing) && (
            <CliRuntimeNotice provider={selectedProvider} />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("settings.label.model")}</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!availableModels.includes(model) && (
              <option key="__current__" value={model}>{model}</option>
            )}
          </select>
          {selectedProvider && selectedProvider.models.length === 0 && !isDefaultAnthropic && (
            <span className="text-[10px] text-[var(--warn)] leading-tight">
              {t("settings.modelHint.noModels")}
            </span>
          )}
          {selectedProvider && selectedProvider.models.length === 0 && isDefaultAnthropic && (
            <span className="text-[10px] text-[var(--text-faint)] leading-tight">
              {t("settings.modelHint.noCache")}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
            {t("settings.label.systemPrompt")}
          </span>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t("settings.placeholder.systemPrompt")}
            rows={5}
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] font-mono text-[11px] resize-y min-h-[80px]"
          />
          <span className="text-[10px] text-[var(--text-faint)] leading-tight">
            {t("settings.systemPromptHint")}
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
            {t("settings.label.team")}
          </span>
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
          >
            <option value="">{t("settings.team.ungrouped")}</option>
            {Object.values(teams)
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
          </select>
        </label>
        {/* Codex agents have no canUseTool path — permissionMode is inert there
            (only the plan-mode systemPrompt is honored). Surface sandboxMode
            instead (rendered below for codex agents). */}
        {!isCodexProvider && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("settings.label.permissionMode")}</span>
            <select
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m} — {t(`settings.permMode.${m}`)}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-[var(--text-faint)] leading-tight">
              {t(`settings.permMode.${permissionMode}`)}
            </span>
          </label>
        )}
        {supportsThinkingMode && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
                {t("settings.label.reasoningEffort")}
              </span>
              <select
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort | "")}
                className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
              >
                <option value="">{t("settings.reasoningEffort.inherit")}</option>
                {REASONING_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-[var(--text-faint)] leading-tight">
                {reasoningEffort === ""
                  ? t("settings.reasoningEffort.hint.inherit")
                  : t(`settings.reasoningEffort.hint.${reasoningEffort}`)}
              </span>
            </label>
          </>
        )}
        {isCodexProvider && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
                {t("settings.label.sandboxMode")}
              </span>
              <select
                value={sandboxMode}
                onChange={(e) => setSandboxMode(e.target.value as SandboxMode | "")}
                className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
              >
                <option value="">{t("settings.sandboxMode.inherit")}</option>
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
              <span className="text-[10px] text-[var(--text-faint)] leading-tight">
                {sandboxMode === ""
                  ? t("settings.sandboxMode.hint.inherit")
                  : t(`settings.sandboxMode.hint.${sandboxMode}`)}
              </span>
            </label>
          </>
        )}
        {error && <div className="text-[var(--err)] text-[10px]">{error}</div>}
        <div className="flex gap-2">
          <button
            onClick={onApply}
            disabled={!dirty || busy}
            className="flex-1 px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
          >
            {t("settings.apply")}
          </button>
          <button
            onClick={onClose}
            className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            {t("settings.cancel")}
          </button>
        </div>

        <div className="border-t border-[var(--border)] pt-3 flex flex-col gap-2">
          <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("settings.lifecycle")}</span>
          <div className="flex gap-2">
            {summary.closed ? (
              <button
                onClick={onRestart}
                disabled={busy}
                className="flex-1 px-2 py-1 border border-[var(--ok)] text-[var(--ok)] hover:bg-[var(--ok)] hover:text-black transition-colors disabled:opacity-30"
                title={t("settings.restart.title")}
              >
                {t("settings.restart")}
              </button>
            ) : (
              <button
                onClick={onCloseAgent}
                disabled={busy}
                className="flex-1 px-2 py-1 border border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn)] hover:text-black transition-colors disabled:opacity-30"
                title={t("settings.close.title")}
              >
                {t("settings.close")}
              </button>
            )}
            <button
              onClick={onDelete}
              disabled={busy}
              className="px-2 py-1 border border-[var(--err)] text-[var(--err)] hover:bg-[var(--err)] hover:text-black transition-colors disabled:opacity-30"
              title={t("settings.delete.title")}
            >
              {t("settings.delete")}
            </button>
          </div>
          <div className="flex gap-2 self-start">
            <button
              onClick={onSpawnChild}
              disabled={busy}
              className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors disabled:opacity-30"
              title={t("settings.spawnChild.title")}
            >
              {t("settings.spawnChild")}
            </button>
            <button
              onClick={() => setSuggestOpen(true)}
              disabled={busy}
              className="px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors disabled:opacity-30"
              title={t("settings.suggestChild.title")}
            >
              {t("settings.suggestChild")}
            </button>
          </div>
          <div className="text-[10px] text-[var(--text-faint)] leading-tight">
            {summary.hasResumeInfo ? t("settings.resume.has") : t("settings.resume.none")}
          </div>
        </div>
      </div>
      {suggestOpen && (
        <SuggestSubagentDialog
          parentId={agentId}
          parentName={summary.name}
          onClose={() => setSuggestOpen(false)}
        />
      )}
    </div>
  );

  return createPortal(dialog, document.body);
}

function CliRuntimeNotice({ provider }: { provider: ProviderDTO | undefined }) {
  const runtime = provider?.currentRuntime ?? null;
  if (!provider || !runtime) return null;
  const cliMissing = runtime.cliPath === null || runtime.cliFound === false;
  const versionTooOld = runtime.cliVersionTooOld === true;
  const authMissing = provider.kind === "openai-codex" && runtime.authPresent === false;
  if (!cliMissing && !versionTooOld && !authMissing) return null;
  const installCommand = runtime.cliRecommendedInstallCommand ?? (
    provider.kind === "openai-codex"
      ? "npm install -g @openai/codex"
      : "npm install -g @anthropic-ai/claude-code"
  );
  const upgradeCommand = runtime.cliRecommendedUpgradeCommand ?? installCommand;
  const loginCommand = runtime.loginCommand ?? (provider.kind === "openai-codex" ? "codex login" : "claude login");
  const command = cliMissing ? installCommand : versionTooOld ? upgradeCommand : loginCommand;
  const label = cliMissing
    ? `${provider.kind === "openai-codex" ? "Codex" : "Claude Code"} CLI not found`
    : versionTooOld
      ? `${provider.kind === "openai-codex" ? "Codex" : "Claude Code"} CLI upgrade recommended`
      : "Codex CLI login missing";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Command remains visible for manual copy.
    }
  };
  return (
    <div className="text-[10px] text-[var(--warn)] leading-tight border-l-2 border-[var(--warn)] pl-2 flex flex-col gap-1">
      <span>
        {label}
        {runtime.cliVersion ? ` · version: ${runtime.cliVersion}` : ""}
        {runtime.configPath ? ` · config: ${runtime.configPath}` : ""}
      </span>
      <button
        type="button"
        onClick={() => void copy()}
        className="self-start px-2 py-0.5 border border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn)] hover:text-black font-mono"
        title="Copy CLI command"
      >
        copy {command}
      </button>
    </div>
  );
}
