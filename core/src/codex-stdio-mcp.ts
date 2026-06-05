import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { BRIDGE_TOKEN, createInternalMcpServer, type InternalToolName } from "./mcp-bridge.js";

function envRequired(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function invokeViaCore(name: InternalToolName, args: Record<string, unknown>): Promise<string> {
  const baseUrl = envRequired("ENSEMBLE_MCP_BASE_URL").replace(/\/+$/, "");
  const agentId = encodeURIComponent(envRequired("ENSEMBLE_MCP_AGENT_ID"));
  const tool = encodeURIComponent(name);
  const token = process.env.ENSEMBLE_MCP_BEARER || BRIDGE_TOKEN;
  const res = await fetch(`${baseUrl}/api/mcp/internal-tool/${agentId}/${tool}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args ?? {}),
  });
  const json = (await res.json().catch(() => null)) as { content?: unknown; error?: unknown } | null;
  if (!res.ok) {
    throw new Error(String(json?.error ?? `Ensemble core returned HTTP ${res.status}`));
  }
  return String(json?.content ?? "");
}

export async function runCodexStdioMcp(): Promise<void> {
  const server = createInternalMcpServer(invokeViaCore);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirect = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isDirect) {
  runCodexStdioMcp().catch((err) => {
    console.error(`[codex-stdio-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
