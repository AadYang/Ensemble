// openai-compat used to surface ToolCards. The stream path then stopped
// forwarding tool_called / approval events, so a switch onto this runtime
// looked like "the agent only prints text". This file pins the translation
// the UI actually consumes: a Claude-shaped assistant tool_use block.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "openai-tool-cards-"));
process.env.AGENTORCH_DATA_DIR = TMP;
process.env.AGENTORCH_DB_PATH = join(TMP, "tool-cards.db");

const mock = vi.hoisted(() => {
  const state = {
    events: [] as unknown[],
    interruptions: [] as unknown[],
    liveness: [] as string[],
    runs: 0,
  };

  class FakeAgent {
    constructor(_config: Record<string, unknown>) {}
  }

  class FakeRunner {
    constructor(_options: unknown) {}
    async run() {
      state.runs += 1;
      const first = state.runs === 1;
      const events = first
        ? state.events
        : [{ type: "run_item_stream_event", name: "message_output_created", item: {} }];
      return {
        interruptions: first ? state.interruptions : [],
        state: { approve() {}, reject() {} },
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      };
    }
  }

  return { state, FakeAgent, FakeRunner };
});

vi.mock("@openai/agents", () => ({
  Agent: mock.FakeAgent,
  Runner: mock.FakeRunner,
  OpenAIProvider: class {},
  tool: (config: unknown) => config,
  user: (content: unknown) => ({ role: "user", content }),
  assistant: (content: unknown) => ({ role: "assistant", content }),
}));

import { OpenAIAgentRuntime } from "../openai.js";
import { resolveRunPlan } from "../../../capability/run-plan.js";
import type { RuntimeEvent, RuntimeOptions } from "../types.js";

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function optsFor(model = "deepseek-flash"): RuntimeOptions {
  const provider = {
    id: "prov-1",
    name: "DeepSeek",
    kind: "openai-compat",
    baseUrl: "https://api.example.test/v1",
    apiKey: "sk-test",
  };
  return {
    sessionId: "s1",
    prompt: "list the files",
    model,
    tools: ["Bash"],
    allowedTools: ["Bash"],
    permissionMode: "bypassPermissions",
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    abortController: new AbortController(),
    mcpServers: {},
    env: {},
    provider,
    liveness: {
      childProcessStarted() {},
      childProcessExited() {},
      streamClosed() {},
      resultSeen: () => mock.state.liveness.push("resultSeen"),
      toolProgress: () => mock.state.liveness.push("toolProgress"),
    },
    runPlan: resolveRunPlan({
      model,
      runtime: "openai",
      providerId: "prov-1",
      projectRoot: {
        configured: { path: TMP, invalid: null },
        scratchPath: TMP,
      },
      transportFacts: {
        value: "chat-completions",
        origin: "provider-discovered",
        confidence: "observed",
        source: "the endpoint answered on /chat/completions",
        considered: [],
      },
      preferences: { transport: "auto" },
    }),
    history: [],
  } as unknown as RuntimeOptions;
}

async function drain(opts: RuntimeOptions): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const event of new OpenAIAgentRuntime().query(opts)) out.push(event);
  return out;
}

const sdkPayloads = (events: RuntimeEvent[]) =>
  events.filter((e) => e.type === "sdk_message").map((e) => e.payload as { type: string; message?: { content?: unknown[] } });

describe("openai-compat tool cards", () => {
  it("translates tool_called into a Claude-shaped assistant tool_use", async () => {
    mock.state.interruptions = [];
    mock.state.liveness = [];
    mock.state.runs = 0;
    mock.state.events = [
      {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          rawItem: {
            type: "function_call",
            callId: "call_ls",
            name: "Bash",
            arguments: JSON.stringify({ command: "ls" }),
          },
        },
      },
      {
        type: "run_item_stream_event",
        name: "tool_output",
        item: { rawItem: { type: "function_call_result", callId: "call_ls", name: "Bash" } },
      },
      {
        type: "raw_model_stream_event",
        data: { type: "output_text_delta", delta: "here they are" },
      },
      {
        type: "run_item_stream_event",
        name: "message_output_created",
        item: { rawItem: { content: [{ type: "output_text", text: "here they are" }] } },
      },
      {
        type: "raw_model_stream_event",
        data: {
          type: "response_done",
          response: { model: "deepseek-flash", usage: { inputTokens: 80, outputTokens: 12 } },
        },
      },
    ];

    const payloads = sdkPayloads(await drain(optsFor()));
    const tool = payloads.find(
      (p) => p.type === "assistant" && (p.message?.content ?? []).some((b) => (b as { type?: string }).type === "tool_use"),
    );
    expect(tool?.message?.content).toEqual([
      { type: "tool_use", id: "call_ls", name: "Bash", input: { command: "ls" } },
    ]);
    expect(payloads.some((p) => p.type === "assistant" && (p.message?.content ?? []).some((b) => (b as { type?: string }).type === "text"))).toBe(true);
    expect(mock.state.liveness).toContain("toolProgress");
  });

  it("does not emit the same call twice when approval also carries it", async () => {
    const item = {
      rawItem: {
        type: "function_call",
        callId: "call_dup",
        name: "Read",
        arguments: JSON.stringify({ file_path: "a.ts" }),
        id: "call_dup",
      },
      toolName: "Read",
    };
    mock.state.interruptions = [item];
    mock.state.liveness = [];
    mock.state.runs = 0;
    mock.state.events = [
      { type: "run_item_stream_event", name: "tool_approval_requested", item },
    ];

    const payloads = sdkPayloads(await drain(optsFor()));
    const tools = payloads.filter(
      (p) => p.type === "assistant" && (p.message?.content ?? []).some((b) => (b as { type?: string }).type === "tool_use"),
    );
    expect(tools).toHaveLength(1);
  });

  it("publishes the confirmed advertised window instead of 0 for deepseek-flash", async () => {
    mock.state.interruptions = [];
    mock.state.liveness = [];
    mock.state.runs = 0;
    mock.state.events = [
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "ok" } },
      { type: "run_item_stream_event", name: "message_output_created", item: {} },
      {
        type: "raw_model_stream_event",
        data: {
          type: "response_done",
          response: { model: "deepseek-flash", usage: { inputTokens: 40, outputTokens: 4 } },
        },
      },
    ];

    const payloads = sdkPayloads(await drain(optsFor("deepseek-flash")));
    const result = payloads.find((p) => p.type === "result") as
      | { type: "result"; modelUsage?: Record<string, { contextWindow?: number }> }
      | undefined;
    expect(result?.modelUsage?.["deepseek-flash"]?.contextWindow).toBe(1_000_000);
    expect(mock.state.liveness).toContain("resultSeen");
  });

  it("forwards reasoning tokens as thinking_delta and keeps them on the assistant message", async () => {
    mock.state.interruptions = [];
    mock.state.liveness = [];
    mock.state.runs = 0;
    mock.state.events = [
      { type: "raw_model_stream_event", data: { type: "response.reasoning.delta", delta: "let me " } },
      { type: "raw_model_stream_event", data: { type: "reasoning_content", delta: { reasoning_content: "think." } } },
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "done" } },
      {
        type: "run_item_stream_event",
        name: "message_output_created",
        item: { rawItem: { content: [{ type: "output_text", text: "done" }] } },
      },
      {
        type: "raw_model_stream_event",
        data: { type: "response_done", response: { model: "deepseek-flash", usage: { inputTokens: 8, outputTokens: 4 } } },
      },
    ];

    const payloads = sdkPayloads(await drain(optsFor())) as Array<{
      type: string;
      event?: { delta?: { type?: string; thinking?: string } };
      message?: { content?: Array<{ type?: string; thinking?: string; text?: string }> };
    }>;
    const thinkingDeltas = payloads.filter((p) => p.event?.delta?.type === "thinking_delta");
    expect(thinkingDeltas.map((p) => p.event?.delta?.thinking)).toEqual(["let me ", "think."]);
    const assistant = payloads.find((p) => p.message?.content?.some((b) => b.type === "thinking"));
    expect(assistant?.message?.content).toEqual([
      { type: "thinking", thinking: "let me think." },
      { type: "text", text: "done" },
    ]);
  });

  it("reads DeepSeek Chat Completions reasoning_content off the raw model chunk", async () => {
    mock.state.interruptions = [];
    mock.state.liveness = [];
    mock.state.runs = 0;
    mock.state.events = [
      {
        type: "raw_model_stream_event",
        data: {
          type: "model",
          event: {
            choices: [{ index: 0, delta: { reasoning_content: "先看仓库状态" } }],
          },
        },
      },
      {
        type: "raw_model_stream_event",
        data: {
          type: "model",
          event: {
            choices: [{ index: 0, delta: { reasoning_content: "，再派工。" } }],
          },
        },
      },
      {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          rawItem: {
            type: "function_call",
            callId: "call_peer",
            name: "peer_send",
            arguments: JSON.stringify({ to: "engineer", text: "go" }),
          },
        },
      },
    ];

    const payloads = sdkPayloads(await drain(optsFor())) as Array<{
      type: string;
      event?: { delta?: { type?: string; thinking?: string } };
      message?: { content?: Array<{ type?: string; thinking?: string; name?: string }> };
    }>;
    const thinkingDeltas = payloads.filter((p) => p.event?.delta?.type === "thinking_delta");
    expect(thinkingDeltas.map((p) => p.event?.delta?.thinking)).toEqual(["先看仓库状态", "，再派工。"]);
    const thinking = payloads.find((p) => p.message?.content?.some((b) => b.type === "thinking"));
    expect(thinking?.message?.content).toEqual([
      { type: "thinking", thinking: "先看仓库状态，再派工。" },
    ]);
  });
});
