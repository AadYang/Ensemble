import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { RuntimeEvent, RuntimeOptions } from "./types.js";

/** A separate app-server connection owns only this compaction, never a model turn. */
export async function* compactCodexThread(
  opts: RuntimeOptions,
  binary: string,
  env: Record<string, string>,
  kill: (child: ChildProcess) => void,
): AsyncIterable<RuntimeEvent> {
  const signal = opts.abortController.signal;
  signal.throwIfAborted();
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
    cwd: opts.runPlan.execution.projectRoot.value!,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const stopChild = () => {
    if (process.platform !== "win32" && child.pid && !closed) {
      try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* already gone */ }
    }
    kill(child);
  };
  let spawnError: Error | undefined;
  let stderr = "";
  let closed = false;
  let compactCompleted = false;
  let completed = false;
  const close = new Promise<void>((resolve) => {
    child.once("close", () => { closed = true; resolve(); });
  });
  child.once("error", (error) => { spawnError = error; });
  child.stdin.on("error", (error) => { spawnError = error; stopChild(); });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr = (stderr + text).slice(-4000);
    opts.onStderr?.(text);
  });
  const abort = () => stopChild();
  signal.addEventListener("abort", abort, { once: true });
  const lines = createInterface({ input: child.stdout });
  const send = (message: object) => {
    signal.throwIfAborted();
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  try {
    send({
      id: 1, method: "initialize",
      params: { clientInfo: { name: "ensemble_compact", version: "1" }, capabilities: {} },
    });
    for await (const line of lines) {
      signal.throwIfAborted();
      let message: Record<string, any>;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method && message.id !== undefined) {
        // A compaction cannot approve tools or answer questions on the user's behalf.
        send({ id: message.id, error: { code: -32601, message: "Unsupported during compaction" } });
        continue;
      }
      if (message.error) {
        throw new Error(`Codex compact RPC failed: ${JSON.stringify(message.error)}`);
      }
      if (message.id === 1) {
        send({ method: "initialized", params: {} });
        send({
          id: 2, method: "thread/resume",
          params: {
            threadId: opts.resume,
            cwd: opts.runPlan.execution.projectRoot.value,
            model: opts.model,
          },
        });
      } else if (message.id === 2) {
        if (message.result?.thread?.id !== opts.resume) {
          throw new Error("Codex compact resumed an unexpected thread");
        }
        send({ id: 3, method: "thread/compact/start", params: { threadId: opts.resume } });
      }
      const params = message.params;
      if (!params || params.threadId !== opts.resume) continue;
      if (message.method === "error" && !params.willRetry) {
        throw new Error(`Codex compact failed: ${params.error?.message ?? JSON.stringify(params.error)}`);
      }
      if (message.method === "item/completed" && params.item?.type === "contextCompaction") {
        compactCompleted = true;
      }
      if (message.method === "item/started" && params.item?.type === "contextCompaction") {
        yield {
          type: "sdk_message",
          payload: { type: "system", subtype: "status", status: "compacting" },
        };
      }
      if (message.method === "turn/completed") {
        if (params.turn?.status !== "completed" || !compactCompleted) {
          throw new Error(`Codex compact did not complete: ${JSON.stringify(params.turn?.error ?? params.turn?.status)}`);
        }
        completed = true;
        yield {
          type: "sdk_message",
          payload: {
            type: "system", subtype: "status", status: null,
            compact_result: "success",
          },
        };
        break;
      }
    }
    signal.throwIfAborted();
    if (!completed) {
      throw spawnError ?? new Error(`Codex app-server exited before compaction completed. ${stderr}`);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    lines.close();
    stopChild();
    if (!closed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([close, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
      if (timer) clearTimeout(timer);
    }
  }
}
