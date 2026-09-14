import { describe, expect, it } from "vitest";
import { compatProviderNeedsResponses } from "../openai.js";

// DeepSeek's thinking mode + tool calls is unsatisfiable over chat-completions
// with @openai/agents (it never echoes `reasoning_content`), so the runtime must
// route those hosts through /responses. Everyone else stays on chat-completions.
describe("compatProviderNeedsResponses", () => {
  it("routes DeepSeek through the Responses API", () => {
    expect(compatProviderNeedsResponses("https://api.deepseek.com")).toBe(true);
  });

  it("matches the host case-insensitively and regardless of trailing path", () => {
    expect(compatProviderNeedsResponses("https://API.DeepSeek.com/")).toBe(true);
    expect(compatProviderNeedsResponses("https://api.deepseek.com/v1")).toBe(true);
  });

  it("does not match look-alike hosts", () => {
    expect(compatProviderNeedsResponses("https://api.deepseek.com.evil.test")).toBe(false);
    expect(compatProviderNeedsResponses("https://deepseek.com")).toBe(false);
  });

  it("keeps other compat upstreams on chat-completions", () => {
    expect(compatProviderNeedsResponses("https://api.openai.com/v1")).toBe(false);
    expect(compatProviderNeedsResponses("https://open.bigmodel.cn/api/paas/v4")).toBe(false);
  });

  it("defaults to chat-completions when the base url is missing or unparseable", () => {
    expect(compatProviderNeedsResponses(null)).toBe(false);
    expect(compatProviderNeedsResponses(undefined)).toBe(false);
    expect(compatProviderNeedsResponses("")).toBe(false);
    expect(compatProviderNeedsResponses("not a url")).toBe(false);
  });
});
