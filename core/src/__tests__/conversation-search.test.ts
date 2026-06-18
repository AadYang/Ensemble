import { beforeAll, describe, expect, it } from "vitest";

process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../db.js").prisma;
let conversationSearch: typeof import("../conversation-search.js").conversationSearch;

beforeAll(async () => {
  ({ prisma } = await import("../db.js"));
  ({ conversationSearch } = await import("../conversation-search.js"));
});

describe("conversationSearch", () => {
  it("finds user and assistant text in team scope and filters tool-use noise", async () => {
    const team = await prisma.team.create({ data: { name: "search-team" } });
    const caller = await prisma.agent.create({ data: { name: "caller", teamId: team.id } });
    const peer = await prisma.agent.create({ data: { name: "peer", teamId: team.id } });
    const outsider = await prisma.agent.create({ data: { name: "outsider" } });

    await prisma.message.create({
      data: {
        agentId: caller.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "Please remember the blue migration plan" } },
      },
    });
    await prisma.message.create({
      data: {
        agentId: peer.id,
        seq: 0,
        type: "assistant",
        payload: {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tool-1", name: "Read", input: { q: "blue migration hidden" } },
              { type: "text", text: "The migration answer is blue-green deployment" },
            ],
          },
        },
      },
    });
    await prisma.message.create({
      data: {
        agentId: outsider.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "outsider migration should not appear" } },
      },
    });

    const out = await conversationSearch(caller.id, { query: "migration", scope: "team", limit: 10 });

    expect(out).toContain("scope=team");
    expect(out).toContain(`agent="${caller.name}"`);
    expect(out).toContain("role=user");
    expect(out).toContain(`agent="${peer.name}"`);
    expect(out).toContain("role=assistant");
    expect(out).toContain("blue-green deployment");
    expect(out).not.toContain("outsider migration");
    expect(out).not.toContain("tool-1");
    expect(out).not.toContain("hidden");
  });

  it("supports self scope, agent scope, missing target, and unteamed fallback", async () => {
    const solo = await prisma.agent.create({ data: { name: "solo-searcher" } });
    const target = await prisma.agent.create({ data: { name: "named-target" } });
    await prisma.message.create({
      data: {
        agentId: solo.id,
        seq: 0,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "self-only keyword" } },
      },
    });
    await prisma.message.create({
      data: {
        agentId: target.id,
        seq: 0,
        type: "assistant",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "target-only keyword" }] } },
      },
    });

    const fallback = await conversationSearch(solo.id, { query: "self-only" });
    expect(fallback).toContain("scope=self");
    expect(fallback).toContain("fell back to self");
    expect(fallback).toContain(`agent="${solo.name}"`);

    const self = await conversationSearch(solo.id, { query: "target-only", scope: "self" });
    expect(self).toContain("matches: 0");

    const agent = await conversationSearch(solo.id, { query: "target-only", scope: "agent", target: target.name });
    expect(agent).toContain("scope=agent");
    expect(agent).toContain(`agent="${target.name}"`);

    const missing = await conversationSearch(solo.id, { query: "anything", scope: "agent", target: "missing-agent" });
    expect(missing).toContain('error: no agent matches "missing-agent"');
  });

  it("applies limit and snippet truncation", async () => {
    const agent = await prisma.agent.create({ data: { name: "truncation-agent" } });
    for (let i = 0; i < 4; i++) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          seq: i,
          type: "user",
          payload: {
            type: "user",
            message: {
              role: "user",
              content: `${"prefix ".repeat(80)}needle-${i}${" suffix".repeat(80)}`,
            },
          },
        },
      });
    }

    const out = await conversationSearch(agent.id, { query: "needle", scope: "self", limit: 2 });
    expect(out).toContain("matches: 2 of 4");
    expect(out).toContain("... ");
    expect(out).toContain("needle-");
    expect(out).not.toContain("prefix ".repeat(40));
  });
});
