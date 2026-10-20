// W16 Slice 5.5: tool-name normalization.
//
// Claude side registers session-aware tools via SDK MCP (peer-mcp,
// ask-user-mcp), which means the SDK surfaces their canonical names as
// `mcp__<server>__<tool>` (e.g. `mcp__agentorch-peer__peer_send`).
// OpenAI side per docs/plans/cross-runtime-peer-send.md §6.1 uses the
// short forms (`peer_send`, `ask_user`, `Task`). To keep ToolCard and the
// permission dialog runtime-agnostic, normalize on display.

/** Strip the SDK's `mcp__<server>__` prefix so `mcp__agentorch-peer__peer_send`
 *  and `mcp__ensemble-postoffice__inbox_wait` render as the short tool name.
 *  Split on `__` — a character-class regex cannot keep underscores in the tool. */
export function displayToolName(raw: string | undefined | null): string {
  if (!raw) return "tool";
  if (raw.startsWith("mcp__")) {
    const parts = raw.split("__");
    if (parts.length >= 3) return parts.slice(2).join("__");
  }
  return raw;
}
