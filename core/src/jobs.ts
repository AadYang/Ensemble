// Jobs: long-running processes whose OWNER IS CORE.
//
// Why this module exists (2026-09-15):
//
// A long build was started as an agent-CLI background shell. That shell is a
// child of the CLI process, and the CLI process lives exactly as long as its
// session — which is recycled the moment the context window fills. When the
// session went away the build went with it, no terminal record was written
// anywhere, and the finished half could only be reconstructed from file
// mtimes. The failure was not carelessness: it was OWNERSHIP. The work was
// anchored to a process with a shorter life than the work itself.
//
// So the rule this module encodes: work that may outlive a turn is spawned by
// CORE, which outlives every session. Nothing here is reachable from a run's
// AbortController, and nothing here is torn down when a turn ends, a session is
// recycled, or an agent's context overflows. The only things that end a job are
// the process exiting on its own, an explicit `cancel`, or core shutting down.
//
// The second half of the rule is that an unfinished job must never LOOK
// finished. Every transition writes a row, the process id is kept so the row
// can be checked against reality, and a `running` row whose process is gone
// becomes `lost` — the honest answer — rather than being read as a success.
//
// The boundary, stated because the first half of the rule is easy to overread
// (measured, not assumed — proving this cross-process showed the shape): a job
// survives its SESSION, not core itself. Core owns the child's stdout through a
// pipe, so a core process that is KILLED rather than shut down takes its
// running jobs with it on a broken pipe. There is no longer-lived owner to hand
// them to — core is the outermost process in the product. What that case buys
// is the second half of the rule: the job is recorded with the exit code it
// really died by, or reconciled to `lost` at the next boot, and its log is
// still on disk. It is never reported as a success.
//
// Output goes to a file, not to memory: the point of the log is to survive the
// agent that asked for it, so it must not live in a spool that a turn disposes.
//
// The primitive deliberately does not depend on a runtime. Agents reach it
// through the `agentorch-jobs` MCP server (Claude), the internal MCP bridge
// (Codex) and the normalized-tool path (OpenAI) — one implementation, three
// transports, none of which is the SDK's background shell.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDataDir } from "./paths.js";
import { prisma, type Job, type JobStatus } from "./db.js";
import { shellFor } from "./sessions/tools/bash.js";

/** Bytes of log returned to an agent by `job_status`. Big enough for a build's
 *  last error plus its summary; small enough that polling does not become the
 *  expensive part of watching a job. */
export const JOB_TAIL_BYTES = 4_096;

/** Longest a single `job_wait` may block, so a waiting agent cannot wedge a
 *  turn indefinitely. Matches the Bash tool's ceiling. */
export const JOB_WAIT_MAX_MS = 600_000;

export type JobShell = "auto" | "powershell" | "sh";

/** How often `lastOutputAt` is written to the DB while a job streams output.
 *  A build printing thousands of lines must not issue thousands of writes. */
const OUTPUT_TOUCH_INTERVAL_MS = 2_000;

export interface JobView {
  id: string;
  status: JobStatus;
  command: string;
  cwd: string;
  pid: number | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  /** Last time the job wrote output. For a running job this is the difference
   *  between "working" and "hung", which the pid alone cannot tell you. */
  lastOutputAt: string | null;
  /** Absolute path to the full log — the job outlives the turn, so the durable
   *  copy is a file the caller can grep later, not a string in a message. */
  logPath: string;
  /** Last bytes of the log, with a marker when it was truncated. */
  tail: string;
  /** Set when `status === "lost"`, or when a start/kill failed. Never a note
   *  that contradicts the status: it explains it. */
  lostReason: string | null;
}

export interface JobStartArgs {
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  /** Shell contract for the command. `auto` uses the platform shell, except
   *  that unmistakably POSIX syntax on Windows is routed to Git Bash when it
   *  is installed. Callers can select explicitly to avoid any inference. */
  shell?: JobShell;
  /** Optional hard ceiling. ABSENT BY DEFAULT ON PURPOSE: a job exists because
   *  the work is longer than a turn, so imposing the Bash tool's 120s default
   *  here would defeat the point. When it does fire, the exit code is reported
   *  as 124 — the GNU timeout convention the Bash tool already uses. */
  timeoutMs?: number;
}

const WINDOWS_GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

/** Syntax that PowerShell 5 cannot parse or commands it does not provide.
 *  This is intentionally narrow: ordinary commands keep the documented
 *  platform shell, while the exact Git-Bash shape agents commonly produce
 *  (`cd /d/... && ... | tail`) is no longer launched into a guaranteed parser
 *  error. */
export function looksLikePosixJobCommand(command: string): boolean {
  return (
    /(?:^|[\s;])cd\s+\/[a-zA-Z]\//.test(command) ||
    /(?:^|[\s|;&])(tail|head|grep|sed|awk|cat)\s+(?:-|\d|['"])/.test(command) ||
    /(?:^|[\s;])export\s+[A-Za-z_][A-Za-z0-9_]*=/.test(command) ||
    /(?:^|[\s;])set\s+-[a-zA-Z]*e/.test(command)
  );
}

export function shellForJob(
  command: string,
  preference: JobShell = "auto",
): { cmd: string; args: string[]; shell: Exclude<JobShell, "auto"> } {
  if (process.platform !== "win32") {
    if (preference === "powershell") {
      throw new Error('job shell "powershell" is only available on Windows');
    }
    return { cmd: "sh", args: ["-c", command], shell: "sh" };
  }

  const wantsSh = preference === "sh" || (preference === "auto" && looksLikePosixJobCommand(command));
  if (wantsSh) {
    const gitBash = WINDOWS_GIT_BASH_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!gitBash) {
      throw new Error(
        'this job uses POSIX shell syntax, but Git Bash was not found; install Git for Windows or pass shell="powershell" with PowerShell syntax',
      );
    }
    return { cmd: gitBash, args: ["--noprofile", "--norc", "-c", command], shell: "sh" };
  }

  const resolved = shellFor(command);
  return { ...resolved, shell: "powershell" };
}

export interface JobManagerOptions {
  /** Called on every state change, so the session layer can broadcast it. */
  onUpdate?: (job: Job) => void;
}

/** Is this pid still a live process?
 *
 *  `signal 0` performs the existence/permission check without delivering
 *  anything; Node implements it on Windows too. EPERM means the process exists
 *  and belongs to someone else — alive, which is why it is not failure here. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kill a pid we hold no handle for. Windows needs the tree walk. */
export function killByPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

/** Kill a child AND its descendants.
 *
 *  A job runs through a shell (`powershell -Command` / `sh -c`), so the pid we
 *  hold is the shell's, not the work's: killing it alone would leave the real
 *  build running and unreachable. Mirrors `killCodexChildTree`
 *  (sessions/runtimes/codex.ts), which solves the same problem for codex. */
export function killJobTree(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  if (process.platform === "win32" && typeof child.pid === "number") {
    killByPid(child.pid);
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // A race with natural exit. Nothing more to do.
  }
}

/** Last `bytes` of a log file, decoded as UTF-8.
 *
 *  Read from the END rather than by loading the file: a build log is expected
 *  to be megabytes and this runs on every `job_status`. Truncation is announced
 *  in the text so a partial tail cannot be read as a complete one. */
export function readTail(path: string, bytes: number = JOB_TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > length ? `[…${size - length} earlier bytes in ${path}]\n${text}` : text;
  } catch {
    // No log yet, or it vanished with the process.
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

// ── The agent-facing surface ──────────────────────────────────────────────
//
// Rendering and the four operations live HERE, not in the MCP server, because
// the same semantics must be reachable from three transports: the
// `agentorch-jobs` MCP server (Claude), the internal bridge (Codex) and the
// normalized-tool path (OpenAI). Two implementations of "what does job_wait
// mean" is how a job's status comes to depend on which runtime asked.

export interface JobToolContext {
  jobs: JobManager;
  agentId: string;
  agentName: string;
  /** Where a job runs when the caller names no directory: the agent's project
   *  root for this turn, never core's own cwd. */
  defaultCwd: string;
}

/** A job rendered for an agent's eyes. Compact on purpose: the caller reads
 *  this every poll, so it carries what changed and points at the log for the
 *  rest. */
export function renderJobView(view: JobView): string {
  const lines = [
    `job ${view.id}`,
    `status: ${view.status}${view.exitCode === null ? "" : ` (exit ${view.exitCode})`}`,
    `command: ${view.command}`,
    `cwd: ${view.cwd}`,
    `started: ${view.startedAt}`,
    view.endedAt ? `ended: ${view.endedAt}` : `last output: ${view.lastOutputAt ?? "none yet"}`,
    `log: ${view.logPath}`,
  ];
  if (view.lostReason) lines.push(`note: ${view.lostReason}`);
  if (view.tail.trim()) lines.push(`--- last output ---\n${view.tail}`);
  return lines.join("\n");
}

export function renderJobList(views: readonly JobView[]): string {
  if (views.length === 0) return "no jobs have been started for this agent";
  return views
    .map(
      (v) =>
        `${v.status.padEnd(9)} ${v.id}  ${v.exitCode === null ? "  " : `exit ${String(v.exitCode).padEnd(4)}`} ${v.command}`,
    )
    .join("\n");
}

/** Outcome of a job operation, transport-neutral: MCP spells `isError` as
 *  `isError: true`, the normalized tools return the string or throw. Nothing
 *  here softens a status — `lost` is reported as lost. */
export interface JobToolResult {
  text: string;
  isError?: true;
}

export function jobStartToolText(
  ctx: JobToolContext,
  args: { command: string; cwd?: string; timeout_ms?: number; shell?: JobShell },
): string {
  const view = ctx.jobs.start({
    agentId: ctx.agentId,
    agentName: ctx.agentName,
    command: args.command,
    cwd: args.cwd ?? ctx.defaultCwd,
    ...(args.shell === undefined ? {} : { shell: args.shell }),
    ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
  });
  return renderJobView(view);
}

export function jobStatusToolText(ctx: JobToolContext, args: { job_id?: string }): JobToolResult {
  if (!args.job_id) {
    const views = ctx.jobs.list(ctx.agentId).map((j) => ctx.jobs.view(j));
    return { text: renderJobList(views) };
  }
  const view = ctx.jobs.status(args.job_id);
  if (!view) return { text: `no job ${args.job_id} is known to this server`, isError: true };
  return { text: renderJobView(view) };
}

export async function jobWaitToolText(
  ctx: JobToolContext,
  args: { job_id: string; timeout_ms?: number },
): Promise<JobToolResult> {
  const view = await ctx.jobs.wait(args.job_id, args.timeout_ms ?? 60_000);
  if (!view) return { text: `no job ${args.job_id} is known to this server`, isError: true };
  return { text: renderJobView(view) };
}

export function jobCancelToolText(ctx: JobToolContext, args: { job_id: string }): JobToolResult {
  const view = ctx.jobs.cancel(args.job_id);
  if (!view) return { text: `no job ${args.job_id} is known to this server`, isError: true };
  return { text: renderJobView(view) };
}

export class JobManager {
  private readonly live = new Map<string, ChildProcess>();
  private readonly streams = new Map<string, WriteStream>();
  /** Ids whose end was already recorded, so the `error` and `close` events
   *  cannot both write a terminal state (and cannot write two different ones). */
  private readonly finalized = new Set<string>();
  /** Ids ended by an explicit `cancel`, so the close event reports the cancel
   *  instead of re-deriving a status from the kill signal. */
  private readonly cancelled = new Set<string>();
  /** Timestamp of the last `lastOutputAt` write, per job. */
  private readonly lastTouch = new Map<string, number>();
  private stopped = false;

  constructor(private readonly opts: JobManagerOptions = {}) {}

  /** Where logs live. Under the data dir, beside `agents/` and `skills/`, so a
   *  job's evidence sits with the rest of the install's state and survives the
   *  process that wrote it. */
  static logDir(): string {
    const dir = join(ensureDataDir(), "jobs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  start(args: JobStartArgs): JobView {
    if (this.stopped) {
      throw new Error("the job manager is shutting down; no new job can be started");
    }
    const id = randomUUID();
    const logPath = join(JobManager.logDir(), `${id}.log`);
    const { cmd, args: shellArgs } = shellForJob(args.command, args.shell);

    // Not `detached`: core still OWNS this child, so a core crash cannot leave
    // an untracked process behind. What lets the job outlive a session is that
    // core — not the session — is its parent.
    const child = spawn(cmd, shellArgs, {
      cwd: args.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const row = prisma.job.create({
      data: {
        id,
        agentId: args.agentId,
        agentName: args.agentName,
        command: args.command,
        cwd: args.cwd,
        pid: child.pid ?? null,
        status: "running",
        logPath,
      },
    });

    this.live.set(id, child);

    // Opened SYNCHRONOUSLY, then handed to the stream by descriptor. The path
    // is part of what `job_start` returns, and a handle that names a file which
    // does not exist yet is a lie the caller can act on (a `read`/`tail` of it
    // fails, and a log path from a job that then died unborn stays a dangling
    // reference forever). Measured while proving the mechanism cross-process:
    // with the async open, a core that exited moments after `start()` left no
    // file at all.
    const fd = openSync(logPath, "a");
    const stream = createWriteStream(logPath, { fd });
    this.streams.set(id, stream);
    const onData = (buf: Buffer): void => {
      stream.write(buf);
      const now = Date.now();
      if (now - (this.lastTouch.get(id) ?? 0) < OUTPUT_TOUCH_INTERVAL_MS) return;
      this.lastTouch.set(id, now);
      try {
        prisma.job.update({
          where: { id },
          data: { lastOutputAt: Math.floor(now / 1000) },
        });
      } catch {
        // Concurrent finalization or a closed DB; the terminal write carries
        // the authoritative value.
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    if (typeof args.timeoutMs === "number" && args.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killJobTree(child);
      }, args.timeoutMs);
    }

    child.once("error", (err) => {
      // The process never started (bad cwd, missing shell). Recorded as a
      // terminal state like any other — the caller is not left waiting.
      if (timer) clearTimeout(timer);
      this.finish(id, {
        status: "failed",
        exitCode: null,
        reason: `the process could not be started: ${String(err)}`,
      });
    });

    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        this.finish(id, { status: "failed", exitCode: 124 });
        return;
      }
      if (this.cancelled.has(id)) {
        this.finish(id, { status: "cancelled", exitCode: typeof code === "number" ? code : null });
        return;
      }
      if (typeof code === "number") {
        this.finish(id, { status: code === 0 ? "exited" : "failed", exitCode: code });
      } else {
        this.finish(id, {
          status: "failed",
          exitCode: null,
          reason: `the process was killed by signal ${signal ?? "unknown"}`,
        });
      }
    });

    return this.view(row);
  }

  /** Write the terminal state once. Idempotent: whichever of `error` / `close`
   *  arrives first owns the transition, and the second is a no-op. */
  private finish(
    id: string,
    patch: { status: Exclude<JobStatus, "running">; exitCode: number | null; reason?: string },
  ): void {
    if (this.finalized.has(id)) return;
    this.finalized.add(id);

    const stream = this.streams.get(id);
    if (stream) {
      stream.end();
      this.streams.delete(id);
    }
    this.live.delete(id);
    this.lastTouch.delete(id);

    try {
      const row = prisma.job.update({
        where: { id },
        data: {
          status: patch.status,
          exitCode: patch.exitCode,
          endedAt: Math.floor(Date.now() / 1000),
          lastOutputAt: Math.floor(Date.now() / 1000),
          // Only ever WRITTEN for the states that need explaining. A normal
          // exit has nothing to explain, and a reason on it would read as a
          // problem that did not happen.
          ...(patch.reason ? { lostReason: patch.reason } : {}),
        },
      });
      this.opts.onUpdate?.(row);
    } catch {
      // The DB is closed (shutdown). The row keeps its last written state and
      // the boot reconciler will mark it lost — which is the truth.
    }
  }

  get(id: string): Job | null {
    return prisma.job.findUnique({ where: { id } }) as Job | null;
  }

  cancel(id: string): JobView | null {
    const job = this.get(id);
    if (!job) return null;
    if (job.status !== "running") return this.view(job);
    this.cancelled.add(id);
    const child = this.live.get(id);
    if (child) {
      // The close handler records the terminal state.
      killJobTree(child);
      return this.view(this.get(id) ?? job);
    }
    // Started by an earlier core process: no handle, but the pid may be real.
    if (job.pid !== null) killByPid(job.pid);
    this.finish(id, { status: "cancelled", exitCode: null });
    return this.view(this.get(id) ?? job);
  }

  list(agentId: string): Job[] {
    return prisma.job.findMany({
      where: { agentId },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
  }

  status(id: string): JobView | null {
    const job = this.get(id);
    return job ? this.view(job) : null;
  }

  /** Bounded wait. Polls the ROW rather than the in-memory handle, so it works
   *  equally for a job this process started and one inherited from an earlier
   *  core process. */
  async wait(id: string, timeoutMs: number): Promise<JobView | null> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), JOB_WAIT_MAX_MS);
    for (;;) {
      const job = this.get(id);
      if (!job) return null;
      if (job.status !== "running") return this.view(job);
      if (Date.now() >= deadline) return this.view(job);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  view(job: Job): JobView {
    return {
      id: job.id,
      status: job.status,
      command: job.command,
      cwd: job.cwd,
      pid: job.pid,
      exitCode: job.exitCode,
      startedAt: job.startedAt.toISOString(),
      endedAt: job.endedAt ? job.endedAt.toISOString() : null,
      lastOutputAt: job.lastOutputAt ? job.lastOutputAt.toISOString() : null,
      logPath: job.logPath,
      tail: readTail(job.logPath),
      lostReason: job.lostReason,
    };
  }

  /** Reconcile rows that claim to be running against the real OS processes.
   *
   *  This is the self-healing half. A `running` row whose process is gone was
   *  never observed finishing: the core that started it crashed, the machine
   *  rebooted, or the process was killed from outside. It is marked `lost` with
   *  whatever log it managed to write, because the alternatives — a row that
   *  says "running" forever, or a default "exited 0" — are the silent-success
   *  shapes this module exists to prevent.
   *
   *  Called once at boot, before any agent can ask about its jobs. */
  reconcile(): Job[] {
    const running = prisma.job.findMany({ where: { status: "running" } }) as Job[];
    const lost: Job[] = [];
    for (const job of running) {
      if (job.pid !== null && isProcessAlive(job.pid)) continue;
      const row = prisma.job.update({
        where: { id: job.id },
        data: {
          status: "lost",
          endedAt: Math.floor(Date.now() / 1000),
          lostReason:
            job.pid === null
              ? "recorded as running but no process id was ever written, and no exit was observed"
              : `process ${job.pid} is gone and no exit was recorded (core restarted or the process was killed)`,
        },
      });
      lost.push(row);
      this.opts.onUpdate?.(row);
    }
    return lost;
  }

  /** Shutdown: end every job THIS process started.
   *
   *  Leaving them running would be the orphan problem this codebase already
   *  refuses elsewhere (see `killCodexChildTree`); leaving the rows as
   *  `running` would make the next boot's reconciler report a clean shutdown as
   *  a `lost` job. So the shutdown is explicit, and the status says so. Jobs
   *  started by an earlier core process are left alone — this process has no
   *  authority over them, and the reconciler will judge them next boot. */
  stopAll(): Job[] {
    this.stopped = true;
    const ended: Job[] = [];
    for (const id of [...this.live.keys()]) {
      const child = this.live.get(id);
      this.cancelled.add(id);
      if (child) killJobTree(child);
      this.finish(id, { status: "cancelled", exitCode: null });
      const after = this.get(id);
      if (after) ended.push(after);
    }
    return ended;
  }
}
