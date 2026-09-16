import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same reason as the capability tests: the override path resolves from
// AGENTORCH_DATA_DIR at module load.
const TMP = mkdtempSync(join(tmpdir(), "run-plan-test-"));
process.env.AGENTORCH_DATA_DIR = TMP;

import type {
  AppliedPreference,
  ResolvedRunPlan,
  RuntimeConstraint,
  TransportPreference,
  UserPreferences,
} from "../types.js";

type CtxMod = typeof import("../../context-window.js");
type PlanMod = typeof import("../run-plan.js");
type BudgetMod = typeof import("../history-budget.js");
let ctx: CtxMod;
let m: PlanMod;
let budget: BudgetMod;

beforeAll(async () => {
  ctx = await import("../../context-window.js");
  m = await import("../run-plan.js");
  budget = await import("../history-budget.js");
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
  rmSync(ctx.contextWindowOverridesPath(), { force: true });
  ctx._resetContextWindowCache();
});

const baseRequest = () => ({
  model: "gpt-5.6-sol",
  runtime: "codex",
  runtimeVersion: "0.154.0",
  providerId: "prov-1",
});

const basePlan = (extra: Record<string, unknown> = {}) =>
  m.resolveRunPlan({ ...baseRequest(), ...extra });


describe("resolveRunPlan", () => {
  it("carries the identity the plan is keyed by", () => {
    expect(basePlan().identity).toEqual({
      providerId: "prov-1",
      providerScope: "codex/openai",
      runtime: "codex",
      transport: "native-cli",
      modelId: "gpt-5.6-sol",
      runtimeVersion: "0.154.0",
    });
  });

  it("exposes the same window facts the capability set resolved", () => {
    const plan = basePlan({ sessionObservedWindow: 700_000, requestedWindow: 1_050_000 });
    expect(plan.context.effectiveWindow).toBe(700_000);
    expect(plan.context.requestedRuntimeWindow).toBe(1_050_000);
    expect(plan.context.advertisedContextWindow).toBe(1_050_000);
    expect(plan.context.outputReserve).toBe(128_000);
    // Consumer and resolver must not be able to disagree.
    expect(plan.facts.runtimeEffectiveWindow.value).toBe(plan.context.effectiveWindow);
  });

  it("leaves an unknown ceiling null rather than borrowing the advertised one", () => {
    const plan = basePlan({ runtimeVersion: "0.199.0" });
    expect(plan.context.effectiveWindow).toBeNull();
    expect(plan.context.requestedRuntimeWindow).toBe(1_050_000);
    expect(plan.context.advertisedContextWindow).toBe(1_050_000);
  });

  it("takes the compaction threshold from the caller, defaulting to unknown", () => {
    expect(basePlan().context.compactionThreshold).toBeNull();
    expect(basePlan({ compactionThreshold: 258_400 }).context.compactionThreshold).toBe(258_400);
  });

  // Phase 3 replaced the two placeholders that used to sit here, and phase 4
  // replaced `liveness`: `history` and `skills` are real structures ("nobody
  // told me" is an ANSWER, not a zeroed struct), and the liveness POLICY is a
  // resolved value with thresholds and a probe capability. `maxModelTurns` —
  // the last field of this shape — is settled too: its `null` is the answer
  // "no cap", and no phase is owed for it.
  it("settles maxModelTurns as an answer: no cap, and no phase owed", () => {
    const plan = basePlan();
    expect(plan.execution.maxModelTurns.value).toBeNull();
    expect(plan.execution.maxModelTurns.reason.length).toBeGreaterThan(0);
    expect(plan.execution.maxModelTurns.pendingPhase).toBeNull();
    // The old wording claimed the SDK's own cap was still in force while the
    // OpenAI runtime already passed `maxTurns: null`. Guard against its return.
    expect(plan.execution.maxModelTurns.reason).not.toMatch(/still in force/i);
    expect(plan.execution.maxModelTurns.reason).not.toMatch(/phase\s*1/i);
  });

  // The phase-4 rule, at the planner: no ceiling is the DEFAULT, and it is a
  // resolved answer rather than a missing one. A run may outlive any amount of
  // silence unless the user typed a number.
  it("resolves liveness with no wall-clock deadline by default", () => {
    const plan = basePlan();
    expect(plan.liveness.status).toBe("resolved");
    expect(plan.liveness.hardDeadlineMs).toBeNull();
    expect(plan.liveness.hardDeadlineSource).toBe("unset");
    expect(plan.liveness.suspectedAfterMs).toBeGreaterThan(0);
    expect(plan.liveness.probe.capability).toBe("process");
    expect(plan.liveness.signals).toContain("child-process");
    expect(plan.liveness.diagnostics.length).toBeGreaterThan(0);
  });

  // A deadline that is not a positive number is REJECTED, not coerced: a
  // deadline the user did not type would end runs they never meant to bound.
  it("rejects a nonsensical run deadline instead of inventing one", () => {
    const plan = m.resolveRunPlan({
      ...baseRequest(),
      preferences: { maxRunDurationMs: 0 },
    });
    expect(plan.liveness.hardDeadlineMs).toBeNull();
    const pref = plan.preferences.find((p) => p.field === "maxRunDurationMs");
    expect(pref?.outcome).toBe("rejected");
  });

  it("carries a user-set run deadline through to the policy", () => {
    const plan = m.resolveRunPlan({
      ...baseRequest(),
      preferences: { maxRunDurationMs: 1_800_000 },
    });
    expect(plan.liveness.hardDeadlineMs).toBe(1_800_000);
    expect(plan.liveness.hardDeadlineSource).toBe("user-preference");
  });

  // The `openai` route has no process or socket handle, so its probe answers
  // `unknown` — which the state machine is forbidden to treat as death.
  it("gives the stream-only runtime no process probe", () => {
    const plan = m.resolveRunPlan({
      ...baseRequest(),
      runtime: "openai",
      transportFacts: {
        value: "responses",
        origin: "runtime-observed",
        confidence: "unverified",
        source: "test",
        considered: [],
      },
    });
    expect(plan.liveness.probe.capability).toBe("stream");
    expect(plan.liveness.signals).not.toContain("child-process");
  });

  it("carries history and skills as unavailable structures, not placeholders", () => {
    const plan = basePlan();
    expect(plan.history.status).toBe("unavailable");
    expect(plan.history.strategy).toBeNull();
    expect(plan.history.reason.length).toBeGreaterThan(0);
    expect(plan.history.counts).toEqual({ included: 0, dropped: 0, summarized: 0 });
    expect(plan.history.overflow).toBeNull();
    expect(plan.skills.status).toBe("unavailable");
    expect(plan.skills.reason.length).toBeGreaterThan(0);
    expect(plan.skills.loadedSkills).toEqual([]);
    expect(plan.skills.deferredSkills).toEqual([]);
    expect("value" in plan.history).toBe(false);
    expect("pendingPhase" in plan.skills).toBe(false);
  });

  // projectRoot was the other deferred field; it is RESOLVED now. A caller that
  // resolves a plan without a project root at all still gets a structured
  // answer rather than a value invented here: unbound, and no directory to run
  // in — never the process's own cwd.
  it("resolves the project root instead of deferring it", () => {
    const plan = basePlan();
    expect(plan.execution.projectRoot.state).toBe("unbound");
    expect(plan.execution.projectRoot.source).toBe("scratch");
    expect(plan.execution.projectRoot.value).toBeNull();
    expect(plan.execution.projectRoot.invalid?.code).toBe("SCRATCH_UNWRITABLE");
    expect("pendingPhase" in plan.execution.projectRoot).toBe(false);
  });

  // Nothing here may be invented. A bare planner call has no window to measure
  // against and no tokens to count, and it says exactly that instead of printing
  // a number nobody measured.
  it("reports an unassigned history budget as unavailable, with no invented number", () => {
    const plan = basePlan();
    expect(plan.history.tokenBudget).toBeNull();
    expect(plan.history.measuredTokens).toBeNull();
    expect(plan.history.counting).toBe("unmeasured");
    expect(plan.history.status).toBe("unavailable");
  });

  // The attach step is what turns the placeholder into the turn's real
  // decision, and it may only happen once: a second attach on the same plan
  // would let a consumer read a history that no longer matches planHash.
  it("attaches history and skills once and re-hashes the plan", () => {
    const plan = basePlan();
    const withHistory = m.attachPlanHistory(plan, {
      ...budget.unavailablePlanHistory("x"),
      status: "resolved",
      strategy: "local-rebuild",
      reason: "test",
    });
    expect(withHistory.history.status).toBe("resolved");
    expect(withHistory.planHash).not.toBe(plan.planHash);
    expect(() =>
      m.attachPlanHistory(withHistory, budget.unavailablePlanHistory("again")),
    ).toThrow(/already resolved/i);
  });

  it("carries the per-field diagnostics through to the plan", () => {
    const plan = basePlan();
    expect(plan.diagnostics.some((d) => d.field === "facts.reasoningLevels")).toBe(true);
    expect(plan.diagnostics.some((d) => d.field === "facts.runtimeEffectiveWindow")).toBe(true);
  });

  it("stamps a resolution time from the injected clock", () => {
    const plan = m.resolveRunPlan({
      model: "gpt-5.6-sol",
      runtime: "codex",
      now: () => new Date("2026-09-15T00:00:00.000Z"),
    });
    expect(plan.resolvedAt).toBe("2026-09-15T00:00:00.000Z");
  });
});

// ── facts vs preferences vs constraints ───────────────────────────────────
//
// A user may choose a transport, a reasoning level or a budget. A user may NOT
// overrule a capability the runtime established. Folding all three into one
// priority chain (`user explicit > observed`) would let a preference fabricate
// a capability.
describe("preference / constraint intersection", () => {
  it("lets a preference fill a field the facts left unknown", () => {
    const plan = basePlan({ runtime: "openai", preferences: { transport: "responses" } });
    // Nothing established the HTTP transport, so the user's choice is the only
    // value we have — and it is labelled as a choice, not as evidence.
    expect(plan.identity.transport).toBe("responses");
    const pref = plan.preferences.find((p) => p.field === "transport")!;
    expect(pref.outcome).toBe("applied");
    const d = plan.diagnostics.find((x) => x.field === "preferences.transport")!;
    expect(d.origin).toBe("user-declared");
  });

  it("does not let a preference overwrite a fact the runtime established", () => {
    // The runtime IS a native CLI; asking for Responses does not change that.
    const plan = basePlan({ preferences: { transport: "responses" } });
    expect(plan.identity.transport).toBe("native-cli");
    expect(plan.facts.scope.transport).toBe("native-cli");
    // ...and the request is not reported as honoured, because it was not.
    const pref = plan.preferences.find((p) => p.field === "transport")!;
    expect(pref.outcome).toBe("rejected");
    expect(pref.rejection!.code).toBe("contradicts-established-fact");
    expect(pref.rejection!.detail).toContain("native-cli");
  });

  it("reports a preference the runtime already satisfies as applied", () => {
    const plan = basePlan({ preferences: { transport: "auto" } });
    expect(plan.identity.transport).toBe("native-cli");
    expect(plan.preferences.find((p) => p.field === "transport")!.outcome).toBe("applied");
  });

  // `native-cli` is a fact about a runtime we launch, not a transport a user can
  // request. Letting it be one is how an HTTP route ends up carrying a
  // `native-cli` identity that contradicts its own runtime.
  it("does not accept a fact-only transport as a preference", () => {
    type Requestable = NonNullable<UserPreferences["transport"]>;
    const requestable: Requestable[] = ["auto", "responses", "chat-completions"];
    // @ts-expect-error `native-cli` is not requestable — it is what the runtime IS
    const factOnly: Requestable = "native-cli";
    // @ts-expect-error `unknown` is the absence of an answer, not a choice
    const absent: Requestable = "unknown";
    expect(requestable).toEqual(["auto", "responses", "chat-completions"]);
    expect([factOnly, absent]).toEqual(["native-cli", "unknown"]);
  });

  // ...and not only in the type system. A value arriving from a config file or a
  // cast is refused at runtime rather than becoming an identity.
  it("refuses a non-requestable transport that bypassed the type", () => {
    const plan = m.resolveRunPlan({
      model: "gpt-5.6-sol",
      runtime: "openai",
      preferences: { transport: "native-cli" as unknown as TransportPreference },
    });
    expect(plan.identity.transport).toBe("unknown");
    const pref = plan.preferences.find((p) => p.field === "transport")!;
    expect(pref.outcome).toBe("rejected");
    expect(pref.rejection!.detail).toContain("native-cli");
  });

  // `auto` asks for no particular transport, so it cannot contradict anything —
  // and when the caller established no fact, "unknown" is the whole answer.
  it("resolves auto to the honest unknown rather than to a default", () => {
    const plan = m.resolveRunPlan({
      model: "gpt-5.6-sol",
      runtime: "openai",
      preferences: { transport: "auto" },
    });
    expect(plan.identity.transport).toBe("unknown");
    expect(plan.identity.transport).not.toBe("chat-completions");
    const pref = plan.preferences.find((p) => p.field === "transport")!;
    expect(pref.outcome).toBe("applied");
    // Honoured, and the note says so without dressing the unknown up as a
    // default — discovery now RUNS (it is the probe), so naming a phase here
    // would be stale the moment the fact arrives.
    expect(plan.diagnostics.find((d) => d.field === "preferences.transport")!.detail).toContain(
      "no transport has been established",
    );
    expect(plan.transport.fallbackAllowed).toBe(false);
  });

  // THE rule: an observed "cannot do this" is not a preference away.
  it("rejects a preference that contradicts an established constraint", () => {
    const plan = basePlan({
      runtime: "openai",
      constraints: [
        { field: "transport", reason: "the endpoint returned 404 for /responses", origin: "provider-discovered" },
      ],
      preferences: { transport: "responses" },
    });
    const pref = plan.preferences.find((p) => p.field === "transport")!;
    expect(pref.outcome).toBe("rejected");
    expect(pref.rejection!.code).toBe("contradicts-runtime-constraint");
    expect(pref.rejection!.detail).toContain("404");
    // ...and the rejection is a structured, visible diagnostic — not a silent
    // drop, and not a silent substitution of another transport.
    const d = plan.diagnostics.find((x) => x.field === "preferences.transport")!;
    expect(d.status).toBe("rejected");
    expect(d.detail).toContain("provider-discovered");
    // The rejected wish must not appear in the resolved identity.
    expect(plan.identity.transport).not.toBe("responses");
  });

  it("applies non-transport preferences and records each one", () => {
    const plan = basePlan({
      preferences: { reasoningEffort: "high", maxOutputTokens: 32_000, contextBudget: 500_000 },
    });
    expect(plan.execution.reasoningEffort).toBe("high");
    expect(plan.preferences.map((p) => p.field)).toEqual([
      "reasoningEffort",
      "maxOutputTokens",
      "contextBudget",
    ]);
    // "applied" has to MEAN something: the value reaches the plan a consumer
    // reads. An `applied` preference that is then ignored is worse than a
    // rejected one, because nothing tells the user it did not happen.
    expect(plan.context.outputReserve).toBe(32_000);
    expect(plan.preferences.find((p) => p.field === "maxOutputTokens")!.outcome).toBe("applied");
    // Phase 3 gave `contextBudget` a consumer (the history budget resolver takes
    // the smaller of the window it derived and this request), so it is no longer
    // "recorded but unconsumed" — and the value has to be here for the resolver
    // to read.
    expect(plan.preferences.find((p) => p.field === "contextBudget")!.outcome).toBe("applied");
    expect(plan.context.contextBudget).toBe(500_000);
  });

  // A rejected preference must not survive anywhere downstream — not even in
  // the field it named.
  it("does not write a rejected reasoningEffort into the execution snapshot", () => {
    const plan = basePlan({
      constraints: [
        {
          field: "reasoningEffort",
          forbids: ["high"],
          reason: "the model rejects effort=high",
          origin: "runtime-observed",
        },
      ],
      preferences: { reasoningEffort: "high" },
    });
    expect(plan.preferences.find((p) => p.field === "reasoningEffort")!.outcome).toBe("rejected");
    expect(plan.execution.reasoningEffort).toBeUndefined();
  });

  // The structured rejection has to name the model and the ladder that refused
  // the value, or a user cannot tell "your model does not have this level" from
  // "we could not reach the model" — and the plan must not quietly substitute a
  // level the model DOES have.
  it("names the model, its ladder and the source when a level is outside it", () => {
    const plan = basePlan({ preferences: { reasoningEffort: "hyper" } });
    expect(plan.execution.reasoningEffort).toBeUndefined();
    const pref = plan.preferences.find((p) => p.field === "reasoningEffort")!;
    expect(pref.outcome).toBe("rejected");
    expect(pref.rejection!.code).toBe("contradicts-model-capability");
    expect(pref.rejection!.detail).toContain("gpt-5.6-sol");
    expect(pref.rejection!.detail).toContain("ultra"); // the supported levels
    expect(pref.rejection!.detail).toContain("codex CLI"); // the source
    expect(pref.rejection!.detail).toContain("hyper"); // the request
  });

  it("applies a DeepSeek official level as supported, not as an unverified guess", () => {
    const plan = m.resolveRunPlan({
      model: "deepseek-flash",
      runtime: "openai",
      preferences: { reasoningEffort: "max" },
    });
    expect(plan.execution.reasoningEffort).toBe("max");
    const pref = plan.preferences.find((p) => p.field === "reasoningEffort")!;
    expect(pref.outcome).toBe("applied");
    expect(plan.facts.reasoningLevels.value).toEqual(["low", "high", "max"]);
    const d = plan.diagnostics.find((x) => x.field === "preferences.reasoningEffort");
    expect(d?.detail ?? "").not.toMatch(/not established|sent unverified/);
  });

  it("applies a Claude official effort level as supported, not as an unverified guess", () => {
    const plan = m.resolveRunPlan({
      model: "claude-opus-4-8",
      runtime: "claude",
      preferences: { reasoningEffort: "xhigh" },
    });
    expect(plan.execution.reasoningEffort).toBe("xhigh");
    const pref = plan.preferences.find((p) => p.field === "reasoningEffort")!;
    expect(pref.outcome).toBe("applied");
    expect(plan.facts.reasoningLevels.value).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const d = plan.diagnostics.find((x) => x.field === "preferences.reasoningEffort");
    expect(d?.detail ?? "").not.toMatch(/not established|sent unverified/);
  });

  it("rejects xhigh on a Claude model the vendor did not list for that level", () => {
    const plan = m.resolveRunPlan({
      model: "claude-sonnet-4-6",
      runtime: "claude",
      preferences: { reasoningEffort: "xhigh" },
    });
    expect(plan.execution.reasoningEffort).toBeUndefined();
    const pref = plan.preferences.find((p) => p.field === "reasoningEffort")!;
    expect(pref.outcome).toBe("rejected");
    expect(pref.rejection!.detail).toContain("claude-sonnet-4-6");
    expect(pref.rejection!.detail).toContain("max");
    expect(pref.rejection!.detail).toContain("xhigh");
  });

  it("carries a legal level as user-declared when the model's ladder is unknown", () => {
    const plan = m.resolveRunPlan({
      model: "not-a-real-model-12345",
      runtime: "claude",
      preferences: { reasoningEffort: "hyper" },
    });
    // Allowed through — but never claimed as supported.
    expect(plan.execution.reasoningEffort).toBe("hyper");
    const pref = plan.preferences.find((p) => p.field === "reasoningEffort")!;
    expect(pref.outcome).toBe("applied");
    const d = plan.diagnostics.find((x) => x.field === "preferences.reasoningEffort")!;
    expect(d.origin).toBe("user-declared");
    expect(d.confidence).toBe("unverified");
    expect(d.detail).toContain("not established");
  });

  it("refuses a level that is not a safe token instead of clearing it", () => {
    const plan = basePlan({ preferences: { reasoningEffort: 'high"; rm -rf /' } });
    expect(plan.execution.reasoningEffort).toBeUndefined();
    const pref = plan.preferences.find((p) => p.field === "reasoningEffort")!;
    expect(pref.outcome).toBe("rejected");
    expect(pref.rejection!.detail).toContain("not a valid reasoning level");
  });

  it("leaves a preference for a different value alone", () => {
    const plan = basePlan({
      constraints: [
        {
          field: "reasoningEffort",
          forbids: ["high"],
          reason: "the model rejects effort=high",
          origin: "runtime-observed",
        },
      ],
      preferences: { reasoningEffort: "low" },
    });
    expect(plan.execution.reasoningEffort).toBe("low");
  });

  // "This endpoint does not speak Responses" is not "this endpoint speaks no
  // transport at all". A field-wide constraint would reject the very fallback
  // the constraint exists to select.
  it("blocks only the forbidden value of a field", () => {
    // Annotated rather than inferred: a bare object literal infers `field: string`,
    // which is exactly the inert-constraint shape `RuntimeConstraint` exists to
    // refuse, so the annotation is what keeps this test honest.
    const constraint: RuntimeConstraint = {
      field: "transport",
      forbids: ["responses"],
      reason: "the endpoint returned 404 for /responses",
      origin: "provider-discovered",
    };
    const openaiRoute = { model: "gpt-5.6-sol", runtime: "openai", constraints: [constraint] };
    const rejected = m.resolveRunPlan({ ...openaiRoute, preferences: { transport: "responses" } });
    expect(rejected.identity.transport).not.toBe("responses");
    const allowed = m.resolveRunPlan({
      ...openaiRoute,
      preferences: { transport: "chat-completions" },
    });
    expect(allowed.identity.transport).toBe("chat-completions");
  });

  it("clamps an output reservation to the model's published cap, and says so", () => {
    const plan = basePlan({ preferences: { maxOutputTokens: 500_000 } });
    // The plan carries the cap; reporting `applied` for 500K would tell the user
    // a reservation happened that did not.
    expect(plan.context.outputReserve).toBe(128_000);
    const pref = plan.preferences.find((p) => p.field === "maxOutputTokens")!;
    expect(pref.outcome).toBe("rejected");
    expect(pref.rejection!.code).toBe("contradicts-established-fact");
    expect(pref.rejection!.detail).toContain("128000");
  });

  it("lets the preference fill an output cap we do not know", () => {
    const plan = m.resolveRunPlan({
      model: "not-a-real-model-12345",
      runtime: "claude",
      preferences: { maxOutputTokens: 32_000 },
    });
    expect(plan.facts.maxOutputTokens.value).toBeUndefined();
    expect(plan.context.outputReserve).toBe(32_000);
  });

  // A user's choice is not an observation. Reporting `observed` here tells the
  // UI and `/status` that the runtime confirmed something the user merely
  // asked for.
  it("never reports a user preference as runtime-observed", () => {
    const plan = basePlan({ preferences: { reasoningEffort: "high" } });
    const d = plan.diagnostics.find((x) => x.field === "preferences.reasoningEffort")!;
    expect(d.origin).toBe("user-declared");
    expect(d.confidence).not.toBe("observed");
    expect(d.status).toBe("resolved");
  });

  // A refused preference must be visible AS a refusal, and the plan must not
  // carry the value anyway: `null` is what the history resolver reads, so a
  // refused budget that survived here would silently cap the transcript.
  it("surfaces a refused history budget instead of dropping it", () => {
    const plan = basePlan({ preferences: { contextBudget: 0 } });
    const d = plan.diagnostics.find((x) => x.field === "preferences.contextBudget")!;
    expect(d.status).toBe("rejected");
    expect(d.origin).toBe("user-declared");
    expect(d.detail).toContain("positive token count");
    expect(plan.context.contextBudget).toBeNull();
    expect(plan.preferences.find((p) => p.field === "contextBudget")!.rejection!.code).toBe(
      "contradicts-established-fact",
    );
  });

  // Contract: `applied` has to MEAN "the plan carries exactly this value", and
  // `rejected` has to mean "it carries something else" — asserted against the
  // plan, per field, not against the label alone. The table is keyed by
  // `UserPreferences`, so a new preference cannot compile until its author says
  // where a consumer reads the value.
  //
  // Each field lists the requests it must be checked with, and every outcome the
  // planner can report appears among them. That is deliberate: an `else` branch
  // that treats everything which is not `applied` as `deferred` asserts nothing
  // about `rejected`, which is the outcome where a refused value leaking into the
  // plan would be invisible.
  describe("preference outcomes agree with the plan", () => {
    type Outcome = AppliedPreference<unknown>["outcome"];
    interface FieldContract {
      /** Where a consumer reads this preference out of the plan. */
      read: (plan: ResolvedRunPlan) => unknown;
      /** The value the plan must carry when the request is HONOURED. This is where
       *  a request stops being a special case: `auto` asks for no particular
       *  transport, and the plan's word for "nothing chosen" is `unknown`. */
      honoured: (asked: unknown) => unknown;
      /** Route to resolve on. Transport needs an HTTP route, whose transport is
       *  not yet established; the rest resolve the same either way. */
      runtime?: string;
      cases: readonly {
        asked: unknown;
        outcome: Outcome;
        constraints?: RuntimeConstraint[];
        /** Model override, for cases whose answer depends on the model's own
         *  ladder (a known ladder versus none). */
        model?: string;
      }[];
    }

    const TRANSPORT_404: RuntimeConstraint = {
      field: "transport",
      forbids: ["responses"],
      reason: "the endpoint returned 404 for /responses",
      origin: "provider-discovered",
    };

    const CONTRACTS: Record<keyof UserPreferences, FieldContract> = {
      transport: {
        read: (plan) => plan.identity.transport,
        honoured: (asked) => (asked === "auto" ? "unknown" : asked),
        runtime: "openai",
        cases: [
          { asked: "responses", outcome: "applied" },
          { asked: "auto", outcome: "applied" },
          { asked: "responses", outcome: "rejected", constraints: [TRANSPORT_404] },
          // Type bypass, not a constraint: `native-cli` is what a runtime IS.
          { asked: "native-cli", outcome: "rejected" },
        ],
      },
      reasoningEffort: {
        read: (plan) => plan.execution.reasoningEffort,
        // "Nothing to send" is the plan's word for both null and "inherit" —
        // one state, never two storage shapes.
        honoured: (asked) => (asked === null || asked === "inherit" ? undefined : asked),
        cases: [
          { asked: "high", outcome: "applied" },
          // Outside the UI's hint list, inside this model's ladder: the plan
          // carries it, which is what makes "the hints are not the valid set" a
          // property of the code and not of a comment.
          { asked: "ultra", outcome: "applied" },
          // Outside a KNOWN ladder: refused, and the plan must not carry it.
          { asked: "hyper", outcome: "rejected" },
          // No ladder for this model: a legal token is carried as
          // user-declared/unverified. "We have no evidence" is not "unsupported".
          { asked: "hyper", outcome: "applied", model: "not-a-real-model-12345" },
          // `null` and the literal "inherit" are the SAME state: nothing to send.
          { asked: null, outcome: "applied" },
          { asked: "inherit", outcome: "applied" },
          {
            asked: "high",
            outcome: "rejected",
            constraints: [
              {
                field: "reasoningEffort",
                forbids: ["high"],
                reason: "the model rejects effort=high",
                origin: "runtime-observed",
              },
            ],
          },
        ],
      },
      maxOutputTokens: {
        read: (plan) => plan.context.outputReserve,
        honoured: (asked) => asked,
        cases: [
          { asked: 32_000, outcome: "applied" },
          // The published cap is a fact, not a wish: the plan carries the cap and
          // the refused request must not be what a consumer reads.
          { asked: 500_000, outcome: "rejected" },
        ],
      },
      contextBudget: {
        // The consumer is `resolveHistoryBudget`, which reads exactly this field.
        read: (plan) => plan.context.contextBudget,
        honoured: (asked) => asked,
        cases: [
          { asked: 500_000, outcome: "applied" },
          // A budget of zero or less is refused: it is not a smaller transcript,
          // it is a value no resolver can apply, and the plan must say so.
          { asked: 0, outcome: "rejected" },
          { asked: -1, outcome: "rejected" },
        ],
      },
      maxRunDurationMs: {
        // Read back through the POLICY, not off the preference: the number only
        // means something once the liveness resolver has decided what it does.
        read: (plan) => plan.liveness.hardDeadlineMs,
        honoured: (asked) => asked,
        cases: [
          { asked: 1_800_000, outcome: "applied" },
          // `null` is the default state and a complete answer: no ceiling.
          { asked: null, outcome: "applied" },
          // A deadline that is not a positive number is refused rather than
          // coerced — a deadline the user did not type would end runs they
          // never meant to bound.
          { asked: 0, outcome: "rejected" },
          { asked: -5, outcome: "rejected" },
          { asked: "10 minutes", outcome: "rejected" },
        ],
      },
    };

    const FIELDS = Object.keys(CONTRACTS) as (keyof UserPreferences)[];

    for (const field of FIELDS) {
      const contract = CONTRACTS[field];
      for (const c of contract.cases) {
        it(`\`${field}\` = ${JSON.stringify(c.asked)} → ${c.outcome}, and the plan agrees`, () => {
          const preferences: UserPreferences = {};
          (preferences as Record<string, unknown>)[field] = c.asked;
          const plan = m.resolveRunPlan({
            model: c.model ?? "gpt-5.6-sol",
            runtime: contract.runtime ?? "codex",
            preferences,
            ...(c.constraints ? { constraints: c.constraints } : {}),
          });
          const record = plan.preferences.find((p) => p.field === field);
          expect(record, `${field} was asked for but not recorded`).toBeDefined();
          expect(record!.requested).toEqual(c.asked);
          expect(record!.outcome).toBe(c.outcome);
          const observed = contract.read(plan);
          const honoured = contract.honoured(c.asked);
          if (c.outcome === "applied") {
            expect(observed, `${field} is applied but the plan does not carry it`).toEqual(honoured);
          } else if (c.outcome === "rejected") {
            expect(observed, `${field} is rejected but the plan carries the refused value`).not.toEqual(
              honoured,
            );
            expect(record!.rejection, `${field} was refused with no reason attached`).toBeDefined();
          } else {
            expect(observed, `${field} is deferred but the plan carries it anyway`).toBeUndefined();
            // Deferred is "recorded, visible, unconsumed" — not "dropped".
            expect(record!.deferred).toBeDefined();
          }
        });
      }
    }

    // `deferred` has no producer since phase 3 gave the last deferred preference
    // (`contextBudget`) a consumer — every field in `PREFERENCE_BINDINGS` is now
    // a `consumer`. The outcome stays in the union, and `preferenceDiagnostic`
    // still handles it, because the next field added may not have an owner yet;
    // what this asserts is that no case is silently unchecked.
    it("exercises every outcome the planner can report", () => {
      const covered = new Set(FIELDS.flatMap((f) => CONTRACTS[f].cases.map((c) => c.outcome)));
      expect([...covered].sort()).toEqual(["applied", "rejected"]);
    });
  });

  it("records no preference when the user asked for nothing", () => {
    const plan = basePlan();
    expect(plan.preferences).toEqual([]);
    expect(plan.diagnostics.some((d) => d.field.startsWith("preferences."))).toBe(false);
  });
});

describe("requireCapability", () => {
  it("returns a resolved value", () => {
    const plan = basePlan();
    expect(m.requireCapability("facts.maxOutputTokens", plan.facts.maxOutputTokens)).toBe(128_000);
  });

  // A consumer that cannot proceed without a value must say WHICH fact it
  // lacked and why — a bare `undefined` at a call site is how an unknown turns
  // into an accidental default.
  it("throws with the field's own provenance when the value is unknown", () => {
    // A model with no registry evidence: the reasoning ladder is the capability
    // that is genuinely unknown here (it stopped being a placeholder when the
    // vendor's ladder was wired in).
    const plan = m.resolveRunPlan({
      model: "not-a-real-model-12345",
      runtime: "claude",
      preferences: { transport: "auto" },
    });
    expect(() => m.requireCapability("facts.reasoningLevels", plan.facts.reasoningLevels)).toThrow(
      /facts\.reasoningLevels.*unknown.*no evidence/s,
    );
  });
});

describe("plan immutability", () => {
  // "Immutable" in a comment is not a guarantee. A consumer that mutates the
  // snapshot would change what every later consumer sees in the same turn.
  it("is frozen, so a consumer cannot rewrite it mid-turn", () => {
    const plan = basePlan();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.facts)).toBe(true);
    expect(Object.isFrozen(plan.context)).toBe(true);
    expect(Object.isFrozen(plan.diagnostics)).toBe(true);
    const before = plan.context.effectiveWindow;
    expect(() => {
      (plan.context as { effectiveWindow: number | null }).effectiveWindow = 1;
    }).toThrow();
    expect(plan.context.effectiveWindow).toBe(before);
  });

  it("keeps the nested per-field capability objects frozen too", () => {
    const plan = basePlan();
    expect(Object.isFrozen(plan.facts.scope)).toBe(true);
    expect(Object.isFrozen(plan.facts.runtimeEffectiveWindow)).toBe(true);
    expect(Object.isFrozen(plan.facts.runtimeEffectiveWindow.considered)).toBe(true);
    expect(() => {
      (plan.facts.scope as { runtime: string }).runtime = "claude";
    }).toThrow();
    expect(plan.identity.runtime).toBe("codex");
  });
});

describe("planHash", () => {
  it("is stable across resolutions with identical content", () => {
    const at = () => new Date("2026-09-15T00:00:00.000Z");
    const a = m.resolveRunPlan({ model: "gpt-5.6-sol", runtime: "codex", runtimeVersion: "0.154.0", now: at });
    const b = m.resolveRunPlan({ model: "gpt-5.6-sol", runtime: "codex", runtimeVersion: "0.154.0", now: at });
    expect(a.planHash).toBe(b.planHash);
    expect(a.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a resolved fact changes", () => {
    const a = m.resolveRunPlan({ model: "gpt-5.6-sol", runtime: "codex", runtimeVersion: "0.154.0" });
    const b = m.resolveRunPlan({ model: "gpt-5.6-cyber", runtime: "codex", runtimeVersion: "0.154.0" });
    expect(a.planHash).not.toBe(b.planHash);
  });
});

// ── Telemetry: the Codex rollout bug, in pure form ────────────────────────
//
// `readCodexTurnContext()` scans the tail of the rollout file for the newest
// `token_count` event. A turn that failed before issuing a model request finds
// no new event and hands back the PREVIOUS turn's `last_token_usage`. A turn id
// on the reader does not fix that — the event carries no turn id, because the
// CLI wrote it for another turn. What fixes it is knowing the file's size when
// the turn started: anything at or below that mark predates the turn.
describe("turn-scoped observations", () => {
  const ROLLOUT = "C:/sessions/rollout.jsonl";
  const watermark = (turnId: string, size: number) => ({
    turnId,
    startedAt: "2026-09-15T00:00:00.000Z",
    marks: [{ kind: "file" as const, path: ROLLOUT, size }],
  });

  const event = (offset: number, value: number, turnId?: string) => ({
    ...(turnId ? { turnId } : {}),
    path: ROLLOUT,
    offset,
    field: "runtimeEffectiveWindow",
    value,
    observedAt: "2026-09-15T00:01:00.000Z",
    source: "runtime-rollout" as const,
  });

  const telemetryFor = (turnId: string, size: number) => {
    const plan = basePlan();
    return m.emptyTelemetry(plan, "run-1", watermark(turnId, size));
  };
  const RUN = "run-1";

  // THE regression: turn 2 issues no model request, so the newest event in the
  // file is turn 1's. It sits below the watermark and must be rejected.
  it("rejects an event written before the turn began", () => {
    const t = telemetryFor("turn-2", 4_096);
    const verdict = m.judgeObservation(t.watermark, event(4_000, 828_400), RUN);
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) {
      expect(verdict.rejection.code).toBe("predates-watermark");
      expect(verdict.rejection.detail).toContain("4096");
    }
  });

  it("reads nothing for a turn that produced no new event", () => {
    const t = telemetryFor("turn-2", 4_096);
    const after = m.recordObservation(t, event(4_000, 828_400));
    expect(after.observations).toEqual([]);
    expect(m.observationForTurn(after, "turn-2", "runtimeEffectiveWindow")).toBeUndefined();
  });

  // A rejection is a fact about the run: it stays visible rather than being
  // swallowed, so the consumer can see WHY it has no reading.
  it("records the rejection instead of dropping it silently", () => {
    const t = telemetryFor("turn-2", 4_096);
    const after = m.recordObservation(t, event(4_000, 828_400));
    expect(after.rejections).toHaveLength(1);
    expect(after.rejections[0]!.rejection.code).toBe("predates-watermark");
    expect(after.rejections[0]!.event.offset).toBe(4_000);
  });

  it("accepts an event written after the turn began", () => {
    const t = telemetryFor("turn-2", 4_096);
    const after = m.recordObservation(t, event(4_200, 700_000));
    expect(after.rejections).toEqual([]);
    expect(m.observationForTurn(after, "turn-2", "runtimeEffectiveWindow")?.value).toBe(700_000);
  });

  // Off-by-one that silently eats a turn's reading: `size` is the byte length
  // BEFORE the turn and `offset` is where the event STARTS, so the first byte
  // the turn appends lands exactly ON the mark. A `<=` test rejects it.
  it("accepts the first event appended at exactly the watermark", () => {
    const t = telemetryFor("turn-2", 4_096);
    const after = m.recordObservation(t, event(4_096, 700_000));
    expect(after.rejections).toEqual([]);
    expect(m.observationForTurn(after, "turn-2", "runtimeEffectiveWindow")?.value).toBe(700_000);
  });

  it("still rejects the previous turn's last event, one byte below the mark", () => {
    const t = telemetryFor("turn-2", 4_096);
    const after = m.recordObservation(t, event(4_095, 828_400));
    expect(after.observations).toEqual([]);
    expect(after.rejections[0]!.rejection.code).toBe("predates-watermark");
  });

  // A fresh thread has no rollout file yet, and its name carries a thread id we
  // only learn from `thread.started`. Ownership therefore comes from the SESSION
  // the file is named after — never from "a file appeared in this directory",
  // which without MCP is shared by every agent on the machine.
  describe("a rollout the turn created", () => {
    const SESSIONS = "C:/Users/dev/.codex/sessions";
    const MINE = "0193a1b2-0000-7000-8000-aaaaaaaaaaaa";
    const THEIRS = "0193a1b2-0000-7000-8000-bbbbbbbbbbbb";
    const sessionWatermark = (sessionId: string) => ({
      turnId: "turn-1",
      startedAt: "2026-09-15T00:00:00.000Z",
      marks: [{ kind: "session-file" as const, directory: SESSIONS, sessionId }],
    });
    const rollout = (threadId: string) =>
      `${SESSIONS}/2026/09/15/rollout-2026-09-15T10-00-00-${threadId}.jsonl`;
    const freshEvent = (path: string) => ({ ...event(10, 828_400), path });

    it("accepts a reading from the rollout this run's thread created", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", sessionWatermark(MINE));
      const after = m.recordObservation(t, freshEvent(rollout(MINE)));
      expect(after.rejections).toEqual([]);
      expect(after.observations).toHaveLength(1);
      expect(m.observationForTurn(after, "turn-1", "runtimeEffectiveWindow")?.value).toBe(828_400);
    });

    // THE concurrency case: both agents started a thread in the same shared
    // `~/.codex/sessions` at the same moment, so the other one's rollout is
    // also brand new. Only the session id in the name separates them.
    it("does not adopt a rollout another run created in the same directory", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", sessionWatermark(MINE));
      const after = m.recordObservation(t, freshEvent(rollout(THEIRS)));
      expect(after.observations).toEqual([]);
      expect(after.rejections[0]!.rejection.code).toBe("no-turn-correlation");
    });

    it("does not vouch for a file outside the marked directory", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", sessionWatermark(MINE));
      const after = m.recordObservation(t, freshEvent(`C:/elsewhere/rollout-${MINE}.jsonl`));
      expect(after.observations).toEqual([]);
      expect(after.rejections[0]!.rejection.code).toBe("no-turn-correlation");
    });

    it("does not vouch for a file in the directory that is not this session's", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", sessionWatermark(MINE));
      const after = m.recordObservation(t, freshEvent(`${SESSIONS}/2026/09/14/rollout-old.jsonl`));
      expect(after.observations).toEqual([]);
      expect(after.rejections[0]!.rejection.code).toBe("no-turn-correlation");
    });

    // Containment is a question about the RESOLVED path. `.../sessions/../..`
    // reads as inside and is not, so a prefix comparison would hand this file to
    // the run — the same false ownership the directory mark was removed for.
    it("does not vouch for a path that only reads as inside the directory", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", sessionWatermark(MINE));
      const after = m.recordObservation(
        t,
        freshEvent(`${SESSIONS}/../../elsewhere/rollout-${MINE}.jsonl`),
      );
      expect(after.observations).toEqual([]);
      expect(after.rejections[0]!.rejection.code).toBe("no-turn-correlation");
    });

    // The other direction: a legal child directory whose name merely STARTS with
    // the climb prefix is still inside. Rejecting it would be the same
    // lexical-vs-resolved mistake, mirrored.
    it("still vouches for a child directory named like a climb", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", sessionWatermark(MINE));
      const after = m.recordObservation(
        t,
        freshEvent(`${SESSIONS}/..cache/rollout-2026-09-15T10-00-00-${MINE}.jsonl`),
      );
      expect(after.rejections).toEqual([]);
      expect(after.observations).toHaveLength(1);
    });

    // Windows resolves `C:\Users\dev\.codex\sessions` and `c:\users\dev\.codex\
    // sessions` to one directory, so the same file has to be recognised either
    // way. (On a case-sensitive filesystem these ARE two paths, and the test does
    // not apply.)
    it.runIf(process.platform === "win32")("matches a differently cased spelling of the directory", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", sessionWatermark(MINE));
      const lowered = rollout(MINE).replace(SESSIONS, SESSIONS.toLowerCase());
      const after = m.recordObservation(t, freshEvent(lowered));
      expect(after.rejections).toEqual([]);
      expect(after.observations).toHaveLength(1);
    });

    // A mark that names no artifact covers nothing. An empty id matching the
    // `includes` test for free would make the directory mark's old
    // "anything new in here is mine" failure arrive through the session door.
    it("does not let a mark with an empty session id vouch for anything", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", sessionWatermark(""));
      const after = m.recordObservation(t, freshEvent(rollout(MINE)));
      expect(after.observations).toEqual([]);
      expect(after.rejections[0]!.rejection.code).toBe("no-turn-correlation");
    });

    // A session id is a file-name fragment. One carrying a separator is not an
    // id, and must not be allowed to widen the mark into a path prefix.
    it("does not let a session id with a path separator widen the mark", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", sessionWatermark(`../${MINE}`));
      const after = m.recordObservation(t, freshEvent(`${SESSIONS}/../rollout-${MINE}.jsonl`));
      expect(after.observations).toEqual([]);
      expect(after.rejections[0]!.rejection.code).toBe("no-turn-correlation");
    });

    // An exact `file` mark still wins over a session mark, so a rollout that
    // already existed keeps its offset check rather than getting a free pass.
    it("still applies the offset rule to a file that has its own mark", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", {
        ...sessionWatermark(MINE),
        marks: [
          { kind: "session-file" as const, directory: SESSIONS, sessionId: MINE },
          { kind: "file" as const, path: rollout(MINE), size: 4_096 },
        ],
      });
      const after = m.recordObservation(t, freshEvent(rollout(MINE)));
      expect(after.observations).toEqual([]);
      expect(after.rejections[0]!.rejection.code).toBe("predates-watermark");
    });

    // The same file reaches the planner spelled differently by different callers.
    // A spelling that resolves to the marked path must still HIT the file mark,
    // or the offset check silently stops running and the looser session rule
    // answers in its place.
    it("recognises an equivalent spelling of a marked file", () => {
      const t = m.emptyTelemetry(basePlan(), "run-1", {
        ...sessionWatermark(MINE),
        marks: [{ kind: "file" as const, path: rollout(MINE), size: 4_096 }],
      });
      const spelled = `${SESSIONS}/./2026/09/15/rollout-2026-09-15T10-00-00-${MINE}.jsonl`;
      const after = m.recordObservation(t, freshEvent(spelled));
      expect(after.observations).toEqual([]);
      expect(after.rejections[0]!.rejection.code).toBe("predates-watermark");
    });
  });

  it("rejects an event the artifact attributed to another turn", () => {
    const t = telemetryFor("turn-2", 0);
    const verdict = m.judgeObservation(t.watermark, event(9_999, 828_400, "turn-1"), RUN);
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.rejection.code).toBe("foreign-turn");
  });

  // The artifact can also name the RUN. A watermark vouches for one run only,
  // so a reading another run produced must not be adopted by this one.
  it("rejects an event the artifact attributed to another run", () => {
    const t = telemetryFor("turn-2", 0);
    const verdict = m.judgeObservation(
      t.watermark,
      { ...event(10, 828_400), runId: "run-2" },
      t.runId,
    );
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) {
      expect(verdict.rejection.code).toBe("foreign-run");
      expect(verdict.rejection.detail).toContain("run-2");
    }
  });

  it("accepts an event the artifact attributed to this run", () => {
    const t = telemetryFor("turn-2", 0);
    const after = m.recordObservation(t, { ...event(10, 828_400), runId: t.runId });
    expect(after.rejections).toEqual([]);
    expect(after.observations).toHaveLength(1);
  });

  // Accepting an event we cannot place would be assuming it is ours.
  it("rejects an event with no correlation anywhere", () => {
    const t = telemetryFor("turn-2", 0);
    const verdict = m.judgeObservation(
      t.watermark,
      { ...event(10, 828_400), path: "C:/sessions/some-other-file.jsonl" },
      RUN,
    );
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.rejection.code).toBe("no-turn-correlation");
  });

  it("returns the newest reading when a turn produced several", () => {
    let t = telemetryFor("turn-1", 0);
    t = m.recordObservation(t, { ...event(10, 828_400), observedAt: "2026-09-15T00:01:00.000Z" });
    t = m.recordObservation(t, { ...event(20, 700_000), observedAt: "2026-09-15T00:02:00.000Z" });
    expect(m.observationForTurn(t, "turn-1", "runtimeEffectiveWindow")?.value).toBe(700_000);
  });

  it("does not hand a previous turn's reading to the current turn", () => {
    const t1 = m.recordObservation(telemetryFor("turn-1", 0), event(10, 828_400));
    const t2 = { ...t1, turnId: "turn-2" };
    expect(m.observationForTurn(t2, "turn-2", "runtimeEffectiveWindow")).toBeUndefined();
    expect(m.observationForTurn(t2, "turn-1", "runtimeEffectiveWindow")?.value).toBe(828_400);
  });

  it("ties telemetry to the plan it came from", () => {
    const plan = basePlan();
    const t = m.emptyTelemetry(plan, "run-1", watermark("turn-1", 0));
    expect(t.planHash).toBe(plan.planHash);
    expect(t.runId).toBe("run-1");
    expect(t.turnId).toBe("turn-1");
    expect(t.observations).toEqual([]);
    expect(t.rejections).toEqual([]);
  });
});
