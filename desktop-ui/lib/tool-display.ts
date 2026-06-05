// W16 Slice 5.5: tool-name normalization.
//
// Claude side registers session-aware tools via SDK MCP (peer-mcp,
// ask-user-mcp), which means the SDK surfaces their canonical names as
// `mcp__<server>__<tool>` (e.g. `mcp__agentorch-peer__peer_send`).
// OpenAI side per docs/plans/cross-runtime-peer-send.md §6.1 uses the
// short forms (`peer_send`, `ask_user`, `Task`). To keep ToolCard and the
// permission dialog runtime-agnostic, normalize on display.

const MCP_PREFIX_RE = /^mcp__[^_]+(?:__[^_]+)*__/;

/** Strip the SDK's `mcp__<server>__` prefix from tool names so Claude side's
 *  `mcp__agentorch-peer__peer_send` and OpenAI side's `peer_send` render
 *  identically in the UI. */
export function displayToolName(raw: string | undefined | null): string {
  if (!raw) return "tool";
  return raw.replace(MCP_PREFIX_RE, "");
}
