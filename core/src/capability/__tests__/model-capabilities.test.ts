import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The capability layer reads the override file, whose path resolves from
// AGENTORCH_DATA_DIR at MODULE LOAD. Point it at a throwaway dir before the
// first real import so a test can never read (or imply) the developer's own
// _data/context-window-overrides.json.
const TMP = mkdtempSync(join(tmpdir(), "model-capabilities-test-"));
process.env.AGENTORCH_DATA_DIR = TMP;

import type { ResolutionDiagnostic } from "../types.js";

// The dynamic imports below are the first thing that actually loads these
// modules, so they observe the AGENTORCH_DATA_DIR set above.
type CtxMod = typeof import("../../context-window.js");
type Mod = typeof import("../model-capabilities.js");
let ctx: CtxMod;
let m: Mod;

beforeAll(async () => {
  ctx = await import("../../context-window.js");
  m = await import("../model-capabilities.js");
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
  rmSync(ctx.contextWindowOverridesPath(), { force: true });
  ctx._resetContextWindowCache();
});

const writeOverrides = (body: unknown): void => {
  writeFileSync(ctx.contextWindowOverridesPath(), JSON.stringify(body), "utf8");
  ctx._resetContextWindowCache();
};

const diag = (diags: ResolutionDiagnostic[], field: string): ResolutionDiagnostic =>
  diags.find((d) => d.field === field)!;

describe("transport resolution", () => {
  // A native CLI is spoken to by launching it — that is a fact about the
  // runtime, not a guess about the model, so it survives with no metadata.
  it("resolves native CLIs without needing endpoint discovery", () => {
    expect(m.transportForRuntime("claude").value).toBe("native-cli");
    expect(m.transportForRuntime("codex").value).toBe("native-cli");
    expect(m.transportForRuntime("codex").origin).toBe("provider-discovered");
  });

  // The bug this guards: defaulting an HTTP route to chat-completions because
  // "that's what it used to be". Unknown is the honest answer until phase 1
  // probes the endpoint.
  it("leaves an HTTP route unknown rather than defaulting to chat", () => {
    const t = m.transportForRuntime("openai");
    expect(t.value).toBeUndefined();
    expect(t.value).not.toBe("chat-completions");
    expect(t.origin).toBe("unknown");
    expect(t.considered.some((c) => c.outcome === "absent" && /phase 1/.test(c.reason))).toBe(true);
  });
});

// Regression: `runtimeIdForProviderKind()` defaults an unknown kind to
// `claude`. That is fine for the display path it was written for, but here it
// would hand an unnamed runtime another runtime's identity.
describe("runtime scope", () => {
  it("does not borrow claude's identity for an unnamed runtime", () => {
    expect(m.runtimeScopeFor({ model: "x" })).toBe("unknown");
    expect(m.runtimeScopeFor({ model: "x", runtime: "" })).toBe("unknown");
    expect(m.runtimeScopeFor({ model: "x", runtime: "   " })).toBe("unknown");
    expect(m.runtimeScopeFor({ model: "x", runtime: "codex" })).toBe("codex");
  });

  it("uses the unknown runtime rather than defaulting anywhere downstream", () => {
    const { facts } = m.resolveModelCapabilities({ model: "gpt-5.6-sol" });
    expect(facts.scope.runtime).toBe("unknown");
    expect(facts.scope.providerScope).toBe("unknown/openai");
    expect(facts.scope.transport).toBe("unknown");
  });
});

describe("resolveModelCapabilities", () => {
  it("reports a confirmed catalog window with its provenance", () => {
    const { facts } = m.resolveModelCapabilities({
      model: "gpt-5.6-sol",
      runtime: "codex",
      runtimeVersion: "0.154.0",
    });
    expect(facts.advertisedContextWindow.value).toBe(1_050_000);
    expect(facts.advertisedContextWindow.confidence).toBe("confirmed");
    expect(facts.advertisedContextWindow.origin).toBe("catalog-confirmed");
    expect(facts.advertisedContextWindow.source).toContain("/models/gpt-5.6-sol");
    expect(facts.maxOutputTokens.value).toBe(128_000);
  });

  // The whole point of the layer: with no live reading, the effective window is
  // UNKNOWN. It must not quietly become the advertised figure.
  it("keeps the effective window unknown when nothing was observed", () => {
    const { facts } = m.resolveModelCapabilities({
      model: "gpt-5.6-sol",
      runtime: "codex",
      runtimeVersion: "0.199.0", // no profile matches this version
    });
    expect(facts.runtimeEffectiveWindow.value).toBeUndefined();
    expect(facts.runtimeEffectiveWindow.origin).toBe("unknown");
    expect(facts.advertisedContextWindow.value).toBe(1_050_000);
    expect(facts.runtimeEffectiveWindow.source).toContain("never the advertised figure");
    // The rungs that lost are recorded, which is what makes it auditable rather
    // than a silent hole.
    expect(facts.runtimeEffectiveWindow.considered.some((c) => c.outcome === "absent")).toBe(true);
  });

  it("prefers the live observation and says it outranks the profile", () => {
    const { facts } = m.resolveModelCapabilities({
      model: "gpt-5.6-sol",
      runtime: "codex",
      runtimeVersion: "0.154.0",
      sessionObservedWindow: 700_000,
      requestedWindow: 1_050_000,
    });
    expect(facts.runtimeEffectiveWindow.value).toBe(700_000);
    expect(facts.runtimeEffectiveWindow.origin).toBe("runtime-observed");
    expect(facts.runtimeEffectiveWindow.confidence).toBe("observed");
    expect(facts.runtimeEffectiveWindow.considered.some((c) => /outranks/.test(c.reason))).toBe(true);
  });

  it("marks a clamped reading in the diagnostic", () => {
    const { diagnostics } = m.resolveModelCapabilities({
      model: "gpt-5.6-sol",
      runtime: "codex",
      runtimeVersion: "0.154.0",
      sessionObservedWindow: 700_000,
      requestedWindow: 1_050_000,
    });
    const d = diag(diagnostics, "facts.runtimeEffectiveWindow");
    expect(d.status).toBe("resolved");
    expect(d.detail).toContain("clamps");
  });

  it("marks an unverified value degraded instead of resolved", () => {
    const { facts, diagnostics } = m.resolveModelCapabilities({
      model: "deepseek-chat",
      runtime: "claude",
    });
    expect(facts.advertisedContextWindow.value).toBe(64_000);
    expect(facts.advertisedContextWindow.confidence).toBe("unverified");
    const d = diag(diagnostics, "facts.advertisedContextWindow");
    expect(d.status).toBe("degraded");
  });

  // Per-field provenance: ONE result must carry different origins for different
  // fields at the same time. A group-level source could not express this.
  it("gives each field its own origin", () => {
    const { facts } = m.resolveModelCapabilities({
      model: "gpt-5.6-sol",
      runtime: "codex",
      runtimeVersion: "0.154.0",
      sessionObservedWindow: 700_000,
    });
    expect(facts.runtimeEffectiveWindow.origin).toBe("runtime-observed");
    expect(facts.advertisedContextWindow.origin).toBe("catalog-confirmed");
    expect(facts.reasoningLevels.origin).toBe("catalog-confirmed");
    expect(facts.reasoningLevels.confidence).toBe("confirmed");
    expect(facts.tools.parallelToolCalls.origin).toBe("unknown");
    // ...and they are genuinely independent objects, not one shared blob.
    expect(facts.runtimeEffectiveWindow).not.toBe(facts.advertisedContextWindow);
  });

  // A user's own number beats the catalog for DISPLAY, but it does not get to
  // borrow our provenance: an override with no stated confidence is unverified
  // and therefore cannot be declared.
  it("does not let a user override inherit confirmed confidence", () => {
    writeOverrides({ catalog: { "openai/gpt-5.6-sol": { advertisedContextWindow: 2_000_000 } } });
    const { facts } = m.resolveModelCapabilities({
      model: "gpt-5.6-sol",
      runtime: "codex",
      runtimeVersion: "0.154.0",
    });
    expect(facts.advertisedContextWindow.value).toBe(2_000_000);
    expect(facts.advertisedContextWindow.confidence).toBe("unverified");
    expect(facts.advertisedContextWindow.origin).toBe("catalog-unverified");
  });

  // A cap the user typed is not a cap we checked. The entry-level confidence
  // describes the ADVERTISED WINDOW, so reusing it for the output cap promotes a
  // user number to `catalog-confirmed` the moment they restate the window
  // figure in the same override.
  it("does not let a user's output cap inherit the entry's confirmed confidence", () => {
    writeOverrides({
      catalog: {
        "openai/gpt-5.6-sol": { advertisedContextWindow: 1_050_000, maxOutputTokens: 32_000 },
      },
    });
    const { facts } = m.resolveModelCapabilities({ model: "gpt-5.6-sol", runtime: "codex" });
    expect(facts.maxOutputTokens.value).toBe(32_000);
    expect(facts.maxOutputTokens.confidence).toBe("unverified");
    expect(facts.maxOutputTokens.origin).toBe("catalog-unverified");
    // ...while the window, which merely restates the catalog, keeps its rung.
    expect(facts.advertisedContextWindow.confidence).toBe("confirmed");
  });

  it("keeps the catalog's rung for an output cap that only restates it", () => {
    writeOverrides({ catalog: { "openai/gpt-5.6-sol": { maxOutputTokens: 128_000 } } });
    const { facts } = m.resolveModelCapabilities({ model: "gpt-5.6-sol", runtime: "codex" });
    expect(facts.maxOutputTokens.value).toBe(128_000);
    expect(facts.maxOutputTokens.confidence).toBe("confirmed");
  });

  // A standalone `maxOutputTokens` override used to be dropped on the floor:
  // `catalogEntry` only enters its override branch when the override also
  // carries a window. The cap has no reason to inherit that gate — a user who
  // writes a cap alone means it.
  it("honours a maxOutputTokens override that carries no window", () => {
    writeOverrides({ catalog: { "openai/gpt-5.6-sol": { maxOutputTokens: 32_000 } } });
    const { facts } = m.resolveModelCapabilities({ model: "gpt-5.6-sol", runtime: "codex" });
    expect(facts.maxOutputTokens.value).toBe(32_000);
    expect(facts.maxOutputTokens.confidence).toBe("unverified");
    // ...and it leaves the window to the catalog, which we did verify.
    expect(facts.advertisedContextWindow.value).toBe(1_050_000);
    expect(facts.advertisedContextWindow.confidence).toBe("confirmed");
  });

  it("keeps a legacy override display-only and says so", () => {
    writeOverrides({ models: { "gpt-5.6-sol": { maxInputTokens: 777_777 } } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { facts } = m.resolveModelCapabilities({ model: "gpt-5.6-sol", runtime: "codex" });
    expect(facts.advertisedContextWindow.value).toBe(777_777);
    expect(facts.advertisedContextWindow.origin).toBe("legacy-override");
    expect(facts.advertisedContextWindow.confidence).toBe("legacy");
    expect(facts.advertisedContextWindow.considered.some((c) => /no declaration rights/.test(c.reason))).toBe(true);
  });

  it("reports an unknown model as unknown everywhere, without inventing a value", () => {
    const { facts, diagnostics } = m.resolveModelCapabilities({
      model: "not-a-real-model-12345",
      runtime: "claude",
    });
    expect(facts.advertisedContextWindow.value).toBeUndefined();
    expect(facts.maxOutputTokens.value).toBeUndefined();
    expect(facts.runtimeEffectiveWindow.value).toBeUndefined();
    expect(facts.reasoningLevels.value).toBeUndefined();
    for (const d of diagnostics) {
      // `facts.transport` is the one diagnostic that is about the RUNTIME, not
      // about the model: a native CLI is spoken to by launching it, so that
      // field is legitimately resolved while everything model-shaped stays
      // unknown. Excluding it keeps the rule this test states — an unknown model
      // invents no model value — instead of weakening it.
      if (d.field === "facts.transport") continue;
      expect(d.status, d.field).not.toBe("resolved");
    }
  });

  // Claiming server conversation support we have not verified is how history
  // gets dropped. Only a native CLI proves it by construction.
  it("does not claim HTTP capabilities it has not discovered", () => {
    const { facts } = m.resolveModelCapabilities({ model: "gpt-5.6-sol", runtime: "openai" });
    expect(facts.supportsServerConversation.value).toBeUndefined();
    expect(facts.supportsNativeCompaction.value).toBeUndefined();
    expect(facts.tools.toolCalling.value).toBeUndefined();
    expect(facts.tools.mcp.value).toBeUndefined();
  });

  it("records native CLI capabilities as observed", () => {
    const { facts } = m.resolveModelCapabilities({
      model: "gpt-5.6-sol",
      runtime: "codex",
      runtimeVersion: "0.154.0",
    });
    expect(facts.supportsServerConversation.value).toBe(true);
    expect(facts.supportsNativeCompaction.value).toBe(true);
    expect(facts.tools.toolCalling.value).toBe(true);
    expect(facts.tools.mcp.value).toBe(true);
  });

  // Tool abilities fail separately, so they are separate fields. Parallel
  // calling is NOT assumed just because a native CLI can call tools at all.
  it("keeps the tool dimensions independent", () => {
    const { facts } = m.resolveModelCapabilities({
      model: "gpt-5.6-sol",
      runtime: "codex",
      runtimeVersion: "0.154.0",
    });
    expect(facts.tools.toolCalling.value).toBe(true);
    expect(facts.tools.parallelToolCalls.value).toBeUndefined();
    expect(facts.tools.builtinTools.value).toBeUndefined();
  });

  // Reasoning is a MODEL capability, read from the registry. `ultra` is the
  // level that proves it is not a copy of the global hint list: the vendor's own
  // catalog for this model lists it, and no enum in the codebase ever did.
  it("reads the model's ladder from the registry, including levels no hint list has", () => {
    const { facts, diagnostics } = m.resolveModelCapabilities({
      model: "gpt-5.6-sol",
      runtime: "codex",
    });
    expect(facts.reasoningLevels.value).toContain("ultra");
    expect(facts.reasoningLevels.value).toContain("medium");
    expect(facts.defaultReasoningLevel.value).toBe("low");
    expect(facts.reasoningLevels.origin).toBe("catalog-confirmed");
    const d = diag(diagnostics, "facts.reasoningLevels");
    expect(d.status).toBe("resolved");
    expect(d.detail).toContain("ultra");
    // The provenance names the artifact the ladder was read from, so a reader
    // can check it rather than trust it.
    expect(d.detail).toContain("codex CLI");
  });

  // The other half of the same rule: no evidence is not "no support". The plan
  // must not claim a model lacks a level it simply has no data for, because a
  // user-declared token is then allowed through as unverified.
  it("leaves the ladder unknown for a model with no evidence, without claiming it is unsupported", () => {
    const { facts, diagnostics } = m.resolveModelCapabilities({
      model: "not-a-real-model-12345",
      runtime: "codex",
    });
    expect(facts.reasoningLevels.value).toBeUndefined();
    expect(facts.defaultReasoningLevel.value).toBeUndefined();
    const d = diag(diagnostics, "facts.reasoningLevels");
    expect(d.status).toBe("unknown");
    expect(d.detail).toContain("no evidence");
    expect(d.detail).toContain("user-declared");
    expect(d.considered?.some((c) => c.outcome === "absent")).toBe(true);
  });

  it("keys the scope by provider so two routes cannot share facts", () => {
    const a = m.resolveModelCapabilities({ model: "gpt-5.6-sol", runtime: "openai", providerId: "prov-a" });
    const b = m.resolveModelCapabilities({ model: "gpt-5.6-sol", runtime: "openai", providerId: "prov-b" });
    expect(a.facts.scope.providerId).toBe("prov-a");
    expect(b.facts.scope.providerId).toBe("prov-b");
    expect(a.facts.scope.providerScope).toBe(b.facts.scope.providerScope);
  });

  it("states the priority ladder in one place", () => {
    expect(m.capabilityPriority()).toEqual([
      "user-declared",
      "runtime-observed",
      "provider-discovered",
      "catalog-confirmed",
      "catalog-unverified",
      "unknown",
    ]);
    // legacy is a display override, not a capability rung.
    expect(m.capabilityPriority()).not.toContain("legacy-override");
  });

  // Every diagnostic must be actionable on its own — a bare "unknown" with no
  // explanation is what made the old behaviour unauditable.
  it("gives every diagnostic a field, a status and a detail", () => {
    const { diagnostics } = m.resolveModelCapabilities({
      model: "not-a-real-model-12345",
      runtime: "openai",
    });
    expect(diagnostics.length).toBeGreaterThanOrEqual(4);
    for (const d of diagnostics) {
      expect(d.field, JSON.stringify(d)).toMatch(/^facts\./);
      expect(d.detail.length, d.field).toBeGreaterThan(0);
      expect(["resolved", "unknown", "degraded", "rejected"]).toContain(d.status);
    }
  });
});
