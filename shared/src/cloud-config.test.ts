// The cloud upload's gates: what leaves this machine, and what counts as "the
// configuration changed".
//
// These are the invariants the cloud sync is accepted under. They live here
// because `desktop-ui` has no test runner and because both ends of the contract
// (the builder, the signature) are in one module — a field that is uploaded but
// not signed would be a change the cloud never notices, and a field that is
// signed but not uploaded would be a signature that moves on its own.
//
//   gate 7 — no path-shaped legacy `codexWorkspace` in the payload, the
//            signature covers EXACTLY the uploaded fields, and the run ceiling
//            rides in `metadata` so it syncs like every other setting.

import { describe, expect, it } from "vitest";
import {
  CLOUD_AGENT_FIELDS,
  CLOUD_AGENT_SERVER_FIELDS,
  PUBLISHED_PLAN_KEY,
  buildCloudSnapshotFromLocal,
  cloudConfigSignature,
  type CloudAgent,
} from "./cloud-config.js";
import type { AgentSummary, TeamSummary } from "./protocol.js";

const agent: AgentSummary = {
  id: "agent-1",
  name: "Agent",
  parentId: null,
  teamId: null,
  status: "idle",
  model: "gpt-test",
  systemPrompt: null,
  providerId: "provider-1",
  projectRoot: "D:/work/project",
  codexWorkspace: "D:/work/project",
  permissionMode: "default",
  sandboxMode: null,
  reasoningEffort: null,
  maxRunDurationMs: 600_000,
  subagentKind: null,
  forcedSkills: [],
  disabledSkills: [],
  closed: false,
  hasResumeInfo: false,
  createdAt: "2026-09-15T00:00:00.000Z",
};

const team: TeamSummary = {
  id: "team-1",
  name: "Team",
  description: null,
  memberIds: ["agent-1"],
  createdAt: "2026-09-15T00:00:00.000Z",
};

const snapshotOf = (over: Partial<AgentSummary> = {}) =>
  buildCloudSnapshotFromLocal({
    agents: [{ ...agent, ...over }],
    teams: [team],
    messagesByAgent: { [agent.id]: [{ seq: 0, msg: { type: "assistant_text", text: "hi" } }] },
  });

describe("gate 7: what the upload carries", () => {
  it("carries no path under the legacy `codexWorkspace` name", () => {
    const [uploaded] = snapshotOf().agents;
    // Not "null" — ABSENT. The retired column is the whole reason the same
    // directory used to travel twice under two names.
    expect("codexWorkspace" in uploaded!).toBe(false);
    expect(uploaded!.projectRoot).toBe("D:/work/project");
  });

  it("uploads exactly the declared field set, and the server's own two", () => {
    const [uploaded] = snapshotOf().agents;
    expect(new Set(Object.keys(uploaded!))).toEqual(
      new Set([...CLOUD_AGENT_FIELDS, ...CLOUD_AGENT_SERVER_FIELDS]),
    );
  });

  it("signs exactly the fields it uploads", () => {
    const snapshot = snapshotOf();
    const signed = JSON.parse(cloudConfigSignature(snapshot)) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(signed.agents).toHaveLength(1);
    // `revision` and `updatedAt` are the server's; everything else the payload
    // carries is signed, and nothing the payload does not carry is.
    expect(new Set(Object.keys(signed.agents[0]!))).toEqual(new Set(CLOUD_AGENT_FIELDS));
  });
});

describe("gate 7: the run ceiling syncs like a setting", () => {
  it("travels in `metadata` under one name, on both sides", () => {
    const [uploaded] = snapshotOf().agents;
    expect(uploaded!.metadata).toMatchObject({ maxRunDurationMs: 600_000 });
  });

  it("moves the signature when it changes", () => {
    const before = cloudConfigSignature(snapshotOf());
    const after = cloudConfigSignature(snapshotOf({ maxRunDurationMs: 900_000 }));
    expect(after).not.toBe(before);
    // …and clearing it is a change too, not a silent no-op.
    expect(cloudConfigSignature(snapshotOf({ maxRunDurationMs: null }))).not.toBe(before);
  });

  it("does not move the signature for a secret-only change", () => {
    const withSecret = snapshotOf();
    const agents = withSecret.agents.map((entry) => ({
      ...entry,
      metadata: { ...entry.metadata, apiKey: "sk-live-123" },
    }));
    expect(cloudConfigSignature({ teams: withSecret.teams, agents })).toBe(
      cloudConfigSignature(withSecret),
    );
  });
});

describe("a published plan is relayed, and is not a configuration change", () => {
  const publish = (planLabel: string): CloudAgent => {
    const [uploaded] = snapshotOf().agents;
    return {
      ...uploaded!,
      metadata: { ...uploaded!.metadata, [PUBLISHED_PLAN_KEY]: { planView: { planHash: planLabel }, publishedAt: planLabel } },
    };
  };

  it("does not move the config signature", () => {
    const base = snapshotOf();
    const before = cloudConfigSignature(base);
    const after = cloudConfigSignature({ teams: base.teams, agents: [publish("plan-a")] });
    expect(after).toBe(before);
    // Two DIFFERENT plans are equally invisible to the signature: a turn must
    // never look like a settings change.
    expect(cloudConfigSignature({ teams: base.teams, agents: [publish("plan-b")] })).toBe(before);
  });

  it("still leaves the rest of the metadata signed", () => {
    const base = snapshotOf();
    const agentWithPlan = publish("plan-a");
    const withCeilingChanged = {
      ...agentWithPlan,
      metadata: { ...agentWithPlan.metadata, maxRunDurationMs: 1 },
    };
    expect(cloudConfigSignature({ teams: base.teams, agents: [withCeilingChanged] })).not.toBe(
      cloudConfigSignature({ teams: base.teams, agents: [agentWithPlan] }),
    );
  });
});
