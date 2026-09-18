/** Yield from `source` until `signal` aborts, then close the iterator.

 *  `for await` alone only notices abort on the *next* yield. A hung Claude CLI,
 *  OpenAI HTTP body, or Codex stdout line would keep the consumer parked, and
 *  cancel would look like a no-op even after AbortController.abort() fired.
 *  Closing the iterator here is what unblocks the consumer; the runtime's own
 *  abort handling is what actually kills the child / fetch. */
export async function* takeUntilAbort<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  const close = () => {
    void it.return?.();
  };
  if (signal.aborted) {
    close();
    return;
  }
  signal.addEventListener("abort", close, { once: true });
  try {
    while (!signal.aborted) {
      const next = await Promise.race([it.next(), abortedAsDone(signal)]);
      if (!next || next.done || signal.aborted) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}

function abortedAsDone(signal: AbortSignal): Promise<IteratorResult<never>> {
  return new Promise((resolve) => {
    const done = () => resolve({ done: true, value: undefined });
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Reject when `signal` aborts. Used to unstick a Promise the SDK never ties
 *  to its own AbortSignal (or ties too late). */
export function rejectWhenAborted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}
