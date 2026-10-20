import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeOptions } from "../runtimes/types.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { compactCodexThread } from "../runtimes/codex-compact.js";

const threadId = "01a1576f-be4d-73f2-9dbe-e04a618fd87a";
let mode: "success" | "silent" | "error" | "cancel";
let requests: Array<Record<string, any>>;
let controller: AbortController;
let child: ChildProcess;
let kill: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mode = "success";
  requests = [];
  controller = new AbortController();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const emit = (message: object) => stdout.write(`${JSON.stringify(message)}\n`);
  kill = vi.fn(() => {
    stdout.end();
    emitter.emit("close", 0);
  });
  const stdin = new Writable({
    write(data, _encoding, callback) {
      const request = JSON.parse(data.toString());
      requests.push(request);
      queueMicrotask(() => {
        if (request.id === 1) emit({ id: 1, result: {} });
        if (request.id === 2) emit({ id: 2, result: { thread: { id: threadId } } });
        if (request.id === 3) {
          if (mode === "cancel") { controller.abort(); return; }
          if (mode === "error") { emit({ id: 3, error: { message: "unsupported method" } }); return; }
          emit({ id: 3, result: {} });
          if (mode === "success") {
            emit({ method: "item/completed", params: { threadId, item: { type: "contextCompaction" } } });
            emit({ method: "turn/completed", params: { threadId, turn: { status: "completed" } } });
          } else {
            stdout.end();
            emitter.emit("close", 0);
          }
        }
      });
      callback();
    },
  });
  child = Object.assign(emitter, { stdin, stdout, stderr }) as unknown as ChildProcess;
  mocks.spawn.mockReturnValue(child);
});

async function run() {
  const opts = {
    resume: threadId,
    model: "test-model",
    abortController: controller,
    runPlan: { execution: { projectRoot: { value: process.cwd() } } },
  } as RuntimeOptions;
  const events = [];
  for await (const event of compactCodexThread(opts, "codex", { CODEX_HOME: "agent-home" }, kill)) {
    events.push(event);
  }
  return events;
}

describe("Codex native compaction protocol", () => {
  it("resumes the exact thread and waits for completed compaction, without starting a user turn", async () => {
    const events = await run();
    expect(requests.map((request) => request.method)).toEqual([
      "initialize", "initialized", "thread/resume", "thread/compact/start",
    ]);
    expect(requests[2]?.params.threadId).toBe(threadId);
    expect(events).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ compact_result: "success" }),
    }));
    expect(kill).toHaveBeenCalledWith(child);
  });

  it("does not treat the RPC acknowledgement as completion", async () => {
    mode = "silent";
    await expect(run()).rejects.toThrow("before compaction completed");
  });

  it("surfaces unsupported native compaction instead of sending a prompt", async () => {
    mode = "error";
    await expect(run()).rejects.toThrow("unsupported method");
    expect(requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("kills its connection and rejects on cancellation", async () => {
    mode = "cancel";
    await expect(run()).rejects.toThrow();
    expect(kill).toHaveBeenCalledWith(child);
  });
});
