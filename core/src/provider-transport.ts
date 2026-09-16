// The WRITE and READ path of the user's transport choice.
//
// `Provider.metadata.transport` is a SETTING, not schema: it is a preference the
// planner consumes, so it goes in the metadata blob with the other per-provider
// settings and no ALTER TABLE is involved. This module is the one place that
// knows the key, the legal values and which provider kinds can carry it — the
// HTTP routes, the API response and the capability layer all read it from here,
// so a value cannot be written by one and rejected by another.
//
// Two rules the callers rely on:
//
//   * a value that is not one of the three preferences is NOT a preference —
//     it reads back as "no choice" rather than being coerced into `auto`, so a
//     hand-edited row or an older client cannot silently become a decision;
//   * only the OpenAI-shape kinds may carry it. On a native CLI the setting
//     would be inert, and an inert control is worse than a missing one.

import { z } from "zod";
import type { TransportPreference } from "./capability/types.js";

/** `auto | responses | chat-completions`. `auto` chooses nothing and permits a
 *  probe-driven switch; the two explicit values are honoured exactly, failures
 *  included. */
export const TRANSPORT_PREFERENCES: readonly TransportPreference[] = [
  "auto",
  "responses",
  "chat-completions",
];

/** The provider kinds with an HTTP transport to choose between. */
export const TRANSPORT_PREFERENCE_KINDS: ReadonlySet<string> = new Set([
  "openai-compat",
  "openai-local",
]);

export const isTransportPreferenceKind = (kind: string): boolean =>
  TRANSPORT_PREFERENCE_KINDS.has(kind);

/** Human-readable list for the 400 body: the client should not have to read the
 *  source to learn which kinds accept the field. */
export const transportPreferenceKindsLabel = (): string =>
  [...TRANSPORT_PREFERENCE_KINDS].join(" / ");

/** The field as it arrives on POST (absent means "not chosen"). */
export const transportInputSchema = z.enum(
  TRANSPORT_PREFERENCES as [TransportPreference, ...TransportPreference[]],
).optional();

/** The field as it arrives on PATCH: `null` clears the stored choice, which is
 *  not the same as `auto` — "unset" lets a future default apply, "deliberately
 *  auto" does not. */
export const transportPatchSchema = z
  .enum(TRANSPORT_PREFERENCES as [TransportPreference, ...TransportPreference[]])
  .optional()
  .nullable();

/** The stored preference, or `undefined` when the user has not chosen.
 *
 *  An unrecognised value reports as no choice. Coercing it into `auto` would
 *  turn a typo into a decision, and a decision into something the planner then
 *  has to honour or contradict. */
export function readProviderTransportPreference(metadata: unknown): TransportPreference | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as Record<string, unknown>).transport;
  return TRANSPORT_PREFERENCES.includes(raw as TransportPreference)
    ? (raw as TransportPreference)
    : undefined;
}

/** The same read, shaped for the API response: `null` = not chosen. */
export function readProviderTransport(metadata: unknown): TransportPreference | null {
  return readProviderTransportPreference(metadata) ?? null;
}

export type TransportMetadataResult =
  | { ok: true; metadata: Record<string, unknown> | null }
  | { ok: false; error: "invalid_for_kind"; message: string };

const asRecord = (metadata: unknown): Record<string, unknown> =>
  metadata && typeof metadata === "object" ? ({ ...(metadata as Record<string, unknown>) }) : {};

/** Apply a transport choice to a metadata blob, for POST and PATCH alike.
 *
 *  `metadata === null` on the result means "nothing to write" (the PATCH asked
 *  for the value already stored), which lets the caller skip an update without
 *  inventing an empty-blob write. All other keys are preserved: the transport
 *  edit must not take `defaultSandbox`, `deprecated` or anything else with it. */
export function transportMetadataFor(input: {
  kind: string;
  transport: TransportPreference | null;
  metadata: unknown;
}): TransportMetadataResult {
  if (!isTransportPreferenceKind(input.kind)) {
    return {
      ok: false,
      error: "invalid_for_kind",
      message:
        `transport is only meaningful for ${transportPreferenceKindsLabel()} providers; ` +
        `kind "${input.kind}" has no HTTP transport to choose.`,
    };
  }
  const base = asRecord(input.metadata);
  if (input.transport === null) {
    if (!("transport" in base)) return { ok: true, metadata: null };
    delete base.transport;
    return { ok: true, metadata: base };
  }
  if (base.transport === input.transport) return { ok: true, metadata: null };
  return { ok: true, metadata: { ...base, transport: input.transport } };
}
