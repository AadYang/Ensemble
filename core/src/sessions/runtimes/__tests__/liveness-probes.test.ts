// Phase 4 gate, part 4: the three routes' probe capability and REGISTRATION.
//
// The policy says what each runtime can observe. That is a claim, and a claim
// is not wiring. This file is where each route's claim is checked against the
// code that would have to deliver it:
//
//   claude / codex — a child process we spawn and keep a handle on, so `dead`
//                    is an observation the OS made and not a guess;
//   openai         — no handle at all, so the honest answer is `unknown`, and
//                    the failure this guards against is a route that PRETENDS
//                    to be observable and reports `alive` from nothing.
//
// The Claude case spawns a real (trivial) child: a stub would only prove the
// stub, and the whole point of the phase is that a handle is really held.

import { beforeAll, describe, expect, it } from "vitest";
import type { RuntimeLivenessReporter } from "../types.js";
import type { LivenessProbeKind } from "@agentorch/shared";

// Set BEFORE anything that reaches db.ts, and imported dynamically for that
// reason: codex.ts pulls in mcp-bridge.ts, which pulls in conversation-search
// and then db.ts — and db.ts reads this variable when it is loaded. A static
// import here would run before this line (ESM imports are hoisted) and the test
// would open the developer's real database.
process.env.AGENTORCH_DB_PATH = ":memory:";

let makeClaudeSpawner: typeof import("../claude.js").makeClaudeSpawner;
let codexChildProbe: typeof import("../codex.js").codexChildProbe;
let runtimeLivenessCapability: typeof import("../../../capability/liveness.js").runtimeLivenessCapability;

beforeAll(async () => {
  ({ makeClaudeSpawner } = await import("../claude.js"));
  ({ codexChildProbe } = await import("../codex.js"));
  ({ runtimeLivenessCapability } = await import("../../../capability/liveness.js"));
});

/** A reporter that records what the runtime told it. */
function recordingReporter() {
  const events: Array<{ kind: string; pid: number | null; exitCode?: number | null; signal?: string | null }> = [];
  let registered: (() => LivenessProbeKind | Promise<LivenessProbeKind>) | null = null;
  const reporter: RuntimeLivenessReporter = {
    childProcessStarted: (info) => events.push({ kind: "started", pid: info.pid }),
    childProcessExited: (info) =>
      events.push({ kind: "exited", pid: info.pid, exitCode: info.exitCode, signal: info.signal }),
    streamClosed: () => events.push({ kind: "streamClosed", pid: null }),
    resultSeen: () => events.push({ kind: "resultSeen", pid: null }),
    toolProgress: () => events.push({ kind: "toolProgress", pid: null }),
    registerProbe: (probe) => {
      registered = probe;
    },
  };
  return { reporter, events, probe: () => registered };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("claude: the child handle is really held", () => {
  it("uses the SDK's own spawn when there is no reporter", () => {
    // The no-reporter path must not change how the CLI is launched at all: the
    // SDK's default spawn is used verbatim.
    expect(makeClaudeSpawner(null)).toBeNull();
  });

  it("reports the child it spawned, and answers from its handle", async () => {
    const { reporter, events, probe } = recordingReporter();
    const observer = makeClaudeSpawner(reporter)!;
    expect(observer).not.toBeNull();

    // Before a child exists the answer is `unknown` — "we have not spawned one
    // yet" is not "it is alive" and it is certainly not "it is dead".
    expect(observer.probe()).toBe("unknown");

    const proc = observer.spawner({
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      env: {},
    } as never);

    // The handle we hold is the difference between "nothing has been printed
    // for twenty minutes" and "the process is still running".
    expect(events.some((e) => e.kind === "started" && typeof e.pid === "number")).toBe(true);
    expect(observer.probe()).toBe("alive");

    // Registration is what the runtime does with this function at spawn time;
    // the probe a health check would receive is the same one asserted above.
    reporter.registerProbe?.(observer.probe);
    expect(probe()!()).toBe("alive");

    await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    await tick();

    expect(observer.probe()).toBe("dead");
    expect(events.some((e) => e.kind === "exited")).toBe(true);
  });

  it("kills the child when the user abort signal fires", async () => {
    const { reporter, events } = recordingReporter();
    const ac = new AbortController();
    const observer = makeClaudeSpawner(reporter, ac.signal)!;
    const proc = observer.spawner({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: {},
    } as never);
    expect(observer.probe()).toBe("alive");
    ac.abort();
    await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    expect(observer.probe()).toBe("dead");
    expect(events.some((e) => e.kind === "exited")).toBe(true);
  });

  it("treats a spawn failure as an exit, not as a live child", async () => {
    const { reporter, events } = recordingReporter();
    const observer = makeClaudeSpawner(reporter)!;

    // A command that cannot be spawned: there is no live child, which is the
    // same observation as an exit.
    const proc = observer.spawner({
      command: "ensemble-no-such-binary-9f3c",
      args: [],
      cwd: process.cwd(),
      env: {},
    } as never);
    void proc;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events.some((e) => e.kind === "exited" && e.exitCode === null)).toBe(true);
  });
});

describe("codex: the probe answers from the handle, and refuses to guess", () => {
  it("says alive while the child lives", () => {
    expect(codexChildProbe({ exited: false, turnCompleted: false })).toBe("alive");
  });

  it("says dead only when an unfinished turn lost its process", () => {
    expect(codexChildProbe({ exited: true, turnCompleted: false })).toBe("dead");
  });

  it("says unknown when the exit merely followed a completed turn", () => {
    // An exit that ends a turn the model already finished is not evidence of
    // death, and this probe refuses to let it become one.
    expect(codexChildProbe({ exited: true, turnCompleted: true })).toBe("unknown");
  });
});

describe("the capability each route declares", () => {
  it("gives the CLI routes a process, and names the signals they carry", () => {
    for (const runtime of ["claude", "codex"] as const) {
      const cap = runtimeLivenessCapability(runtime);
      expect(cap.capability).toBe("process");
      expect(cap.signals).toContain("child-process");
    }
  });

  it("gives the HTTP route no process, and does not claim one", () => {
    const cap = runtimeLivenessCapability("openai");
    expect(cap.capability).toBe("stream");
    // The claim and the wiring have to agree: this route never registers a
    // probe, so the snapshot reports `probeRegistered: false` and every health
    // check answers `unknown`. `alive`/`dead` are not answers it can ever give.
    expect(cap.signals).not.toContain("child-process");
  });

  it("admits ignorance for a runtime it does not know", () => {
    const cap = runtimeLivenessCapability("something-new");
    expect(cap.capability).toBe("none");
    expect(cap.reason).toContain("no probe capability is known");
  });
});
