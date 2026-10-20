export type McpTransport = "stdio" | "http" | "sse";

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpLikeConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface McpServerDTO {
  id: string;
  /** null = global. Anything else = private to that agent. */
  agentId: string | null;
  name: string;
  transport: McpTransport;
  config: McpStdioConfig | McpHttpLikeConfig;
  enabled: boolean;
}

/**
 * `all` is the management view (every row, with its owner). Without options
 * the server returns the global list; with `agentId` it returns what that
 * agent actually gets at runtime (globals + its own, agent winning on a name
 * collision).
 */
export async function listMcpServers(
  opts: { agentId?: string; all?: boolean } = {},
): Promise<McpServerDTO[]> {
  const qs = opts.all
    ? "?scope=all"
    : opts.agentId
      ? `?agentId=${encodeURIComponent(opts.agentId)}`
      : "";
  const res = await fetch(`/api/mcp-servers${qs}`);
  if (!res.ok) throw new Error(`listMcpServers: ${res.status}`);
  return (await res.json()) as McpServerDTO[];
}

export async function createMcpServer(input: {
  name: string;
  transport: McpTransport;
  config: McpStdioConfig | McpHttpLikeConfig;
  enabled?: boolean;
  /** Omit or null for a global server; an agent id scopes it to that agent. */
  agentId?: string | null;
}): Promise<McpServerDTO> {
  const res = await fetch("/api/mcp-servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`createMcpServer: ${res.status}`);
  return (await res.json()) as McpServerDTO;
}

export async function patchMcpServer(
  id: string,
  patch: { name?: string; enabled?: boolean },
): Promise<void> {
  const res = await fetch(`/api/mcp-servers/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patchMcpServer: ${res.status}`);
}

export async function deleteMcpServer(id: string): Promise<void> {
  const res = await fetch(`/api/mcp-servers/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteMcpServer: ${res.status}`);
}
