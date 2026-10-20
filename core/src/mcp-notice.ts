/**
 * Turn a Claude Code stderr line about an MCP server into a human-readable
 * failure, or null when the line is not one.
 *
 * The CLI emits a pair for a failed connection:
 *
 *   [ERROR] MCP server "x" SdkHttpError: Error POSTing to endpoint:
 *           {"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"该信箱已被另一路 MCP 占用…"}}
 *   [ERROR] MCP server "x" Server rejected the configured Authorization header (HTTP 401)…
 *
 * The second line is the CLI's own guess after a failed handshake; the JSON-RPC
 * `message` in the first is what the server actually said. Callers keep the
 * first reason per server.
 */
export function parseMcpFailureLine(line: string): { name: string; reason: string } | null {
  const named = /MCP server "([^"]+)"/.exec(line);
  const name = named?.[1];
  if (!name) return null;
  if (!/(failed|Error|error|rejected)/.test(line)) return null;
  const reason = /"message":"([^"]+)"/.exec(line)?.[1] ?? line.trim().slice(0, 240);
  return { name, reason };
}
