import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { resolveRunPlan } from "../../../capability/run-plan.js";

/** A real directory for the plan's project root: the resolver's `bound` branch
 *  echoes whatever path it is given, and the runtime passes it to the SDK's
 *  `cwd` — which the SDK itself requires to exist. */
const PROJECT_ROOT = process.cwd();

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
  model: "claude-opus-4-8",
  permissionMode: "default",
  tools: [],
  allowedTools: [],
  canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
  abortController: new AbortController(),
  mcpServers: {},
  env: {},
  provider: stubProvider,
  // The plan is required for every runtime now, and it is the ONE source of the
  // working directory — there is no `cwd` option any more. The real resolver
  // produces the answer the runtime reads.
  runPlan: resolveRunPlan({
    model: "claude-opus-4-8",
    runtime: "claude",
    providerId: stubProvider.id,
    projectRoot: {
      configured: { path: PROJECT_ROOT, invalid: null },
      scratchPath: PROJECT_ROOT,
    },
  }),
  history: [],
});

/** A plan carrying a reasoning request, resolved by the real resolver — the
 *  runtime reads `runPlan.execution.reasoningEffort`, so a fixture that set the
 *  value anywhere else would be testing a channel that no longer exists. */
const planWithReasoning = (reasoningEffort: string, model = "claude-opus-4-8") =>
  resolveRunPlan({
    model,
    runtime: "claude",
    providerId: stubProvider.id,
    // The root is no longer deferred: a plan that cannot name a directory is a
    // plan whose turn is refused, so a fixture that omitted it would be testing
    // the refusal path instead of the reasoning path it means to test.
    projectRoot: {
      configured: { path: PROJECT_ROOT, invalid: null },
      scratchPath: PROJECT_ROOT,
    },
    preferences: { reasoningEffort },
  });

let previousClaudeConfigDir: string | undefined;
let tmpClaudeConfigDir: string | null = null;

function writeClaudeSettings(settings: unknown): void {
  if (!tmpClaudeConfigDir) throw new Error("test CLAUDE_CONFIG_DIR not initialized");
  writeFileSync(join(tmpClaudeConfigDir, "settings.json"), JSON.stringify(settings), "utf8");
}

function lastQueryOptions(): Record<string, unknown> {
  const call = vi.mocked(query).mock.calls.at(-1);
  expect(call).toBeDefined();
  const options = call![0]!.options;
  expect(options).toBeDefined();
  return options as Record<string, unknown>;
}

beforeEach(() => {
  queuedMessages.length = 0;
  vi.mocked(query).mockClear();
  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  tmpClaudeConfigDir = mkdtempSync(join(tmpdir(), "ensemble-claude-settings-"));
  process.env.CLAUDE_CONFIG_DIR = tmpClaudeConfigDir;
});

afterEach(() => {
  if (previousClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  }
  if (tmpClaudeConfigDir) {
    rmSync(tmpClaudeConfigDir, { recursive: true, force: true });
    tmpClaudeConfigDir = null;
  }
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

  it("spawns in the plan's project root, not the process's own directory", async () => {
    // A root that is deliberately NOT `process.cwd()`: if the runtime still
    // reached for a process-wide default, this is the assertion that fails.
    const root = mkdtempSync(join(tmpdir(), "ensemble-claude-root-"));
    try {
      queuedMessages.push([]);
      const rt = new ClaudeAgentRuntime();
      for await (const _ of rt.query({
        ...baseOpts(),
        runPlan: resolveRunPlan({
          model: "claude-opus-4-8",
          runtime: "claude",
          providerId: stubProvider.id,
          projectRoot: { configured: { path: root, invalid: null }, scratchPath: root },
        }),
      })) {
        // consume stream
      }

      const options = vi.mocked(query).mock.calls.at(-1)![0]!.options!;
      expect(options.cwd).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses the turn when the plan carries no usable root", async () => {
    // The plan's `value` is null exactly when the configured root was found
    // unusable (or no scratch could be resolved). The runtime must not invent a
    // directory for it: the SDK call is never made.
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    const events: unknown[] = [];
    for await (const ev of rt.query({
      ...baseOpts(),
      runPlan: resolveRunPlan({
        model: "claude-opus-4-8",
        runtime: "claude",
        providerId: stubProvider.id,
        projectRoot: { configured: { path: PROJECT_ROOT, invalid: { code: "PROJECT_ROOT_NOT_FOUND", reason: "gone" } }, scratchPath: PROJECT_ROOT },
      }),
    })) {
      events.push(ev);
    }
    expect(vi.mocked(query)).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ type: "error", code: "PROJECT_ROOT_NOT_FOUND" }),
    ]);
  });

  it("passes explicit thinking mode as Claude Code max thinking tokens", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({
      ...baseOpts(),
      runPlan: planWithReasoning("high"),
    })) {
      // consume stream
    }

    const call = vi.mocked(query).mock.calls.at(-1);
    expect(call).toBeDefined();
    const queryArgs = call![0]!;
    const options = queryArgs.options!;
    expect(options.maxThinkingTokens).toBe(16384);
  });

  // The level reaches the adapter from the plan (that is the only channel now),
  // and a level this adapter cannot turn into a budget is REFUSED before the
  // request — the alternative is sending the turn while silently ignoring what
  // the user asked for, which is the exact failure the contract forbids.
  it("refuses an unexpressible level before calling the SDK instead of dropping it", async () => {
    const rt = new ClaudeAgentRuntime();
    const events: unknown[] = [];
    for await (const ev of rt.query({
      ...baseOpts(),
      runPlan: planWithReasoning("ultra"),
    })) {
      events.push(ev);
    }

    expect(vi.mocked(query)).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    const err = events[0] as {
      type: string;
      code?: string;
      reasoning?: { requested: string; model: string; supportedLevels: string[]; source: string };
    };
    expect(err.type).toBe("error");
    expect(err.code).toBe("REASONING_EFFORT_UNSUPPORTED");
    expect(err.reasoning?.requested).toBe("ultra");
    expect(err.reasoning?.model).toBe("claude-opus-4-8");
    // What it CAN express, as data — not only as prose in the message.
    expect(err.reasoning?.supportedLevels).toContain("high");
    expect(err.reasoning?.supportedLevels).not.toContain("ultra");
    expect(err.reasoning?.source).toContain("thinking-token budget");
  });

  it("omits max thinking tokens when thinking mode inherits runtime defaults", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    // A plan that resolved `inherit` (the default `baseOpts()` already is one):
    // `execution.reasoningEffort` is undefined, so no parameter is sent and the
    // upstream default applies. An omitted key, not a zero or a "default" one.
    expect(baseOpts().runPlan.execution.reasoningEffort).toBeUndefined();
    for await (const _ of rt.query(baseOpts())) {
      // consume stream
    }

    const call = vi.mocked(query).mock.calls.at(-1);
    expect(call).toBeDefined();
    const queryArgs = call![0]!;
    const options = queryArgs.options!;
    expect(options).not.toHaveProperty("maxThinkingTokens");
  });

  it("passes the dangerous skip flag only for bypassPermissions", async () => {
    const rt = new ClaudeAgentRuntime();

    for (const permissionMode of ["default", "plan", "acceptEdits", "dontAsk"] as const) {
      queuedMessages.push([]);
      for await (const _ of rt.query({ ...baseOpts(), permissionMode })) {
        // consume stream
      }
      expect(lastQueryOptions()).not.toHaveProperty("allowDangerouslySkipPermissions");
    }

    queuedMessages.push([]);
    for await (const _ of rt.query({ ...baseOpts(), permissionMode: "bypassPermissions" })) {
      // consume stream
    }
    expect(lastQueryOptions().allowDangerouslySkipPermissions).toBe(true);
  });

  it("restores Claude local auth env from user settings without loading SDK settings", async () => {
    writeClaudeSettings({
      env: {
        ANTHROPIC_AUTH_TOKEN: "settings-token",
        ANTHROPIC_BASE_URL: "https://claude.example.test",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "polluting-model",
        CLAUDE_CODE_USE_VERTEX: "1",
        EMPTY: "",
      },
      hooks: { Stop: [{ command: "should-not-load" }] },
      mcpServers: { userServer: { command: "should-not-load" } },
      memory: "should-not-load",
    });

    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({ ...baseOpts(), systemPrompt: "Ensemble prompt" })) {
      // consume stream
    }

    const options = lastQueryOptions();
    expect(options.settingSources).toEqual([]);
    expect(options.systemPrompt).toBe("Ensemble prompt");
    expect(options.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "settings-token",
      ANTHROPIC_BASE_URL: "https://claude.example.test",
    });
    expect(options.env).not.toHaveProperty("ANTHROPIC_DEFAULT_OPUS_MODEL");
    expect(options.env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
    expect(options).not.toHaveProperty("hooks");
    expect(options.mcpServers).toEqual({});
  });

  it("declares the documented context CAPACITY for a third-party model", async () => {
    // Claude Code assumes ≈200k for models it doesn't recognize and
    // auto-compacts at ~85% of that; on this provider's 1M window that threw
    // away ~1.1M tokens of context across six measured compactions.
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({ ...baseOpts(), model: "deepseek-flash" })) {
      // consume stream
    }

    expect(lastQueryOptions().env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
    });
  });

  // MAX_CONTEXT is a CAPACITY declaration; AUTO_COMPACT is a POLICY trigger and
  // must leave headroom for the response. We have never measured Claude Code's
  // compaction behaviour for these models, so we do not get to invent one.
  it("does NOT pin the compaction policy to the model maximum", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({ ...baseOpts(), model: "deepseek-flash" })) {
      // consume stream
    }

    const env = (lastQueryOptions().env ?? {}) as Record<string, string>;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  it("declares a smaller documented window too (glm-4.5 documents 128k)", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({ ...baseOpts(), model: "glm-4.5" })) {
      // consume stream
    }

    expect(lastQueryOptions().env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "128000",
    });
  });

  // A value we never verified is a guess about the model, so it must never
  // reach config. `deepseek-chat` is carried at its last documented V3-era
  // window with `unverified` confidence.
  it("does not declare a window we have not confirmed", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({ ...baseOpts(), model: "deepseek-chat" })) {
      // consume stream
    }

    const env = (lastQueryOptions().env ?? {}) as Record<string, string>;
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  // Every gpt-5.6 variant now has its own vendor page, so the gate opens for
  // them — and it opens with the DOCUMENTED value, which differs for cyber.
  it("declares each individually verified model at its own documented value", async () => {
    for (const [model, expected] of [
      ["gpt-5.6-terra", "1050000"],
      ["gpt-5.6-cyber", "400000"],
    ] as const) {
      queuedMessages.push([]);
      const rt = new ClaudeAgentRuntime();
      for await (const _ of rt.query({ ...baseOpts(), model })) {
        // consume stream
      }
      expect((lastQueryOptions().env ?? {}) as Record<string, string>, model)
        .toMatchObject({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: expected });
    }
  });

  it("leaves the SDK's own window alone for models we have no verified value for", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({ ...baseOpts(), model: "claude-opus-4-8" })) {
      // consume stream
    }

    const env = (lastQueryOptions().env ?? {}) as Record<string, string>;
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  it("never overrides a window the caller set explicitly", async () => {
    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({
      ...baseOpts(),
      model: "deepseek-flash",
      env: {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "750000",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "250000",
      },
    })) {
      // consume stream
    }

    expect(lastQueryOptions().env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "750000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "250000",
    });
  });

  it("keeps explicit runtime env ahead of Claude settings auth env", async () => {
    writeClaudeSettings({
      env: {
        ANTHROPIC_AUTH_TOKEN: "settings-token",
        ANTHROPIC_BASE_URL: "https://claude.example.test",
      },
    });

    queuedMessages.push([]);
    const rt = new ClaudeAgentRuntime();
    for await (const _ of rt.query({
      ...baseOpts(),
      env: {
        ANTHROPIC_AUTH_TOKEN: "explicit-token",
        EXISTING_FLAG: "kept",
      },
    })) {
      // consume stream
    }

    const options = lastQueryOptions();
    expect(options.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "explicit-token",
      ANTHROPIC_BASE_URL: "https://claude.example.test",
      EXISTING_FLAG: "kept",
    });
  });
});
