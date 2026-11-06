/** Transient upstream "this model has no free slots right now".
 *
 *  Interactive Codex CLI retries these; `codex exec --json` does not. Match the
 *  ChatGPT/Codex capacity sentence and Claude's overloaded_error — not a bare
 *  "capacity" (context window) and not a generic "overloaded". */
const CAPACITY_RE =
  /(?:selected\s+)?model\s+is\s+at\s+capacity|at\s+capacity\.?\s*please\s+try|model\s+overloaded|overloaded_error/i;

export const MODEL_CAPACITY_MAX_ATTEMPTS = 3;

export function isModelAtCapacity(message: string): boolean {
  return CAPACITY_RE.test(message);
}

/** Delay after a failed attempt before the next try: 2s, then 4s. */
export function capacityRetryDelayMs(failedAttempt: number): number {
  return 2000 * 2 ** Math.max(0, failedAttempt - 1);
}

export function shouldRetryModelCapacity(args: {
  message: string;
  attempt: number;
  yieldedVisible: boolean;
  aborted: boolean;
  rateLimited?: boolean;
  maxAttempts?: number;
}): boolean {
  if (args.aborted || args.yieldedVisible) return false;
  if (args.attempt >= (args.maxAttempts ?? MODEL_CAPACITY_MAX_ATTEMPTS)) return false;
  return Boolean(args.rateLimited) || isModelAtCapacity(args.message);
}

/** Abort-aware sleep. Returns false if the signal fired before the delay elapsed. */
export async function waitForCapacityRetry(
  signal: AbortSignal,
  failedAttempt: number,
): Promise<boolean> {
  if (signal.aborted) return false;
  const ms = capacityRetryDelayMs(failedAttempt);
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
  return !signal.aborted;
}
