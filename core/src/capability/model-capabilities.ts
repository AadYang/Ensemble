// Phase 0: the single resolver for "what can this model do, on this route,
// with this runtime build".
//
// Everything below is PURE with respect to the run: it reads the existing fact
// layers (user overrides, runtime profiles, the confirmed catalog, live session
// observations) and returns one `ResolvedCapability<T>` per field. It writes
// nothing, spawns nothing and sets no environment variable.
//
// The shape of every resolution is the same, and it is the reason this module
// exists:
//
//   1. Walk the ladder for THAT FIELD from most to least authoritative.
//   2. Record every rung — including the ones that were absent or rejected.
//   3. When no rung yields a value, return `undefined` with origin "unknown".
//      Never substitute a default, a sibling model, or a "safe" constant.
//
// Provenance is per field on purpose. A model can have a vendor-documented
// advertised window, no live effective window, and an unknown reasoning ladder
// at the same time; a single group-level `source` could only describe that by
// being wrong about two of the three.

import {
  catalogEntry,
  compactionThreshold,
  effectiveWindow,
  maxOutputTokensEntry,
  reasoningLevelsEntry,
  vendorScopeForModel,
} from "../context-window.js";
import {
  CAPABILITY_PRIORITY,
  unknownCapability,
  type CapabilityConfidence,
  type CapabilityFacts,
  type CapabilityOrigin,
  type CapabilityScope,
  type ConsideredRung,
  type ResolutionDiagnostic,
  type ResolutionRequest,
  type ResolvedCapability,
  type RunPlanTransport,
  type ToolCapabilities,
} from "./types.js";

function confidenceFromWindow(confidence: string): CapabilityConfidence {
  switch (confidence) {
    case "confirmed":
      return "confirmed";
    case "legacy":
      return "legacy";
    case "family-analogy":
    case "unverified":
      return "unverified";
    default:
      return "unknown";
  }
}

function originFromWindow(confidence: string): CapabilityOrigin {
  switch (confidence) {
    case "confirmed":
      return "catalog-confirmed";
    case "legacy":
      return "legacy-override";
    default:
      return "catalog-unverified";
  }
}

/** Wrap a value with its provenance, keeping the rung list. */
function resolved<T>(
  value: T,
  origin: CapabilityOrigin,
  confidence: CapabilityConfidence,
  source: string,
  considered: ConsideredRung[],
): ResolvedCapability<T> {
  return { value, origin, confidence, source, considered };
}

/** The runtime's transport is a fact about the runtime, not a guess about the
 *  model: a native CLI is spoken to by running it, and no amount of missing
 *  metadata changes that. For HTTP runtimes the transport genuinely depends on
 *  endpoint discovery, which is phase 1 — so it stays unknown rather than
 *  defaulting to chat-completions (the exact silent fallback the plan bans). */
export function transportForRuntime(runtime: string): ResolvedCapability<RunPlanTransport> {
  if (runtime === "claude" || runtime === "codex") {
    return resolved(
      "native-cli" as RunPlanTransport,
      "provider-discovered",
      "observed",
      `runtime "${runtime}" is a native CLI; it is spoken to by launching it`,
      [
        {
          origin: "provider-discovered",
          outcome: "used",
          reason: `runtime "${runtime}" is a native CLI`,
        },
      ],
    );
  }
  return unknownCapability<RunPlanTransport>("no transport has been established for this route", [
    ...(runtime === "openai"
      ? [
          {
            origin: "provider-discovered" as CapabilityOrigin,
            outcome: "absent" as const,
            reason: "HTTP transport discovery has not run (phase 1)",
          },
        ]
      : []),
    {
      origin: "unknown",
      outcome: "absent",
      reason: "no provider endpoint metadata describes the transport",
    },
  ]);
}

/** A runtime we cannot name must not inherit another runtime's identity. The
 *  context-window layer's `runtimeIdForProviderKind("")` defaults to `claude`,
 *  which is right for the display path it was written for but wrong here: an
 *  unnamed runtime IS unknown. This resolver therefore never calls it. */
export function runtimeScopeFor(req: ResolutionRequest): string {
  const named = req.runtime?.trim();
  return named && named !== "" ? named : "unknown";
}

/** The model's reasoning ladder, from the capability registry.
 *
 *  This is a MODEL fact — `vendor/model`, and optionally a provider-pinned
 *  override — so it is resolved from the same registry path as the advertised
 *  window and the output cap, NOT from the provider kind. The old rule lived the
 *  other way round ("Claude, Codex or OpenAI-compat may set an effort"), which
 *  both excluded `openai-local` by omission and said nothing about whether the
 *  chosen model has that level at all.
 *
 *  An unusable user override is reported as a rejected rung rather than falling
 *  through to the built-in ladder: a user who typed a broken ladder needs to see
 *  that their configuration did not take effect, not a silently different one. */
function reasoningCapability(
  model: string,
  vendor: string,
  providerId: string | null,
): { levels: ResolvedCapability<string[]>; defaultLevel: ResolvedCapability<string> } {
  const entry = reasoningLevelsEntry(model, vendor, { providerId });

  if (entry === null) {
    const considered: ConsideredRung[] = [
      {
        origin: "catalog-confirmed",
        outcome: "absent",
        reason: "no catalog entry for this model states a reasoning ladder",
      },
      {
        origin: "provider-discovered",
        outcome: "absent",
        reason: "no provider endpoint reports a model's reasoning levels",
      },
      {
        origin: "runtime-observed",
        outcome: "absent",
        reason: "this turn produced no runtime observation of the ladder",
      },
    ];
    const source =
      "no evidence in the registry states which reasoning levels this model supports; " +
      "a syntactically valid level is accepted as user-declared and sent unverified";
    return {
      levels: unknownCapability<string[]>(source, considered),
      // A default is only meaningful against a known ladder, so it stays unknown
      // for the same reason — never "no default", which would be a claim.
      defaultLevel: unknownCapability<string>(source, considered),
    };
  }

  if (!entry.ok) {
    const considered: ConsideredRung[] = [
      { origin: "user-declared", outcome: "rejected", reason: entry.reason },
      {
        origin: "catalog-confirmed",
        outcome: "absent",
        reason: "the built-in catalog is not used as a stand-in for a rejected override",
      },
    ];
    return {
      levels: unknownCapability<string[]>(entry.reason, considered),
      defaultLevel: unknownCapability<string>(entry.reason, considered),
    };
  }

  const origin = originFromWindow(entry.confidence);
  const confidence = confidenceFromWindow(entry.confidence);
  const source = `${entry.levels.join(", ")} — ${entry.source}`;
  const considered: ConsideredRung[] = [
    {
      origin,
      outcome: "used",
      reason: entry.source,
    },
  ];
  if (confidence !== "confirmed") {
    considered.push({
      origin: "catalog-confirmed",
      outcome: "rejected",
      reason: `confidence is "${entry.confidence}", so the ladder bounds what we accept but is not claimed as verified`,
    });
  }
  return {
    levels: resolved(entry.levels, origin, confidence, source, considered),
    defaultLevel:
      entry.defaultLevel === null
        ? unknownCapability<string>(
            "the recorded ladder does not name a default level that is one of its own members",
            considered,
          )
        : resolved(
            entry.defaultLevel,
            origin,
            confidence,
            `"${entry.defaultLevel}" is the vendor default — ${entry.source}`,
            considered,
          ),
  };
}

function toolCapabilities(transport: ResolvedCapability<RunPlanTransport>): ToolCapabilities {
  const nativeCli = transport.value === "native-cli";
  const unexplored = (what: string): ConsideredRung[] => [
    {
      origin: "provider-discovered",
      outcome: "absent",
      reason: `${what} has not been established for this route (phase 1)`,
    },
    {
      origin: "unknown",
      outcome: "absent",
      reason: "no default is assumed for an unexplored capability",
    },
  ];
  return {
    // A native CLI runs our own tools, so calling them is a fact about the
    // harness rather than something to discover.
    toolCalling: nativeCli
      ? resolved(true, "provider-discovered", "observed", `runtime "${transport.source}" runs our tools`, [])
      : unknownCapability("tool calling has not been established for this route", unexplored("tool calling")),
    parallelToolCalls: unknownCapability(
      "parallel tool calls have not been established for this route",
      unexplored("parallel tool calling"),
    ),
    builtinTools: unknownCapability(
      "vendor built-in tools have not been established for this route",
      unexplored("built-in tool availability"),
    ),
    mcp: nativeCli
      ? resolved(true, "provider-discovered", "observed", "the CLI launches the MCP servers we pass it", [])
      : unknownCapability("MCP acceptance has not been established for this route", unexplored("MCP support")),
  };
}

export interface ResolvedCapabilities {
  facts: CapabilityFacts;
  diagnostics: ResolutionDiagnostic[];
}

export function resolveModelCapabilities(req: ResolutionRequest): ResolvedCapabilities {
  const runtime = runtimeScopeFor(req);
  const vendor = req.vendor?.trim() || vendorScopeForModel(req.model);
  const providerId = req.providerId ?? null;
  const runtimeVersion = req.runtimeVersion ?? null;
  // The transport fact comes from whoever could OBSERVE the endpoint (a native
  // CLI launch, the provider kind, a cached/live probe). Falling back to the
  // runtime-only answer keeps this resolver honest for callers that have not
  // established one: the value stays `unknown` rather than defaulting.
  const transport = req.transportFacts ?? transportForRuntime(runtime);

  const scope: CapabilityScope = {
    providerId,
    providerScope: `${runtime}/${vendor}`,
    runtime,
    runtimeVersion,
    transport: transport.value ?? "unknown",
    modelId: req.model,
  };

  const diagnostics: ResolutionDiagnostic[] = [];
  const winOpts = { providerId };

  // ── transport ───────────────────────────────────────────────────────────
  // Reported like every other fact, so `/status` can show WHERE the transport
  // came from. `unknown` confidence means the value is a starting point rather
  // than a finding, and is rendered as degraded — the one thing that must never
  // happen is a baseline attempt reading as "this endpoint was observed to
  // speak chat-completions".
  diagnostics.push({
    field: "facts.transport",
    status:
      transport.value === undefined
        ? "unknown"
        : transport.confidence === "unknown"
          ? "degraded"
          : "resolved",
    origin: transport.origin,
    confidence: transport.confidence,
    detail:
      transport.value === undefined
        ? transport.source
        : `"${transport.value}" — ${transport.source}`,
    considered: transport.considered,
  });

  // ── advertised: what the vendor says the model holds ────────────────────
  const entry = catalogEntry(req.model, vendor, winOpts);
  const advertisedRungs: ConsideredRung[] = [];
  let advertised = unknownCapability<number>("no documented context window is known for this model");
  if (entry && entry.advertisedContextWindow > 0) {
    const origin = originFromWindow(entry.confidence);
    advertisedRungs.push({ origin, outcome: "used", reason: entry.source });
    if (entry.confidence !== "confirmed") {
      advertisedRungs.push({
        origin: "catalog-confirmed",
        outcome: entry.confidence === "legacy" ? "overruled" : "rejected",
        reason:
          entry.confidence === "legacy"
            ? "the value came from the legacy override shape; display only, no declaration rights"
            : `confidence is "${entry.confidence}", so this figure may be shown but never declared`,
      });
    }
    advertised = resolved(
      entry.advertisedContextWindow,
      origin,
      confidenceFromWindow(entry.confidence),
      entry.source,
      advertisedRungs,
    );
  } else {
    advertisedRungs.push({
      origin: "catalog-confirmed",
      outcome: "absent",
      reason: "no catalog entry for this model in this vendor scope",
    });
  }
  diagnostics.push(
    advertised.value === undefined
      ? {
          field: "facts.advertisedContextWindow",
          status: "unknown",
          origin: "unknown",
          confidence: "unknown",
          detail: advertised.source,
          considered: advertised.considered,
        }
      : {
          field: "facts.advertisedContextWindow",
          status: advertised.confidence === "confirmed" ? "resolved" : "degraded",
          origin: advertised.origin,
          confidence: advertised.confidence,
          detail: `${advertised.value} tokens, documented at ${advertised.source}`,
          considered: advertised.considered,
        },
  );

  // ── runtimeEffectiveWindow: what this session is actually running under ──
  const live = effectiveWindow(req.model, {
    runtime,
    vendor,
    runtimeVersion,
    providerId,
    sessionObserved: req.sessionObservedWindow ?? null,
    requested: req.requestedWindow ?? null,
  });
  const observed = req.sessionObservedWindow != null && req.sessionObservedWindow > 0;
  const liveRungs: ConsideredRung[] = [
    {
      origin: "runtime-observed",
      outcome: observed ? "used" : "absent",
      reason: observed
        ? `the runtime reported ${req.sessionObservedWindow} tokens for this turn`
        : "this turn produced no runtime reading; an earlier turn's reading must not be reused",
    },
  ];
  if (live?.origin === "runtime-profile") {
    liveRungs.push({
      origin: "catalog-confirmed",
      outcome: "used",
      reason: `version-matched runtime profile (runtime ${live.runtimeVersion}, observed ${live.observedAt})`,
    });
  } else {
    liveRungs.push({
      origin: "catalog-confirmed",
      outcome: live === null ? "absent" : "rejected",
      reason:
        live === null
          ? "no profile matches this runtime version, and we do not reuse a profile from another version"
          : "a live reading outranks the static profile",
    });
  }
  const effective =
    live === null
      ? unknownCapability<number>(
          "no trustworthy live ceiling — callers must show unknown, never the advertised figure",
          liveRungs,
        )
      : resolved(
          live.tokens,
          live.origin === "session-observed" ? "runtime-observed" : "catalog-confirmed",
          live.origin === "session-observed" ? "observed" : "confirmed",
          live.origin === "session-observed"
            ? "the running process reported it for this turn"
            : `version-matched runtime profile for ${live.runtimeVersion}`,
          liveRungs,
        );
  diagnostics.push(
    effective.value === undefined
      ? {
          field: "facts.runtimeEffectiveWindow",
          status: "unknown",
          origin: "unknown",
          confidence: "unknown",
          detail: effective.source,
          considered: effective.considered,
        }
      : {
          field: "facts.runtimeEffectiveWindow",
          status: "resolved",
          origin: effective.origin,
          confidence: effective.confidence,
          detail:
            `${effective.value} tokens (${live!.origin})` +
            (live!.clamped ? " — the runtime clamps our declared value" : ""),
          considered: effective.considered,
        },
  );

  // ── maxOutputTokens ─────────────────────────────────────────────────────
  // Resolved on its OWN rung, not through `entry`: the entry's confidence
  // describes the advertised window, so borrowing it would promote a cap the
  // user typed to `catalog-confirmed` whenever they also restated the window.
  const maxOutEntry = maxOutputTokensEntry(req.model, vendor, winOpts);
  const maxOut =
    maxOutEntry === null
      ? unknownCapability<number>(
          "the vendor's published output cap is not known for this model",
          [
            {
              origin: "catalog-confirmed",
              outcome: "absent",
              reason: "no maxOutputTokens field on the catalog entry",
            },
          ],
        )
      : resolved(
          maxOutEntry.value,
          originFromWindow(maxOutEntry.confidence),
          confidenceFromWindow(maxOutEntry.confidence),
          maxOutEntry.source,
          [
            {
              origin: originFromWindow(maxOutEntry.confidence),
              outcome: "used",
              reason: maxOutEntry.source,
            },
          ],
        );
  diagnostics.push({
    field: "facts.maxOutputTokens",
    status: maxOut.value === undefined ? "unknown" : maxOut.confidence === "confirmed" ? "resolved" : "degraded",
    origin: maxOut.origin,
    confidence: maxOut.confidence,
    detail: maxOut.value === undefined ? maxOut.source : `${maxOut.value} tokens, from ${maxOut.source}`,
    considered: maxOut.considered,
  });

  // ── reasoning ───────────────────────────────────────────────────────────
  const reasoning = reasoningCapability(req.model, vendor, providerId);
  const reasoningLevels = reasoning.levels;
  const defaultReasoningLevel = reasoning.defaultLevel;
  diagnostics.push({
    field: "facts.reasoningLevels",
    status:
      reasoningLevels.value === undefined
        ? "unknown"
        : reasoningLevels.confidence === "confirmed"
          ? "resolved"
          : "degraded",
    origin: reasoningLevels.origin,
    confidence: reasoningLevels.confidence,
    detail: reasoningLevels.source,
    considered: reasoningLevels.considered,
  });
  diagnostics.push({
    field: "facts.defaultReasoningLevel",
    status: defaultReasoningLevel.value === undefined ? "unknown" : "resolved",
    origin: defaultReasoningLevel.origin,
    confidence: defaultReasoningLevel.confidence,
    detail: defaultReasoningLevel.source,
    considered: defaultReasoningLevel.considered,
  });

  // ── conversation / compaction ───────────────────────────────────────────
  // A native CLI owns its own conversation and compaction, so those are facts
  // about the runtime. For HTTP routes both depend on endpoint discovery
  // (phase 1) and stay unknown rather than defaulting to true — claiming
  // server-conversation support we have not verified is how history gets
  // dropped.
  const nativeCli = transport.value === "native-cli";
  // Two DIFFERENT claims, and conflating them is how a plan ends up naming a
  // continuation nobody holds.
  //
  //   supportsServerConversation — "this route can continue a conversation the
  //     SERVER stored". A native CLI resumes a session file in our own home
  //     directory (or a thread in its own process); that is a runtime session,
  //     and the honest value here is FALSE, established — not `true` borrowed
  //     from "the CLI has a session".
  //   supportsNativeCompaction — "this runtime throws context away on its own,
  //     at a point we know". Holding a session does not prove it, so the value
  //     is asserted only where a version-matched observation of this runtime's
  //     compaction trigger exists (context-window.ts).
  const supportsServerConversation = nativeCli
    ? resolved(
        false,
        "runtime-observed",
        "confirmed",
        `runtime "${runtime}" resumes its own session (a local session file/process); that is a runtime session, not a server-side conversation`,
        [
          {
            origin: "provider-discovered",
            outcome: "absent",
            reason: "no server-side conversation id is issued to us by a native CLI",
          },
        ],
      )
    : unknownCapability<boolean>("not established for this route; no default is assumed", [
        { origin: "provider-discovered", outcome: "absent", reason: "no discovery has run (phase 1)" },
      ]);
  const observedCompaction = nativeCli
    ? compactionThreshold(req.model, { runtime, vendor, runtimeVersion, providerId })
    : null;
  const supportsNativeCompaction =
    observedCompaction !== null
      ? resolved(
          true,
          "runtime-observed",
          "confirmed",
          `runtime "${runtime}" was observed compacting at ${observedCompaction} tokens on version ${runtimeVersion ?? "(unversioned)"}`,
          [],
        )
      : unknownCapability<boolean>(
          nativeCli
            ? `runtime "${runtime}" holds its own session, but no version-matched compaction observation exists for ${req.model}; holding a session is not evidence of native compaction`
            : "not established for this route; no default is assumed",
          [{ origin: "runtime-observed", outcome: "absent", reason: "no compaction observation" }],
        );

  const facts: CapabilityFacts = {
    scope,
    // Same object as the scope's value — assigned, never re-derived, so
    // `scope.transport` and `facts.transport.value` cannot disagree.
    transport,
    advertisedContextWindow: advertised,
    runtimeEffectiveWindow: effective,
    maxOutputTokens: maxOut,
    reasoningLevels,
    defaultReasoningLevel,
    supportsServerConversation,
    supportsNativeCompaction,
    tools: toolCapabilities(transport),
  };

  return { facts, diagnostics };
}

/** The priority ladder, exposed so the ordering is stated in exactly one place. */
export function capabilityPriority(): readonly CapabilityOrigin[] {
  return CAPABILITY_PRIORITY;
}
