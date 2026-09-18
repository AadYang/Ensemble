import { describe, expect, it } from "vitest";
import { rejectWhenAborted, takeUntilAbort } from "../abort-iterable.js";

describe("takeUntilAbort", () => {
  it("unblocks a hung iterator as soon as the signal aborts", async () => {
    const ac = new AbortController();
    async function* hung(): AsyncGenerator<number> {
      yield 1;
      await new Promise(() => {
        /* never */
      });
    }
    const got: number[] = [];
    const consume = (async () => {
      for await (const n of takeUntilAbort(hung(), ac.signal)) got.push(n);
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(got).toEqual([1]);
    ac.abort();
    await consume;
    expect(got).toEqual([1]);
  });

  it("closes the source iterator when the consumer stops", async () => {
    let cleaned = false;
    async function* source(): AsyncGenerator<string> {
      try {
        yield "result";
        await new Promise(() => {
          /* never */
        });
      } finally {
        cleaned = true;
      }
    }
    const ac = new AbortController();
    for await (const value of takeUntilAbort(source(), ac.signal)) {
      expect(value).toBe("result");
      break;
    }
    expect(cleaned).toBe(true);
  });
});

describe("rejectWhenAborted", () => {
  it("rejects a promise the callee never tied to AbortSignal", async () => {
    const ac = new AbortController();
    const hanging = new Promise<string>(() => {
      /* never */
    });
    const raced = rejectWhenAborted(ac.signal, hanging);
    ac.abort();
    await expect(raced).rejects.toMatchObject({ name: "AbortError" });
  });
});
