/** Zustand equality for the agent directory.

 *  Stream flushes replace `agents` and the one agent's `turns`, but they keep
 *  the same `summary` object. Sidebar, page chrome, and other panes only care
 *  about summaries (name/status/team). Comparing those references means a
 *  thinking agent does not re-render the rest of the window. */
export function agentDirectoryUnchanged<T extends { summary: object }>(
  a: Record<string, T>,
  b: Record<string, T>,
): boolean {
  if (a === b) return true;
  const ids = Object.keys(a);
  if (ids.length !== Object.keys(b).length) return false;
  for (const id of ids) {
    const left = a[id];
    const right = b[id];
    if (!left || !right || left.summary !== right.summary) return false;
  }
  return true;
}
