"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CapabilityFieldView,
  CapabilityViewModel,
  PermissionMode,
  RunPlanSettingField,
  RunPlanStatusView,
  SandboxMode,
  SettingInvalidation,
  SettingsImpactReport,
  SettingsImpactRequest,
} from "@agentorch/shared";
import {
  capabilityView,
  formatCapabilityFieldLines,
  isReasoningToken,
  REASONING_HINTS,
  REASONING_SYNTAX_RULE,
} from "@agentorch/shared";
import {
  AgentRequestError,
  closeAgent,
  deleteAgent,
  getAgentSettingsImpact,
  getAgentStatusReport,
  isSettingsInvalidationError,
  patchAgent,
  resetRuntimeSession,
  restartAgent,
  type AgentPatch,
} from "@/lib/agent-api";
import { listProviders, type ProviderDTO } from "@/lib/provider-api";
import { getWS } from "@/lib/ws";
import { useStore } from "@/store/agents";
import { useT, type TranslateFn } from "@/i18n/useT";
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

// The dropdown used to hold its own copy of the level list, which meant the UI
// could offer a level the protocol no longer accepted (or hide one it did). The
// options now come from the shared contract and are HINTS: a model may have
// levels this list does not know (`ultra`), so the field accepts a typed token.
const REASONING_OPTION_ID = "reasoning-effort-options";

function planFieldLabel(t: TranslateFn, field: string): string {
  const key = `settings.plan.field.${field}`;
  const label = t(key);
  return label === key ? field : label;
}

function protocolLabel(t: TranslateFn, transport: string): string {
  const key = `settings.transport.${transport}`;
  const label = t(key);
  return label === key ? transport : label;
}

function reasoningOptionLabel(t: TranslateFn, level: string): string {
  const key = `settings.reasoningEffort.option.${level}`;
  const label = t(key);
  return label === key ? level : label;
}

function fieldByName(capability: CapabilityViewModel, field: RunPlanSettingField): CapabilityFieldView | null {
  return capability.fields.find((r) => r.field === field) ?? null;
}

/** Same rows `/status` prints — collapsed under diagnostics so the form stays a form. */
function PlanStatusSection({
  capability,
  t,
}: {
  capability: CapabilityViewModel;
  t: TranslateFn;
}) {
  const [copied, setCopied] = useState(false);
  const plan = capability.planView;
  const header = capability.header;
  if (!plan || !header) {
    return (
      <span className="text-[10px] text-[var(--text-faint)] leading-tight">
        {t("settings.plan.none")}
      </span>
    );
  }
  const copy = async () => {
    const lines = [
      t("settings.plan.header", {
        source: capability.runPlanSource,
        hash: header.planHash,
        at: header.resolvedAt,
      }),
      t("settings.plan.identity", {
        providerScope: header.providerScope,
        runtime: header.runtime,
        version: header.runtimeVersion ?? "—",
        transport: header.transport,
        model: header.modelId,
      }),
      ...formatCapabilityFieldLines(capability.fields),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the dump is still on screen */
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[var(--text-dim)] leading-tight">
          {t("settings.plan.header", {
            source: capability.runPlanSource,
            hash: header.planHash.slice(0, 12),
            at: header.resolvedAt,
          })}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="ml-auto px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
        >
          {copied ? t("settings.plan.copied") : t("settings.plan.copy")}
        </button>
      </div>
      <span className="text-[10px] text-[var(--text-faint)] leading-tight break-all">
        {t("settings.plan.identity", {
          providerScope: header.providerScope,
          runtime: header.runtime,
          version: header.runtimeVersion ?? "—",
          transport: header.transport,
          model: header.modelId,
        })}
      </span>
      {capability.fields.map((row) => (
        <div
          key={row.field}
          className="flex flex-col gap-0.5 border border-[var(--border)] px-1.5 py-1"
        >
          <div className="flex items-center gap-1">
            <span className={row.editable ? "" : "text-[var(--text-faint)]"}>
              {planFieldLabel(t, row.field)}
            </span>
            <span className="ml-auto">
              {row.requested ?? "—"} → {row.resolved ?? "—"}
            </span>
          </div>
          {!row.editable && (
            <div className="text-[10px] text-[var(--text-faint)]">{t("settings.plan.na")}</div>
          )}
          {(row.rejection !== null || row.outcome === "rejected" || row.outcome === "unknown" || !row.editable) && (
            <div className={row.editable ? "text-[10px] text-[var(--text-faint)]" : "text-[10px] text-[var(--warn)]"}>
              {row.disabledReason ?? row.reason}
            </div>
          )}
          {row.rejection !== null && (
            <div className="text-[10px] text-[var(--warn)]">
              {t("settings.plan.rejectedValue", { value: row.rejection.value, code: row.rejection.code })}
            </div>
          )}
          {row.rejectedChoices.map((rc) => (
            <div key={rc.value} className="text-[10px] text-[var(--err)]">
              {t("settings.plan.rejected", { value: rc.value, code: rc.code, detail: rc.detail })}
            </div>
          ))}
        </div>
      ))}
      {plan.diagnostics.length > 0 && (
        <span className="text-[10px] text-[var(--text-dim)]">
          {t("settings.plan.diagnostics", {
            summary: (Object.entries(plan.diagnosticCounts) as [string, number][])
              .map(([k, v]) => `${k}:${v}`)
              .join(" "),
          })}
        </span>
      )}
      {plan.diagnostics.map((d, i) => (
        <span key={`${d.field}-${i}`} className="text-[10px] text-[var(--text-faint)] leading-tight">
          {t("settings.plan.diagnostic", {
            field: d.field,
            status: d.status,
            origin: d.origin,
            confidence: d.confidence,
            detail: d.detail,
          })}
        </span>
      ))}
    </div>
  );
}

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
  // Plain string: the stored value may be a level this build has no hint for.
  const [reasoningEffort, setReasoningEffort] = useState<string>(
    agent?.summary.reasoningEffort ?? "",
  );
  // "" = UNBOUND project (the agent works in its own scratch directory). Not a
  // provider-scoped field any more: every runtime honors it.
  const [projectRoot, setProjectRoot] = useState<string>(agent?.summary.projectRoot ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plan this agent's last turn ran under, as the server's view-model. The
  // live store value is preferred (it is the turn's own snapshot); when nothing
  // has run yet we read `/status`, which resolves a PREDICTION and labels it as
  // one. Either way this is the ONE object every row below is read from — no
  // field here is decided from the provider kind or the model id.
  const storePlan = useStore((s) => s.planByAgent[agentId]);
  const [fetchedPlan, setFetchedPlan] = useState<RunPlanStatusView | null>(null);
  const planView = storePlan ?? fetchedPlan;
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

  // Read the plan when the store holds none. `/status` reports what it resolved
  // (and says the source is `fresh-resolution`, not a turn's own snapshot), so
  // the rows below are never blank just because nothing has run yet.
  useEffect(() => {
    if (storePlan) return;
    let cancelled = false;
    void getAgentStatusReport(agentId)
      .then((report) => {
        // `null` = this instance has no such agent (a cloud-only one). The rows
        // then render "no plan", which is the truth, rather than a report
        // fabricated from the synced snapshot.
        if (!cancelled) setFetchedPlan(report?.planView ?? null);
      })
      .catch((err) => {
        // A failed read is not a reason to invent a plan: the rows render as
        // "unknown" instead.
        console.warn("getAgentStatusReport failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, storePlan]);

  // The DRAFT's own plan, refreshed as the form changes.
  //
  // Read through the same `/settings-impact` entry the Apply flow uses, which
  // resolves the proposal with `resolveRunPlan` and `allowProbe: false`: no
  // write, no probe, no fetch. The answer is labelled `preview` by the server,
  // so nothing below can render a draft like a plan an agent is running under.
  const [draftPreview, setDraftPreview] = useState<SettingsImpactReport | null>(null);
  const [draftPreviewError, setDraftPreviewError] = useState<string | null>(null);
  const draftRequest = useMemo<SettingsImpactRequest | null>(() => {
    const summary = agent?.summary;
    if (!summary) return null;
    const request: SettingsImpactRequest = {
      providerId: (providerId ?? null) !== (summary.providerId ?? null) ? providerId : undefined,
      model: model !== summary.model ? model : undefined,
      reasoningEffort:
        (reasoningEffort.trim() || null) !== (summary.reasoningEffort ?? null)
          ? reasoningEffort.trim() || null
          : undefined,
      projectRoot:
        (projectRoot.trim() || null) !== (summary.projectRoot ?? null) ? projectRoot.trim() || null : undefined,
    };
    return Object.values(request).some((value) => value !== undefined) ? request : null;
  }, [agent?.summary, providerId, model, reasoningEffort, projectRoot]);
  // The request's CONTENT, not its identity: two renders that compute the same
  // proposal must not re-ask the server, and every keystroke in a text field
  // produces a new object.
  const draftKey = draftRequest === null ? null : JSON.stringify(draftRequest);
  useEffect(() => {
    if (draftKey === null) {
      setDraftPreview(null);
      setDraftPreviewError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getAgentSettingsImpact(agentId, JSON.parse(draftKey) as SettingsImpactRequest)
        .then((impact) => {
          if (cancelled) return;
          setDraftPreview(impact);
          setDraftPreviewError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setDraftPreview(null);
          setDraftPreviewError((err as Error).message);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [agentId, draftKey]);

  // NOTE: this effect used to REPLACE the model whenever the provider changed to
  // one that did not list the current value. That is a silent edit of a stored
  // setting: the user switched the provider, and the model they had chosen was
  // gone from the form without a word — and "Apply" then wrote the replacement.
  // The value is now left exactly where the user put it, the field says the
  // chosen model is not in the new provider's list, and the model/provider change
  // goes through the invalidation report (which names every field the change
  // affects and asks first). The server still does the final validation.

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

  const capability = useMemo(() => capabilityView(planView), [planView]);
  const draftCapability = useMemo(() => capabilityView(draftPreview?.nextPlan ?? null), [draftPreview]);

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
  const selectedRuntime = selectedProvider?.currentRuntime ?? null;
  const providerCliMissing =
    selectedProvider?.kind === "openai-codex" || selectedProvider?.kind === "anthropic-local"
      ? selectedRuntime?.cliPath === null || selectedRuntime?.cliFound === false
      : false;
  const providerCliVersionTooOld = selectedRuntime?.cliVersionTooOld === true;
  const providerAuthMissing = selectedProvider?.kind === "openai-codex" && selectedRuntime?.authPresent === false;
  // Whether the setting is REACHABLE no longer depends on the provider kind.
  // The old kind list excluded `openai-local` by omission, and a kind is the
  // wrong question anyway: it decides whether an adapter can express a level
  // (which the runtime answers with a structured error) and never which levels a
  // model has. Hiding the field would also CLEAR a stored level on a provider
  // switch, which is the silent edit this contract exists to stop.
  const supportsThinkingMode = providerCapabilityKnown;
  // A token that is not even legal syntax cannot be persisted: the API refuses
  // it (400) and nothing would be written, so the form says so first.
  const reasoningEffortInvalid = reasoningEffort.trim() !== "" && !isReasoningToken(reasoningEffort);
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
  // Whether a per-agent sandbox override means anything here is the SERVER's
  // answer (`sandboxOverrideSupported`, from the runtime it would launch), not
  // this component's reading of a provider kind.
  const sandboxSupported = selectedProvider?.sandboxOverrideSupported === true;
  // On a provider that does not honour the override, the draft is the STORED
  // value — so the patch below leaves `sandboxMode` out entirely and the old
  // value survives the switch. It used to send `null`, which cleared a stored
  // override with no prompt at all: the user changed provider and their setting
  // was gone. The server now reports that clear as an invalidation and asks.
  const effectiveSandbox: SandboxMode | null = sandboxSupported
    ? sandboxMode || null
    : (summary.sandboxMode ?? null);
  // `null` clears (the same state as `inherit`), a token sets. It is never
  // derived from the provider kind — that is the runtime's question.
  const effectiveReasoningEffort: string | null | undefined = providerCapabilityKnown
    ? (reasoningEffort.trim() || null)
    : undefined;
  const effectiveSystemPrompt: string | null = systemPrompt.trim() ? systemPrompt : null;
  const effectiveTeamId: string | null = teamId || null;
  const effectiveProjectRoot: string | null = projectRoot.trim() || null;
  // The plan's verdict on a field, when it has one. A row the plan marked
  // uneditable disables the control AND shows the server's own reason — a
  // disabled input with no explanation is the state this contract exists to
  // prevent. The reason is never re-worded here.
  // The controls below read their verdicts off the SAME view-model the plan
  // section renders and `/status` prints. Looking the rows up in
  // `planView.settings` here instead was a second read of the same contract: it
  // did not know about `disabledReason`, so "uneditable" and "why" could only be
  // reconnected by hand.
  const liveReasoning = fieldByName(capability, "reasoning");
  const liveProject = fieldByName(capability, "project");
  const draftReasoning = fieldByName(draftCapability, "reasoning");
  const draftProject = fieldByName(draftCapability, "project");
  const reasoningRow = draftReasoning ?? liveReasoning;
  const projectRow = draftProject ?? liveProject;
  const reasoningPlanReason = reasoningRow?.disabledReason ?? null;
  const projectPlanReason = projectRow?.disabledReason ?? null;
  const reasoningRejection = reasoningRow?.rejection ?? null;
  const projectRejection = projectRow?.rejection ?? null;
  const reasoningLadder = reasoningRow?.options ?? null;
  const transportHeader = draftCapability.header ?? capability.header;
  const transportName = transportHeader?.transport ?? null;
  const showTransportBadge = transportName !== null && transportName !== "native-cli";
  const roleWeak = !effectiveTeamId && !effectiveSystemPrompt;
  const dirty =
    name.trim() !== summary.name ||
    model !== summary.model ||
    (providerId ?? null) !== (summary.providerId ?? null) ||
    permissionMode !== summary.permissionMode ||
    effectiveSandbox !== (summary.sandboxMode ?? null) ||
    (effectiveReasoningEffort !== undefined && effectiveReasoningEffort !== (summary.reasoningEffort ?? null)) ||
    effectiveSystemPrompt !== (summary.systemPrompt ?? null) ||
    effectiveProjectRoot !== (summary.projectRoot ?? null) ||
    effectiveTeamId !== (summary.teamId ?? null);

  const guard = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      // The server's structured refusal keeps its CODE. `reasoning_effort_unsupported`
      // and `project_root_invalid` are not interchangeable failures, and the
      // user cannot act on either if all they are shown is an HTTP status.
      setError(
        err instanceof AgentRequestError
          ? err.code && !err.message.startsWith(err.code)
            ? `${err.code}: ${err.message}`
            : err.message
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  /** The patch this form would send. `undefined` per field means "not part of
   *  this change" — the same rule `patchAgent` follows, so the proposal sent to
   *  `/settings-impact` is exactly the change that would be applied. */
  const buildPatch = (): AgentPatch => ({
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
    // null clears the binding (back to scratch); a path binds. The server
    // validates it and answers with a structured code if it is unusable.
    projectRoot:
      effectiveProjectRoot !== (summary.projectRoot ?? null) ? effectiveProjectRoot : undefined,
    teamId: effectiveTeamId !== (summary.teamId ?? null) ? effectiveTeamId : undefined,
  });

  /** The fields whose change can make a STORED value unusable elsewhere. Only
   *  these are worth asking the server about; a rename or a persona edit cannot
   *  invalidate a capability setting. */
  const impactRequestOf = (patch: AgentPatch): SettingsImpactRequest | null => {
    const req: SettingsImpactRequest = {
      providerId: patch.providerId,
      model: patch.model,
      reasoningEffort: patch.reasoningEffort as string | null | undefined,
      projectRoot: patch.projectRoot,
      sandboxMode: patch.sandboxMode,
    };
    const touches = Object.values(req).some((v) => v !== undefined);
    return touches ? req : null;
  };

  /** Render the affected fields and ask. Resolves FALSE when the user declines —
   *  and by then nothing has been written. The server's own wording is used for
   *  every reason: this dialog explains a decision it did not make. */
  const confirmInvalidations = async (impact: SettingsImpactReport): Promise<boolean> => {
    const lines = impact.invalidated.map((i: SettingInvalidation) =>
      t("settings.invalidate.line", {
        field: i.field,
        current: i.current,
        next: i.next ?? t("settings.invalidate.cleared"),
        code: i.code,
        reason: i.reason,
      }),
    );
    return getDialog().confirm({
      title: t("settings.invalidate.title"),
      message: lines.join("\n"),
      danger: true,
      okLabel: t("settings.invalidate.ok"),
    });
  };

  const onApply = () =>
    guard(async () => {
      const patch = buildPatch();
      const request = impactRequestOf(patch);
      let confirmedInvalidated: RunPlanSettingField[] | undefined;
      if (request) {
        // Ask BEFORE writing. A proposal that cannot resolve is refused with the
        // server's sentence rather than written and reported afterwards.
        const impact = await getAgentSettingsImpact(agentId, request);
        if (impact.resolutionError !== null) {
          throw new Error(t("settings.invalidate.unresolved", { reason: impact.resolutionError }));
        }
        if (impact.requiresConfirmation) {
          if (!(await confirmInvalidations(impact))) return; // declined: nothing written
          confirmedInvalidated = impact.invalidated.map((i) => i.field);
        }
      }
      try {
        await patchAgent(
          agentId,
          confirmedInvalidated ? { ...patch, confirmInvalidated: confirmedInvalidated } : patch,
        );
      } catch (err) {
        // The server refused because a value would be invalidated that the
        // probe above did not predict (it is best-effort; the PATCH is the
        // authority). Show the server's own report and re-ask instead of
        // retrying with a blanket confirmation.
        if (!isSettingsInvalidationError(err)) throw err;
        if (!(await confirmInvalidations(err.impact))) return;
        await patchAgent(agentId, {
          ...patch,
          confirmInvalidated: err.impact.invalidated.map((i) => i.field),
        });
      }
    });

  const onCloseAgent = () => guard(() => closeAgent(agentId));
  const onRestart = () => guard(() => restartAgent(agentId));
  const onResetRuntime = () => guard(() => resetRuntimeSession(agentId));
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
          {/* The value stays where the user put it and the field SAYS the new
              provider does not list it, instead of the old behaviour, which
              replaced it silently and wrote the replacement on Apply. */}
          {!availableModels.includes(model) && (
            <span className="text-[10px] text-[var(--warn)] leading-tight">
              {t("settings.modelHint.notInProvider", {
                model,
                provider: selectedProvider?.name ?? t("settings.modelHint.noProvider"),
              })}
            </span>
          )}
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
        {showTransportBadge && transportName && (
          <div className="text-[10px] text-[var(--text-faint)] leading-tight">
            {t("settings.transport.badge", { protocol: protocolLabel(t, transportName) })}
            {" · "}
            {t("settings.transport.changeInProvider")}
          </div>
        )}
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
          {roleWeak && (
            <span className="text-[10px] text-[var(--warn)] leading-tight">
              {t("settings.roleWeak")}
            </span>
          )}
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
        {!sandboxSupported && (
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
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("settings.label.reasoningEffort")}
            </span>
            {reasoningLadder !== null ? (
              <select
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value)}
                disabled={reasoningPlanReason !== null}
                title={reasoningPlanReason ?? undefined}
                className={
                  "bg-[var(--bg-pane)] border px-1.5 py-1 outline-none focus:border-[var(--accent)] " +
                  (reasoningEffortInvalid || reasoningRejection ? "border-[var(--err)]" : "border-[var(--border)]")
                }
              >
                <option value="">{t("settings.reasoningEffort.inherit")}</option>
                {[
                  ...reasoningLadder,
                  ...(reasoningEffort.trim() && !reasoningLadder.includes(reasoningEffort)
                    ? [reasoningEffort]
                    : []),
                ].map((level) => (
                  <option key={level} value={level}>
                    {reasoningOptionLabel(t, level)}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input
                  list={REASONING_OPTION_ID}
                  value={reasoningEffort}
                  onChange={(e) => setReasoningEffort(e.target.value)}
                  placeholder={t("settings.reasoningEffort.inherit")}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={reasoningPlanReason !== null}
                  title={reasoningPlanReason ?? undefined}
                  className={
                    "bg-[var(--bg-pane)] border px-1.5 py-1 outline-none focus:border-[var(--accent)] " +
                    (reasoningEffortInvalid ? "border-[var(--err)]" : "border-[var(--border)]")
                  }
                />
                <datalist id={REASONING_OPTION_ID}>
                  {REASONING_HINTS.map((effort) => (
                    <option key={effort} value={effort} />
                  ))}
                </datalist>
              </>
            )}
            {(reasoningPlanReason !== null ||
              reasoningEffortInvalid ||
              reasoningRejection !== null ||
              (reasoningLadder === null && capability.planView != null)) && (
              <span
                className={
                  "text-[10px] leading-tight " +
                  (reasoningEffortInvalid || reasoningRejection
                    ? "text-[var(--err)]"
                    : "text-[var(--text-faint)]")
                }
              >
                {reasoningPlanReason !== null
                  ? reasoningPlanReason
                  : reasoningEffortInvalid
                    ? t("settings.reasoningEffort.hint.invalid", { rule: REASONING_SYNTAX_RULE })
                    : reasoningRejection !== null
                      ? t("settings.plan.rejectedValue", {
                          value: reasoningRejection.value,
                          code: reasoningRejection.code,
                        })
                      : t("settings.reasoningEffort.unknownLadder")}
              </span>
            )}
          </label>
        )}
        {sandboxSupported && (
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
        <label className="flex flex-col gap-1">
          <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
            {t("project.label")}
          </span>
          <input
            value={projectRoot}
            onChange={(e) => setProjectRoot(e.target.value)}
            placeholder={t("project.placeholder")}
            disabled={projectPlanReason !== null}
            title={projectPlanReason ?? undefined}
            className={
              "bg-[var(--bg-pane)] border px-1.5 py-1 outline-none focus:border-[var(--accent)] " +
              (projectPlanReason !== null || projectRejection !== null
                ? "border-[var(--err)]"
                : "border-[var(--border)]")
            }
          />
          {(projectPlanReason !== null || projectRejection !== null || !projectRoot.trim()) && (
            <span
              className={
                "text-[10px] leading-tight " +
                (projectPlanReason !== null || projectRejection !== null
                  ? "text-[var(--warn)]"
                  : "text-[var(--text-faint)]")
              }
            >
              {projectPlanReason !== null
                ? projectPlanReason
                : projectRejection !== null
                  ? t("settings.plan.rejectedValue", {
                      value: projectRejection.value,
                      code: projectRejection.code,
                    })
                  : `${t("project.unbound")} — ${t("project.unbound.hint")}`}
            </span>
          )}
        </label>
        {error && <div className="text-[var(--err)] text-[10px]">{error}</div>}
        {(draftPreview?.rejection ||
          draftPreviewError !== null ||
          draftPreview?.resolutionError != null ||
          (draftPreview?.invalidated.length ?? 0) > 0) && (
          <div className="flex flex-col gap-1 border-l-2 border-[var(--warn)] pl-2">
            {draftPreview?.rejection && (
              <span className="text-[10px] text-[var(--err)] leading-tight">
                {t("settings.preview.rejected", {
                  code: draftPreview.rejection.code,
                  detail: draftPreview.rejection.detail,
                })}
              </span>
            )}
            {draftPreviewError !== null && (
              <span className="text-[10px] text-[var(--warn)] leading-tight">{draftPreviewError}</span>
            )}
            {draftPreview?.resolutionError != null && (
              <span className="text-[10px] text-[var(--warn)] leading-tight">
                {t("settings.invalidate.unresolved", { reason: draftPreview.resolutionError })}
              </span>
            )}
            {(draftPreview?.invalidated.length ?? 0) > 0 && (
              <span className="text-[10px] text-[var(--warn)] leading-tight">
                {t("settings.preview.invalidated", { n: draftPreview!.invalidated.length })}
              </span>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={onApply}
            disabled={!dirty || busy || reasoningEffortInvalid || draftPreview?.rejection != null}
            title={reasoningEffortInvalid ? t("settings.reasoningEffort.hint.invalid", { rule: REASONING_SYNTAX_RULE }) : undefined}
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

        <details className="border-t border-[var(--border)] pt-3">
          <summary className="text-[10px] tracking-wider text-[var(--text-faint)] cursor-pointer select-none">
            {t("settings.plan.title")}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <PlanStatusSection capability={capability} t={t} />
            {draftRequest !== null && (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
                  {t("settings.preview.title")}
                </span>
                <PlanStatusSection capability={draftCapability} t={t} />
              </div>
            )}
          </div>
        </details>

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
              onClick={onResetRuntime}
              disabled={busy}
              className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors disabled:opacity-30"
              title={t("settings.resetRuntime.title")}
            >
              {t("settings.resetRuntime")}
            </button>
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
