import { prisma, type McpServer } from "./db.js";

/**
 * Which MCP rows an agent may use.
 *
 * The rule is deliberately "global ∪ own", never "all": `McpServer.agentId`
 * is NULL for a global server and set for a per-agent one. A private server
 * belonging to agent B must never reach agent A's runtime, and /status must
 * report the same set the runtime actually gets.
 */
export type McpRow = Pick<McpServer, "agentId" | "name" | "transport" | "config">;

/** Rows that apply to `agentId`: global rows plus that agent's own rows. */
export function appliesToAgent(row: Pick<McpServer, "agentId">, agentId: string): boolean {
  return row.agentId === null || row.agentId === agentId;
}

/**
 * Resolve the effective rows for an agent. A per-agent row overrides a global
 * row with the same `name` — the agent-scoped definition is the more specific
 * intent, and the runtime map is keyed by name, so only one can win. The
 * winning row is the one returned, so callers can report which scope is live.
 */
export function scopedMcpRows<T extends Pick<McpServer, "agentId" | "name">>(rows: T[], agentId: string): T[] {
  const byName = new Map<string, T>();
  // Globals first, agent rows second, so the agent-scoped row overwrites.
  for (const row of rows) {
    if (row.agentId === null) byName.set(row.name, row);
  }
  for (const row of rows) {
    if (row.agentId === agentId) byName.set(row.name, row);
  }
  return [...byName.values()];
}

export type McpServerMap = Record<
  string,
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
>;

function toSdkShape(row: McpRow): McpServerMap[string] | null {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  if (row.transport === "stdio") {
    return {
      type: "stdio",
      command: String(cfg.command),
      args: Array.isArray(cfg.args) ? (cfg.args as string[]) : undefined,
      env: (cfg.env as Record<string, string> | undefined) ?? undefined,
    };
  }
  if (row.transport === "http") {
    return {
      type: "http",
      url: String(cfg.url),
      headers: (cfg.headers as Record<string, string> | undefined) ?? undefined,
    };
  }
  if (row.transport === "sse") {
    return {
      type: "sse",
      url: String(cfg.url),
      headers: (cfg.headers as Record<string, string> | undefined) ?? undefined,
    };
  }
  return null;
}

export class McpScopeError extends Error {
  readonly code = "AGENT_NOT_FOUND";
  constructor(agentId: string) {
    super(`no agent with id ${agentId}`);
    this.name = "McpScopeError";
  }
}

/**
 * Persist a server row. `agentId` is stored verbatim (null = global) — the
 * create route used to hardcode null, which silently turned every per-agent
 * server into a global one. An unknown agent is refused rather than written:
 * a row pointing at nothing would be invisible to every runtime.
 */
export async function createMcpServerRow(input: {
  name: string;
  transport: string;
  config: unknown;
  enabled?: boolean;
  agentId?: string | null;
}): Promise<McpServer> {
  const agentId = input.agentId ?? null;
  if (agentId) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new McpScopeError(agentId);
  }
  return prisma.mcpServer.create({
    data: {
      name: input.name,
      transport: input.transport,
      config: input.config as object,
      enabled: input.enabled ?? true,
      agentId,
    },
  });
}

/** Enabled servers visible to one agent, in the shape every runtime consumes. */
export async function loadEnabledMcpServers(agentId: string): Promise<McpServerMap> {
  const rows = await prisma.mcpServer.findMany({
    where: { enabled: true, OR: [{ agentId: null }, { agentId }] },
  });
  const out: McpServerMap = {};
  for (const row of scopedMcpRows(rows, agentId)) {
    const shaped = toSdkShape(row);
    if (shaped) out[row.name] = shaped;
  }
  return out;
}
