import { describe, expect, it } from "vitest";
import type { AgentSummary, LayoutWorkspace, TeamSummary } from "./index";
import {
  collectLayoutAgentIds,
  filterWorkspaceEntitiesForLayout,
  formatWorkspaceSelectionKey,
  parseStoredWorkspaceSelection,
  parseWorkspaceSelectionKey,
} from "./workspace-selection";

describe("workspace selection keys", () => {
  it("round-trips local and cloud keys even when ids collide", () => {
    const id = "same-id";
    expect(formatWorkspaceSelectionKey({ kind: "local", id })).toBe("local:same-id");
    expect(formatWorkspaceSelectionKey({ kind: "cloud", id })).toBe("cloud:same-id");
    expect(parseWorkspaceSelectionKey("local:same-id")).toEqual({ kind: "local", id });
    expect(parseWorkspaceSelectionKey("cloud:same-id")).toEqual({ kind: "cloud", id });
  });

  it("keeps colons inside workspace ids", () => {
    expect(parseWorkspaceSelectionKey("cloud:account:workspace")).toEqual({
      kind: "cloud",
      id: "account:workspace",
    });
  });

  it("treats legacy stored ids as local workspace ids", () => {
    expect(parseStoredWorkspaceSelection("legacy-id")).toEqual({ kind: "local", id: "legacy-id" });
    expect(parseStoredWorkspaceSelection("local:next")).toEqual({ kind: "local", id: "next" });
  });
});

describe("workspace entity scope", () => {
  it("collects only agent ids attached to the current layout", () => {
    expect([...collectLayoutAgentIds(layout)].sort()).toEqual(["child", "solo"]);
  });

  it("filters cloud copy sources to current workspace agents and their parent chain", () => {
    const scoped = filterWorkspaceEntitiesForLayout({ agents, teams, layout });
    expect(scoped.agents.map((agent) => agent.id)).toEqual(["parent", "child", "solo"]);
    expect(scoped.teams).toEqual([
      {
        id: "team-a",
        name: "Team A",
        description: null,
        memberIds: ["parent", "child"],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });
});

const layout: LayoutWorkspace = {
  activeWindowId: "w1",
  windows: [
    {
      id: "w1",
      name: "main",
      activePaneId: "p1",
      root: {
        kind: "split",
        id: "s1",
        dir: "h",
        ratio: 0.5,
        a: { kind: "pane", id: "p1", agentId: "child" },
        b: { kind: "pane", id: "p2", agentId: "solo" },
      },
    },
  ],
};

const baseAgent = {
  status: "idle",
  model: "model",
  systemPrompt: null,
  providerId: null,
  codexWorkspace: null,
  permissionMode: "default",
  sandboxMode: null,
  reasoningEffort: null,
  forcedSkills: [],
  disabledSkills: [],
  closed: false,
  hasResumeInfo: false,
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies Omit<AgentSummary, "id" | "name" | "parentId" | "teamId">;

const agents: AgentSummary[] = [
  { ...baseAgent, id: "parent", name: "Parent", parentId: null, teamId: "team-a" },
  { ...baseAgent, id: "child", name: "Child", parentId: "parent", teamId: "team-a" },
  { ...baseAgent, id: "solo", name: "Solo", parentId: null, teamId: null },
  { ...baseAgent, id: "other", name: "Other", parentId: null, teamId: "team-b" },
];

const teams: TeamSummary[] = [
  {
    id: "team-a",
    name: "Team A",
    description: null,
    memberIds: ["parent", "child", "other"],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "team-b",
    name: "Team B",
    description: null,
    memberIds: ["other"],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];
