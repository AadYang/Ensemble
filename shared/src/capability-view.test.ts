// The capability view-model's gates: what the settings page, the `/status` text
// and the context bar are allowed to say about one plan.
//
// `desktop-ui` has no test runner, so the agreement the three surfaces have to
// keep is pinned HERE, on the object they all read. Two of them are gates the
// settings contract was accepted with:
//
//   gate 2 — a value the route REJECTED is still shown verbatim, with the
//            server's reason, and its control stays usable; only a field with no
//            value space at all (a native CLI's transport) is disabled, and it
//            says why.
//   gate 8 — for ONE report, the settings rows and the `/status` text resolve to
//            the same value for every field, because they are the same array.

import { describe, expect, it } from "vitest";
import { capabilityView, formatCapabilityFieldLines } from "./capability-view.js";
import { runPlanStatusView, type RunPlanStatusView } from "./run-plan-view.js";
import type {
  CapabilityConfidence,
  CapabilityOrigin,
  ResolvedCapability,
  ResolvedRunPlan,
} from "./capability.js";

const fact = <T,>(value: T | undefined, over: Partial<ResolvedCapability<T>> = {}): ResolvedCapability<T> => ({
  value,
  origin: "provider-discovered" as CapabilityOrigin,
  confidence: (value === undefined ? "unknown" : "confirmed") as CapabilityConfidence,
  source: "the provider's own catalog entry for this route",
  considered: [],
  ...over,
});

/** A COMPLETE plan, not a bag of the fields one assertion needs: the point of
 *  these gates is that the projection is faithful, and a fixture that omits half
 *  the plan would not be able to show that it is. */
function planFixture(over: Partial<ResolvedRunPlan> = {}): ResolvedRunPlan {
  const base: ResolvedRunPlan = {
    identity: {
      providerId: "provider-1",
      providerScope: "openai-compat",
      runtime: "http",
      runtimeVersion: null,
      transport: "responses",
      modelId: "gpt-test",
    },
    facts: {
      scope: {
        providerId: "provider-1",
        providerScope: "openai-compat",
        runtime: "http",
        runtimeVersion: null,
        transport: "responses",
        modelId: "gpt-test",
      },
      transport: fact("responses"),
      advertisedContextWindow: fact(200_000),
      runtimeEffectiveWindow: fact(200_000),
      maxOutputTokens: fact(8_000),
      reasoningLevels: fact(["low", "medium", "high"]),
      defaultReasoningLevel: fact("medium"),
      supportsServerConversation: fact(true),
      supportsNativeCompaction: fact(false),
      tools: {
        toolCalling: fact(true),
        parallelToolCalls: fact(true),
        builtinTools: fact([]),
        mcp: fact(true),
      },
    },
    transport: {
      requested: "responses",
      resolved: "responses",
      origin: "user-declared",
      confidence: "confirmed",
      fallbackAllowed: false,
      fallbackTarget: null,
      fallbackReason: "an explicit request is honoured exactly, including its failures",
    },
    execution: {
      reasoningEffort: "high",
      maxModelTurns: { value: null, pendingPhase: null, reason: "no consumer in this phase" },
      projectRoot: {
        value: "/work/project",
        configuredPath: "/work/project",
        source: "agent",
        state: "bound",
        invalid: null,
      },
    },
    context: {
      effectiveWindow: 200_000,
      requestedRuntimeWindow: 200_000,
      advertisedContextWindow: 200_000,
      outputReserve: 8_000,
      compactionThreshold: 150_000,
      contextBudget: null,
    },
    history: {
      status: "resolved",
      strategy: "server-conversation",
      reason: "a server-side conversation id is held and its signature still matches",
      tokenBudget: 100_000,
      measuredTokens: 1_000,
      actualIncludedTokens: 1_000,
      overBudget: false,
      counting: "exact",
      counts: { included: 4, dropped: 0, summarized: 0 },
      includedRanges: [{ fromSeq: 0, toSeq: 4 }],
      overflow: null,
      summaries: [],
      diagnostics: [],
    },
    skills: {
      status: "resolved",
      reason: "skill discovery ran against the agent's project root",
      discovered: 1,
      selected: 1,
      loaded: 1,
      deferred: 0,
      unavailable: 0,
      loadedSkills: [{ name: "reviewer", source: "project", tokens: 10 }],
      deferredSkills: [],
      unavailableSkills: [],
      tokenCost: 10,
      counting: "exact",
      diagnostics: [],
    },
    liveness: {
      status: "resolved",
      reason: "no user ceiling is configured; a suspected stall warns and is checked, it never terminates",
      suspectedAfterMs: 120_000,
      suspectedAfterSource: "default",
      healthCheckGraceMs: 60_000,
      hardDeadlineMs: null,
      hardDeadlineSource: "unset",
      probe: { capability: "stream", reason: "this route emits model events" },
      signals: ["model-event", "tool-progress"],
      diagnostics: [],
    },
    preferences: [
      { field: "transport", requested: "responses", outcome: "applied" },
      { field: "reasoningEffort", requested: "high", outcome: "applied" },
    ],
    diagnostics: [],
    planHash: "plan-hash-1",
    resolvedAt: "2026-09-15T10:00:00.000Z",
  };
  return { ...base, ...over };
}

const viewOf = (over: Partial<ResolvedRunPlan> = {}): RunPlanStatusView =>
  runPlanStatusView({ plan: planFixture(over), source: "last-turn" });

describe("gate 2: a rejected value stays visible, explained, and fixable", () => {
  // A reasoning level the model's own ladder does not contain. The preference
  // comes back `rejected`, so the level NEVER reaches the plan — which is
  // exactly why the row has to carry it separately.
  const rejected = viewOf({
    execution: {
      ...planFixture().execution,
      reasoningEffort: undefined,
    },
    preferences: [
      { field: "transport", requested: "responses", outcome: "applied" },
      {
        field: "reasoningEffort",
        requested: "ultra",
        outcome: "rejected",
        rejection: {
          code: "contradicts-model-capability",
          detail: "this model's ladder is low / medium / high; ultra is not in it",
        },
      },
    ],
  });

  it("shows what the user asked for, with the server's code and reason", () => {
    const row = capabilityView(rejected).fields.find((r) => r.field === "reasoning");
    expect(row).toBeDefined();
    expect(row!.requested).toBe("ultra");
    expect(row!.resolved).toBeNull();
    expect(row!.outcome).toBe("rejected");
    expect(row!.rejection).toEqual({
      value: "ultra",
      code: "contradicts-model-capability",
      detail: "this model's ladder is low / medium / high; ultra is not in it",
    });
    // The reason is never empty and is the server's own sentence.
    expect(row!.reason).toContain("ultra is not in it");
  });

  it("keeps the control usable, so the fix is to pick another value", () => {
    const row = capabilityView(rejected).fields.find((r) => r.field === "reasoning")!;
    expect(row.editable).toBe(true);
    expect(row.disabledReason).toBeNull();
    // The value space is the model's ladder — the rejected value is excluded by
    // the ROUTE, and the list tells the user what to pick instead.
    expect(row.options).toEqual(["low", "medium", "high"]);
  });

  it("disables exactly the field with no value space, and says why", () => {
    // A native CLI has no transport to choose: what it is, is not a setting.
    const native = planFixture();
    const cliView = viewOf({
      identity: { ...native.identity, transport: "native-cli", runtime: "codex-cli" },
      facts: { ...native.facts, scope: { ...native.facts.scope, transport: "native-cli" }, transport: fact("native-cli") },
      transport: {
        requested: null,
        resolved: "native-cli",
        origin: "runtime-observed",
        confidence: "observed",
        fallbackAllowed: false,
        fallbackTarget: null,
        fallbackReason: "a native CLI owns its own transport",
      },
    });
    const row = capabilityView(cliView).fields.find((r) => r.field === "transport")!;
    expect(row.editable).toBe(false);
    expect(row.options).toEqual([]);
    // "Disabled" always comes with the sentence that explains it.
    expect(row.disabledReason).toBe(row.reason);
    expect(row.disabledReason).not.toBe("");
  });

  it("leaves an UNKNOWN ladder editable rather than treating it as an empty one", () => {
    const native = planFixture();
    const unknown = viewOf({
      facts: {
        ...native.facts,
        reasoningLevels: fact<string[]>(undefined, { source: "no catalog entry" }),
      },
      execution: { ...native.execution, reasoningEffort: "high" },
    });
    const row = capabilityView(unknown).fields.find((r) => r.field === "reasoning")!;
    // null (open/unknown) is not [] (a bounded set with nothing in it).
    expect(row.options).toBeNull();
    expect(row.editable).toBe(true);
    expect(row.disabledReason).toBeNull();
  });
});

describe("gate 8: one report, one resolved value per field, on every surface", () => {
  const view = viewOf();

  it("projects the plan's own rows one-for-one, in order", () => {
    const fields = capabilityView(view).fields;
    expect(fields.map((f) => f.field)).toEqual(view.settings.map((s) => s.field));
    for (const [index, row] of view.settings.entries()) {
      expect(fields[index]!.resolved).toBe(row.resolved);
      expect(fields[index]!.requested).toBe(row.requested);
      expect(fields[index]!.outcome).toBe(row.outcome);
      expect(fields[index]!.reason).toBe(row.reason);
      expect(fields[index]!.source).toBe(row.source);
      expect(fields[index]!.confidence).toBe(row.confidence);
    }
  });

  it("prints exactly the resolved value the settings row renders", () => {
    const fields = capabilityView(view).fields;
    const lines = formatCapabilityFieldLines(fields);
    expect(lines).toHaveLength(view.settings.length);
    for (const [index, row] of view.settings.entries()) {
      const line = lines[index]!;
      expect(line).toContain(`plan.setting=${row.field}`);
      expect(line).toContain(`path:${row.path}`);
      expect(line).toContain(`resolved:${row.resolved ?? "(none)"}`);
      expect(line).toContain(`requested:${row.requested ?? "(none)"}`);
      expect(line).toContain(`editable:${row.editable}`);
      // The row's reason is printed verbatim, never summarised.
      expect(line.endsWith(`— ${row.reason}`)).toBe(true);
    }
  });

  it("carries the plan source through, so a preview is never read as a record", () => {
    const preview = runPlanStatusView({ plan: planFixture(), source: "preview" });
    expect(capabilityView(preview).runPlanSource).toBe("preview");
    // …and no plan at all is its own answer, not a defaulted one.
    const none = capabilityView(null);
    expect(none.runPlanSource).toBe("none");
    expect(none.fields).toEqual([]);
    expect(none.header).toBeNull();
  });
});
