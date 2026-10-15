/** Fastify WS/HTTP sit in the poll phase. `await` of a resolved promise only
 *  drains microtasks, so thinking floods must `setImmediate` or create_agent
 *  waits behind every delta.
 *
 *  Stamp `lastAt` AFTER the yield. Stamping before made a slow poll (another
 *  agent's sqlite, a fat WS flush) look like "16ms already elapsed", so the
 *  next 1-char thinking_delta yielded again — ~20 chars/s on the pane
 *  (3–4 words/sec) while the CLI's thinking_duration was still tens of seconds. */
export const EVENT_LOOP_YIELD_EVERY_N = 32;
export const EVENT_LOOP_YIELD_MIN_MS = 16;

export function createEventLoopYielder(opts?: {
  everyN?: number;
  minMs?: number;
  flush?: () => Promise<void>;
  now?: () => number;
}): () => Promise<void> {
  const everyN = opts?.everyN ?? EVENT_LOOP_YIELD_EVERY_N;
  const minMs = opts?.minMs ?? EVENT_LOOP_YIELD_MIN_MS;
  const flush =
    opts?.flush ??
    (() =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      }));
  const now = opts?.now ?? Date.now;
  let eventsSinceYield = 0;
  let lastAt = 0;
  return async () => {
    eventsSinceYield++;
    if (eventsSinceYield < everyN && now() - lastAt < minMs) return;
    eventsSinceYield = 0;
    await flush();
    lastAt = now();
  };
}
