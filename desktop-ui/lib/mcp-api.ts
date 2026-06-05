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
  name: string;
  transport: McpTransport;
  config: McpStdioConfig | McpHttpLikeConfig;
  enabled: boolean;
}

export async function listMcpServers(): Promise<McpServerDTO[]> {
  const res = await fetch("/api/mcp-servers");
  if (!res.ok) throw new Error(`listMcpServers: ${res.status}`);
  return (await res.json()) as McpServerDTO[];
}

export async function createMcpServer(input: {
  name: string;
  transport: McpTransport;
  config: McpStdioConfig | McpHttpLikeConfig;
  enabled?: boolean;
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
