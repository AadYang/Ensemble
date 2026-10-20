import { describe, expect, it } from "vitest";
import { postofficeCredsFromMcp, stayOnLinePrompt, userAskedHangup } from "../postoffice-line.js";

describe("postoffice-line", () => {
  it("reads bind + base url from an http MCP row", () => {
    const creds = postofficeCredsFromMcp({
      "ensemble-postoffice": {
        type: "http",
        url: "https://www.ensemble-ai.cn/postoffice/mcp",
        headers: { Authorization: "Bearer po_abc" },
      },
    });
    expect(creds).toEqual({
      baseUrl: "https://www.ensemble-ai.cn/postoffice",
      bind: "po_abc",
    });
  });

  it("ignores unrelated MCP servers", () => {
    expect(
      postofficeCredsFromMcp({
        docs: { type: "stdio", command: "npx" },
      }),
    ).toBeNull();
  });

  it("builds an inject prompt only when there is unread", () => {
    expect(stayOnLinePrompt({ commCode: "A", name: "a", call: null, unread: [] })).toBeNull();
    const prompt = stayOnLinePrompt({
      commCode: "A",
      name: "a",
      call: { status: "connected" },
      unread: [{ id: "1", from: "B", fromName: "phone", body: "next task" }],
    });
    expect(prompt).toContain("next task");
    expect(prompt).toContain("Call send now");
  });

  it("detects hangup phrases", () => {
    expect(userAskedHangup("挂断吧")).toBe(true);
    expect(userAskedHangup("keep going")).toBe(false);
  });
});
