// The HTTP half of the reasoning contract.
//
// The RULE lives in `@agentorch/shared` (one definition, one validator, used by
// the planner, the metadata reader, the runtime adapters and the UI type). What
// lives here is only the wire adapter: the zod schema `PATCH /agents/:id` runs,
// which must accept three shapes and produce exactly ONE clear shape.
//
//   "high"      → "high"    (a token; membership is checked against the model's
//                            capability further down, never against a list here)
//   "inherit"   → null      (the same state as "unset" — never a second stored
//                            shape that a later reader could disagree with)
//   null        → null      (clear)
//   anything else → 400     (quotes, whitespace, `=`, over-long: the token is
//                            interpolated into TOML, argv and JSON, so the
//                            character set is the safety boundary)
//
// The schema is exported rather than inlined in index.ts so the contract can be
// pinned by a test: index.ts is a listen-on-import entry point and cannot be
// imported without starting a server.

import { z } from "zod";
import { parseReasoningChoice, REASONING_SYNTAX_RULE } from "@agentorch/shared";

/** A token, null, or the literal "inherit" — normalized to `string | null`,
 *  where null is the only representation of "send no reasoning parameter". */
export const reasoningChoiceSchema = z
  .union([z.string(), z.null()])
  .refine((value) => parseReasoningChoice(value).kind !== "invalid", {
    message: `not a valid reasoning level: a level is ${REASONING_SYNTAX_RULE}`,
  })
  .transform((value) => {
    const parsed = parseReasoningChoice(value);
    return parsed.kind === "level" ? parsed.level : null;
  });

/** `PATCH /agents/:id` omits the field to leave it alone; an explicit null (or
 *  "inherit") clears it. */
export const reasoningPatchSchema = reasoningChoiceSchema.optional();
