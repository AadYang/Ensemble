// Slice 3.2: shared path validation for the file tools (Read/Edit/Write).
//
// Mirror of Claude SDK Read/Edit/Write semantics: accept absolute paths only.
// Relative paths are surprisingly easy for the model to hand us — without an
// up-front rejection, the tool would resolve against the sidecar's cwd
// (which the model has no visibility into), causing confusing failures.

import { isAbsolute, resolve } from "node:path";

export function resolveSafe(input: string): string {
  if (!isAbsolute(input)) {
    throw new Error(
      `path must be absolute: got "${input}". Resolve with the workspace root before calling.`,
    );
  }
  // resolve() normalizes `..` and `.` segments; keeps the abs path stable.
  return resolve(input);
}
