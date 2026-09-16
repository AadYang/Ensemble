// Slice 3.2: shared path validation for the file tools (Read/Edit/Write).
//
// Mirror of Claude SDK Read/Edit/Write semantics: accept absolute paths only.
// Relative paths are surprisingly easy for the model to hand us — without an
// up-front rejection, the tool would resolve against the sidecar's cwd
// (which the model has no visibility into), causing confusing failures.

import { isAbsolute, resolve } from "node:path";

/** Absolute-only, with the turn's project root NAMED in the error.
 *
 *  The rule is unchanged (a relative path is refused rather than guessed at);
 *  what changed is that the refusal now tells the model which directory to
 *  resolve against, so a rejected call is correctable in one step instead of
 *  leaving it to guess at a root it cannot see. */
export function resolveSafe(input: string, projectRoot: string): string {
  if (!isAbsolute(input)) {
    throw new Error(
      `path must be absolute: got "${input}". The agent's project root is "${projectRoot}" — ` +
        `resolve the path against it (e.g. "${resolve(projectRoot, input)}") and call again.`,
    );
  }
  // resolve() normalizes `..` and `.` segments; keeps the abs path stable.
  return resolve(input);
}
