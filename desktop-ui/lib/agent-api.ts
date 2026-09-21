import type {
  AgentStatusReport,
  AgentSummary,
  PermissionMode,
  ReasoningEffort,
  RunPlanSettingField,
  SandboxMode,
  SettingsImpactReport,
  SettingsImpactRequest,
} from "@agentorch/shared";

/** The structured failure body the API returns for a refused write.
 *
 *  Thrown as data, never flattened into `patchAgent: 400`. The server's codes
 *  are the whole point — `reasoning_effort_unsupported` carries WHICH level, on
 *  WHICH model, and the ladder it does have, and a UI that receives the string
 *  "400" has to invent all of that back. */
export class AgentRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The server's own detail object, unmodified. */
  readonly detail: Record<string, unknown>;
  constructor(status: number, code: string | null, detail: Record<string, unknown>) {
    // The server's sentence when it sent one, so the caller has something to
    // show even before it inspects `detail`.
    const message =
      (typeof detail.message === "string" && detail.message) ||
      (typeof detail.reason === "string" && detail.reason) ||
      code ||
      `${status}`;
    super(message);
    this.name = "AgentRequestError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Parse a non-OK response into `AgentRequestError`. Best-effort by design: a
 *  proxy that returns HTML must not turn into an unhandled parse error, so a
 *  body that is not JSON yields a code-less error carrying only the status. */
async function throwAgentRequestError(res: Response, fallback: string): Promise<never> {
  const text = await res.text().catch(() => "");
  let detail: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") detail = parsed as Record<string, unknown>;
  } catch {
    // not JSON — keep the raw text so the message is not empty
  }
  const code = typeof detail.error === "string" ? detail.error : null;
  throw new AgentRequestError(res.status, code, detail.message || detail.reason ? detail : { ...detail, message: text || fallback });
}

export interface AgentPatch {
  name?: string;
  model?: string;
  providerId?: string | null;
  /** The agent's project root — the directory its turns run in. Absolute path
   *  to an existing directory, or null for unbound. */
  projectRoot?: string | null;
  /** Legacy alias of `projectRoot`; server-side they are one field. */
  codexWorkspace?: string | null;
  permissionMode?: PermissionMode;
  /** Codex per-agent sandbox override. null = clear override (inherit provider). */
  sandboxMode?: SandboxMode | null;
  /** Claude Code/Codex per-agent thinking override. null = clear override (inherit runtime). */
  reasoningEffort?: ReasoningEffort | null;
  /** Role / persona prompt. Changing it clears the resume pointer server-side
   *  so the next turn picks up the new prompt instead of resuming the CLI
   *  session it locked in earlier. */
  systemPrompt?: string | null;
  /** Move agent into / out of a team. null = ungrouped. */
  teamId?: string | null;
  /** The fields whose stored value the caller has SEEN the invalidation report
   *  for and accepted. The server refuses a change that would invalidate a
   *  stored value unless that field is named here (HTTP 409
   *  `settings-invalidation-unconfirmed`), which is what stops a model/provider
   *  switch from silently clearing a reasoning level or a sandbox override. It
   *  is a confirmation, NOT an instruction: naming a field does not make the
   *  server drop anything it would not otherwise drop, and the server still
   *  runs its own final validation afterwards. */
  confirmInvalidated?: RunPlanSettingField[];
}

export async function listAgents(): Promise<AgentSummary[]> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error(`listAgents: ${res.status}`);
  return (await res.json()) as AgentSummary[];
}

export interface PersistedMessage {
  seq: number;
  msg: unknown;
}

export async function listMessages(
  id: string,
  limit = 200,
  afterSeq?: number,
  beforeSeq?: number,
): Promise<PersistedMessage[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (afterSeq !== undefined) params.set("afterSeq", String(afterSeq));
  if (beforeSeq !== undefined) params.set("beforeSeq", String(beforeSeq));
  const res = await fetch(`/api/agents/${id}/messages?${params.toString()}`);
  if (!res.ok) throw new Error(`listMessages: ${res.status}`);
  return (await res.json()) as PersistedMessage[];
}

/** The server refused a write because it would invalidate stored values the
 *  caller has not acknowledged. Carries the report the server produced, so the
 *  dialog can render the SAME reasons it would have seen from
 *  `getAgentSettingsImpact` — the client never composes the list itself, and
 *  never retries with a blanket confirmation. */
export class SettingsInvalidationError extends Error {
  readonly impact: SettingsImpactReport;
  constructor(impact: SettingsImpactReport) {
    super(
      `patchAgent: refused, ${impact.invalidated.length} setting(s) would be invalidated without confirmation`,
    );
    this.name = "SettingsInvalidationError";
    this.impact = impact;
  }
}

export function isSettingsInvalidationError(err: unknown): err is SettingsInvalidationError {
  return err instanceof SettingsInvalidationError;
}

export async function patchAgent(id: string, patch: AgentPatch): Promise<AgentSummary> {
  const res = await fetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 409) {
    // The server's own report, thrown as a typed error rather than a string:
    // the settings dialog shows the affected fields and re-asks, and the write
    // is NOT retried automatically.
    const body = (await res.json().catch(() => null)) as { impact?: SettingsImpactReport } | null;
    if (body?.impact) throw new SettingsInvalidationError(body.impact);
    // A 409 without a report is not the confirmation contract; it is an error
    // like any other, and it must not be shown as an unexplained refusal.
    throw new AgentRequestError(409, "settings-invalidation-unconfirmed", {});
  }
  // Everything else keeps its STRUCTURE: `reasoning_effort_unsupported` and
  // `project_root_invalid` carry the level / the path / the ladder / the code
  // that the form has to render. The old `throw new Error(\`patchAgent: ${res.status}\`)`
  // threw all of that away and left the user with a number.
  if (!res.ok) await throwAgentRequestError(res, `patchAgent: ${res.status}`);
  return (await res.json()) as AgentSummary;
}

/** What a proposed settings change would invalidate, BEFORE anything is written.
 *  Read-only server-side: it resolves a candidate plan and reports the fields
 *  whose stored value the change would make unusable. The dialog must show this
 *  and get an explicit confirmation before calling `patchAgent` — nothing is
 *  written by this call. */
export async function getAgentSettingsImpact(
  id: string,
  request: SettingsImpactRequest,
): Promise<SettingsImpactReport> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/settings-impact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) await throwAgentRequestError(res, `getAgentSettingsImpact: ${res.status}`);
  return (await res.json()) as SettingsImpactReport;
}

export async function closeAgent(id: string): Promise<AgentSummary> {
  const res = await fetch(`/api/agents/${id}/close`, { method: "POST" });
  if (!res.ok) throw new Error(`closeAgent: ${res.status}`);
  return (await res.json()) as AgentSummary;
}

export async function restartAgent(id: string): Promise<AgentSummary> {
  const res = await fetch(`/api/agents/${id}/restart`, { method: "POST" });
  if (!res.ok) throw new Error(`restartAgent: ${res.status}`);
  return (await res.json()) as AgentSummary;
}

export async function resetRuntimeSession(id: string): Promise<AgentSummary> {
  const res = await fetch(`/api/agents/${id}/reset-runtime-session`, { method: "POST" });
  if (!res.ok) throw new Error(`resetRuntimeSession: ${res.status}`);
  return (await res.json()) as AgentSummary;
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteAgent: ${res.status}`);
}

export async function clearAgentContext(id: string): Promise<void> {
  const res = await fetch(`/api/agents/${id}/clear`, { method: "POST" });
  if (!res.ok) throw new Error(`clearAgentContext: ${res.status}`);
}

export async function compactAgent(id: string): Promise<{ summary: string }> {
  const res = await fetch(`/api/agents/${id}/compact`, { method: "POST" });
  if (!res.ok) throw new Error(`compactAgent: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as { summary: string };
}

/** The `/status` payload, from its ONE declaration in `shared`.
 *
 *  Re-exported rather than re-declared. A hand-copied partial copy of this
 *  shape is how the UI came to be missing planView / history / liveness /
 *  archivedGenerations while every cast still type-checked: the copy silently
 *  dropped whatever it had never been taught about. Importing the same type
 *  the server returns makes an added server field visible here immediately, and
 *  `core/src/__tests__/status-dto-parity.check.ts` makes a drifted shape a
 *  compile error on the server side too. */
export type { AgentStatusReport };

/** The `/status` read, for a LOCAL agent.
 *
 *  `null` = this instance has no such agent. That is a real, reachable state —
 *  an agent that exists only in a cloud workspace has no report here, because
 *  its plan, its liveness and its token counts are produced by the process
 *  actually running it. Returning a report for it would mean fabricating one
 *  from the synced snapshot, and answering from a DIFFERENT local agent that
 *  happens to share the id would be worse still. Callers render the null. */
export async function getAgentStatusReport(id: string): Promise<AgentStatusReport | null> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/status`);
  if (res.status === 404) return null;
  if (!res.ok) await throwAgentRequestError(res, `getAgentStatusReport: ${res.status}`);
  return (await res.json()) as AgentStatusReport | null;
}

// ----- W14: subagent suggestions -----

export interface SubagentSuggestion {
  key: string;
  displayName: string;
  systemPrompt: string;
}

export interface CatalogEntry {
  key: string;
  displayName: string;
  description: string;
}

/** Fetch the static subagent catalog. Cheap, cacheable client-side. */
export async function getSubagentCatalog(): Promise<CatalogEntry[]> {
  const res = await fetch("/api/subagent-catalog");
  if (!res.ok) throw new Error(`getSubagentCatalog: ${res.status}`);
  const body = (await res.json()) as { entries: CatalogEntry[] };
  return body.entries;
}

/** Ask the server to recommend three subagents for the given parent agent.
 *  Server-side timeout is ~15s; the client adds its own AbortController on
 *  top so the dialog can fall back to the static catalog if the response
 *  doesn't arrive in time. */
export async function suggestSubagents(
  parentId: string,
  signal?: AbortSignal,
): Promise<SubagentSuggestion[]> {
  const res = await fetch(`/api/agents/${parentId}/suggest-children`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal,
  });
  if (!res.ok) throw new Error(`suggestSubagents: ${res.status}`);
  const body = (await res.json()) as { suggestions: SubagentSuggestion[] };
  return body.suggestions;
}
