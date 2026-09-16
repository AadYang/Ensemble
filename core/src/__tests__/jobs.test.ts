// The gate for the job primitive — the mechanism, not the outage.
//
// The failure this file reproduces (2026-09-15): a long build was started as an
// agent-CLI background shell. That shell was a child of the CLI process, the
// CLI process lived only as long as its session, the session was recycled when
// the context window filled, and the build died with it. No terminal record was
// written anywhere — the finished half could only be reconstructed from file
// mtimes, and the harness reported "no completion record".
//
// So the contract asserted here is ownership and honesty, in that order:
//
//   • a job started on behalf of a session is NOT bound to that session: the
//     binding can be discarded entirely and the job still finishes, still
//     reports, and still writes its terminal row
//   • a process that vanished without an exit is `lost`, never `exited`
//   • a clean shutdown records `cancelled` (and later boots do not re-read it
//     as `lost`)
//   • the log is a real file that outlives the process that wrote it
//   • every terminal state is written exactly once, with the right exit code
//
// The commands run through the same platform shell the Bash tool uses, so the
// fixture is a node one-liner-free script: quoting a command string correctly
// for both PowerShell and sh is exactly the divergence jobs.ts imports
// `shellFor` to avoid, and a test that hand-rolled its own quoting would be
// testing the test.

// MUST come first: it sets the data dir before anything resolves it.
import "./jobs-env.js";

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JobManager,
  isProcessAlive,
  renderJobView,
  jobStatusToolText,
  looksLikePosixJobCommand,
  shellForJob,
} from "../jobs.js";
import { prisma, type Job } from "../db.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "ensemble-jobs-fixture-"));
const scriptPath = join(fixtureDir, "fixture.mjs");
writeFileSync(
  scriptPath,
  [
    "const mode = process.argv[2];",
    "if (mode === 'exit') process.exit(Number(process.argv[3]));",
    "if (mode === 'print') { process.stdout.write(process.argv[3] + '\\n'); process.exit(0); }",
    "if (mode === 'hold') { setInterval(() => process.stdout.write('tick\\n'), 200); }",
  ].join("\n"),
  "utf8",
);

/** Double quotes are the one quoting form sh and PowerShell agree on. */
const run = (...args: string[]): string => `node "${scriptPath}" ${args.join(" ")}`;

/** A job's binding for the "session" that asked for it, in JobStartArgs shape.
 *
 *  These ids are deliberately the ONLY place a session is mentioned: the
 *  assertions below never use them again, which is what makes "the job does not
 *  depend on the binding that started it" a fact about the code rather than a
 *  claim in a comment.
 *
 *  The Agent row is written first because Job.agentId is a real foreign key —
 *  in production the caller always has one (the session id IS an agent id), and
 *  a test that skipped it would be exercising a shape the product cannot
 *  produce. The FK is also what makes the notice path safe: a job can never
 *  point at an agent that does not exist. */
const forSession = (id: string) => {
  if (!prisma.agent.findUnique({ where: { id } })) {
    prisma.agent.create({ data: { id, name: `agent-${id}` } });
  }
  // NOT the fixture directory: a job's cwd is held by the child for as long as
  // it lives, and Windows refuses to remove a directory that is some process's
  // working directory — including a just-killed one whose handle has not been
  // reaped yet. The fixture dir holds the script; the jobs run here.
  return { agentId: id, agentName: `agent-${id}`, cwd: process.cwd() };
};
const context = (mgr: JobManager, id: string) => ({
  jobs: mgr,
  agentId: id,
  agentName: `agent-${id}`,
  defaultCwd: fixtureDir,
});

/** Poll the ROW, not the manager, until it leaves `running`. Mirrors what an
 *  agent does through job_wait, and keeps the tests from depending on event
 *  ordering between the child's `close` and the test's next line. */
async function settle(mgr: JobManager, id: string, ms = 20_000): Promise<Job> {
  const view = await mgr.wait(id, ms);
  expect(view, `job ${id} never appeared`).not.toBeNull();
  expect(view!.status, `job ${id} never settled (still ${view!.status})`).not.toBe("running");
  return mgr.get(id)!;
}

/** A pid that is certainly dead: a child we spawned and reaped. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  const pid = child.pid;
  expect(typeof pid).toBe("number");
  return pid!;
}

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("a job's owner is core, not the session that asked for it", () => {
  it("outlives the binding that started it, and still records a terminal state", async () => {
    const updates: Job[] = [];
    const observed = new JobManager({ onUpdate: (j) => updates.push(j) });

    // A job started through one agent's context...
    const job = observed.start({
      ...forSession("session-a"),
      command: run("print", "recycled-away"),
    });
    expect(job.status).toBe("running");

    // ...and then that context is gone. Nothing in the manager holds a
    // reference to `session-a`, and nothing here ever mentions it again — which
    // is the whole point: the job must not need the binding to finish.
    const done = await settle(observed, job.id);
    expect(done.status).toBe("exited");
    expect(done.exitCode).toBe(0);
    expect(readFileSync(done.logPath, "utf8")).toContain("recycled-away");

    // The terminal notification fired exactly once, with the outcome — this is
    // what becomes the agent's transcript notice, and a job that settles
    // silently is the outage with extra steps.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe(job.id);
    expect(updates[0]!.status).toBe("exited");

    // A second manager — a different core process — sees the same fact.
    const other = new JobManager();
    expect(other.status(job.id)?.status).toBe("exited");
  });

  it("keeps its output in a file, not in the memory of a process that ended", async () => {
    const mgr = new JobManager();
    const job = mgr.start({ ...forSession("session-log"), command: run("print", "durable-line") });
    const done = await settle(mgr, job.id);
    expect(done.logPath.startsWith(JobManager.logDir())).toBe(true);
    expect(readFileSync(done.logPath, "utf8")).toContain("durable-line");
  });
});

describe("an unobserved end is reported as unknown, never as success", () => {
  it("marks a running row whose process is gone as lost, with its log kept", () => {
    const mgr = new JobManager();
    const pid = deadPid();
    const logPath = join(JobManager.logDir(), "lost-fixture.log");
    writeFileSync(logPath, "half a build\n", "utf8");

    // Exactly the row a crashed core leaves behind: it says `running`, but the
    // process it names is not there and no exit was ever recorded.
    const row = prisma.job.create({
      data: {
        ...forSession("session-lost"),
        command: "make everything",
        pid,
        status: "running",
        logPath,
      },
    });
    expect(isProcessAlive(pid)).toBe(false);

    const lost = mgr.reconcile();
    expect(lost.map((j) => j.id)).toContain(row.id);

    const after = mgr.get(row.id)!;
    expect(after.status).toBe("lost");
    // The two shapes of silent success this module exists to prevent.
    expect(after.status).not.toBe("exited");
    expect(after.exitCode).toBeNull();
    expect(after.lostReason).toContain(String(pid));
    expect(after.endedAt).not.toBeNull();
    // The evidence survives the verdict: a `lost` job's log is how the user
    // finds out how far it got.
    expect(mgr.view(after).tail).toContain("half a build");
  });

  it("leaves a genuinely live job alone", async () => {
    const mgr = new JobManager();
    const job = mgr.start({ ...forSession("session-live"), command: run("hold") });
    expect(mgr.reconcile()).toEqual([]);
    expect(mgr.get(job.id)!.status).toBe("running");
    // Not left behind for the suite's own sake.
    mgr.stopAll();
  });

  it("renders a lost job as lost, and an unknown id as an error", () => {
    const mgr = new JobManager();
    const view = mgr.view({
      id: "00000000-0000-0000-0000-000000000000",
      agentId: "session-render",
      agentName: "a",
      command: "build",
      cwd: fixtureDir,
      pid: 1,
      status: "lost",
      exitCode: null,
      logPath: join(fixtureDir, "nothing.log"),
      lastOutputAt: null,
      startedAt: new Date(),
      endedAt: new Date(),
      lostReason: "process 1 is gone and no exit was recorded",
      transcriptNotifiedAt: null,
    });
    const text = renderJobView(view);
    expect(text).toContain("status: lost");
    expect(text).toContain("no exit was recorded");

    const unknown = jobStatusToolText(
      context(mgr, "session-render"),
      { job_id: "does-not-exist" },
    );
    expect(unknown.isError).toBe(true);
    // An unknown job must not render as an empty (i.e. clean) job list.
    expect(unknown.text).toContain("does-not-exist");
  });
});

describe("every end is recorded once, with the code it ended by", () => {
  it("distinguishes a zero exit from a failing one", async () => {
    const mgr = new JobManager();
    const ok = mgr.start({ ...forSession("s"), command: run("exit", "0") });
    const bad = mgr.start({ ...forSession("s"), command: run("exit", "7") });

    const okDone = await settle(mgr, ok.id);
    const badDone = await settle(mgr, bad.id);

    expect(okDone.status).toBe("exited");
    expect(okDone.exitCode).toBe(0);
    expect(badDone.status).toBe("failed");
    expect(badDone.exitCode).toBe(7);
  });

  it("records an explicit cancel as cancelled, not as the signal that killed it", async () => {
    const mgr = new JobManager();
    const job = mgr.start({ ...forSession("s"), command: run("hold") });
    expect(isProcessAlive(job.pid!)).toBe(true);

    mgr.cancel(job.id);
    const done = await settle(mgr, job.id);
    expect(done.status).toBe("cancelled");
    // The tree really went away — a "cancelled" row whose process is still
    // running is the orphan problem wearing a status label.
    await waitForDeath(job.pid!);
    expect(isProcessAlive(job.pid!)).toBe(false);
  });

  it("records a clean shutdown as cancelled, so the next boot does not call it lost", () => {
    const mgr = new JobManager();
    const job = mgr.start({ ...forSession("s"), command: run("hold") });
    const ended = mgr.stopAll();
    expect(ended.map((j) => j.id)).toContain(job.id);
    const row = mgr.get(job.id)!;
    expect(row.status).toBe("cancelled");
    expect(row.lostReason).toBeNull();

    // The reconciler judges `running` rows only: a shutdown that recorded its
    // jobs must not be re-read a boot later as a crash.
    expect(new JobManager().reconcile()).toEqual([]);
  });
});

describe("the job shell contract", () => {
  it.runIf(process.platform === "win32")(
    "routes the POSIX command shape that failed in production to Git Bash",
    async () => {
      const command = `printf 'first\\nsecond\\n' | tail -1`;
      expect(looksLikePosixJobCommand(command)).toBe(true);
      const resolved = shellForJob(command);
      expect(resolved.shell).toBe("sh");
      expect(resolved.cmd.toLowerCase()).toContain("git");

      const mgr = new JobManager();
      const job = mgr.start({ ...forSession("session-posix"), command });
      const done = await settle(mgr, job.id);
      expect(done.status).toBe("exited");
      expect(done.exitCode).toBe(0);
      expect(readFileSync(done.logPath, "utf8").trim()).toBe("second");
    },
  );

  it("keeps ordinary commands on the documented platform shell", () => {
    const resolved = shellForJob(run("print", "ordinary"));
    expect(resolved.shell).toBe(process.platform === "win32" ? "powershell" : "sh");
  });
});

/** `taskkill`/SIGKILL land asynchronously; give the OS a moment to reap. */
async function waitForDeath(pid: number, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
