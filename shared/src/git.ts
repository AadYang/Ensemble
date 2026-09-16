// The git contract between core and the desktop UI.
//
// This is a shared module rather than a UI detail for three reasons:
//
//   • the SERVER is the only thing that reads a repository. The UI renders what
//     it was told and never infers a branch from a path, a cache, or a guess —
//     a chip that shows a stale branch is worse than one that shows nothing.
//   • the branch-name rule must hold in two places (the picker refuses before a
//     round trip, core refuses before argv), so it is one function, not two
//     spellings of one rule.
//   • "may the user switch right now?" is a decision, not a rendering: it
//     depends on the repository state AND on whether the agent is mid-turn.
//     Putting it here is what lets a single test pin the answer for both sides.
//
// The parsers below read git's own output formats. They are pure by design —
// the subprocess lives in core, so the shapes git produces can be tested
// without a repository on disk.

/** Every way this feature can refuse. Kept as one union so a new code is a
 *  compile error at every switch that maps it to a state or an HTTP status,
 *  instead of a string that quietly falls through to "something went wrong". */
export const GIT_ERROR_CODES = [
  "GIT_UNAVAILABLE",
  "GIT_NOT_A_REPO",
  "GIT_UNBOUND",
  "GIT_BRANCH_INVALID",
  "GIT_CHECKOUT_FAILED",
  "GIT_TIMEOUT",
] as const;

export type GitErrorCode = (typeof GIT_ERROR_CODES)[number];

/** What the repository IS, as far as the server could tell. `ok` is the only
 *  state that carries a branch; the rest are distinct answers rather than
 *  flavours of failure:
 *
 *   • `not-a-repo`  — the project root is real but is not inside a work tree
 *   • `unbound`     — the agent has no usable project root (it works in scratch)
 *   • `unavailable` — git could not be run (no binary, timeout, I/O)
 *
 * The UI renders each one differently — hide, disable, warn — so collapsing
 * them into "error" would lose the only thing it needs. */
export type GitRepoState = "ok" | "not-a-repo" | "unbound" | "unavailable";

export interface GitDirtyCounts {
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface GitStatus {
  state: GitRepoState;
  /** The structured code. Null exactly when `state === "ok"`. */
  code: GitErrorCode | null;
  /** The work tree git resolved. Null unless `state === "ok"`.
   *
   *  This is `rev-parse --show-toplevel`, which can differ from the agent's
   *  projectRoot: a root INSIDE a repository is a legitimate project, and the
   *  branch belongs to the work tree, not to the subdirectory. */
  root: string | null;
  /** Null on a detached HEAD, and on a branch born but never committed to. */
  branch: string | null;
  detached: boolean;
  /** The full commit sha; null on an unborn branch. */
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** Null unless the counts were actually read — zero is a measurement, and
   *  "we did not look" must not render as "nothing to commit". */
  dirty: GitDirtyCounts | null;
  /** The server's sentence, when it has one. */
  error: string | null;
  /** git's own stderr, kept verbatim for the user to act on. */
  detail: string | null;
}

export interface GitLocalBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** ISO-8601 committer date of the tip, or null when ref reported none. */
  lastCommitAt: string | null;
}

export interface GitRemoteBranch {
  /** The full remote ref, e.g. `origin/main` — the name a user must see to know
   *  which remote it is. */
  name: string;
}

export interface GitBranches {
  state: GitRepoState;
  code: GitErrorCode | null;
  error: string | null;
  detail: string | null;
  local: GitLocalBranch[];
  remote: GitRemoteBranch[];
}

export interface GitCheckoutRequest {
  /** The branch to switch to, or (with `create`) the name to create. */
  branch: string;
  /** true = create the branch and switch to it. */
  create?: boolean;
  /** Start point for `create`. A remote ref here is how a tracking branch is
   *  made; giving `from` without `create` implies create. */
  from?: string;
}

export interface GitCheckoutOk {
  ok: true;
  /** true when a branch was created — including the remote-tracking case,
   *  which is a creation even though `create` was not sent. */
  created: boolean;
  /** The remote ref a tracking branch was created from, when that happened. */
  tracked: string | null;
  /** The repository as it is AFTER the switch, read back from git rather than
   *  predicted, so the chip cannot show the branch we asked for when git
   *  actually did something else. */
  status: GitStatus;
}

export interface GitCheckoutError {
  ok: false;
  code: GitErrorCode;
  error: string;
  detail: string | null;
}

export type GitCheckoutResult = GitCheckoutOk | GitCheckoutError;

// ── Validation ──────────────────────────────────────────────────────────────

/** A refusal carries its reason, because every caller prints it. A success
 *  carries nothing, so a caller cannot read a `reason` that does not exist. */
export type Check = { ok: true } | { ok: false; reason: string };

/**
 * Git's own ref grammar, as a fast local refusal.
 *
 * `git check-ref-format --branch` remains the authority — core runs it before
 * every checkout, because these rules are a copy and a copy can drift. This one
 * exists so the picker can say "that is not a branch name" without a round trip,
 * and so the argv rule below is stated once.
 *
 * The leading `-` rule is NOT a git rule: it is about argv. Even with an argv
 * array, a value starting with `-` is read by git as an option, so a branch
 * name can only be passed safely once that is impossible.
 */
export function validateBranchName(name: string): Check {
  if (name.length === 0) return { ok: false, reason: "branch name is empty" };
  if (name.length > 255) return { ok: false, reason: "branch name is longer than 255 characters" };
  if (name.startsWith("-")) return { ok: false, reason: "branch name must not start with '-'" };
  if (/\s/.test(name)) return { ok: false, reason: "branch name must not contain whitespace" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, reason: "branch name must not contain control characters" };
  }
  if (name.includes("..")) return { ok: false, reason: "branch name must not contain '..'" };
  if (name.includes("@{")) return { ok: false, reason: "branch name must not contain '@{'" };
  if (name === "@") return { ok: false, reason: "'@' is not a branch name" };
  if (/[~^:?*[\]\\]/.test(name)) {
    return { ok: false, reason: "branch name must not contain any of ~ ^ : ? * [ ] \\" };
  }
  if (name.startsWith("/") || name.endsWith("/")) {
    return { ok: false, reason: "branch name must not start or end with '/'" };
  }
  if (name.endsWith(".")) return { ok: false, reason: "branch name must not end with '.'" };
  for (const part of name.split("/")) {
    if (part.length === 0) return { ok: false, reason: "branch name must not contain '//'" };
    if (part.startsWith(".")) return { ok: false, reason: "a branch name component must not start with '.'" };
    if (part.endsWith(".lock")) return { ok: false, reason: "a branch name component must not end with '.lock'" };
  }
  return { ok: true };
}

/**
 * A start point (`from`) is not a branch name: `HEAD~1`, a tag, or a raw sha are
 * all legitimate values a user may branch from. Only the argv rule applies —
 * plus the control-character rule, because a NUL would truncate the argument.
 * Whether the ref RESOLVES is git's answer to give, and it gives it loudly.
 */
export function validateRefArgument(value: string): Check {
  if (value.length === 0) return { ok: false, reason: "start point is empty" };
  if (value.startsWith("-")) return { ok: false, reason: "start point must not start with '-'" };
  if (/\s/.test(value)) return { ok: false, reason: "start point must not contain whitespace" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, reason: "start point must not contain control characters" };
  }
  return { ok: true };
}

// ── Parsers ─────────────────────────────────────────────────────────────────

export interface GitStatusFacts {
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: GitDirtyCounts;
}

const tallyXY = (xy: string, dirty: GitDirtyCounts): void => {
  // X = the index, Y = the work tree. A `.` in either means "no change on that
  // side", which is why a partially-staged file is honestly one of each.
  if (xy.length < 2) return;
  if (xy.charAt(0) !== ".") dirty.staged += 1;
  if (xy.charAt(1) !== ".") dirty.unstaged += 1;
};

/**
 * `git status --porcelain=v2 --branch` — one call that carries the branch, its
 * upstream, the ahead/behind counts and the dirty tally, which is why it is the
 * single source for all of them instead of four commands that can disagree.
 *
 * Header lines (`# branch.*`) describe HEAD; entry lines are one record per
 * changed path. Unknown lines are ignored rather than guessed at: a format we
 * do not recognise must not become a dirty count.
 */
export function parseGitStatusV2(text: string): GitStatusFacts {
  let oid: string | null = null;
  let headName: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const dirty: GitDirtyCounts = { staged: 0, unstaged: 0, untracked: 0 };

  for (const line of text.split("\n")) {
    if (line.length === 0) continue;

    if (line.startsWith("# branch.oid ")) {
      oid = line.slice("# branch.oid ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      headName = line.slice("# branch.head ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = /^\+(\d+)\s+-(\d+)$/.exec(line.slice("# branch.ab ".length).trim());
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    const kind = line.charAt(0);
    if (kind === "?") {
      dirty.untracked += 1;
      continue;
    }
    if (kind === "!") continue;
    if (kind === "1" || kind === "2" || kind === "u") {
      // "<kind> <XY> <rest…>" — XY is the second whitespace-delimited field,
      // and for `u` (unmerged) the conflict is honestly both staged and
      // unstaged, so the same tally is the right one.
      tallyXY(line.split(" ")[1] ?? "", dirty);
      continue;
    }
  }

  const detached = headName === "(detached)";
  return {
    branch: headName && !detached ? headName : null,
    detached,
    // `(initial)` is an unborn branch: the name is real, the commit is not.
    head: oid && oid !== "(initial)" ? oid : null,
    upstream,
    ahead,
    behind,
    dirty,
  };
}

export interface UpstreamTrack {
  ahead: number | null;
  behind: number | null;
  /** The upstream is configured but the remote ref is gone. Distinct from "no
   *  upstream": one is a deleted branch, the other is a branch never pushed. */
  gone: boolean;
}

/** `%(upstream:track)` — `[ahead 1, behind 2]`, `[ahead 1]`, `[behind 2]`,
 *  `[gone]`, or empty when there is no upstream. */
export function parseUpstreamTrack(text: string): UpstreamTrack {
  const t = text.trim();
  if (t === "") return { ahead: null, behind: null, gone: false };
  if (t === "[gone]") return { ahead: null, behind: null, gone: true };
  const ahead = /ahead (\d+)/.exec(t);
  const behind = /behind (\d+)/.exec(t);
  return {
    ahead: ahead ? Number(ahead[1]) : null,
    behind: behind ? Number(behind[1]) : null,
    gone: false,
  };
}

/**
 * `for-each-ref` over `refs/heads`, fields separated by TABS.
 *
 * Tab rather than NUL: git forbids control characters in ref names, so a tab
 * cannot occur inside a field, and the raw output stays readable in a log.
 * An empty field (no upstream, no date) survives `split` as an empty string,
 * which is what makes "absent" distinguishable from "shifted".
 */
export function parseLocalBranches(stdout: string): GitLocalBranch[] {
  const out: GitLocalBranch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [name = "", headMark = "", upstream = "", track = "", date = ""] = line.split("\t");
    if (name === "") continue;
    const parsed = parseUpstreamTrack(track);
    out.push({
      name,
      current: headMark === "*",
      upstream: upstream || null,
      ahead: parsed.ahead,
      behind: parsed.behind,
      lastCommitAt: date || null,
    });
  }
  return out;
}

/** `for-each-ref` over `refs/remotes`. `<remote>/HEAD` is a symbolic alias of
 *  the remote's default branch, not a branch anyone can switch to, so it is
 *  dropped here rather than shown as a dead entry. */
export function parseRemoteBranches(stdout: string): GitRemoteBranch[] {
  const out: GitRemoteBranch[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const name = line.trim();
    if (name === "" || name.endsWith("/HEAD")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name });
  }
  return out;
}

/**
 * `origin/feature/x` → `feature/x`, given the configured remote names.
 *
 * The remote list is passed in rather than inferred because the first path
 * component is a remote ONLY when it names one: a local branch literally called
 * `origin/thing` is not a remote ref, and stripping its prefix would silently
 * point the user at a different branch.
 */
export function localNameForRemoteRef(ref: string, remotes: readonly string[]): string {
  for (const remote of remotes) {
    if (remote !== "" && ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
  }
  return ref;
}

// ── Decisions ───────────────────────────────────────────────────────────────

/** Why a switch is refused before it is attempted. Null = allowed. */
export type GitSwitchBlock = "running" | "not-a-repo" | "unbound" | "unavailable" | null;

/**
 * The gate the UI applies. `running` comes first because it is the only reason
 * that is about the AGENT rather than the repository: switching the work tree
 * under an agent that is mid-turn rewrites the files it is reading, so no
 * repository state makes that safe.
 */
export function gitSwitchBlock(state: GitRepoState, running: boolean): GitSwitchBlock {
  if (running) return "running";
  if (state === "ok") return null;
  return state;
}

/**
 * What the chip prints for a repository we could read. A detached HEAD has no
 * branch to name, so the commit IS the name — shortened here, once, rather than
 * in the JSX where the length would be a rendering detail two call sites can
 * disagree about.
 *
 * Null means "unborn": the branch exists but has no commit yet, which the UI
 * says in words instead of showing an empty chip.
 */
export function gitRefLabel(branch: string | null, head: string | null): string | null {
  if (branch) return branch;
  if (head) return head.slice(0, 7);
  return null;
}

/** Anything to commit, stage, or clean up. Counts only — a dirty repository is
 *  not an error, it is a reason to ask before switching. */
export function isDirty(counts: GitDirtyCounts | null): boolean {
  if (!counts) return false;
  return counts.staged > 0 || counts.unstaged > 0 || counts.untracked > 0;
}
