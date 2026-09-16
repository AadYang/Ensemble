import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedCapability, RunPlanTransport } from "../types.js";
import type { TransportProbeEntry, TransportProbeStore } from "../transport-probe.js";

// The probe WRITER is backed by AppSetting, and `db.js` decides which sqlite file
// that is AT MODULE LOAD — so the data dir has to be redirected before anything
// imports it. Static imports are hoisted above this assignment, hence the
// dynamic imports in `beforeAll` (same pattern as run-plan.test.ts).
const TMP = mkdtempSync(join(tmpdir(), "transport-phase1-"));
process.env.AGENTORCH_DATA_DIR = TMP;
process.env.AGENTORCH_DB_PATH = join(TMP, "phase1.db");

let errs: typeof import("../transport-errors.js");
let probe: typeof import("../transport-probe.js");
let tr: typeof import("../transport.js");
let marks: typeof import("../marks.js");
let plans: typeof import("../run-plan.js");
let db: typeof import("../../db.js");

beforeAll(async () => {
  errs = await import("../transport-errors.js");
  probe = await import("../transport-probe.js");
  tr = await import("../transport.js");
  marks = await import("../marks.js");
  plans = await import("../run-plan.js");
  db = await import("../../db.js");
});

afterAll(() => {
  // Windows will not delete a directory whose sqlite file is still open, and
  // the AppSetting-backed probe writer opens one.
  try {
    db?.closeDb();
  } catch {
    // already closed / never opened — the cleanup below is what matters.
  }
  rmSync(TMP, { recursive: true, force: true });
});

const classify = (...args: Parameters<typeof errs.classifyTransportError>) =>
  errs.classifyTransportError(...args);

// ── helpers ───────────────────────────────────────────────────────────────

function memoryStore(): TransportProbeStore & { entries: TransportProbeEntry[]; writes: number } {
  const store = {
    entries: [] as TransportProbeEntry[],
    writes: 0,
    read: () => store.entries,
    write: (entries: TransportProbeEntry[]) => {
      store.writes += 1;
      store.entries = entries;
    },
  };
  return store;
}

function countingFetch(respond: () => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: () => number;
} {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

/** A `fetch` that fails if anything asks it a question — the assertion that no
 *  network is touched, made by making the network throw. */
const forbiddenFetch = (() => {
  throw new Error("this path must not touch the network");
}) as unknown as typeof fetch;

const jsonResponse = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fact = (
  value: RunPlanTransport | undefined,
  origin: ResolvedCapability<RunPlanTransport>["origin"],
  confidence: ResolvedCapability<RunPlanTransport>["confidence"],
): ResolvedCapability<RunPlanTransport> => ({
  value,
  origin,
  confidence,
  source: "test fact",
  considered: [],
});

const probeEntry = (over: Partial<TransportProbeEntry> = {}): TransportProbeEntry => ({
  providerId: "p1",
  baseUrl: "https://api.example.com/v1",
  transport: "responses",
  outcome: "supported",
  httpStatus: 200,
  upstreamCode: null,
  upstreamType: null,
  detail: "ok",
  probedAt: new Date().toISOString(),
  method: "responses-route-probe",
  ...over,
});

// ══ 1. error classification ═══════════════════════════════════════════════
//
// Only `unsupported` may move a turn to another transport. Every other way an
// HTTP call fails has to land in its own class, decided from structured fields.

describe("classifyTransportError", () => {
  it("treats a missing route as unsupported", () => {
    for (const status of [404, 405, 501]) {
      const c = classify({ status, message: "whatever the body said" });
      expect(c.classification).toBe("unsupported");
      expect(c.httpStatus).toBe(status);
    }
  });

  it("treats an explicit upstream code as unsupported even on a 400", () => {
    const c = classify({
      status: 400,
      error: { code: "unsupported_endpoint", type: "invalid_request_error" },
    });
    expect(c.classification).toBe("unsupported");
    expect(c.upstreamCode).toBe("unsupported_endpoint");
    expect(c.upstreamType).toBe("invalid_request_error");
  });

  it("does not classify by prose", () => {
    // The exact sentence that must NOT become a fallback: the endpoint answered
    // us, so the route exists. A wording change upstream must not move a turn.
    const c = classify({
      status: 400,
      message: "404: the model was not found / this is an unsupported endpoint",
    });
    expect(c.classification).toBe("request");
  });

  it("separates auth, quota, server and plain request failures", () => {
    expect(classify({ status: 401 }).classification).toBe("auth");
    expect(classify({ status: 403 }).classification).toBe("auth");
    expect(classify({ status: 429 }).classification).toBe("rate-limit");
    expect(classify({ status: 500 }).classification).toBe("server");
    expect(classify({ status: 503 }).classification).toBe("server");
    expect(classify({ status: 422 }).classification).toBe("request");
  });

  it("calls a failure with no status a network failure", () => {
    expect(classify(new Error("fetch failed")).classification).toBe("network");
    expect(classify({ name: "AbortError", message: "aborted" }).classification).toBe("network");
  });

  it("reads the SDK's wrapped cause chain, not just the outer error", () => {
    // @openai/agents raises its own error with the provider's APIError below it.
    const c = classify({
      name: "AgentsError",
      message: "provider call failed",
      cause: { status: 404, error: { code: "endpoint_not_found" } },
    });
    expect(c.classification).toBe("unsupported");
    expect(c.httpStatus).toBe(404);
    expect(c.upstreamCode).toBe("endpoint_not_found");
  });

  it("lets auth, quota and server failures outrank any error code", () => {
    // A vendor that answers 401 with `unsupported_endpoint` is telling us about
    // the KEY. Reading the code first would switch transports and hide a real,
    // fixable failure behind a route change.
    expect(classify({ status: 401, error: { code: "unsupported_endpoint" } }).classification).toBe(
      "auth",
    );
    expect(classify({ status: 403, error: { code: "not_implemented" } }).classification).toBe("auth");
    expect(classify({ status: 429, error: { code: "unsupported_transport" } }).classification).toBe(
      "rate-limit",
    );
    expect(classify({ status: 500, error: { code: "endpoint_not_found" } }).classification).toBe(
      "server",
    );
    expect(classify({ status: 502, error: { code: "no_such_route" } }).classification).toBe("server");
  });

  it("reads a 404 that names a model or a resource as that failure, not the route", () => {
    // A gateway that validates the model before the path answers every unknown
    // URL this way. Treating it as "no /responses" would strand an auto turn on
    // a transport that works.
    const model = classify({ status: 404, error: { code: "model_not_found" } });
    expect(model.classification).toBe("request");
    expect(model.upstreamCode).toBe("model_not_found");
    expect(classify({ status: 404, error: { code: "resource_not_found" } }).classification).toBe(
      "request",
    );
    // A bare 404 — nothing structured — is the plainest "no such route".
    expect(classify({ status: 404 }).classification).toBe("unsupported");
    // And a 404 that names the ROUTE is still unsupported.
    expect(classify({ status: 404, error: { code: "endpoint_not_found" } }).classification).toBe(
      "unsupported",
    );
    expect(classify({ status: 404, error: { code: "no_such_route" } }).classification).toBe(
      "unsupported",
    );
  });

  it("calls 405 and 501 unsupported regardless of an unrelated code", () => {
    expect(classify({ status: 405, error: { code: "model_not_found" } }).classification).toBe(
      "unsupported",
    );
    expect(classify({ status: 501 }).classification).toBe("unsupported");
  });

  it("offers a sibling only for the two HTTP transports", () => {
    expect(errs.siblingTransport("responses")).toBe("chat-completions");
    expect(errs.siblingTransport("chat-completions")).toBe("responses");
    expect(errs.siblingTransport("native-cli")).toBeNull();
    expect(errs.siblingTransport("unknown")).toBeNull();
  });
});

// ══ 2. probe caching ══════════════════════════════════════════════════════

describe("transport probe cache", () => {
  it("normalizes the two spellings of one endpoint into one key", () => {
    expect(probe.normalizeBaseUrlKey("https://API.Example.com:443/v1/")).toBe(
      "https://api.example.com/v1",
    );
    expect(probe.normalizeBaseUrlKey("http://api.example.com:80/v1")).toBe(
      "http://api.example.com/v1",
    );
    expect(probe.transportProbeKey("p", "https://API.example.com/v1/")).toBe(
      probe.transportProbeKey("p", "https://api.example.com/v1"),
    );
  });

  it("expires a verdict after 24h", () => {
    const store = memoryStore();
    const probedAt = new Date(Date.now() - (probe.TRANSPORT_PROBE_TTL_MS + 60_000)).toISOString();
    store.write([probeEntry({ probedAt })]);
    expect(probe.readCachedProbe("p1", "https://api.example.com/v1", new Date(), store)).toBeNull();
  });

  it("never stores an inconclusive attempt", () => {
    const store = memoryStore();
    probe.writeProbe(
      probeEntry({ outcome: "inconclusive", httpStatus: 401, detail: "rejected key" }),
      store,
    );
    expect(store.writes).toBe(0);
    expect(probe.readCachedProbe("p1", "https://api.example.com/v1", new Date(), store)).toBeNull();
  });

  it("keeps two providers that share a base URL apart", () => {
    const store = memoryStore();
    probe.writeProbe(probeEntry({ providerId: "a", outcome: "supported" }), store);
    probe.writeProbe(probeEntry({ providerId: "b", outcome: "unsupported", httpStatus: 404 }), store);
    expect(probe.readCachedProbe("a", "https://api.example.com/v1", new Date(), store)?.outcome).toBe(
      "supported",
    );
    expect(probe.readCachedProbe("b", "https://api.example.com/v1", new Date(), store)?.outcome).toBe(
      "unsupported",
    );
  });

  it("does not ask again while a verdict is fresh", async () => {
    const store = memoryStore();
    const fetched = countingFetch(() => jsonResponse(200, { ok: true }));
    const opts = {
      providerId: "fresh-1",
      baseUrl: "https://fresh.example/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: fetched.impl,
      store,
    };
    expect((await probe.ensureResponsesProbeFact(opts))?.outcome).toBe("supported");
    expect((await probe.ensureResponsesProbeFact(opts))?.outcome).toBe("supported");
    expect(fetched.calls()).toBe(1);
  });

  it("throttles a repeated inconclusive attempt without caching a verdict", async () => {
    const store = memoryStore();
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const base = Date.now();
    const opts = {
      providerId: "throttle-1",
      baseUrl: "https://unreachable.example/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: failing,
      store,
    };
    expect((await probe.ensureResponsesProbeFact({ ...opts, now: () => new Date(base) }))?.outcome).toBe(
      "inconclusive",
    );
    expect(calls).toBe(1);
    // Within the window: no second network call, and still no cached verdict.
    expect(
      await probe.ensureResponsesProbeFact({ ...opts, now: () => new Date(base + 30_000) }),
    ).toBeNull();
    expect(calls).toBe(1);
    expect(store.entries).toEqual([]);
    // After the window the question may be asked again.
    expect(
      (await probe.ensureResponsesProbeFact({ ...opts, now: () => new Date(base + 61_000) }))?.outcome,
    ).toBe("inconclusive");
    expect(calls).toBe(2);
  });

  it("derives the verdict from the SAME classification the runtime uses", async () => {
    // The response is classified once. Two readings of one response is how a 400
    // naming an unsupported endpoint is classified `unsupported` while the cache
    // records "supported" for a day.
    const cases: Array<{ status: number; body: unknown; expected: string; httpStatus?: number }> = [
      { status: 400, body: { error: { code: "unsupported_endpoint" } }, expected: "unsupported" },
      { status: 422, body: { error: { code: "invalid_value" } }, expected: "supported" },
      { status: 400, body: { error: { message: "bad input" } }, expected: "supported" },
      { status: 401, body: { error: { code: "unsupported_endpoint" } }, expected: "inconclusive" },
      { status: 429, body: {}, expected: "inconclusive" },
      { status: 500, body: {}, expected: "inconclusive" },
      { status: 404, body: { error: { code: "model_not_found" } }, expected: "inconclusive" },
      { status: 404, body: { error: { code: "endpoint_not_found" } }, expected: "unsupported" },
    ];
    for (const [i, c] of cases.entries()) {
      const store = memoryStore();
      const out = await probe.ensureResponsesProbeFact({
        providerId: `probe-case-${i}`,
        baseUrl: `https://probe-case-${i}.example/v1`,
        apiKey: "k",
        model: "m",
        fetchImpl: countingFetch(() => jsonResponse(c.status, c.body)).impl,
        store,
      });
      expect(out?.outcome, `HTTP ${c.status} ${JSON.stringify(c.body)}`).toBe(c.expected);
      // Only a conclusive verdict is ever stored.
      expect(store.entries.length, `HTTP ${c.status} cached`).toBe(
        c.expected === "inconclusive" ? 0 : 1,
      );
    }
  });

  it("records no verdict for the failures that say nothing about the route", async () => {
    // Each of these is weather, not capability: rotating a key or riding out an
    // outage must not decide tomorrow's transport.
    const statuses = [401, 403, 429, 500, 503];
    for (const status of statuses) {
      const store = memoryStore();
      const out = await probe.ensureResponsesProbeFact({
        providerId: `weathered-${status}`,
        baseUrl: `https://weathered-${status}.example/v1`,
        apiKey: "k",
        model: "m",
        fetchImpl: countingFetch(() => jsonResponse(status, { error: { message: "nope" } })).impl,
        store,
      });
      expect(out?.outcome, `HTTP ${status}`).toBe("inconclusive");
      expect(store.entries, `HTTP ${status}`).toEqual([]);
    }
  });

  it("persists a conclusive verdict to AppSetting and leaves Provider rows alone", async () => {
    const providersBefore = db.prisma.provider.findMany();
    const fetched = countingFetch(() => jsonResponse(405, { error: { message: "no route" } }));
    const out = await probe.ensureResponsesProbeFact({
      providerId: "db-1",
      baseUrl: "https://DB.example/v1/",
      apiKey: "k",
      model: "m",
      fetchImpl: fetched.impl,
    });
    expect(out?.outcome).toBe("unsupported");
    // Readable back through the real store, keyed by the normalized URL.
    expect(probe.readCachedProbe("db-1", "https://db.example/v1", new Date())?.outcome).toBe(
      "unsupported",
    );
    // The fact went to AppSetting, never into provider metadata — the user's
    // preference and the probe's finding do not share a home.
    const row = db.prisma.appSetting.findUnique({ where: { key: probe.TRANSPORT_PROBE_SETTING_KEY } });
    expect(Array.isArray(row?.value)).toBe(true);
    expect(db.prisma.provider.findMany()).toEqual(providersBefore);
  });
});

// ══ 3. transport selection ════════════════════════════════════════════════

describe("resolveTransportFacts", () => {
  const base = {
    runtime: "openai",
    providerId: "prov-x",
    providerKind: "openai-compat",
    baseUrl: "https://sel.example/v1",
    apiKey: "k",
    model: "m",
    allowProbe: true,
  } as const;

  it("reads a native CLI as a fact and never probes it", async () => {
    for (const runtime of ["claude", "codex"]) {
      const f = await tr.resolveTransportFacts({ ...base, runtime, fetchImpl: forbiddenFetch });
      expect(f.value).toBe("native-cli");
      expect(f.confidence).toBe("observed");
    }
  });

  it("resolves openai-local by declaration, without probing", async () => {
    const f = await tr.resolveTransportFacts({
      ...base,
      providerKind: "openai-local",
      fetchImpl: forbiddenFetch,
    });
    expect(f.value).toBe("responses");
    expect(f.confidence).toBe("observed");
    expect(f.source).toContain("openai-local");
  });

  it("honours an explicit choice without reading a cache or asking the endpoint", async () => {
    // Even a fresh cached verdict is left alone: the turn runs on the user's
    // choice, so a fact we may not act on is not worth reading.
    const store = memoryStore();
    probe.writeProbe(probeEntry({ providerId: "prov-x", baseUrl: "https://sel.example/v1" }), store);
    const writesBefore = store.writes;
    for (const preference of ["responses", "chat-completions"] as const) {
      const f = await tr.resolveTransportFacts({
        ...base,
        preference,
        fetchImpl: forbiddenFetch,
        probeStore: store,
      });
      expect(f.value).toBeUndefined();
      expect(f.origin).toBe("unknown");
      expect(f.considered.some((r) => r.outcome === "used" && r.reason.includes(preference))).toBe(
        true,
      );
    }
    expect(store.writes).toBe(writesBefore);
  });

  it("uses a probe verdict when the user asked for auto", async () => {
    const supported = countingFetch(() => jsonResponse(200, {}));
    const ok = await tr.resolveTransportFacts({
      ...base,
      preference: "auto",
      fetchImpl: supported.impl,
      probeStore: memoryStore(),
    });
    expect(ok.value).toBe("responses");
    expect(ok.confidence).toBe("observed");

    const denied = countingFetch(() => jsonResponse(404, { error: { message: "no route" } }));
    const fallback = await tr.resolveTransportFacts({
      ...base,
      providerId: "prov-y",
      preference: "auto",
      fetchImpl: denied.impl,
      probeStore: memoryStore(),
    });
    expect(fallback.value).toBe("chat-completions");
    expect(fallback.confidence).toBe("observed");
  });

  it("leaves the fact unknown when the probe was inconclusive", async () => {
    const unauthorized = countingFetch(() => jsonResponse(401, { error: { message: "bad key" } }));
    const f = await tr.resolveTransportFacts({
      ...base,
      providerId: "prov-z",
      preference: "auto",
      fetchImpl: unauthorized.impl,
      probeStore: memoryStore(),
    });
    // The baseline is still what the turn attempts, but it is explicitly NOT a
    // finding: origin/confidence stay unknown so no consumer can read it as one.
    expect(f.value).toBe("chat-completions");
    expect(f.origin).toBe("unknown");
    expect(f.confidence).toBe("unknown");
    expect(f.source).toContain("NOT a claim");
  });

  it("hands the planner a fact that keeps an explicit choice runnable", async () => {
    // End to end through the real resolver: what an explicit choice produces is
    // NOT a fabricated fact, and the planner must still run the chosen transport.
    const chosen = await tr.resolveTransportFacts({
      ...base,
      providerId: "prov-explicit",
      preference: "responses",
      fetchImpl: forbiddenFetch,
    });
    expect(chosen.value).toBeUndefined();

    const p = plans.resolveRunPlan({
      model: "gpt-5.6-sol",
      runtime: "openai",
      providerId: "prov-explicit",
      transportFacts: chosen,
      preferences: { transport: "responses" },
    });
    expect(p.identity.transport).toBe("responses");
    expect(p.transport.resolved).toBe("responses");
    expect(p.transport.origin).toBe("user-declared");
    expect(p.transport.fallbackAllowed).toBe(false);
  });

  it("does not probe without a key or when probing is not allowed", async () => {
    const noKey = await tr.resolveTransportFacts({
      ...base,
      apiKey: null,
      fetchImpl: forbiddenFetch,
    });
    expect(noKey.origin).toBe("unknown");
    const sideChannel = await tr.resolveTransportFacts({
      ...base,
      allowProbe: false,
      fetchImpl: forbiddenFetch,
    });
    expect(sideChannel.origin).toBe("unknown");
    expect(sideChannel.considered.some((r) => r.reason.includes("side-channel"))).toBe(true);
  });
});

// ══ 4. the plan as the single source ══════════════════════════════════════

describe("run plan transport wiring", () => {
  const plan = (extra: Record<string, unknown> = {}) =>
    plans.resolveRunPlan({
      model: "gpt-5.6-sol",
      runtime: "openai",
      providerId: "prov-1",
      ...extra,
    });

  it("carries one transport value into facts, identity and the decision", () => {
    const p = plan({
      transportFacts: fact("responses", "provider-discovered", "observed"),
      preferences: { transport: "auto" },
    });
    expect(p.transport.resolved).toBe("responses");
    expect(p.facts.transport.value).toBe("responses");
    expect(p.facts.scope.transport).toBe("responses");
    expect(p.identity.transport).toBe("responses");
    expect(p.facts.transport.value).toBe(p.transport.resolved);
  });

  it("permits a switch only under auto, and names the sibling", () => {
    const auto = plan({
      transportFacts: fact("responses", "provider-discovered", "observed"),
      preferences: { transport: "auto" },
    });
    expect(auto.transport.fallbackAllowed).toBe(true);
    expect(auto.transport.fallbackTarget).toBe("chat-completions");

    const explicit = plan({
      transportFacts: fact("responses", "provider-discovered", "observed"),
      preferences: { transport: "responses" },
    });
    expect(explicit.transport.fallbackAllowed).toBe(false);
    expect(explicit.transport.fallbackTarget).toBeNull();
    expect(explicit.transport.fallbackReason).toContain("explicit transport");
  });

  it("runs the transport the user explicitly chose — one value, not two", () => {
    // The regression this pins: `identity.transport` said "responses" while
    // `transport.resolved` was re-read from the fact (unknown) and the runtime
    // — which reads the latter — refused the turn.
    const explicit = fact(undefined, "unknown", "unknown"); // the resolver's answer for a choice
    const p = plan({ transportFacts: explicit, preferences: { transport: "responses" } });
    expect(p.identity.transport).toBe("responses");
    expect(p.transport.resolved).toBe("responses");
    expect(p.transport.resolved).toBe(p.identity.transport);
    // Provenance says who decided: the user, unverified — not the endpoint.
    expect(p.transport.origin).toBe("user-declared");
    expect(p.transport.confidence).toBe("unverified");
    expect(p.transport.fallbackAllowed).toBe(false);
    expect(p.transport.fallbackTarget).toBeNull();
  });

  it("keeps the fact's provenance when the fact is what resolved it", () => {
    const observed = plan({
      transportFacts: fact("responses", "provider-discovered", "observed"),
      preferences: { transport: "auto" },
    });
    expect(observed.transport.origin).toBe("provider-discovered");
    expect(observed.transport.confidence).toBe("observed");
  });

  it("permits no switch away from a native CLI", () => {
    const p = plan({ runtime: "codex" });
    expect(p.transport.resolved).toBe("native-cli");
    expect(p.transport.fallbackAllowed).toBe(false);
  });

  it("reports an unestablished transport as unknown rather than choosing one", () => {
    const p = plan({ transportFacts: fact(undefined, "unknown", "unknown") });
    expect(p.transport.resolved).toBe("unknown");
    expect(p.identity.transport).toBe("unknown");
    expect(p.transport.fallbackAllowed).toBe(false);
    expect(p.transport.confidence).toBe("unknown");
  });

  it("marks an unestablished transport in diagnostics without inventing a fact", () => {
    const p = plan({ transportFacts: fact(undefined, "unknown", "unknown") });
    expect(p.diagnostics.find((x) => x.field === "facts.transport")!.status).toBe("unknown");
    const known = plan({ transportFacts: fact("responses", "provider-discovered", "observed") });
    expect(known.diagnostics.find((x) => x.field === "facts.transport")!.status).toBe("resolved");
    const baseline = plan({ transportFacts: fact("chat-completions", "unknown", "unknown") });
    expect(baseline.diagnostics.find((x) => x.field === "facts.transport")!.status).toBe("degraded");
  });
});

// ══ 5. metadata / preference persistence ══════════════════════════════════

describe("provider transport preference", () => {
  it("reads the stored choice off Provider.metadata", () => {
    expect(tr.readProviderTransportPreference({ transport: "auto" })).toBe("auto");
    expect(tr.readProviderTransportPreference({ transport: "responses" })).toBe("responses");
    expect(tr.readProviderTransportPreference({ transport: "chat-completions" })).toBe(
      "chat-completions",
    );
    expect(tr.readProviderTransportPreference({ transport: "responses", sandbox: "x" })).toBe(
      "responses",
    );
  });

  it("reports an unrecognised value as no choice rather than coercing it", () => {
    for (const raw of ["Responses", "response", "native-cli", "", 42, null, {}]) {
      expect(tr.readProviderTransportPreference({ transport: raw })).toBeUndefined();
    }
    expect(tr.readProviderTransportPreference({})).toBeUndefined();
    expect(tr.readProviderTransportPreference(null)).toBeUndefined();
    expect(tr.readProviderTransportPreference("transport")).toBeUndefined();
  });
});

// ══ 6. session association marks ══════════════════════════════════════════

describe("artifact marks", () => {
  it("measures a resume mark from the file's current size", () => {
    const path = join(TMP, "rollout.jsonl");
    writeFileSync(path, "abc");
    expect(marks.fileMark(path)).toEqual({ kind: "file", path, size: 3 });
    expect(marks.fileMark(join(TMP, "missing.jsonl"))).toBeNull();
  });

  it("refuses a session id that could not name a file", () => {
    expect(marks.sessionFileMark("/sessions", "")).toBeNull();
    expect(marks.sessionFileMark("/sessions", "   ")).toBeNull();
    expect(marks.sessionFileMark("/sessions", "a/b")).toBeNull();
    expect(marks.sessionFileMark("/sessions", "a\\b")).toBeNull();
    expect(marks.sessionFileMark("/sessions", "abc")).toEqual({
      kind: "session-file",
      directory: "/sessions",
      sessionId: "abc",
    });
  });

  it("lets a runtime attribute an artifact to this turn with the same rules", () => {
    const resume = join(TMP, "resume.jsonl");
    writeFileSync(resume, "{}");
    const fileMarks = [marks.fileMark(resume)!];
    expect(plans.markCoversPath(fileMarks, resume)).toBeDefined();
    expect(plans.markCoversPath(fileMarks, join(TMP, "other.jsonl"))).toBeUndefined();

    const sessionMarks = [marks.sessionFileMark(TMP, "thread-7")!];
    expect(plans.markCoversPath(sessionMarks, join(TMP, "rollout-thread-7.jsonl"))).toBeDefined();
    expect(plans.markCoversPath(sessionMarks, join(TMP, "rollout-thread-8.jsonl"))).toBeUndefined();
  });
});
