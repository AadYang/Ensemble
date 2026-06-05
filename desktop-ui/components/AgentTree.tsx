"use client";

import { useMemo, useState } from "react";
import type { AgentSummary, TeamSummary } from "@agentorch/shared";
import { useStore, type AgentState } from "@/store/agents";
import { useT } from "@/i18n/useT";
import { AgentSettings } from "./AgentSettings";
import { AddTeamMemberDialog } from "./AddTeamMemberDialog";
import { TeamSettingsDialog } from "./TeamSettingsDialog";
import { getDialog } from "@/lib/dialog";
import { deleteTeam } from "@/lib/team-api";

interface TreeNode {
  agent: AgentState;
  children: TreeNode[];
}

const buildTreeFromList = (list: AgentState[]): TreeNode[] => {
  const idSet = new Set(list.map((a) => a.summary.id));
  const byParent = new Map<string | null, AgentState[]>();
  for (const a of list) {
    // If parent is in a different group (e.g. parent is ungrouped while
    // child is in team X), treat the child as a root of the local subset.
    const parent = a.summary.parentId && idSet.has(a.summary.parentId) ? a.summary.parentId : null;
    const bucket = byParent.get(parent) ?? [];
    bucket.push(a);
    byParent.set(parent, bucket);
  }
  const construct = (parent: string | null): TreeNode[] =>
    (byParent.get(parent) ?? [])
      .sort((x, y) => x.summary.name.localeCompare(y.summary.name))
      .map((a) => ({ agent: a, children: construct(a.summary.id) }));
  return construct(null);
};

interface GroupedView {
  teams: Array<{ team: TeamSummary; nodes: TreeNode[] }>;
  ungrouped: TreeNode[];
}

const groupAgents = (agents: Record<string, AgentState>, teams: Record<string, TeamSummary>): GroupedView => {
  const buckets = new Map<string | "_none", AgentState[]>();
  for (const a of Object.values(agents)) {
    const key = a.summary.teamId ?? "_none";
    const bucket = buckets.get(key) ?? [];
    bucket.push(a);
    buckets.set(key, bucket);
  }
  const teamGroups = Object.values(teams)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((team) => ({
      team,
      nodes: buildTreeFromList(buckets.get(team.id) ?? []),
    }));
  const ungrouped = buildTreeFromList(buckets.get("_none") ?? []);
  return { teams: teamGroups, ungrouped };
};

export function AgentTree({
  onPick,
  activeId,
  boundAgentIds,
}: {
  onPick: (a: AgentSummary) => void;
  activeId: string | null;
  boundAgentIds: ReadonlySet<string>;
}) {
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const grouped = useMemo(() => groupAgents(agents, teams), [agents, teams]);
  const t = useT();
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [collapsedTeams, setCollapsedTeams] = useState<Record<string, boolean>>({});
  const [addMemberTo, setAddMemberTo] = useState<TeamSummary | null>(null);
  const [editingTeam, setEditingTeam] = useState<TeamSummary | null>(null);

  if (Object.keys(agents).length === 0) {
    return <div className="p-3 text-[var(--text-dim)] text-xs">{t("agent.empty")}</div>;
  }

  const onDeleteTeam = async (team: TeamSummary) => {
    const ok = await getDialog().confirm({
      title: t("team.delete.confirm", { name: team.name }),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTeam(team.id);
    } catch (err) {
      console.warn("delete team failed", err);
    }
  };

  return (
    <div className="text-xs">
      {grouped.teams.map(({ team, nodes }) => {
        const collapsed = !!collapsedTeams[team.id];
        return (
          <div key={team.id} className="border-b border-[var(--border)]">
            <div
              className="group w-full text-left px-2 py-1.5 flex items-center gap-2 bg-[var(--bg-pane)]/40 hover:bg-[var(--bg-pane)] cursor-pointer"
              onClick={() => setCollapsedTeams((p) => ({ ...p, [team.id]: !collapsed }))}
              title={team.description ?? team.name}
            >
              <span className="text-[var(--text-faint)]">{collapsed ? "▸" : "▾"}</span>
              <span className="text-[var(--accent)] text-[10px] tracking-wider uppercase">team</span>
              <span className="font-bold text-[var(--text)] truncate flex-1">{team.name}</span>
              <span className="text-[var(--text-faint)] text-[10px]">{nodes.length}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setAddMemberTo(team);
                }}
                title={t("team.addMember.title")}
                className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)] opacity-0 group-hover:opacity-100"
              >
                +
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingTeam(team);
                }}
                title={t("team.settings.title")}
                className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)] opacity-0 group-hover:opacity-100"
              >
                ✎
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void onDeleteTeam(team);
                }}
                title={t("team.delete.title")}
                className="px-1 text-[var(--text-dim)] hover:text-[var(--err)] opacity-0 group-hover:opacity-100"
              >
                ×
              </button>
            </div>
            {!collapsed && nodes.length === 0 && (
              <div className="px-3 py-1 text-[var(--text-faint)] text-[10px] italic">
                {t("team.empty")}
              </div>
            )}
            {!collapsed &&
              nodes.map((node) => (
                <TreeRow
                  key={node.agent.summary.id}
                  node={node}
                  depth={0}
                  onPick={onPick}
                  activeId={activeId}
                  boundAgentIds={boundAgentIds}
                  onSettings={setSettingsAgentId}
                />
              ))}
          </div>
        );
      })}
      {grouped.ungrouped.length > 0 && grouped.teams.length > 0 && (
        <div className="px-2 py-1.5 bg-[var(--bg-pane)]/40 text-[10px] tracking-wider uppercase text-[var(--text-faint)] border-b border-[var(--border)]">
          {t("team.ungroupedLabel")}
        </div>
      )}
      {grouped.ungrouped.map((node) => (
        <TreeRow
          key={node.agent.summary.id}
          node={node}
          depth={0}
          onPick={onPick}
          activeId={activeId}
          boundAgentIds={boundAgentIds}
          onSettings={setSettingsAgentId}
        />
      ))}
      {settingsAgentId && (
        <AgentSettings agentId={settingsAgentId} onClose={() => setSettingsAgentId(null)} />
      )}
      {addMemberTo && (
        <AddTeamMemberDialog
          teamId={addMemberTo.id}
          teamName={addMemberTo.name}
          onClose={() => setAddMemberTo(null)}
        />
      )}
      {editingTeam && (
        <TeamSettingsDialog team={editingTeam} onClose={() => setEditingTeam(null)} />
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  onPick,
  activeId,
  boundAgentIds,
  onSettings,
}: {
  node: TreeNode;
  depth: number;
  onPick: (a: AgentSummary) => void;
  activeId: string | null;
  boundAgentIds: ReadonlySet<string>;
  onSettings: (id: string) => void;
}) {
  const a = node.agent.summary;
  const bound = boundAgentIds.has(a.id);
  const t = useT();
  return (
    <>
      <div
        onClick={() => onPick(a)}
        className={`group w-full text-left px-2 py-2 border-b border-[var(--border)] flex items-center gap-2 cursor-pointer ${
          activeId === a.id ? "bg-[var(--bg-pane)]" : "hover:bg-[var(--bg-pane)]/50"
        }`}
        style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}
        title={bound ? t("agent.bound.tooltip") : t("agent.notBound.tooltip")}
      >
        {depth > 0 && <span className="text-[var(--text-faint)]">└</span>}
        <span className={`status-dot ${a.status}`} />
        <span className={`truncate flex-1 ${bound ? "text-[var(--accent)]" : "text-[var(--text)]"}`}>
          {a.name}
        </span>
        {bound && <span className="text-[var(--accent)] text-[10px]" aria-label="attached">●</span>}
        {node.children.length > 0 && (
          <span className="text-[var(--text-faint)] text-[10px]">{node.children.length}</span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSettings(a.id);
          }}
          title={t("pane.btn.settings")}
          className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity"
        >
          ⚙
        </button>
      </div>
      {node.children.map((c) => (
        <TreeRow
          key={c.agent.summary.id}
          node={c}
          depth={depth + 1}
          onPick={onPick}
          activeId={activeId}
          boundAgentIds={boundAgentIds}
          onSettings={onSettings}
        />
      ))}
    </>
  );
}
