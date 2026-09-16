// The `/status` DTO parity gate. NOT a test file (no `.test.` in the name) — it
// is a compile-time assertion, checked by `tsc --noEmit`, because the failure it
// guards against is a TYPE drift, not a runtime behaviour.
//
// Why it exists: the report used to be declared twice — once in the core's
// return annotation, once (partially, by hand) in the UI's `agent-api.ts`. The
// UI copy went stale and silently dropped whatever it had never been taught
// about, so a surface could not tell "the server does not report this" from
// "this copy of the type never heard about it".
//
// The report itself now has ONE declaration (`shared/src/status-report.ts`) that
// `getStatusReport` returns directly, which makes any change to the returned
// object literal a compile error here in the core. What is left to check is the
// two leaf shapes that file declares STRUCTURALLY rather than importing, because
// their owning modules are core-internal (`LivenessSignals` / `TransportErrorClass`
// would have had to move with them). Those twins are only safe while they are
// mutually assignable with the real types in BOTH directions — a field the core
// adds to one and not the other must stop the build, not reach a UI that renders
// it as `undefined`.

import type {
  StatusLivenessSnapshot,
  StatusTransportFallback,
} from "@agentorch/shared";
import type { LivenessSnapshot } from "../capability/liveness.js";
import type { TransportFallbackInfo } from "../sessions/runtimes/types.js";

/** `true` only when each type is assignable to the other, i.e. neither has a
 *  member the other lacks. A one-way check would pass while the shared twin was
 *  a strict subset, which is the direction that silently loses a field. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Assigning `true` to a computed `false` is the whole mechanism: the file stops
 *  compiling, and the error names the type that drifted. */
const LIVENESS_SNAPSHOT_PARITY: MutuallyAssignable<LivenessSnapshot, StatusLivenessSnapshot> = true;
const TRANSPORT_FALLBACK_PARITY: MutuallyAssignable<TransportFallbackInfo, StatusTransportFallback> = true;

// Referenced so `noUnusedLocals` does not turn the gate off by deleting it.
export const STATUS_DTO_PARITY: [true, true] = [LIVENESS_SNAPSHOT_PARITY, TRANSPORT_FALLBACK_PARITY];
