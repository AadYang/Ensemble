// The reasoning-level contract: ONE definition, shared by the HTTP schema, the
// agent-metadata reader, the run planner, the runtime adapters, the
// cloud-realtime payloads and the UI.
//
// A level is an OPEN token, not a closed enum. "Supported levels" is a fact
// about a MODEL, established by a registry entry or a runtime observation — it
// is not a constant, so it cannot be a union type. The closed enum that used to
// live in protocol.ts failed in both directions at once: it could not represent
// `ultra` (a level the vendor's own model catalog lists for gpt-6-astra), and
// every place that carried a copy of it — the zod schema, the metadata reader,
// the Codex adapter, the settings dropdown — had to be edited together or the
// app silently dropped a value the user could still select in one of the other
// copies.
//
// Safety therefore comes from SYNTAX, not from membership. The token is
// interpolated into Codex's `config.toml`, into a `-c key="value"` argv entry
// and into a JSON request body, so the character set is deliberately tiny:
// `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Quotes, backslashes, whitespace, newlines,
// `=` and `]` are unrepresentable, which makes TOML/argv injection impossible by
// construction rather than by escaping.
//
// Membership is a SEPARATE question with a separate answer:
//   • syntax valid + model's levels known + in the list  → applied
//   • syntax valid + model's levels known + outside      → rejected, structured
//   • syntax valid + model's levels UNKNOWN              → applied as
//                                                          user-declared/unverified
//                                                          (never claimed supported)
//   • syntax invalid                                     → rejected, structured
//   • literal "inherit" / null / unset                   → no parameter is sent
//
// `inherit` is always valid, in every model and every runtime, and it is the
// SAME state as "unset" — never a second storage shape that a reader could
// disagree with.

export type ReasoningEffort = string;

/** The literal a client may send to mean "no override". It normalizes to the
 *  same state as null/unset, so nothing downstream has to model "explicitly
 *  inherit" and "nothing configured" as two things. */
export const REASONING_INHERIT = "inherit";

/** The levels the UI offers as common options. NOT the set of valid values, and
 *  NOT the set any model supports: a model's own ladder comes from the
 *  capability registry, and a user may always type a safe custom token. */
export const REASONING_HINTS: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** The whole safety boundary for a reasoning token, in one place. */
export const REASONING_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isReasoningToken(value: unknown): value is string {
  return typeof value === "string" && REASONING_TOKEN_PATTERN.test(value);
}

export type ReasoningChoice =
  /** Send no reasoning parameter: unset, null, or the literal "inherit". */
  | { kind: "clear"; reason: string }
  | { kind: "level"; level: string }
  /** Present but unusable. Carries the offending value so a caller can report
   *  it verbatim instead of paraphrasing it away. */
  | { kind: "invalid"; value: unknown; reason: string };

/** The rule, without the offending value: reused by the HTTP schema's message
 *  so a rejection reads the same wherever it is produced. */
export const REASONING_SYNTAX_RULE =
  "1-64 characters of letters, digits, dot, underscore or dash, starting with a " +
  'letter or digit (for example "high", or the literal "inherit" to use the runtime default)';

/** Why a value was not accepted, phrased for a user who typed it. */
export function reasoningSyntaxError(value: unknown): string {
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  return `${shown} is not a valid reasoning level: a level is ${REASONING_SYNTAX_RULE}`;
}

/** The single reader/writer rule for a reasoning value.
 *
 *  Every boundary uses this — the HTTP schema, `Agent.metadata` read and write,
 *  the run planner, and the UI's own type. A value that is not a token is NEVER
 *  coerced to null "to be safe": that would silently clear a user's setting on a
 *  typo, which is exactly the failure the literal `inherit` exists to make
 *  distinguishable. */
export function parseReasoningChoice(value: unknown): ReasoningChoice {
  if (value === null || value === undefined) {
    return { kind: "clear", reason: "no override is set" };
  }
  if (typeof value !== "string") {
    return { kind: "invalid", value, reason: reasoningSyntaxError(value) };
  }
  if (value === REASONING_INHERIT) {
    return { kind: "clear", reason: '"inherit" means the same as unset: no reasoning parameter is sent' };
  }
  if (!REASONING_TOKEN_PATTERN.test(value)) {
    return { kind: "invalid", value, reason: reasoningSyntaxError(value) };
  }
  return { kind: "level", level: value };
}

/** The effort a runtime should send, from a plan value that has already been
 *  validated: `undefined` (send nothing) or a token. Kept here so every adapter
 *  answers "inherit means omit the parameter" the same way. */
export function reasoningForRequest(value: string | undefined | null): string | undefined {
  const parsed = parseReasoningChoice(value);
  return parsed.kind === "level" ? parsed.level : undefined;
}
