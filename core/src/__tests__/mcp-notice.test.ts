import { describe, expect, it } from "vitest";
import { parseMcpFailureLine } from "../mcp-notice.js";

describe("parseMcpFailureLine", () => {
  it("extracts the server's own JSON-RPC reason, not the CLI's follow-up guess", () => {
    const line =
      '[ERROR] MCP server "ensemble-postoffice" SdkHttpError: Error POSTing to endpoint: ' +
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"该信箱已被另一路 MCP 占用，请等待对方掉线或重置绑定码"}}';
    expect(parseMcpFailureLine(line)).toEqual({
      name: "ensemble-postoffice",
      reason: "该信箱已被另一路 MCP 占用，请等待对方掉线或重置绑定码",
    });
  });

  it("does not turn the Authorization follow-up into a second, wrong reason", () => {
    const line =
      '[ERROR] MCP server "ensemble-postoffice" Server rejected the configured Authorization header (HTTP 401).';
    const parsed = parseMcpFailureLine(line);
    expect(parsed?.name).toBe("ensemble-postoffice");
    // No JSON-RPC message: the raw line is the honest fallback.
    expect(parsed?.reason).toContain("rejected the configured Authorization header");
  });

  it("ignores ordinary lines and successful connections", () => {
    expect(parseMcpFailureLine("[claude-cli] booting")).toBeNull();
    expect(parseMcpFailureLine('[DEBUG] MCP server "x": Successfully connected (transport: http) in 518ms')).toBeNull();
  });
});
