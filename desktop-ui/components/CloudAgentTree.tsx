"use client";

import { useMemo } from "react";
import type { CloudAgent, CloudTeam } from "@/lib/cloud-api";

export function CloudAgentTree({
  agents,
  teams,
  activeId,
  onPick,
}: {
  agents: CloudAgent[];
  teams: CloudTeam[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  const grouped = useMemo(() => {
    const byTeam = new Map<string | "_none", CloudAgent[]>();
    for (const agent of agents) {
      const key = agent.teamId ?? "_none";
      byTeam.set(key, [...(byTeam.get(key) ?? []), agent]);
    }
    return {
      teams: teams
        .map((team) => ({
          team,
          agents: (byTeam.get(team.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
        }))
        .filter((group) => group.agents.length > 0),
      ungrouped: (byTeam.get("_none") ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    };
  }, [agents, teams]);

  if (agents.length === 0) {
    return <div className="p-3 text-[var(--text-dim)] text-xs">No agents in this cloud workspace.</div>;
  }

  return (
    <div className="text-xs">
      {grouped.teams.map(({ team, agents: teamAgents }) => (
        <div key={team.id} className="border-b border-[var(--border)]">
          <div className="px-2 py-1.5 flex items-center gap-2 bg-[var(--bg-pane)]/40">
            <span className="text-[var(--accent)] text-[10px] tracking-wider uppercase">cloud team</span>
            <span className="font-bold text-[var(--text)] truncate flex-1">{team.name}</span>
            <span className="text-[var(--text-faint)] text-[10px]">{teamAgents.length}</span>
          </div>
          {teamAgents.map((agent) => (
            <CloudAgentRow key={agent.id} agent={agent} active={activeId === agent.id} onPick={onPick} />
          ))}
        </div>
      ))}
      {grouped.ungrouped.length > 0 && grouped.teams.length > 0 && (
        <div className="px-2 py-1.5 bg-[var(--bg-pane)]/40 text-[10px] tracking-wider uppercase text-[var(--text-faint)] border-b border-[var(--border)]">
          ungrouped
        </div>
      )}
      {grouped.ungrouped.map((agent) => (
        <CloudAgentRow key={agent.id} agent={agent} active={activeId === agent.id} onPick={onPick} />
      ))}
    </div>
  );
}

function CloudAgentRow({
  agent,
  active,
  onPick,
}: {
  agent: CloudAgent;
  active: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(agent.id)}
      className={`w-full text-left px-2 py-2 border-b border-[var(--border)] flex items-center gap-2 cursor-pointer ${
        active ? "bg-[var(--bg-pane)]" : "hover:bg-[var(--bg-pane)]/50"
      }`}
      title={agent.model ?? agent.id}
    >
      <span className="status-dot idle" />
      <span className="truncate flex-1 text-[var(--text)]">{agent.name}</span>
      <span className="text-[var(--text-faint)] text-[10px]">cloud</span>
    </button>
  );
}
