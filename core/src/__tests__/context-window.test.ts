import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The override file lives in the app data dir, which is resolved from
// AGENTORCH_DATA_DIR at MODULE LOAD. Point it at a throwaway dir before the
// first import so these tests can never touch the developer's real _data.
const TMP = mkdtempSync(join(tmpdir(), "context-window-test-"));
process.env.AGENTORCH_DATA_DIR = TMP;

// Type-only import: erased at runtime, so the dynamic import below is still the
// first thing that actually loads the module (after AGENTORCH_DATA_DIR is set).
import type { WindowScope } from "../context-window.js";

type Mod = typeof import("../context-window.js");
let m: Mod;

beforeAll(async () => {
  m = await import("../context-window.js");
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
  rmSync(m.contextWindowOverridesPath(), { force: true });
  m._resetContextWindowCache();
});

const writeOverrides = (body: unknown): void => {
  writeFileSync(m.contextWindowOverridesPath(), JSON.stringify(body), "utf8");
  m._resetContextWindowCache();
};

const codexSol = (runtimeVersion: string | null = "0.154.0"): WindowScope => ({
  runtime: "codex",
  vendor: "openai",
  runtimeVersion,
});

// ── Scope derivation ──────────────────────────────────────────────────────

describe("runtimeIdForProviderKind", () => {
  // Every kind in PROVIDER_KINDS (core/src/index.ts) must be handled: a missing
  // case silently gives one runtime another runtime's identity.
  it("maps every provider kind to a runtime", () => {
    expect(m.runtimeIdForProviderKind("openai-codex")).toBe("codex");
    expect(m.runtimeIdForProviderKind("openai-local")).toBe("openai");
    expect(m.runtimeIdForProviderKind("openai-compat")).toBe("openai");
    expect(m.runtimeIdForProviderKind("anthropic")).toBe("claude");
    expect(m.runtimeIdForProviderKind("anthropic-local")).toBe("claude");
  });

  // Regression: the official OpenAI provider used to fall through to "claude".
  it("never routes the official OpenAI provider to the Claude runtime", () => {
    expect(m.runtimeIdForProviderKind("openai-local")).not.toBe("claude");
  });

  it("falls back to claude only for an absent kind", () => {
    expect(m.runtimeIdForProviderKind(null)).toBe("claude");
    expect(m.runtimeIdForProviderKind(undefined)).toBe("claude");
  });
});

describe("vendorScopeForModel", () => {
  it("attributes model families to their vendor", () => {
    expect(m.vendorScopeForModel("gpt-5.6-sol")).toBe("openai");
    expect(m.vendorScopeForModel("o3-mini")).toBe("openai");
    expect(m.vendorScopeForModel("claude-opus-4-8")).toBe("anthropic");
    expect(m.vendorScopeForModel("deepseek-flash")).toBe("deepseek");
    expect(m.vendorScopeForModel("minimax-m3")).toBe("minimax");
    expect(m.vendorScopeForModel("glm-5.3")).toBe("zhipu");
  });

  it("does not attribute an unknown family to a vendor", () => {
    expect(m.vendorScopeForModel("some-random-model")).toBe("unknown");
    expect(m.vendorScopeForModel("")).toBe("unknown");
    expect(m.vendorScopeForModel(null)).toBe("unknown");
  });
});

describe("scopeForAgent", () => {
  it("combines runtime, vendor and version", () => {
    expect(m.scopeForAgent("gpt-5.6-sol", "openai-codex", "0.154.0")).toEqual({
      runtime: "codex",
      vendor: "openai",
      runtimeVersion: "0.154.0",
      providerId: null,
    });
    expect(m.scopeForAgent("deepseek-flash", "anthropic-local")).toEqual({
      runtime: "claude",
      vendor: "deepseek",
      runtimeVersion: null,
      providerId: null,
    });
  });

  it("carries the provider row so two providers can be told apart", () => {
    expect(m.scopeForAgent("deepseek-flash", "openai-compat", null, "prov-a").providerId)
      .toBe("prov-a");
    expect(m.scopeForAgent("deepseek-flash", "openai-compat", null, "prov-b").providerId)
      .toBe("prov-b");
  });
});

// ── Layer A: the catalog ──────────────────────────────────────────────────

describe("catalog carries provenance and a confidence", () => {
  it("every entry says where it came from, when, and how sure we are", () => {
    const missing = Object.entries(m.MODEL_CATALOG)
      .filter(([, e]) => !e.source || !e.verifiedAt || !e.confidence)
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });

  it("every entry has a positive advertised window and a vendor-scoped key", () => {
    for (const [k, entry] of Object.entries(m.MODEL_CATALOG)) {
      expect(entry.advertisedContextWindow, k).toBeGreaterThan(0);
      expect(k, k).toMatch(/^[a-z]+\/.+/);
      expect(["confirmed", "family-analogy", "unverified", "legacy"], k).toContain(entry.confidence);
    }
  });

  // The value that made this whole refactor necessary: a number derived by
  // analogy must never be dressed up as a checked one.
  it("values derived by analogy are never marked confirmed", () => {
    const analogies = Object.entries(m.MODEL_CATALOG)
      .filter(([, e]) => /not checked individually|no longer on the current page/i.test(e.source));
    for (const [k, entry] of analogies) {
      expect(entry.confidence, `${k} is an analogy but claims ${entry.confidence}`)
        .not.toBe("confirmed");
    }
    // Guard against the check silently becoming vacuous.
    expect(analogies.length).toBeGreaterThan(0);
  });

  // Review finding: these four were carried as `family-analogy` while the
  // vendor already publishes an individual page each. A per-model citation is
  // what makes `confirmed` (and therefore a runtime declaration) legitimate.
  it("cites each OpenAI model's OWN page, not a family index", () => {
    for (const [k, entry] of Object.entries(m.MODEL_CATALOG)) {
      if (!k.startsWith("openai/")) continue;
      const model = k.slice("openai/".length);
      expect(entry.source, `${model} (${entry.confidence})`).toContain(`/models/${model}`);
      expect(entry.confidence, model).toBe("confirmed");
    }
  });

  // The exact values the reviewer quoted, so a future edit cannot quietly
  // re-generalise the family.
  it("carries the gpt-5.6 family's real per-model figures", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"]) {
      expect(m.advertisedWindow(id), id).toBe(1_050_000);
      expect(m.maxOutputTokensFor(id), id).toBe(128_000);
      expect(m.MODEL_CATALOG[`openai/${id}`]!.confidence, id).toBe("confirmed");
    }
    // Cyber is the small-window member — assuming the family value here would
    // over-declare by 2.6×.
    expect(m.advertisedWindow("gpt-5.6-cyber")).toBe(400_000);
    expect(m.maxOutputTokensFor("gpt-5.6-cyber")).toBe(128_000);
  });

  it("treats bare gpt-5.6 as the alias the vendor redirects to gpt-5.6-sol", () => {
    expect(m.advertisedWindow("gpt-5.6")).toBe(1_050_000);
    expect(m.MODEL_CATALOG["openai/gpt-5.6"]!.source).toContain("/models/gpt-5.6");
  });

  it("lets the newly cited models drive a runtime declaration", () => {
    for (const id of ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"]) {
      expect(m.requestedRuntimeWindow(id, codexSol()), id).toBe(1_050_000);
    }
    expect(m.requestedRuntimeWindow("gpt-5.6-cyber", codexSol())).toBe(400_000);
  });
});

describe("maxOutputTokens", () => {
  it("is recorded for the core models we actually verified", () => {
    expect(m.maxOutputTokensFor("gpt-4o")).toBe(16_384);
    expect(m.maxOutputTokensFor("gpt-4o-mini")).toBe(16_384);
    expect(m.maxOutputTokensFor("o1")).toBe(100_000);
    expect(m.maxOutputTokensFor("o1-mini")).toBe(65_536);
    expect(m.maxOutputTokensFor("o3-mini")).toBe(100_000);
    expect(m.maxOutputTokensFor("gpt-5")).toBe(128_000);
  });

  it("is absent rather than guessed where we have no published figure", () => {
    expect(m.maxOutputTokensFor("deepseek-flash")).toBeNull();
    expect(m.maxOutputTokensFor("deepseek-v4-pro")).toBeNull();
    expect(m.maxOutputTokensFor("glm-4.5")).toBeNull();
  });

  // Documents the semantic distinction the schema has to keep: the advertised
  // context window and the max output cap are different published quantities.
  it("is a different quantity from the advertised context window", () => {
    expect(m.advertisedWindow("gpt-4o")).toBe(128_000);
    expect(m.maxOutputTokensFor("gpt-4o")).toBe(16_384);
    expect(m.maxOutputTokensFor("gpt-4o")).toBeLessThan(m.advertisedWindow("gpt-4o")!);
  });
});

describe("catalog vs vendored snapshot", () => {
  it("curated-vs-snapshot disagreements are all acknowledged", () => {
    const disagreements: string[] = [];
    for (const [k, entry] of Object.entries(m.MODEL_CATALOG)) {
      if (entry.confidence !== "confirmed") continue;
      const model = k.slice(k.indexOf("/") + 1);
      const snapshot = m.snapshotContextWindow(model);
      if (snapshot === null) continue;
      if (snapshot !== entry.advertisedContextWindow) {
        disagreements.push(`${model}: catalog ${entry.advertisedContextWindow} vs snapshot ${snapshot}`);
        if (!m.REVIEWED_SNAPSHOT_DISAGREEMENTS[model]) {
          throw new Error(
            `Unacknowledged catalog/snapshot disagreement — add it to ` +
              `REVIEWED_SNAPSHOT_DISAGREEMENTS with the reason: ${model} ` +
              `(catalog ${entry.advertisedContextWindow}, snapshot ${snapshot})`,
          );
        }
      }
    }
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it("an acknowledged disagreement that disappeared is stale", () => {
    const stale: string[] = [];
    for (const model of Object.keys(m.REVIEWED_SNAPSHOT_DISAGREEMENTS)) {
      const vendor = m.vendorScopeForModel(model);
      const entry = m.MODEL_CATALOG[`${vendor}/${model}`];
      expect(entry, `${model} is not a catalog model`).toBeDefined();
      const snapshot = m.snapshotContextWindow(model);
      if (snapshot === entry!.advertisedContextWindow) stale.push(model);
    }
    expect(stale).toEqual([]);
  });
});

describe("advertisedWindow", () => {
  it("returns the documented capacity within the vendor scope", () => {
    expect(m.advertisedWindow("gpt-5.6-sol", "openai")).toBe(1_050_000);
    expect(m.advertisedWindow("GPT-5.6-SOL", "OPENAI")).toBe(1_050_000);
    expect(m.advertisedWindow("deepseek-flash", "deepseek")).toBe(1_000_000);
  });

  // Scope isolation: an id we only documented for one vendor must not be
  // answered from another vendor's entry.
  it("does not answer across vendor scopes", () => {
    expect(m.advertisedWindow("gpt-5.6-sol", "unknown")).not.toBe(1_050_000);
    expect(m.advertisedWindow("deepseek-flash", "openai")).not.toBe(1_000_000);
  });

  it("falls back to the snapshot for the long tail, flagged unverified", () => {
    const snap = m.snapshotContextWindow("gpt-5.1");
    if (snap !== null) {
      const e = m.catalogEntry("gpt-5.1", "openai");
      expect(e!.advertisedContextWindow).toBe(snap);
      expect(e!.confidence).toBe("unverified");
    }
  });

  it("knows nothing about a truly unknown model", () => {
    expect(m.advertisedWindow("not-a-real-model-12345")).toBeNull();
  });
});

// ── Layer B: the runtime's effective window ───────────────────────────────

describe("runtime profiles", () => {
  it("keys profiles by runtime AND vendor AND model", () => {
    for (const k of Object.keys(m.RUNTIME_WINDOW_PROFILES)) {
      expect(k.split("/")).toHaveLength(3);
    }
  });

  it("every profile states the condition it was measured under", () => {
    for (const [k, p] of Object.entries(m.RUNTIME_WINDOW_PROFILES)) {
      expect(p.measuredUnder, k).toBeTruthy();
      expect(p.source, k).toBeTruthy();
    }
  });

  // Item 3: the 828,400 effective window comes from the DECLARED-1.05M
  // configuration; 258,400 is codex's compaction point under the DEFAULT 272k
  // configuration. Putting them in one record would describe a configuration
  // nobody measured, so the threshold must stay null until re-measured.
  it("never stitches numbers from different configuration conditions", () => {
    const p = m.RUNTIME_WINDOW_PROFILES["codex/openai/gpt-5.6-sol"]!;
    expect(p.runtimeEffectiveWindow).toBe(828_400);
    expect(p.compactionThreshold).toBeNull();
    expect(p.measuredUnder).toMatch(/1,050,000/);
    expect(p.measuredUnder).not.toMatch(/default/i);
    // And nothing in the tree silently re-adds the default-mode number.
    expect(m.compactionThreshold("gpt-5.6-sol", codexSol())).toBeNull();
  });

  it("is not applied on a different runtime version", () => {
    expect(m.runtimeWindowProfile("gpt-5.6-sol", codexSol("0.200.0"))).toBeNull();
    expect(m.runtimeWindowProfile("gpt-5.6-sol", codexSol(null))).toBeNull();
  });

  it("is not applied to a different runtime or vendor", () => {
    expect(
      m.runtimeWindowProfile("gpt-5.6-sol", { runtime: "claude", vendor: "openai", runtimeVersion: "0.154.0" }),
    ).toBeNull();
    expect(
      m.runtimeWindowProfile("gpt-5.6-sol", { runtime: "codex", vendor: "unknown", runtimeVersion: "0.154.0" }),
    ).toBeNull();
  });
});

describe("effectiveWindow", () => {
  it("prefers a session observation over the static profile", () => {
    const win = m.effectiveWindow("gpt-5.6-sol", {
      ...codexSol(),
      sessionObserved: 900_000,
    });
    expect(win).toEqual({
      tokens: 900_000,
      origin: "session-observed",
      runtimeVersion: "0.154.0",
      observedAt: null,
      clamped: false,
    });
  });

  it("uses a version-matched runtime profile when the session reported none", () => {
    const win = m.effectiveWindow("gpt-5.6-sol", codexSol());
    expect(win).toMatchObject({
      tokens: 828_400,
      origin: "runtime-profile",
      runtimeVersion: "0.154.0",
      observedAt: "2026-09-15",
    });
  });

  it("flags a clamped window — the request was bigger than what we got", () => {
    const win = m.effectiveWindow("gpt-5.6-sol", {
      ...codexSol(),
      requested: m.requestedRuntimeWindow("gpt-5.6-sol", codexSol()),
    });
    expect(win!.clamped).toBe(true);
    expect(win!.tokens).toBeLessThan(m.advertisedWindow("gpt-5.6-sol", "openai")!);
  });

  // The single most important behaviour change: an unknown ceiling must read as
  // unknown, not be silently replaced by the model's advertised capacity.
  it("never falls back to the advertised capacity", () => {
    expect(m.advertisedWindow("gpt-5.6-terra", "openai")).toBe(1_050_000);
    expect(m.effectiveWindow("gpt-5.6-terra", codexSol())).toBeNull();
  });

  it("never falls back to the snapshot either", () => {
    expect(
      m.effectiveWindow("deepseek-chat", {
        runtime: "claude",
        vendor: "deepseek",
        runtimeVersion: "1.0.0",
      }),
    ).toBeNull();
  });
});

describe("compactionThreshold", () => {
  it("is unknown for every scope we have not measured it under", () => {
    expect(m.compactionThreshold("gpt-5.6-sol", codexSol("0.200.0"))).toBeNull();
    expect(m.compactionThreshold("deepseek-flash", {
      runtime: "claude",
      vendor: "deepseek",
      runtimeVersion: "1.0.0",
    })).toBeNull();
  });

  // A compaction policy is never derived from the catalog or from maxOutput
  // tokens — those describe different things.
  it("is not derived from the advertised window or the output cap", () => {
    const scope: WindowScope = { runtime: "claude", vendor: "openai", runtimeVersion: "1.0.0" };
    expect(m.advertisedWindow("gpt-4o", "openai")).toBe(128_000);
    expect(m.compactionThreshold("gpt-4o", scope)).toBeNull();
  });
});

// ── The policy gate: what may reach a config file ─────────────────────────

describe("requestedRuntimeWindow (policy gate)", () => {
  it("returns the confirmed capacity for a runtime whose key is verified", () => {
    expect(
      m.requestedRuntimeWindow("deepseek-flash", { runtime: "claude", vendor: "deepseek" }),
    ).toBe(1_000_000);
    expect(m.requestedRuntimeWindow("gpt-5.6-sol", codexSol())).toBe(1_050_000);
  });

  // The family-analogy tier is currently empty (every OpenAI id now has its own
  // page), but the GATE has to keep working for the next un-verified family.
  it("refuses to declare a family analogy to any runtime", () => {
    writeOverrides({
      catalog: {
        "openai/gpt-9-nova": {
          advertisedContextWindow: 1_050_000,
          source: "family analogy; not checked individually",
          verifiedAt: "2026-09-15",
          confidence: "family-analogy",
        },
      },
    });
    expect(m.requestedRuntimeWindow("gpt-9-nova", codexSol())).toBeNull();
    // ...but it is still available for DISPLAY.
    expect(m.advertisedWindow("gpt-9-nova", "openai")).toBe(1_050_000);
  });

  it("refuses to declare an unverified value", () => {
    expect(
      m.requestedRuntimeWindow("deepseek-chat", { runtime: "claude", vendor: "deepseek" }),
    ).toBeNull();
  });

  // The in-process OpenAI runtime has no verified config key for the window.
  it("refuses to declare anything for a runtime with unverified semantics", () => {
    expect(
      m.requestedRuntimeWindow("gpt-5.6-sol", { runtime: "openai", vendor: "openai" }),
    ).toBeNull();
    expect(m.requestedRuntimeWindow("deepseek-flash", { runtime: "other", vendor: "deepseek" }))
      .toBeNull();
  });

  it("refuses to declare across vendor scopes", () => {
    expect(m.requestedRuntimeWindow("gpt-5.6-sol", { runtime: "codex", vendor: "unknown" }))
      .toBeNull();
  });

  it("refuses to declare for an unknown model", () => {
    expect(m.requestedRuntimeWindow("not-a-real-model-12345", codexSol())).toBeNull();
  });
});

// ── Overrides: field-scoped, scope-aware, and legacy-compatible ───────────

describe("user overrides", () => {
  it("a catalog override replaces the advertised value", () => {
    writeOverrides({ catalog: { "openai/gpt-5.6-sol": { advertisedContextWindow: 2_000_000 } } });
    expect(m.advertisedWindow("gpt-5.6-sol", "openai")).toBe(2_000_000);
  });

  it("an override can promote a family analogy to confirmed", () => {
    writeOverrides({
      catalog: {
        "openai/gpt-5.6-terra": {
          advertisedContextWindow: 1_050_000,
          source: "our own probe",
          verifiedAt: "2026-09-15",
          confidence: "confirmed",
        },
      },
    });
    expect(m.requestedRuntimeWindow("gpt-5.6-terra", codexSol())).toBe(1_050_000);
  });

  it("a runtime override changes the effective window, not the advertised one", () => {
    writeOverrides({
      runtime: {
        "codex/openai/gpt-5.6-sol": {
          runtimeEffectiveWindow: 700_000,
          runtimeVersion: "0.154.0",
          observedAt: "2026-09-15",
          measuredUnder: "user probe",
        },
      },
    });
    expect(m.advertisedWindow("gpt-5.6-sol", "openai")).toBe(1_050_000);
    expect(m.effectiveWindow("gpt-5.6-sol", codexSol())!.tokens).toBe(700_000);
  });

  it("a runtime override does not leak to another runtime or vendor", () => {
    writeOverrides({
      runtime: {
        "codex/openai/gpt-5.6-sol": {
          runtimeEffectiveWindow: 700_000,
          runtimeVersion: "0.154.0",
          observedAt: "2026-09-15",
          measuredUnder: "user probe",
        },
      },
    });
    expect(
      m.effectiveWindow("gpt-5.6-sol", {
        runtime: "claude",
        vendor: "openai",
        runtimeVersion: "0.154.0",
      }),
    ).toBeNull();
  });

  it("a malformed override file is ignored, not fatal", () => {
    writeFileSync(m.contextWindowOverridesPath(), "{ not json", "utf8");
    m._resetContextWindowCache();
    expect(m.advertisedWindow("gpt-5.6-sol", "openai")).toBe(1_050_000);
  });

  // A file containing literal `null` used to leave the memo null, and the
  // legacy warning re-entered the loader — infinite recursion. The memo must
  // always hold an object.
  it("survives a JSON file that is not an object", () => {
    for (const body of ["null", "[]", "42", '"a string"', "true"]) {
      writeFileSync(m.contextWindowOverridesPath(), body, "utf8");
      m._resetContextWindowCache();
      expect(m.loadContextWindowOverrides(), body).toEqual({});
      expect(m.advertisedWindow("gpt-5.6-sol", "openai"), body).toBe(1_050_000);
    }
  });

  it("ignores non-object sections and non-object entries", () => {
    writeOverrides({ catalog: "nope", runtime: [1, 2], models: null });
    expect(m.loadContextWindowOverrides()).toEqual({
      catalog: undefined,
      runtime: undefined,
      models: undefined,
    });
    expect(m.requestedRuntimeWindow("gpt-5.6-sol", codexSol())).toBe(1_050_000);
    writeOverrides({ catalog: { "openai/gpt-5.6-sol": "nope" } });
    expect(m.advertisedWindow("gpt-5.6-sol", "openai")).toBe(1_050_000);
  });

  // The interface promises case-insensitive keys; normalizing at LOAD time is
  // what makes that true for every lookup path at once.
  it("honours mixed-case keys in every section", () => {
    writeOverrides({
      catalog: { "OpenAI/GPT-5.6-SOL": { advertisedContextWindow: 2_000_000 } },
      runtime: {
        "Codex/OpenAI/GPT-5.6-SOL": {
          runtimeEffectiveWindow: 700_000,
          runtimeVersion: "0.154.0",
          observedAt: "2026-09-15",
          measuredUnder: "user probe",
        },
      },
      models: { "GPT-5.6-TERRA": { maxInputTokens: 888_888 } },
    });
    expect(m.advertisedWindow("gpt-5.6-sol", "openai")).toBe(2_000_000);
    expect(m.effectiveWindow("gpt-5.6-sol", codexSol())!.tokens).toBe(700_000);
    expect(m.advertisedWindow("gpt-5.6-terra")).toBe(888_888);
  });
});

// Review finding: two openai-compat providers can serve the same model id with
// different real limits, so an override must be pinnable to one provider row.
describe("provider-pinned overrides", () => {
  const pin = (providerId: string, tokens: number) => ({
    catalog: { [`openai/gpt-5.6-sol#${providerId}`]: { advertisedContextWindow: tokens } },
  });

  it("prefers the pinned entry over the broad one", () => {
    writeOverrides({
      catalog: {
        "openai/gpt-5.6-sol": { advertisedContextWindow: 1_500_000 },
        "openai/gpt-5.6-sol#prov-a": { advertisedContextWindow: 640_000 },
      },
    });
    expect(m.advertisedWindow("gpt-5.6-sol", "openai", { providerId: "prov-a" })).toBe(640_000);
    expect(m.advertisedWindow("gpt-5.6-sol", "openai", { providerId: "prov-b" })).toBe(1_500_000);
  });

  it("keeps one provider's pinned value out of another provider's scope", () => {
    writeOverrides(pin("prov-a", 640_000));
    expect(m.advertisedWindow("gpt-5.6-sol", "openai", { providerId: "prov-a" })).toBe(640_000);
    expect(m.advertisedWindow("gpt-5.6-sol", "openai", { providerId: "prov-b" })).toBe(1_050_000);
    expect(m.advertisedWindow("gpt-5.6-sol", "openai")).toBe(1_050_000);
  });

  it("pins runtime overrides the same way", () => {
    writeOverrides({
      runtime: {
        "codex/openai/gpt-5.6-sol#prov-a": {
          runtimeEffectiveWindow: 512_000,
          runtimeVersion: "0.154.0",
          observedAt: "2026-09-15",
          measuredUnder: "user probe on gateway A",
        },
      },
    });
    const pinned = m.effectiveWindow("gpt-5.6-sol", { ...codexSol(), providerId: "prov-a" })!;
    expect(pinned.tokens).toBe(512_000);
    // Another provider still gets the built-in codex profile.
    expect(m.effectiveWindow("gpt-5.6-sol", { ...codexSol(), providerId: "prov-b" })!.tokens)
      .toBe(828_400);
  });

  it("does not treat a pinned key as an unpinned one", () => {
    writeOverrides(pin("prov-a", 640_000));
    expect(m.loadContextWindowOverrides().catalog!["openai/gpt-5.6-sol"]).toBeUndefined();
  });
});

// Item 5: the pre-scope shape must not be silently dropped.
describe("legacy override files", () => {
  const legacy = { models: { "gpt-5.6-sol": { maxInputTokens: 777_777 } } };

  it("are still read, migrated into the vendor-scoped catalog", () => {
    writeOverrides(legacy);
    expect(m.advertisedWindow("gpt-5.6-sol", "openai")).toBe(777_777);
  });

  it("are marked legacy, never confirmed", () => {
    writeOverrides(legacy);
    expect(m.catalogEntry("gpt-5.6-sol", "openai")!.confidence).toBe("legacy");
    expect(m.catalogEntry("gpt-5.6-sol", "openai")!.source).toMatch(/legacy/i);
  });

  // Display-only: an unverified hand-written number must not become a runtime
  // declaration just because it was lying around in the user's config.
  it("are never the number we declare to a runtime", () => {
    writeOverrides(legacy);
    const declared = m.requestedRuntimeWindow("gpt-5.6-sol", codexSol());
    expect(declared).not.toBe(777_777);
  });

  it("grant no declaration rights at all for a model we have not confirmed", () => {
    writeOverrides({ models: { "my-custom-model": { maxInputTokens: 500_000 } } });
    expect(m.advertisedWindow("my-custom-model")).toBe(500_000); // display: yes
    expect(m.requestedRuntimeWindow("my-custom-model", {
      runtime: "codex",
      vendor: "unknown",
      runtimeVersion: "0.154.0",
    })).toBeNull(); // policy: no
  });

  // The converse of the rule above: a stale legacy entry must not *disable* the
  // confirmed declaration either — that is what left codex on its 272k default.
  it("do not suppress a confirmed declaration we already hold", () => {
    writeOverrides(legacy);
    expect(m.requestedRuntimeWindow("gpt-5.6-sol", codexSol())).toBe(1_050_000);
  });

  it("resolve a model the catalog and the snapshot both lack", () => {
    writeOverrides({ models: { "my-custom-model": { maxInputTokens: 500_000 } } });
    expect(m.catalogEntry("my-custom-model")!.confidence).toBe("legacy");
    expect(m.advertisedWindow("not-a-real-model-12345")).toBeNull();
  });

  it("emit a diagnosable warning naming the file and the ids", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeOverrides(legacy);
    m.loadContextWindowOverrides();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain("context-window-overrides.json");
    expect(msg).toContain("gpt-5.6-sol");
    expect(msg).toMatch(/legacy/i);
    // The suggested replacement must not hand out declaration rights by default:
    // copying the example verbatim has to land on `unverified`, and `confirmed`
    // may only appear as the thing you write AFTER checking the vendor docs.
    expect(msg).toContain('"confidence":"unverified"');
    expect(msg).toMatch(/vendor'?s own\s+documentation/i);
  });

  it("warn once, not once per lookup", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeOverrides(legacy);
    // Every read path goes through the catalog layer; the user must not get a
    // warning per context-bar refresh.
    m.advertisedWindow("gpt-5.6-sol", "openai");
    m.catalogEntry("gpt-5.6-sol", "openai");
    m.maxOutputTokensFor("gpt-5.6-sol", "openai");
    m.requestedRuntimeWindow("gpt-5.6-sol", codexSol());
    m.effectiveWindow("gpt-5.6-sol", codexSol());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("do not warn when there is no legacy section", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeOverrides({ catalog: { "openai/gpt-5.6-sol": { advertisedContextWindow: 1 } } });
    m.loadContextWindowOverrides();
    expect(warn).not.toHaveBeenCalled();
  });

  it("lose to a scoped catalog override for the same model", () => {
    writeOverrides({
      models: { "gpt-5.6-sol": { maxInputTokens: 777_777 } },
      catalog: { "openai/gpt-5.6-sol": { advertisedContextWindow: 999_999 } },
    });
    expect(m.advertisedWindow("gpt-5.6-sol", "openai")).toBe(999_999);
  });
});

// /status and the pane both render the same ContextUsage object, so the
// provenance of the advertised figure has to travel on it — otherwise a legacy
// or unverified number reaches the user looking like settled fact.
describe("advertised-figure provenance reaches ContextUsage", () => {
  let usage: typeof import("../context-usage.js");

  beforeAll(async () => {
    usage = await import("../context-usage.js");
  });

  const codexScope = { runtime: "codex", vendor: "openai", runtimeVersion: "0.154.0" };

  it("marks a confirmed catalog value as confirmed, with its source", () => {
    const u = usage.contextUsageFromUsedTokens("gpt-5.6-sol", codexScope, 100_000)!;
    expect(u.advertisedContextWindow).toBe(1_050_000);
    expect(u.advertisedWindowConfidence).toBe("confirmed");
    expect(u.advertisedWindowSource).toContain("developers.openai.com/api/docs/models/gpt-5.6-sol");
  });

  it("marks a family analogy as such", () => {
    writeOverrides({
      catalog: {
        "openai/gpt-9-nova": {
          advertisedContextWindow: 1_050_000,
          source: "family analogy; not checked individually",
          verifiedAt: "2026-09-15",
          confidence: "family-analogy",
        },
      },
    });
    const u = usage.contextUsageFromUsedTokens("gpt-9-nova", codexScope, 100_000)!;
    expect(u.advertisedWindowConfidence).toBe("family-analogy");
  });

  it("marks a legacy-migrated value as legacy", () => {
    writeOverrides({ models: { "gpt-5.6-sol": { maxInputTokens: 777_777 } } });
    const u = usage.contextUsageFromUsedTokens("gpt-5.6-sol", codexScope, 100_000)!;
    expect(u.advertisedContextWindow).toBe(777_777);
    expect(u.advertisedWindowConfidence).toBe("legacy");
    expect(u.advertisedWindowSource).toMatch(/legacy/i);
  });

  it("marks an unverified snapshot value as unverified", () => {
    const u = usage.contextUsageFromUsedTokens(
      "deepseek-chat",
      { runtime: "claude", vendor: "deepseek" },
      100,
    )!;
    expect(u.advertisedWindowConfidence).toBe("unverified");
  });
});

// ── Display must not write config ─────────────────────────────────────────

describe("reading facts never writes config", () => {
  it("display resolvers leave no override file behind", () => {
    expect(existsSync(m.contextWindowOverridesPath())).toBe(false);
    m.advertisedWindow("gpt-5.6-sol", "openai");
    m.maxOutputTokensFor("gpt-4o", "openai");
    m.effectiveWindow("gpt-5.6-sol", codexSol());
    m.compactionThreshold("gpt-5.6-sol", codexSol());
    m.catalogEntry("deepseek-flash", "deepseek");
    expect(existsSync(m.contextWindowOverridesPath())).toBe(false);
  });

  it("the policy gate does not mutate the override file either", () => {
    m.requestedRuntimeWindow("gpt-5.6-sol", codexSol());
    expect(existsSync(m.contextWindowOverridesPath())).toBe(false);
  });

  it("the override file, once written, is only ever read", () => {
    writeOverrides({ catalog: { "openai/gpt-5.6-sol": { advertisedContextWindow: 2_000_000 } } });
    const before = readFileSync(m.contextWindowOverridesPath(), "utf8");
    m.advertisedWindow("gpt-5.6-sol", "openai");
    m.requestedRuntimeWindow("gpt-5.6-sol", codexSol());
    expect(readFileSync(m.contextWindowOverridesPath(), "utf8")).toBe(before);
  });
});
