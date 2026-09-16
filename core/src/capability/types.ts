// The capability TYPES live in `@agentorch/shared` (AGENTS.md §2.3): `/status`
// and the UI resolve against the same `ResolvedRunPlan` the runtime executes, so
// the contract cannot be re-declared on the other side of the boundary.
//
// This module is the core's import site for them, and holds the two things that
// are VALUES and therefore cannot live in a types-only shared module: the
// priority ladder and the `unknown` constructor. (A runtime `import` of
// `@agentorch/shared` would also drag the workspace package's TS source into the
// core's `rootDir: src` emit, so values stay here.)

export type {
  AppliedPreference,
  ArtifactMark,
  CapabilityConfidence,
  CapabilityFacts,
  CapabilityOrigin,
  CapabilityScope,
  ConsideredRung,
  DeferredPlanField,
  LivenessProbeCapability,
  LivenessProbeKind,
  LivenessSignalName,
  LivenessState,
  LivenessTerminalReason,
  LivenessUpdate,
  ObservationRejection,
  ObservationVerdict,
  PendingPhase,
  PreferenceRejectionCode,
  ProjectRootErrorCode,
  ProjectRootInput,
  RawObservationEvent,
  ResolutionDiagnostic,
  ResolutionRequest,
  ResolvedCapability,
  ResolvedProjectRoot,
  ResolvedRunPlan,
  RunObservation,
  RunPlanContext,
  RunPlanLiveness,
  RunPlanHistory,
  RunPlanHistoryCounts,
  RunPlanHistoryStrategy,
  RunPlanHistorySummaryRef,
  RunPlanSkillEntry,
  RunPlanSkills,
  RunPlanTokenCounting,
  RunPlanTransport,
  RunPlanTransportPlan,
  RunTelemetry,
  RuntimeConstraint,
  ToolCapabilities,
  TransportPreference,
  TurnWatermark,
  UserPreferences,
} from "@agentorch/shared";

import type { CapabilityOrigin, ConsideredRung, ResolvedCapability } from "@agentorch/shared";

/** Priority ladder, highest first, applied PER FIELD. `legacy` is deliberately
 *  absent: it is a display-only override that must never win a capability
 *  resolution. */
export const CAPABILITY_PRIORITY: readonly CapabilityOrigin[] = [
  "user-declared",
  "runtime-observed",
  "provider-discovered",
  "catalog-confirmed",
  "catalog-unverified",
  "unknown",
];

/** The `unknown` value of a capability field. `value === undefined` is a
 *  complete answer, so it needs no "missing" sentinel — only its provenance. */
export function unknownCapability<T>(
  source: string,
  considered: ConsideredRung[] = [],
): ResolvedCapability<T> {
  return { value: undefined, origin: "unknown", confidence: "unknown", source, considered };
}
