// The stage-1 gate contract for long tool loops: a task that needs MORE than
// the SDK's default cap must not die at ten model turns.
//
// `@openai/agents` substitutes DEFAULT_MAX_TURNS = 10 whenever `maxTurns` is
// left undefined (`turnPreparation` only throws when `state._maxTurns !== null`),
// so the runtime has to pass the SDK's own "no cap" sentinel — `null` — on every
// `runner.run`. `buildRunnerRunOptions` is the single place that decides it, and
// `openai-responses-transport.test.ts` already pins the value it returns.
//
// This file pins the CONSEQUENCE: the options the runtime actually hands the SDK
// complete a 16-turn loop. The SDK's cap rule is reproduced in a fake Runner
// (with a control case below proving the reproduction really does stop at 10),
// so the test exercises the real runtime path — plan → runTurnOnce → runner.run —
// without a network. The runtime's own MAX_INTERRUPT_ROUNDS = 32 approval-round
// protection is untouched by this and still bounded.
//
// The second block reuses the same fake to pin the OTHER thing this runtime
// hands the SDK: the plan's reasoning level, forwarded verbatim and omitted
// entirely on inherit — no provider-kind whitelist in between.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// `resolveRunPlan` reads the data dir for its overrides at import time.
const TMP = mkdtempSync(join(tmpdir(), "openai-tool-turn-cap-"));
process.env.AGENTORCH_DATA_DIR = TMP;
process.env.AGENTORCH_DB_PATH = join(TMP, "tool-turn-cap.db");

const mock = vi.hoisted(() => {
  /** The SDK's documented default when `maxTurns` is undefined. */
  const DEFAULT_MAX_TURNS = 10;
  /** The task length this contract uses: more than the default, so a run that
   *  completes can only have done so under an explicit "no cap". */
  const TOOL_TURNS = 16;

  const state = {
    /** Every run-options object the runtime handed the SDK, in order. */
    runOptionsSeen: [] as { maxTurns?: number | null }[],
    /** Model turns the last run consumed — the value the cap acts on. */
    turnsRun: 0,
    /** Every Agent config the runtime built, so the reasoning setting the SDK
     *  actually receives can be asserted — including that it is absent. */
    agentConfigs: [] as Record<string, unknown>[],
  };

  class FakeAgent {
    constructor(config: Record<string, unknown>) {
      state.agentConfigs.push(config);
    }
  }

  class FakeRunner {
    constructor(_options: unknown) {}
    // eslint-disable-next-line require-yield
    async run(_agent: unknown, _input: unknown, runOptions: { maxTurns?: number | null }) {
      state.runOptionsSeen.push(runOptions ?? {});
      const cap = runOptions?.maxTurns === undefined ? DEFAULT_MAX_TURNS : runOptions.maxTurns;
      let turns = 0;
      // The SDK's loop in miniature: each iteration is one model turn, and the
      // cap is checked before the turn that would exceed it.
      while (true) {
        turns += 1;
        if (cap !== null && turns > cap) {
          throw new Error(`Max turns (${cap}) exceeded.`);
        }
        if (turns >= TOOL_TURNS) break;
      }
      state.turnsRun = turns;
      const events = [
        {
          type: "raw_model_stream_event",
          data: { type: "output_text_delta", delta: `completed ${turns} turns` },
        },
        { type: "run_item_stream_event", name: "message_output_created", item: {} },
      ];
      return {
        interruptions: [],
        state: {},
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      };
    }
  }

  return { DEFAULT_MAX_TURNS, TOOL_TURNS, state, FakeAgent, FakeRunner };
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

function optsFor(
  over: { kind?: string; reasoningEffort?: string; model?: string } = {},
): RuntimeOptions {
  const model = over.model ?? "gpt-5.6-sol";
  const provider = {
    id: "prov-1",
    name: "Test Provider",
    kind: over.kind ?? "openai-compat",
    baseUrl: "https://api.example.test/v1",
    apiKey: "sk-test",
  };
  return {
    sessionId: "s1",
    prompt: "walk the repository and summarise it",
    model,
    tools: [],
    allowedTools: [],
    permissionMode: "default",
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    abortController: new AbortController(),
    mcpServers: {},
    env: {},
    provider,
    runPlan: resolveRunPlan({
      model,
      runtime: "openai",
      providerId: "prov-1",
      // There is no `cwd` option any more: the plan's project root is the only
      // channel, and an unresolvable one refuses the turn before the SDK runs.
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
      preferences: { transport: "auto", ...(over.reasoningEffort ? { reasoningEffort: over.reasoningEffort } : {}) },
    }),
    history: [],
  } as unknown as RuntimeOptions;
}

describe("openai long tool loops", () => {
  it("runs a 16-turn task instead of stopping at the SDK's 10-turn default", async () => {
    mock.state.runOptionsSeen.length = 0;
    mock.state.turnsRun = 0;

    const events: RuntimeEvent[] = [];
    for await (const event of new OpenAIAgentRuntime().query(optsFor())) events.push(event);

    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(mock.state.turnsRun).toBe(mock.TOOL_TURNS);
    // The value that makes it possible, as handed to the SDK — not just as
    // returned by a helper.
    expect(mock.state.runOptionsSeen).toHaveLength(1);
    expect(mock.state.runOptionsSeen[0]!.maxTurns).toBeNull();
    // The turn still ends the way the UI expects: assistant text + a result.
    const types = events.filter((e) => e.type === "sdk_message").map((e) => (e as { payload: { type: string } }).payload.type);
    expect(types).toContain("assistant");
    expect(types).toContain("result");
  });

  // Without this the test above could pass for the wrong reason: if the fake did
  // not actually apply the SDK's rule, "16 turns completed" would prove nothing
  // about the option the runtime passes.
  it("the reproduced SDK rule does stop at 10 turns when maxTurns is left undefined", async () => {
    await expect(new mock.FakeRunner({}).run(null, null, {})).rejects.toThrow(
      `Max turns (${mock.DEFAULT_MAX_TURNS}) exceeded.`,
    );
  });
});

// ── reasoning: forwarded from the plan, omitted on inherit ─────────────────
//
// The runtime is not the authority on which levels exist (the plan is), so it
// forwards whatever the plan resolved — including a level the SDK's own
// `ModelSettingsReasoningEffort` union does not list (`ultra`). `inherit` is
// the absence of the setting, not an empty or lowest value.
describe("openai reasoning passthrough", () => {
  const effortOf = (config: Record<string, unknown> | undefined) =>
    (config?.modelSettings as { reasoning?: { effort?: string } } | undefined)?.reasoning?.effort;

  const drain = async (opts: RuntimeOptions): Promise<RuntimeEvent[]> => {
    const out: RuntimeEvent[] = [];
    for await (const event of new OpenAIAgentRuntime().query(opts)) out.push(event);
    return out;
  };

  it("sends the plan's level to the SDK, including one its own union lacks", async () => {
    mock.state.agentConfigs.length = 0;
    const events = await drain(optsFor({ reasoningEffort: "ultra" }));

    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(mock.state.agentConfigs).toHaveLength(1);
    expect(effortOf(mock.state.agentConfigs[0])).toBe("ultra");
  });

  it("omits the setting entirely when the level is inherited", async () => {
    mock.state.agentConfigs.length = 0;
    await drain(optsFor());

    expect(mock.state.agentConfigs).toHaveLength(1);
    expect("modelSettings" in (mock.state.agentConfigs[0] ?? {})).toBe(false);
  });

  it("carries the setting for an openai-local provider too", async () => {
    mock.state.agentConfigs.length = 0;
    const events = await drain(optsFor({ kind: "openai-local", reasoningEffort: "high" }));

    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(effortOf(mock.state.agentConfigs[0])).toBe("high");
  });
});
