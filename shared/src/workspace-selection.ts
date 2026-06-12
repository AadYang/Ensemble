import type { AgentSummary, TeamSummary } from "./protocol";
import type { LayoutNode, LayoutWorkspace } from "./layout";

export type WorkspaceSelectionKind = "local" | "cloud";

export interface WorkspaceSelection {
  kind: WorkspaceSelectionKind;
  id: string;
}

export function formatWorkspaceSelectionKey(selection: WorkspaceSelection): string {
  return `${selection.kind}:${selection.id}`;
}

export function parseWorkspaceSelectionKey(value: string | null | undefined): WorkspaceSelection | null {
  if (!value) return null;
  if (value.startsWith("local:")) return parseSelection("local", value.slice("local:".length));
  if (value.startsWith("cloud:")) return parseSelection("cloud", value.slice("cloud:".length));
  return null;
}

export function parseStoredWorkspaceSelection(value: string | null | undefined): WorkspaceSelection | null {
  const parsed = parseWorkspaceSelectionKey(value);
  if (parsed) return parsed;
  return value ? { kind: "local", id: value } : null;
}

export function collectLayoutAgentIds(layout: Pick<LayoutWorkspace, "windows">): Set<string> {
  const ids = new Set<string>();
  const visit = (node: LayoutNode): void => {
    if (node.kind === "pane") {
      if (node.agentId) ids.add(node.agentId);
      return;
    }
    visit(node.a);
    visit(node.b);
  };
  for (const window of layout.windows) visit(window.root);
  return ids;
}

export function filterWorkspaceEntitiesForLayout(input: {
  agents: AgentSummary[];
  teams: TeamSummary[];
  layout: Pick<LayoutWorkspace, "windows">;
}): { agents: AgentSummary[]; teams: TeamSummary[] } {
  const included = collectLayoutAgentIds(input.layout);
  const byId = new Map(input.agents.map((agent) => [agent.id, agent]));

  for (const id of Array.from(included)) {
    let parentId = byId.get(id)?.parentId ?? null;
    while (parentId) {
      if (included.has(parentId)) break;
      included.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }

  const agents = input.agents.filter((agent) => included.has(agent.id));
  const teamIds = new Set(agents.map((agent) => agent.teamId).filter((id): id is string => !!id));
  const teams = input.teams
    .filter((team) => teamIds.has(team.id))
    .map((team) => ({
      ...team,
      memberIds: team.memberIds.filter((id) => included.has(id)),
    }));

  return { agents, teams };
}

function parseSelection(kind: WorkspaceSelectionKind, id: string): WorkspaceSelection | null {
  return id ? { kind, id } : null;
}
