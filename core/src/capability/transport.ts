// Phase 1: establishing the transport FACT for a route.
//
// This is the only module allowed to answer "what does this endpoint speak?".
// Its answer becomes `facts.transport` on the run plan, and everything else —
// the SDK's `useResponses`, the fallback policy, `/status`, the diagnostics —
// reads that one value. The hostname heuristic this replaces lived in the
// runtime, which meant the runtime could disagree with what the UI showed; a
// fact with provenance has one author.
//
// What counts as evidence, in order:
//
//   1. a native CLI              — we launch it; there is no HTTP route to ask.
//   2. `openai-local`            — the kind DECLARES the official endpoint.
//   3. a fresh probe verdict     — the endpoint answered a request on /responses.
//   4. nothing                   — stays `unknown`, never "chat-completions by
//                                  default": a default dressed as a fact is the
//                                  silent fallback the plan bans.
//
// A user's explicit preference is NOT evidence and is not consulted here: it is
// applied by the planner, which records whether it was honoured. The preference
// does decide whether we probe at all — asking the network to check a choice the
// user has already made would spend their latency on a question they answered.

import {
  transportForRuntime,
} from "./model-capabilities.js";
import { ensureResponsesProbeFact, normalizeBaseUrlKey, type TransportProbeStore } from "./transport-probe.js";
import { unknownCapability, type CapabilityOrigin, type ConsideredRung, type ResolvedCapability, type RunPlanTransport, type TransportPreference } from "./types.js";

export const TRANSPORT_PREFERENCES: readonly TransportPreference[] = [
  "auto",
  "responses",
  "chat-completions",
];

/** Where the user's stored choice is READ. The key, the legal values and the
 *  rule that an unrecognised value is no choice at all belong to the module that
 *  WRITES it (provider-transport.ts) — one reader, one writer, no chance of the
 *  API accepting a value the planner then ignores. Re-exported here because this
 *  is the layer that consumes it. */
export { readProviderTransportPreference } from "../provider-transport.js";

export interface ResolveTransportFactsOptions {
  runtime: string;
  providerId?: string | null;
  providerKind: string | null;
  baseUrl: string | null;
  apiKey?: string | null;
  model: string;
  /** The user's stored choice, when they made one. An explicit choice suppresses
   *  both the cache and the probe: the turn will run on it regardless, and
   *  probing could only produce a fact we are forbidden to act on. */
  preference?: TransportPreference;
  /** False for side-channel queries (quickQuery) that must not touch the
   *  network before a real turn needs the answer. */
  allowProbe: boolean;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  probeStore?: TransportProbeStore;
}

function resolvedTransport(
  value: RunPlanTransport,
  origin: CapabilityOrigin,
  confidence: ResolvedCapability<RunPlanTransport>["confidence"],
  source: string,
  considered: ConsideredRung[],
): ResolvedCapability<RunPlanTransport> {
  return { value, origin, confidence, source, considered };
}

/** The transport fact for this route. Async because establishing it may require
 *  the one lazy probe; everything else on the plan is pure. */
export async function resolveTransportFacts(
  opts: ResolveTransportFactsOptions,
): Promise<ResolvedCapability<RunPlanTransport>> {
  const native = transportForRuntime(opts.runtime);
  if (native.value !== undefined) return native;

  // Not a runtime we launch: the transport is an HTTP question about the
  // endpoint, and only the provider tells us which endpoint that is.
  if (opts.providerKind === "openai-local") {
    return resolvedTransport(
      "responses",
      "provider-discovered",
      "observed",
      'provider kind "openai-local" declares the official OpenAI endpoint, which speaks Responses',
      [
        {
          origin: "provider-discovered",
          outcome: "used",
          reason: 'the provider kind declares the official endpoint as "openai-local"',
        },
        {
          origin: "unknown",
          outcome: "absent",
          reason: "no probe is needed or performed: the endpoint is known by declaration",
        },
      ],
    );
  }

  const baseUrl = opts.baseUrl ?? "";
  const considered: ConsideredRung[] = [];

  if (opts.preference === "responses" || opts.preference === "chat-completions") {
    // The user decided. A cached verdict older than the decision must not
    // silently override them (and an automatic switch is not permitted on an
    // explicit choice), so we neither read the cache nor probe.
    considered.push({
      origin: "user-declared",
      outcome: "used",
      reason: `the user declared the transport as "${opts.preference}"; the endpoint is not probed`,
    });
    return unknownCapability<RunPlanTransport>(
      `the transport is the user's declaration ("${opts.preference}") — this is not a finding about the endpoint`,
      considered,
    );
  }

  if (opts.providerKind !== "openai-compat" || baseUrl === "") {
    considered.push({
      origin: "provider-discovered",
      outcome: "absent",
      reason:
        opts.providerKind === "openai-compat"
          ? "the provider has no base URL to ask"
          : `provider kind "${opts.providerKind ?? "none"}" does not establish an HTTP transport`,
    });
    return unknownCapability<RunPlanTransport>(
      "no transport has been established for this route",
      considered,
    );
  }

  considered.push({
    origin: "user-declared",
    outcome: "absent",
    reason:
      opts.preference === "auto"
        ? 'the user asked for "auto", which chooses nothing'
        : "the user expressed no transport preference",
  });

  if (!opts.allowProbe || !opts.apiKey) {
    considered.push({
      origin: "provider-discovered",
      outcome: "absent",
      reason: opts.allowProbe
        ? "the provider has no API key, so /responses cannot be asked"
        : "probing is not allowed in this context (side-channel query)",
    });
    return unresolvedCompatBaseline(considered);
  }

  const fact = await ensureResponsesProbeFact({
    providerId: opts.providerId ?? "",
    baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    now: opts.now,
    fetchImpl: opts.fetchImpl,
    store: opts.probeStore,
  });

  if (fact === null) {
    considered.push({
      origin: "provider-discovered",
      outcome: "absent",
      reason: "the probe produced no verdict",
    });
    return unresolvedCompatBaseline(considered);
  }

  const endpoint = `${normalizeBaseUrlKey(baseUrl)}`;
  if (fact.outcome === "supported") {
    considered.push({
      origin: "provider-discovered",
      outcome: "used",
      reason: `probe of ${endpoint}/responses at ${fact.probedAt}: ${fact.detail}`,
    });
    return resolvedTransport(
      "responses",
      "provider-discovered",
      "observed",
      `the endpoint answered /responses (probed ${fact.probedAt})`,
      considered,
    );
  }
  if (fact.outcome === "unsupported") {
    considered.push({
      origin: "provider-discovered",
      outcome: "used",
      reason: `probe of ${endpoint}/responses at ${fact.probedAt}: ${fact.detail}`,
    });
    return resolvedTransport(
      "chat-completions",
      "provider-discovered",
      "observed",
      `the endpoint rejected /responses as a route; the compat baseline serves /chat/completions (probed ${fact.probedAt})`,
      considered,
    );
  }

  considered.push({
    origin: "provider-discovered",
    outcome: "absent",
    reason: `probe of ${endpoint}/responses was inconclusive (${fact.detail}); it is not a capability verdict and was not cached`,
  });
  return unresolvedCompatBaseline(considered);
}

/** The value an openai-compat turn falls back to when NOTHING established the
 *  transport — explicitly not a finding.
 *
 *  A turn has to send a request, and the compat baseline is the only route most
 *  compat endpoints implement. The point of returning it with origin
 *  `unknown` / confidence `unknown` is that no consumer can mistake it for
 *  evidence: `/status` and the diagnostics show "not established", and the plan
 *  still permits a switch when the endpoint says the route does not exist. */
function unresolvedCompatBaseline(
  considered: ConsideredRung[],
): ResolvedCapability<RunPlanTransport> {
  return {
    value: "chat-completions",
    origin: "unknown",
    confidence: "unknown",
    source:
      "no transport was established for this endpoint; the compat baseline /chat/completions is attempted for this turn, and this is NOT a claim that the endpoint speaks it",
    considered,
  };
}
