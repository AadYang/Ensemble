// Git, as core runs it: a child process with an argv array, in the agent's
// project root, with a deadline and a bounded output.
//
// Three rules this module exists to keep:
//
//   • NEVER a shell string. Every invocation is `execFile("git", [...])`, so a
//     branch name can never become a second command. The leading-`-` guard in
//     `validateBranchName` is the other half of that: an argv array still lets
//     a value starting with `-` be read by git as an option.
//   • NEVER a substituted directory. The caller resolves the project root and
//     refuses an unbound or unusable one with a code. Nothing here falls back
//     to the home directory or `process.cwd()` — that would describe, and let
//     the user switch, a repository the agent has nothing to do with.
//   • NEVER a guess about what git did. The state is read back from git after
//     a checkout rather than assumed from the command, so a chip cannot show
//     the branch we asked for when git actually did something else.
//
// No `--force` appears anywhere in this file. When git refuses to switch
// because the work tree is dirty, that refusal IS the answer: it is returned
// with git's own stderr, and the user decides what to do about their changes.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspectProjectRoot } from "./sessions/project-root.js";
import {
  localNameForRemoteRef,
  parseGitStatusV2,
  parseLocalBranches,
  parseRemoteBranches,
  validateBranchName,
  validateRefArgument,
  type GitBranches,
  type GitCheckoutResult,
  type GitErrorCode,
  type GitRepoState,
  type GitStatus,
} from "@agentorch/shared";

/** A git invocation's deadline. Long enough for a cold `git status` on a large
 *  work tree on Windows, short enough that a hung credential helper or a
 *  network-backed work tree cannot hold a request open indefinitely. */
export const GIT_TIMEOUT_MS = 15_000;

/** Bounded stdout. A porcelain status or a branch list is kilobytes; anything
 *  past this is not a repository we can describe honestly, and reading it
 *  would cost more memory than the answer is worth. */
export const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface GitRunOptions {
  timeoutMs?: number;
}

/** Directories to search when `git` is not on PATH.
 *
 *  A Tauri-spawned sidecar inherits the GUI app's PATH, which on Windows often
 *  omits Git for Windows and on macOS omits Homebrew. The chip then reports
 *  `GIT_UNAVAILABLE` and refuses to switch. Tests may empty this array so an
 *  empty PATH still means "git cannot be run". */
export const GIT_EXTRA_BIN_DIRS: string[] =
  process.platform === "win32"
    ? [
        join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd"),
        join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin"),
        join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "cmd"),
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd") : "",
      ].filter(Boolean)
    : ["/opt/homebrew/bin", "/usr/local/bin"];

function gitFallbackExecutable(): string | null {
  const name = process.platform === "win32" ? "git.exe" : "git";
  return GIT_EXTRA_BIN_DIRS.map((dir) => join(dir, name)).find((p) => existsSync(p)) ?? null;
}

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when the PROCESS could not produce an answer (no binary, timeout,
   *  output cap). Null when git ran and exited non-zero — that is git talking,
   *  not the environment failing. */
  failure: GitErrorCode | null;
  /** A sentence for the failure above, or git's stderr for a non-zero exit. */
  message: string | null;
}

function invokeGit(bin: string, cwd: string, args: string[], timeoutMs: number): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: GIT_MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const errText = typeof stderr === "string" ? stderr : "";
        if (!err) {
          resolve({ ok: true, stdout: out, stderr: errText, failure: null, message: null });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        // Order matters: an output-cap kill sets BOTH `killed` and its own
        // code, so it has to be recognised before the timeout branch or a
        // runaway listing would be reported as a slow one.
        if (e.code === "ENOENT") {
          resolve({
            ok: false,
            stdout: out,
            stderr: errText,
            failure: "GIT_UNAVAILABLE",
            message: "git could not be found on PATH",
          });
          return;
        }
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({
            ok: false,
            stdout: out,
            stderr: errText,
            failure: "GIT_UNAVAILABLE",
            message: `git produced more than ${GIT_MAX_OUTPUT_BYTES} bytes of output`,
          });
          return;
        }
        if (e.killed === true || e.signal === "SIGTERM") {
          resolve({
            ok: false,
            stdout: out,
            stderr: errText,
            failure: "GIT_TIMEOUT",
            message: `git did not finish within ${timeoutMs} ms`,
          });
          return;
        }
        resolve({
          ok: false,
          stdout: out,
          stderr: errText,
          failure: null,
          message: errText.trim() || String(err),
        });
      },
    );
  });
}

/** One git invocation. Never throws: every outcome is a value, because
 *  "git is not installed" and "git said no" are answers the API has to
 *  distinguish and an exception would flatten them. */
async function runGit(cwd: string, args: string[], timeoutMs: number): Promise<GitRun> {
  const first = await invokeGit("git", cwd, args, timeoutMs);
  if (first.message !== "git could not be found on PATH") return first;
  const fallback = gitFallbackExecutable();
  if (!fallback) return first;
  return invokeGit(fallback, cwd, args, timeoutMs);
}

const stateForCode = (code: GitErrorCode): GitRepoState =>
  code === "GIT_NOT_A_REPO" ? "not-a-repo" : code === "GIT_UNBOUND" ? "unbound" : "unavailable";

function failedStatus(
  code: GitErrorCode,
  error: string,
  detail: string | null = null,
  root: string | null = null,
): GitStatus {
  return {
    state: stateForCode(code),
    code,
    root,
    branch: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirty: null,
    error,
    detail,
  };
}

/**
 * The answer for an agent with no usable project root.
 *
 * Exported rather than built at the route, because "there is no project here"
 * has to produce the SAME shape as every other refusal — a UI that has to
 * special-case the unbound response is a UI that will get it wrong.
 */
export function unboundGitStatus(reason: string): GitStatus {
  return failedStatus("GIT_UNBOUND", reason);
}

/** The same answer for the branch list, so the picker has one shape to render
 *  whether the repository is empty, unusable, or simply not there. */
export function unboundGitBranches(reason: string): GitBranches {
  return {
    state: "unbound",
    code: "GIT_UNBOUND",
    error: reason,
    detail: null,
    local: [],
    remote: [],
  };
}

/** Bound and usable, or the reason it is not. */
export type GitRootResolution =
  | { ok: true; root: string }
  | { ok: false; code: GitErrorCode; reason: string };

/**
 * What an agent's stored project root means for git.
 *
 * Takes the STORED VALUE rather than an agent so the rule is testable without a
 * database, and so there is exactly one place that decides an unbound agent has
 * no repository. The `code` is always GIT_UNBOUND — "no root" and "a root that
 * is gone" are the same refusal to the API; the reason sentence is what tells
 * the user which one it was, and it is the inspector's own words, not a
 * re-wording.
 */
export function resolveGitRoot(projectRoot: string | null | undefined): GitRootResolution {
  const stored = projectRoot?.trim();
  if (!stored) {
    return {
      ok: false,
      code: "GIT_UNBOUND",
      reason: "this agent has no project root — it works in its scratch directory",
    };
  }
  const invalid = inspectProjectRoot(stored);
  if (invalid) return { ok: false, code: "GIT_UNBOUND", reason: invalid.reason };
  return { ok: true, root: stored };
}

interface RepoFailure {
  ok: false;
  code: GitErrorCode;
  error: string;
  detail: string | null;
}
type RepoResult = { ok: true; root: string } | RepoFailure;

/** Only for a directory git confirmed is a work tree. */
const notARepo = (stderr: string): boolean => /not a git repository|not a working tree/i.test(stderr);

/**
 * Resolve the work tree this directory belongs to.
 *
 * A project root INSIDE a repository is a legitimate project: git runs in the
 * project root (that is the directory a turn runs in) and the work tree git
 * reports is the one a branch actually belongs to.
 */
async function resolveRepo(cwd: string, timeoutMs: number): Promise<RepoResult> {
  const r = await runGit(cwd, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (r.ok) {
    // `--show-toplevel` can print nothing in a bare repository; there is no
    // work tree to stand in, so the project root is the honest answer.
    return { ok: true, root: r.stdout.trim() || cwd };
  }
  if (r.failure) {
    return {
      ok: false,
      code: r.failure,
      error: r.message ?? "git could not be run",
      detail: r.stderr.trim() || null,
    };
  }
  if (notARepo(r.stderr)) {
    return {
      ok: false,
      code: "GIT_NOT_A_REPO",
      error: `${cwd} is not inside a git work tree`,
      detail: r.stderr.trim() || null,
    };
  }
  // git ran, exited non-zero, and did not say "not a repository" — an
  // ownership check, a corrupt object store, a broken .git. Report what it
  // said rather than inventing a state for it.
  return {
    ok: false,
    code: "GIT_UNAVAILABLE",
    error: r.message ?? "git could not describe this directory",
    detail: r.stderr.trim() || null,
  };
}

/** The repository's current state, read in one `git status` call. */
export async function readGitState(cwd: string, opts: GitRunOptions = {}): Promise<GitStatus> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;

  const repo = await resolveRepo(cwd, timeoutMs);
  if (!repo.ok) return failedStatus(repo.code, repo.error, repo.detail);

  const r = await runGit(
    cwd,
    ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
    timeoutMs,
  );
  if (!r.ok) {
    const code: GitErrorCode = r.failure ?? (notARepo(r.stderr) ? "GIT_NOT_A_REPO" : "GIT_UNAVAILABLE");
    return failedStatus(code, r.message ?? "git status failed", r.stderr.trim() || null, repo.root);
  }

  const facts = parseGitStatusV2(r.stdout);
  return {
    state: "ok",
    code: null,
    root: repo.root,
    branch: facts.branch,
    detached: facts.detached,
    head: facts.head,
    upstream: facts.upstream,
    ahead: facts.ahead,
    behind: facts.behind,
    dirty: facts.dirty,
    error: null,
    detail: null,
  };
}

/**
 * Every branch the user could switch to.
 *
 * All-or-nothing on purpose: a list that silently lacks its remote branches
 * would render as "this repository has no remotes", and the user would act on
 * that. When a read fails, the failure is the answer.
 */
export async function listGitBranches(cwd: string, opts: GitRunOptions = {}): Promise<GitBranches> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const empty = (
    code: GitErrorCode,
    error: string,
    detail: string | null,
  ): GitBranches => ({ state: stateForCode(code), code, error, detail, local: [], remote: [] });

  const repo = await resolveRepo(cwd, timeoutMs);
  if (!repo.ok) return empty(repo.code, repo.error, repo.detail);

  // Tab-separated: git forbids control characters in ref names, so a tab can
  // never occur inside a field and an empty field survives the split.
  const localRun = await runGit(
    cwd,
    [
      "for-each-ref",
      "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)\t%(committerdate:iso-strict)",
      "refs/heads",
    ],
    timeoutMs,
  );
  if (!localRun.ok) {
    const code: GitErrorCode = localRun.failure ?? "GIT_UNAVAILABLE";
    return empty(code, localRun.message ?? "could not list local branches", localRun.stderr.trim() || null);
  }

  const remoteRun = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"], timeoutMs);
  if (!remoteRun.ok) {
    const code: GitErrorCode = remoteRun.failure ?? "GIT_UNAVAILABLE";
    return empty(code, remoteRun.message ?? "could not list remote branches", remoteRun.stderr.trim() || null);
  }

  return {
    state: "ok",
    code: null,
    error: null,
    detail: null,
    local: parseLocalBranches(localRun.stdout),
    remote: parseRemoteBranches(remoteRun.stdout),
  };
}

/** The configured remote names, used only to turn a remote ref into the local
 *  name a tracking branch should take. A failure here is not fatal: without
 *  names to match, the ref is treated as its own name and git reports the
 *  result — which is still an honest answer. */
async function remoteNames(cwd: string, timeoutMs: number): Promise<string[]> {
  const r = await runGit(cwd, ["remote"], timeoutMs);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** The full ref names that exist locally and under `refs/remotes`. One call,
 *  used to tell "this is a local branch" from "this is a remote ref" — the two
 *  cases that need different `git checkout` arguments. */
async function existingRefs(cwd: string, timeoutMs: number): Promise<Set<string>> {
  const r = await runGit(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], timeoutMs);
  if (!r.ok) return new Set();
  return new Set(
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}

/**
 * Switch branches.
 *
 * Three cases, and the difference between them is what the user asked for:
 *
 *   • `create` — a new branch, optionally from a start point.
 *   • a remote ref — Cursor's behaviour, which is also what a user means by
 *     clicking `origin/foo`: a LOCAL branch that tracks it, because checking
 *     the remote ref out directly would detach HEAD and silently stop tracking.
 *   • anything else — a plain checkout, with git's own refusal (uncommitted
 *     changes, unknown ref) returned verbatim rather than worked around.
 */
export async function checkoutGitBranch(
  cwd: string,
  input: { branch: string; create?: boolean; from?: string | null },
  opts: GitRunOptions = {},
): Promise<GitCheckoutResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const branch = input.branch;

  const valid = validateBranchName(branch);
  if (!valid.ok) return { ok: false, code: "GIT_BRANCH_INVALID", error: valid.reason, detail: null };

  const from = (input.from ?? "").trim();
  // `from` implies create: a start point only means something for a branch
  // that does not exist yet, and accepting it for an existing one would make
  // the request mean two different things depending on the repository.
  const wantsCreate = input.create === true || from !== "";
  if (from !== "") {
    const fromValid = validateRefArgument(from);
    if (!fromValid.ok) return { ok: false, code: "GIT_BRANCH_INVALID", error: fromValid.reason, detail: null };
  }

  const repo = await resolveRepo(cwd, timeoutMs);
  if (!repo.ok) return { ok: false, code: repo.code, error: repo.error, detail: repo.detail };

  // git's own grammar check. The rule above is a fast copy; this is the
  // authority, and it is the last thing before the name reaches argv.
  const refCheck = await runGit(cwd, ["check-ref-format", "--branch", branch], timeoutMs);
  if (!refCheck.ok) {
    if (refCheck.failure) {
      return {
        ok: false,
        code: refCheck.failure,
        error: refCheck.message ?? "git could not be run",
        detail: refCheck.stderr.trim() || null,
      };
    }
    return {
      ok: false,
      code: "GIT_BRANCH_INVALID",
      error: `${branch} is not a valid branch name`,
      detail: refCheck.stderr.trim() || null,
    };
  }

  let args: string[];
  let created = false;
  let tracked: string | null = null;

  if (wantsCreate) {
    args = from !== "" ? ["checkout", "-b", branch, from] : ["checkout", "-b", branch];
    created = true;
  } else {
    const refs = await existingRefs(cwd, timeoutMs);
    const isLocal = refs.has(`refs/heads/${branch}`);
    const isRemote = refs.has(`refs/remotes/${branch}`);
    if (isRemote && !isLocal) {
      const short = localNameForRemoteRef(branch, await remoteNames(cwd, timeoutMs));
      args = ["checkout", "-b", short, "--track", branch];
      created = true;
      tracked = branch;
    } else {
      args = ["checkout", branch];
    }
  }

  const run = await runGit(cwd, args, timeoutMs);
  if (!run.ok) {
    if (run.failure) {
      return {
        ok: false,
        code: run.failure,
        error: run.message ?? "git could not be run",
        detail: run.stderr.trim() || null,
      };
    }
    const detail = run.stderr.trim() || null;
    return {
      ok: false,
      code: "GIT_CHECKOUT_FAILED",
      // git's own sentence, unparaphrased. "Your local changes to the following
      // files would be overwritten by checkout" plus the file list IS the
      // answer; rewording it would drop the part the user needs.
      error: detail ?? run.message ?? `git checkout ${branch} failed`,
      detail,
    };
  }

  return { ok: true, created, tracked, status: await readGitState(cwd, { timeoutMs }) };
}
