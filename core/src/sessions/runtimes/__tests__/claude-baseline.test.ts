import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Claude SDK BEFORE importing ClaudeAgentRuntime so the runtime
// picks up the mocked `query`. The test fixtures (queueMockMessages) drive
// what the mock yields per call.
const queuedMessages: unknown[][] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    const msgs = queuedMessages.shift() ?? [];
    return (async function* () {
      for (const m of msgs) yield m;
    })();
  }),
}));

import { ClaudeAgentRuntime } from "../claude.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Provider } from "../../../db.js";
import type { RuntimeOptions } from "../types.js";

const stubProvider: Provider = {
  id: "p1",
  name: "anthropic-default",
  kind: "anthropic-local",
  baseUrl: null,
  apiKey: null,
  autoManaged: false,
  upstreamProvider: null,
  upstreamModel: null,
  models: [],
  isDefault: true,
  disabled: false,
  metadata: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const baseOpts = (): RuntimeOptions => ({
  sessionId: "test-session",
  prompt: "hello",
  model: "claude-opus-4-7",
  permissionMode: "default",
  tools: [],
  allowedTools: [],
  canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
  abortController: new AbortController(),
  mcpServers: {},
  env: {},
  cwd: "/",
  provider: stubProvider,
  history: [],
});

beforeEach(() => {
  queuedMessages.length = 0;
  vi.mocked(query).mockClear();
});

describe("ClaudeAgentRuntime baseline", () => {
  it("re-emits SDK messages as sdk_message events in order", async () => {
    queuedMessages.push([
      { type: "system", subtype: "init", session_id: "abc" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "result", subtype: "success" },
    ]);

    const events: string[] = [];
    const rt = new ClaudeAgentRuntime();
    for await (const ev of rt.query(baseOpts())) {
      if (ev.type === "sdk_message") {
        events.push(ev.payload.type);
      } else {
        events.push(`error:${ev.message}`);
      }
    }

    expect(events).toEqual(["system", "stream_event", "assistant", "result"]);
  });

  it("yields nothing when the SDK stream is empty (e.g. immediate abort)", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    const events: unknown[] = [];
    for await (const ev of rt.query(baseOpts())) events.push(ev);
    expect(events).toEqual([]);
  });

  it("preserves payload identity (no transformation)", async () => {
    const msg = { type: "assistant", message: { content: [{ type: "text", text: "verbatim" }] } };
    queuedMessages.push([msg]);
    const rt = new ClaudeAgentRuntime();
    const out: unknown[] = [];
    for await (const ev of rt.query(baseOpts())) {
      if (ev.type === "sdk_message") out.push(ev.payload);
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(msg); // referential — runtime is pass-through
  });

  it("passes explicit thinking mode as Claude Code max thinking tokens", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({ ...baseOpts(), reasoningEffort: "high" })) {
      // consume stream
    }

    const call = vi.mocked(query).mock.calls.at(-1);
    expect(call).toBeDefined();
    const queryArgs = call![0]!;
    const options = queryArgs.options!;
    expect(options.maxThinkingTokens).toBe(16384);
  });

  it("omits max thinking tokens when thinking mode inherits runtime defaults", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query(baseOpts())) {
      // consume stream
    }

    const call = vi.mocked(query).mock.calls.at(-1);
    expect(call).toBeDefined();
    const queryArgs = call![0]!;
    const options = queryArgs.options!;
    expect(options).not.toHaveProperty("maxThinkingTokens");
  });
});
