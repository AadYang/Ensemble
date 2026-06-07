import type { AgentSummary, PermissionMode, ReasoningEffort, SandboxMode } from "@agentorch/shared";

export interface AgentPatch {
  name?: string;
  model?: string;
  providerId?: string | null;
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

export async function listMessages(id: string, limit = 200): Promise<PersistedMessage[]> {
  const res = await fetch(`/api/agents/${id}/messages?limit=${limit}`);
  if (!res.ok) throw new Error(`listMessages: ${res.status}`);
  return (await res.json()) as PersistedMessage[];
}

export async function patchAgent(id: string, patch: AgentPatch): Promise<AgentSummary> {
  const res = await fetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patchAgent: ${res.status}`);
  return (await res.json()) as AgentSummary;
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

export interface AgentStatusReport {
  name: string;
  providerName: string | null;
  providerKind: string | null;
  model: string;
  permissionMode: PermissionMode;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access" | null;
  reasoningEffort: ReasoningEffort | null;
  codexWorkspace: string | null;
  hasResumeInfo: boolean;
  closed: boolean;
  messages: number;
  enabledMcpServers: number;
}

export async function getAgentStatusReport(id: string): Promise<AgentStatusReport> {
  const res = await fetch(`/api/agents/${id}/status`);
  if (!res.ok) throw new Error(`getAgentStatusReport: ${res.status}`);
  return (await res.json()) as AgentStatusReport;
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
