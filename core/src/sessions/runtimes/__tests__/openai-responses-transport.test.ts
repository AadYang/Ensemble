import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// `resolveRunPlan` reads the data dir for its overrides at import time.
const TMP = mkdtempSync(join(tmpdir(), "openai-plan-test-"));
process.env.AGENTORCH_DATA_DIR = TMP;
process.env.AGENTORCH_DB_PATH = join(TMP, "plan.db");

import {
  OpenAIAgentRuntime,
  buildInputItems,
  buildRunnerRunOptions,
  makeApprovalLoopTracker,
  planTransportAttempts,
} from "../openai.js";
import { resolveRunPlan } from "../../../capability/run-plan.js";
import type { RuntimeEvent, RuntimeOptions } from "../types.js";
import type { ResolvedCapability, RunPlanTransport } from "@agentorch/shared";

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// The transport is NOT decided here any more. The hostname heuristic that used
// to live in this runtime ("api.deepseek.com therefore Responses") is gone: it
// was a second authority that could disagree with what `/status` showed, and it
// was wrong for any DeepSeek-compatible gateway on another host. The runtime now
// reads `ResolvedRunPlan.identity.transport`, whose fact comes from the provider
// kind, an explicit user preference, or a cached probe of `/responses` — see
// capability/transport.ts and capability/transport-probe.ts.

// A 20-step task must not die on the SDK's default cap. @openai/agents
// substitutes DEFAULT_MAX_TURNS = 10 when `maxTurns` is undefined, so the value
// has to be explicitly `null` — the SDK's own "no cap" sentinel.
describe("buildRunnerRunOptions", () => {
  it("runs the turn without a model-turn cap", () => {
    const opts = buildRunnerRunOptions(new AbortController().signal);
    expect(opts.maxTurns).toBeNull();
  });

  it("still streams and stays cancellable", () => {
    const ac = new AbortController();
    const opts = buildRunnerRunOptions(ac.signal);
    expect(opts.stream).toBe(true);
    expect(opts.signal).toBe(ac.signal);
  });

  // The server-side conversation owner. `previous_response_id` is the ONE way
  // this runtime continues a conversation the server stored; the SDK forwards it
  // as `previous_response_id` and refuses to combine it with `conversation`
  // (openaiResponsesModel builds the request from exactly one of them).
  it("carries the continuation id when there is one, and omits the key when there is not", () => {
    expect(buildRunnerRunOptions(new AbortController().signal, "resp_abc").previousResponseId)
      .toBe("resp_abc");
    // Absent, not empty: an empty or undefined value would be sent as a
    // malformed continuation instead of "rebuild the transcript locally".
    expect("previousResponseId" in buildRunnerRunOptions(new AbortController().signal)).toBe(false);
    expect("previousResponseId" in buildRunnerRunOptions(new AbortController().signal, "")).toBe(false);
  });
});

// ── what actually goes over the wire ──────────────────────────────────────
//
// The rule this pins is the one the whole feature can be lost to: with a
// continuation, the transcript must NOT also travel in the body. The server
// already holds it (reasoning and tool items included, in their native form) and
// recovers it from the response id — sending both is the duplicate-history bug.
describe("buildInputItems", () => {
  const withHistory = (): RuntimeOptions => {
    const base = optsFor();
    return {
      ...base,
      history: [
        { type: "user", message: { role: "user", content: "first" } },
        { type: "assistant", message: { content: [{ type: "text", text: "answer" }] } },
      ],
    } as unknown as RuntimeOptions;
  };

  it("replays the transcript only when there is no continuation", () => {
    const rebuilt = buildInputItems(withHistory());
    expect(JSON.stringify(rebuilt)).toContain("first");
    expect(rebuilt).toHaveLength(3);

    const delta = buildInputItems(withHistory(), { continueFrom: "resp_abc" });
    expect(delta).toHaveLength(1);
    expect(JSON.stringify(delta)).toContain("hello");
    expect(JSON.stringify(delta)).not.toContain("first");
  });

  it("does not replay thinking or tool_result blobs", () => {
    const rebuilt = buildInputItems({
      ...optsFor(),
      history: [
        { type: "user", message: { role: "user", content: "first" } },
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "hidden reasoning" },
              { type: "text", text: "answer" },
            ],
          },
        },
        {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", content: "blob" }] },
        },
      ],
    } as unknown as RuntimeOptions);
    const text = JSON.stringify(rebuilt);
    expect(text).toContain("first");
    expect(text).toContain("answer");
    expect(text).not.toContain("hidden reasoning");
    expect(text).not.toContain("blob");
  });
});

// ── the approval loop, observed instead of counted ────────────────────────
//
// This replaces `MAX_INTERRUPT_ROUNDS = 32`: a round budget could not tell a
// long turn doing new work from the same call coming back forever.
describe("makeApprovalLoopTracker", () => {
  it("trips on the same call with the same arguments, and never on new work", () => {
    const tracker = makeApprovalLoopTracker();
    expect(tracker.record("Bash", { command: "npm test" }).loop).toBe(false);
    expect(tracker.record("Bash", { command: "npm test" }).loop).toBe(false);
    expect(tracker.record("Bash", { command: "npm test" }).loop).toBe(true);
    // A different call (or the same tool with different arguments) is progress,
    // however many rounds the turn takes.
    for (let i = 0; i < 40; i++) {
      expect(tracker.record("Bash", { command: `echo ${i}` }).loop).toBe(false);
      expect(tracker.record("Read", { file_path: "x" }).loop).toBe(false);
    }
  });
});

// ── refusals: the runtime must not re-derive the transport ────────────────
//
// Every case below returns BEFORE any SDK call, so no network is involved. They
// pin the rule that matters: the transport comes from the plan, and a plan that
// does not name an HTTP route makes the runtime stop rather than guess one.

function optsFor(
  over: {
    kind?: string;
    baseUrl?: string | null;
    apiKey?: string | null;
    runPlan?: unknown;
    newSessionId?: () => string;
  } = {},
): RuntimeOptions {
  const provider = {
    id: "prov-1",
    name: "Test Provider",
    kind: over.kind ?? "openai-compat",
    baseUrl: over.baseUrl === undefined ? "https://api.example.test/v1" : over.baseUrl,
    apiKey: over.apiKey === undefined ? "sk-test" : over.apiKey,
  };
  return {
    sessionId: "s1",
    prompt: "hello",
    model: "gpt-5.6-sol",
    tools: [],
    allowedTools: [],
    permissionMode: "default",
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    abortController: new AbortController(),
    mcpServers: {},
    env: {},
    cwd: TMP,
    provider,
    runPlan: over.runPlan,
    newSessionId: over.newSessionId,
    history: [],
  } as unknown as RuntimeOptions;
}

async function events(runtime: OpenAIAgentRuntime, opts: RuntimeOptions): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of runtime.query(opts)) out.push(e);
  return out;
}

const errorOf = (list: RuntimeEvent[]) => {
  const e = list.find((x) => x.type === "error");
  if (!e || e.type !== "error") throw new Error(`expected an error event, got ${list.length}`);
  return e;
};

describe("openai runtime transport refusals", () => {
  it("refuses to run without a resolved plan", async () => {
    const e = errorOf(await events(new OpenAIAgentRuntime(), optsFor()));
    expect(e.message).toContain("without a resolved run plan");
    expect(e.message).toContain("openai-compat");
  });

  it("names the real provider kind, not a guess", async () => {
    expect(errorOf(await events(new OpenAIAgentRuntime(), optsFor({ kind: "openai-local" }))).message)
      .toContain("openai-local");
    expect(errorOf(await events(new OpenAIAgentRuntime(), optsFor({ kind: "openai-compat" }))).message)
      .toContain("openai-compat");
  });

  it("stops when the plan could not establish a transport", async () => {
    const plan = resolveRunPlan({
      model: "gpt-5.6-sol",
      runtime: "openai",
      providerId: "prov-1",
      transportFacts: { value: undefined, origin: "unknown", confidence: "unknown", source: "n", considered: [] },
      preferences: { transport: "auto" },
    });
    const e = errorOf(await events(new OpenAIAgentRuntime(), optsFor({ runPlan: plan })));
    expect(e.message).toContain("unknown");
    expect(e.message).toContain("no transport was established");
  });

  it("refuses a plan that names a transport it cannot drive", async () => {
    // A native-CLI plan handed to the HTTP runtime: mis-routing, not a guess.
    const plan = resolveRunPlan({ model: "gpt-5.6-sol", runtime: "codex", providerId: "prov-1" });
    expect(plan.transport.resolved).toBe("native-cli");
    const e = errorOf(await events(new OpenAIAgentRuntime(), optsFor({ runPlan: plan })));
    expect(e.message).toContain("native-cli");
  });

  it("reports a missing endpoint or key before anything else", async () => {
    expect(errorOf(await events(new OpenAIAgentRuntime(), optsFor({ baseUrl: null }))).message).toContain(
      "missing baseUrl",
    );
    expect(errorOf(await events(new OpenAIAgentRuntime(), optsFor({ apiKey: null }))).message).toContain(
      "missing apiKey",
    );
  });
});

// ── the plan a user's explicit choice produces ────────────────────────────
//
// The wiring bug this pins: `identity.transport` carried the user's choice while
// the runtime was handed "unknown" and refused the turn. The runtime reads ONE
// field, so that field has to be the choice.
describe("an explicit transport choice reaches the runtime", () => {
  const attemptPlan = (preference: "responses" | "chat-completions" | "auto") => {
    const plan = resolveRunPlan({
      model: "gpt-5.6-sol",
      runtime: "openai",
      providerId: "prov-1",
      // Exactly what resolveTransportFacts returns for an explicit choice: no
      // fabricated fact (the user's word is not evidence about the endpoint).
      transportFacts: { value: undefined, origin: "unknown", confidence: "unknown", source: "s", considered: [] },
      preferences: { transport: preference },
    });
    return { plan, planned: planTransportAttempts(plan, "openai-compat provider \"p\"") };
  };

  it("runs the chosen transport instead of refusing an unknown one", () => {
    const explicit = attemptPlan("responses");
    expect(explicit.planned).toEqual({ ok: true, attempts: ["responses"] });
    expect(explicit.plan.identity.transport).toBe(explicit.plan.transport.resolved);
  });

  it("honours chat-completions the same way, with no sibling queued", () => {
    expect(attemptPlan("chat-completions").planned).toEqual({
      ok: true,
      attempts: ["chat-completions"],
    });
  });

  it("still refuses when nothing established a transport at all", () => {
    // `auto` with no fact: the compat baseline the SessionManager passes is what
    // keeps a real turn runnable; a plan without one is a caller error.
    const auto = attemptPlan("auto");
    expect(auto.plan.transport.resolved).toBe("unknown");
    expect(auto.planned.ok).toBe(false);
  });
});

// ── one session id per turn ───────────────────────────────────────────────
//
// system/init, the assistant/result messages and the stream must all name the
// SAME session — including across a fallback, which re-runs the turn. The id is
// minted once in `query` and passed to every attempt; the generator is injectable
// so this contract needs no network.
describe("turn session id", () => {
  it("mints once, before the first attempt, and reports it in system/init", async () => {
    let minted = 0;
    const plan = resolveRunPlan({
      model: "gpt-5.6-sol",
      runtime: "openai",
      providerId: "prov-1",
      transportFacts: {
        value: "responses",
        origin: "provider-discovered",
        confidence: "observed",
        source: "s",
        considered: [],
      },
      preferences: { transport: "auto" },
    });
    const opts = optsFor({
      runPlan: plan,
      newSessionId: () => {
        minted += 1;
        return `session-${minted}`;
      },
    });
    // Stop after the init: it is emitted before any attempt, so the assertion
    // needs no provider and no socket.
    const seen: RuntimeEvent[] = [];
    for await (const e of new OpenAIAgentRuntime().query(opts)) {
      seen.push(e);
      break;
    }
    const init = seen[0]!;
    if (init.type !== "sdk_message" || init.payload.type !== "system") {
      throw new Error(`expected system/init, got ${init.type}`);
    }
    expect(init.payload.session_id).toBe("session-1");
    expect(minted).toBe(1);
  });
});
