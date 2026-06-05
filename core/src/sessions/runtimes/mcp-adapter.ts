// W20 Slice 5.5b: shared adapter that converts Ensemble's stored MCP server
// records (Claude SDK shape, as produced by SessionManager.loadEnabledMcpServers)
// into @openai/agents MCPServer instances the OpenAI runtime can pass into
// `new Agent({ mcpServers })`.
//
// Lifecycle contract per @openai/agents Agent docs: callers must `connect()`
// each MCPServer before handing it to the Agent, and `close()` after the run
// completes. We expose `connectAll` / `closeAll` helpers so the runtime
// keeps a single try/finally bracket.

import {
  MCPServerStdio,
  MCPServerStreamableHttp,
  MCPServerSSE,
  type MCPServer,
} from "@openai/agents";

/** Translate the Claude-SDK-shaped mcpServers map into a list of
 *  @openai/agents MCPServer instances. In-process SDK MCP entries
 *  (Claude `createSdkMcpServer` / `type: 'sdk'`) are skipped — those are
 *  Claude-side-only and have no transport counterpart on the OpenAI side
 *  (peer_send / ask_user / Task are surfaced via NormalizedTool there). */
export function toOpenAIMcpServers(servers: Record<string, unknown>): MCPServer[] {
  const out: MCPServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object") continue;
    const cfg = raw as {
      type?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
    };
    if (cfg.type === "stdio" && cfg.command) {
      out.push(
        new MCPServerStdio({
          name,
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
        }),
      );
    } else if (cfg.type === "http" && cfg.url) {
      out.push(new MCPServerStreamableHttp({ name, url: cfg.url }));
    } else if (cfg.type === "sse" && cfg.url) {
      out.push(new MCPServerSSE({ name, url: cfg.url }));
    }
    // 'sdk' or unknown → silently drop; surfaced via NormalizedTool instead.
  }
  return out;
}

/** Connect all MCPServers in parallel. Throws aggregated error if any fail. */
export async function connectAll(servers: MCPServer[]): Promise<void> {
  await Promise.all(servers.map((s) => s.connect()));
}

/** Close all MCPServers, swallowing per-server errors so one stuck server
 *  doesn't block teardown of the others. Errors logged via the logger
 *  injected at construction (default: console.warn). */
export async function closeAll(servers: MCPServer[]): Promise<void> {
  await Promise.all(
    servers.map(async (s) => {
      try {
        await s.close();
      } catch {
        // Best-effort cleanup; per-server logger already surfaced details.
      }
    }),
  );
}
