import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// `resolveRunPlan` reads the data dir for its overrides at import time.
const TMP = mkdtempSync(join(tmpdir(), "openai-plan-test-"));
process.env.AGENTORCH_DATA_DIR = TMP;
process.env.AGENTORCH_DB_PATH = join(TMP, "plan.db");

import { OpenAIAgentRuntime, buildRunnerRunOptions, planTransportAttempts } from "../openai.js";
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
