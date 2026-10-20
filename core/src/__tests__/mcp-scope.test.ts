// Regression coverage for per-agent MCP scoping.
//
// The reported defect: POST /mcp-servers accepted `agentId` in the body but
// persisted `agentId: null`, turning every per-agent server into a global one —
// and the runtime only ever loaded `agentId: null` rows, so a correctly scoped
// row would have been invisible anyway. These tests pin both halves: the row
// keeps its scope on create, and the loader returns exactly global ∪ own.

process.env.AGENTORCH_DB_PATH = ":memory:";

import { beforeAll, describe, expect, it } from "vitest";

let prisma: typeof import("../db.js").prisma;
let scope: typeof import("../mcp-scope.js");

beforeAll(async () => {
  ({ prisma } = await import("../db.js"));
  scope = await import("../mcp-scope.js");
});

async function agent(name: string): Promise<string> {
  const row = await prisma.agent.create({ data: { name } });
  return row.id;
}

function stdio(command: string): { command: string } {
  return { command };
}

describe("createMcpServerRow", () => {
  it("persists the submitted agentId instead of silently storing null", async () => {
    const a = await agent("mcp-create-a");
    const row = await scope.createMcpServerRow({
      name: "private-search",
      transport: "stdio",
      config: stdio("search-mcp"),
      agentId: a,
    });
    expect(row.agentId).toBe(a);
    // Read it back through the DB, not the returned object: the bug lived in
    // what was written, not what was echoed.
    const stored = await prisma.mcpServer.findUnique({ where: { id: row.id } });
    expect(stored?.agentId).toBe(a);
    expect(stored?.enabled).toBe(true);
  });

  it("keeps an omitted agentId global", async () => {
    const row = await scope.createMcpServerRow({
      name: "shared-search",
      transport: "stdio",
      config: stdio("search-mcp"),
    });
    const stored = await prisma.mcpServer.findUnique({ where: { id: row.id } });
    expect(stored?.agentId ?? null).toBeNull();
  });

  it("refuses an unknown agent rather than writing an orphan scope", async () => {
    await expect(
      scope.createMcpServerRow({
        name: "orphan",
        transport: "stdio",
        config: stdio("nothing"),
        agentId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toBeInstanceOf(scope.McpScopeError);
    const count = await prisma.mcpServer.findMany({ where: { name: "orphan" } });
    expect(count).toHaveLength(0);
  });
});

describe("loadEnabledMcpServers", () => {
  it("returns globals plus the agent's own rows and nothing else", async () => {
    const a = await agent("mcp-load-a");
    const b = await agent("mcp-load-b");
    await prisma.mcpServer.create({
      data: { name: "global-one", transport: "stdio", config: stdio("g"), enabled: true, agentId: null },
    });
    await prisma.mcpServer.create({
      data: { name: "only-a", transport: "stdio", config: stdio("a"), enabled: true, agentId: a },
    });
    await prisma.mcpServer.create({
      data: { name: "only-b", transport: "stdio", config: stdio("b"), enabled: true, agentId: b },
    });

    const map = await scope.loadEnabledMcpServers(a);
    expect(map["global-one"]).toMatchObject({ type: "stdio", command: "g" });
    expect(map["only-a"]).toEqual({ type: "stdio", command: "a", args: undefined, env: undefined });
    // Another agent's private server must never appear, even though it is
    // enabled and lives in the same table.
    expect(map["only-b"]).toBeUndefined();
  });

  it("skips disabled rows but lets an enabled per-agent row shadow a disabled global", async () => {
    const a = await agent("mcp-load-shadow");
    await prisma.mcpServer.create({
      data: { name: "shadowed", transport: "stdio", config: stdio("global-off"), enabled: false, agentId: null },
    });
    expect((await scope.loadEnabledMcpServers(a))["shadowed"]).toBeUndefined();

    await prisma.mcpServer.create({
      data: { name: "shadowed", transport: "stdio", config: stdio("agent-on"), enabled: true, agentId: a },
    });
    const map = await scope.loadEnabledMcpServers(a);
    expect(map["shadowed"]).toMatchObject({ type: "stdio", command: "agent-on" });
  });

  it("lets a per-agent definition override a same-named global one", async () => {
    const a = await agent("mcp-load-override");
    await prisma.mcpServer.create({
      data: {
        name: "same-name",
        transport: "http",
        config: { url: "https://global.example.test/mcp" },
        enabled: true,
        agentId: null,
      },
    });
    await prisma.mcpServer.create({
      data: {
        name: "same-name",
        transport: "http",
        config: { url: "https://agent.example.test/mcp" },
        enabled: true,
        agentId: a,
      },
    });
    const map = await scope.loadEnabledMcpServers(a);
    expect(map["same-name"]).toEqual({
      type: "http",
      url: "https://agent.example.test/mcp",
      headers: undefined,
    });
  });
});

describe("scopedMcpRows", () => {
  it("keeps one row per name with the agent-scoped row winning", () => {
    const rows = [
      { name: "x", agentId: null as string | null },
      { name: "x", agentId: "a" },
      { name: "y", agentId: "b" },
    ];
    expect(scope.scopedMcpRows(rows, "a")).toEqual([
      { name: "x", agentId: "a" },
    ]);
  });
});
