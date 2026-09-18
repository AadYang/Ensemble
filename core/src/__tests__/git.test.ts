import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests use REAL repositories. The parsers have their own unit tests in
// `shared`; what can only be checked here is that the argv we build is the argv
// git accepts, that the cwd is the project root, and that a refusal (a dirty
// work tree, a name git rejects) comes back as the structured code the API
// promises rather than as a thrown exception.

let git: typeof import("../git.js");

let TMP: string;

beforeAll(async () => {
  git = await import("../git.js");
  TMP = mkdtempSync(join(tmpdir(), "ensemble-git-"));
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

let counter = 0;

/** Run git in the test's own repositories. The TEST may use a shell-free helper
 *  like this one; the module under test never does. */
const raw = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

function newRepo(name: string): string {
  const dir = join(TMP, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  raw(dir, ["init", "-b", "main"]);
  // A local identity, so the test does not depend on (or write to) the
  // developer's global git config.
  raw(dir, ["config", "user.email", "test@example.invalid"]);
  raw(dir, ["config", "user.name", "Ensemble Test"]);
  return dir;
}

function commit(dir: string, message: string): string {
  raw(dir, ["add", "-A"]);
  raw(dir, ["commit", "-m", message]);
  return raw(dir, ["rev-parse", "HEAD"]).trim();
}

const write = (dir: string, file: string, body: string): void => {
  writeFileSync(join(dir, file), body, "utf8");
};

describe("readGitState", () => {
  it("describes a clean repository on its default branch", async () => {
    const dir = newRepo("clean");
    write(dir, "a.txt", "hello\n");
    const head = commit(dir, "first");

    const state = await git.readGitState(dir);
    expect(state.state).toBe("ok");
    expect(state.code).toBeNull();
    expect(state.branch).toBe("main");
    expect(state.detached).toBe(false);
    expect(state.head).toBe(head);
    expect(state.root).toBeTruthy();
    expect(state.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
    expect(state.error).toBeNull();
  });

  it("counts staged, unstaged and untracked separately", async () => {
    const dir = newRepo("dirty");
    write(dir, "committed.txt", "one\n");
    commit(dir, "first");

    write(dir, "committed.txt", "two\n");
    write(dir, "untracked.txt", "new\n");
    raw(dir, ["add", "committed.txt"]);
    write(dir, "committed.txt", "three\n");

    const state = await git.readGitState(dir);
    // Staged AND unstaged on one file is honestly one of each.
    expect(state.dirty).toEqual({ staged: 1, unstaged: 1, untracked: 1 });
  });

  it("reports an unborn branch with a name and no commit", async () => {
    const dir = newRepo("unborn");
    const state = await git.readGitState(dir);
    expect(state.state).toBe("ok");
    expect(state.branch).toBe("main");
    expect(state.head).toBeNull();
    expect(state.detached).toBe(false);
  });

  it("reports a detached HEAD with no branch and the commit it is on", async () => {
    const dir = newRepo("detached");
    write(dir, "a.txt", "one\n");
    const first = commit(dir, "first");
    write(dir, "a.txt", "two\n");
    commit(dir, "second");
    raw(dir, ["checkout", first]);

    const state = await git.readGitState(dir);
    expect(state.state).toBe("ok");
    expect(state.branch).toBeNull();
    expect(state.detached).toBe(true);
    expect(state.head).toBe(first);
  });

  it("reads the upstream and the ahead/behind counts from a real remote", async () => {
    const remote = join(TMP, `remote-${counter++}.git`);
    mkdirSync(remote, { recursive: true });
    raw(remote, ["init", "--bare", "-b", "main"]);

    const dir = newRepo("upstream");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");
    raw(dir, ["remote", "add", "origin", remote]);
    raw(dir, ["push", "-u", "origin", "main"]);

    let state = await git.readGitState(dir);
    expect(state.upstream).toBe("origin/main");
    expect(state.ahead).toBe(0);
    expect(state.behind).toBe(0);

    write(dir, "a.txt", "two\n");
    commit(dir, "second");
    state = await git.readGitState(dir);
    expect(state.ahead).toBe(1);
    expect(state.behind).toBe(0);
  });

  it("refuses a directory that is not in a work tree, and never substitutes one", async () => {
    const dir = join(TMP, `plain-${counter++}`);
    mkdirSync(dir, { recursive: true });

    const state = await git.readGitState(dir);
    expect(state.state).toBe("not-a-repo");
    expect(state.code).toBe("GIT_NOT_A_REPO");
    // The critical half: no root, no branch, and no fallback directory. A cwd
    // of `process.cwd()` would have found THIS repository.
    expect(state.root).toBeNull();
    expect(state.branch).toBeNull();
    expect(state.error).toContain(dir);
  });

  it("still describes a project root that sits INSIDE a repository", async () => {
    const dir = newRepo("nested");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");
    const sub = join(dir, "packages", "inner");
    mkdirSync(sub, { recursive: true });
    write(sub, "b.txt", "two\n");

    const state = await git.readGitState(sub);
    expect(state.state).toBe("ok");
    expect(state.branch).toBe("main");
    // The root is the WORK TREE's, not the subdirectory's — that is the
    // directory a branch actually belongs to. (`--show-toplevel` reports
    // forward slashes even on Windows, hence the normalization.)
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    expect(norm(state.root ?? "")).toBe(norm(dir));
    expect(norm(state.root ?? "")).not.toBe(norm(sub));
  });

  it("reports git as unavailable rather than as a broken repository", async () => {
    const dir = newRepo("nogit");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");

    const savedPath = process.env.PATH;
    const emptyPath = join(TMP, `empty-path-${counter++}`);
    mkdirSync(emptyPath, { recursive: true });
    process.env.PATH = emptyPath;
    const savedExtra = git.GIT_EXTRA_BIN_DIRS.splice(0, git.GIT_EXTRA_BIN_DIRS.length);
    try {
      const state = await git.readGitState(dir);
      expect(state.state).toBe("unavailable");
      expect(state.code).toBe("GIT_UNAVAILABLE");
      expect(state.dirty).toBeNull();
    } finally {
      git.GIT_EXTRA_BIN_DIRS.push(...savedExtra);
      process.env.PATH = savedPath;
    }
  });
});

describe("listGitBranches", () => {
  it("lists local branches with the current one marked, and no remote refs", async () => {
    const dir = newRepo("branches");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");
    raw(dir, ["branch", "feature/one"]);
    raw(dir, ["branch", "feature/two"]);

    const list = await git.listGitBranches(dir);
    expect(list.state).toBe("ok");
    expect(list.local.map((b) => b.name).sort()).toEqual(["feature/one", "feature/two", "main"]);
    expect(list.local.filter((b) => b.current).map((b) => b.name)).toEqual(["main"]);
    expect(list.remote).toEqual([]);
  });

  it("lists remote branches but never the symbolic <remote>/HEAD", async () => {
    const remote = join(TMP, `remote-list-${counter++}.git`);
    mkdirSync(remote, { recursive: true });
    raw(remote, ["init", "--bare", "-b", "main"]);

    const dir = newRepo("remote-list");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");
    raw(dir, ["remote", "add", "origin", remote]);
    raw(dir, ["push", "-u", "origin", "main"]);
    raw(dir, ["fetch", "origin"]);

    const list = await git.listGitBranches(dir);
    const names = list.remote.map((b) => b.name);
    expect(names).toContain("origin/main");
    expect(names.some((n) => n.endsWith("/HEAD"))).toBe(false);
  });

  it("refuses a non-repository with the same code as the state route", async () => {
    const dir = join(TMP, `plain-list-${counter++}`);
    mkdirSync(dir, { recursive: true });

    const list = await git.listGitBranches(dir);
    expect(list.state).toBe("not-a-repo");
    expect(list.code).toBe("GIT_NOT_A_REPO");
    expect(list.local).toEqual([]);
    expect(list.remote).toEqual([]);
  });
});

describe("checkoutGitBranch", () => {
  it("switches to an existing local branch", async () => {
    const dir = newRepo("switch");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");
    raw(dir, ["branch", "other"]);

    const result = await git.checkoutGitBranch(dir, { branch: "other" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    // Read back from git, not predicted from the command.
    expect(result.status.branch).toBe("other");
  });

  it("creates a branch and switches to it", async () => {
    const dir = newRepo("create");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");

    const result = await git.checkoutGitBranch(dir, { branch: "feature/new", create: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.status.branch).toBe("feature/new");
  });

  it("creates a branch from an explicit start point", async () => {
    const dir = newRepo("create-from");
    write(dir, "a.txt", "one\n");
    const first = commit(dir, "first");
    write(dir, "a.txt", "two\n");
    commit(dir, "second");

    // `from` alone means create: a start point is only meaningful for a branch
    // that does not exist yet.
    const result = await git.checkoutGitBranch(dir, { branch: "from-first", from: first });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.status.branch).toBe("from-first");
    expect(raw(dir, ["rev-parse", "HEAD"]).trim()).toBe(first);
  });

  it("turns a remote ref into a local tracking branch instead of detaching", async () => {
    const remote = join(TMP, `remote-track-${counter++}.git`);
    mkdirSync(remote, { recursive: true });
    raw(remote, ["init", "--bare", "-b", "main"]);

    const dir = newRepo("track");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");
    raw(dir, ["remote", "add", "origin", remote]);
    raw(dir, ["push", "-u", "origin", "main"]);

    const other = newRepo("track-source");
    write(other, "a.txt", "from other\n");
    commit(other, "other first");
    raw(other, ["remote", "add", "origin", remote]);
    raw(other, ["push", "origin", "main:feature/remote-only"]);

    raw(dir, ["fetch", "origin"]);
    // Sanity: the remote ref is there and no local branch of that name is.
    const before = await git.listGitBranches(dir);
    expect(before.remote.map((b) => b.name)).toContain("origin/feature/remote-only");
    expect(before.local.map((b) => b.name)).not.toContain("feature/remote-only");

    const result = await git.checkoutGitBranch(dir, { branch: "origin/feature/remote-only" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.tracked).toBe("origin/feature/remote-only");
    expect(result.status.branch).toBe("feature/remote-only");
    expect(result.status.detached).toBe(false);
    expect(result.status.upstream).toBe("origin/feature/remote-only");
  });

  it("returns git's own refusal for a dirty work tree, and does not force it", async () => {
    const dir = newRepo("dirty-refusal");
    write(dir, "conflict.txt", "on main\n");
    commit(dir, "first");
    raw(dir, ["checkout", "-b", "other"]);
    write(dir, "conflict.txt", "on other\n");
    commit(dir, "second");
    raw(dir, ["checkout", "main"]);
    // Uncommitted, and in the way of the switch.
    write(dir, "conflict.txt", "edited on main\n");

    const result = await git.checkoutGitBranch(dir, { branch: "other" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("GIT_CHECKOUT_FAILED");
    // git's sentence, kept whole — it names the file the user has to deal with.
    expect(result.error).toMatch(/local changes|overwritten/i);
    expect(result.detail).toBeTruthy();

    // The two things `--force` would have broken: still on the original branch,
    // and the user's edit is still on disk.
    expect(raw(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(readFileSync(join(dir, "conflict.txt"), "utf8")).toBe("edited on main\n");
  });

  it("refuses an unknown branch with a checkout failure, not a crash", async () => {
    const dir = newRepo("unknown");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");

    const result = await git.checkoutGitBranch(dir, { branch: "does-not-exist" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("GIT_CHECKOUT_FAILED");
    expect(result.error).toMatch(/did not match|not found|pathspec/i);
  });

  it("refuses a branch name that would be read as an option", async () => {
    const dir = newRepo("option");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");

    for (const branch of ["--force", "-b", "-"]) {
      const result = await git.checkoutGitBranch(dir, { branch });
      expect(result.ok, branch).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("GIT_BRANCH_INVALID");
    }
    // Nothing was created and nothing moved.
    expect(raw(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
  });

  it("defers to git for a name the local rule cannot catch", async () => {
    const dir = newRepo("authority");
    write(dir, "a.txt", "one\n");
    commit(dir, "first");

    // `HEAD` passes every rule in the shared copy, and git refuses it. That
    // asymmetry is exactly why `check-ref-format` runs before argv.
    const result = await git.checkoutGitBranch(dir, { branch: "HEAD" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("GIT_BRANCH_INVALID");
  });

  it("refuses to work in a non-repository", async () => {
    const dir = join(TMP, `plain-checkout-${counter++}`);
    mkdirSync(dir, { recursive: true });

    const result = await git.checkoutGitBranch(dir, { branch: "main" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("GIT_NOT_A_REPO");
  });
});

describe("resolveGitRoot", () => {
  it("refuses an unbound agent instead of naming a directory for it", () => {
    for (const value of [null, undefined, "", "   "]) {
      const resolved = git.resolveGitRoot(value);
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.code).toBe("GIT_UNBOUND");
      expect(resolved.reason).toContain("scratch");
    }
  });

  it("refuses a root that is configured but no longer usable", () => {
    const missing = join(TMP, "definitely-not-here");
    const resolved = git.resolveGitRoot(missing);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("GIT_UNBOUND");
    // The inspector's own sentence, so the user learns WHICH rule failed.
    expect(resolved.reason).toContain(missing);
    expect(existsSync(missing)).toBe(false);
  });

  it("refuses a relative path — it is resolved against nothing the agent knows", () => {
    const resolved = git.resolveGitRoot("relative/project");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe("GIT_UNBOUND");
  });

  it("accepts a real directory and returns the stored spelling", () => {
    const dir = newRepo("resolve");
    const resolved = git.resolveGitRoot(dir);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.root).toBe(dir);
  });
});

describe("unbound responses", () => {
  it("answers with the same shape a readable repository would", () => {
    const status = git.unboundGitStatus("no root here");
    expect(status.state).toBe("unbound");
    expect(status.code).toBe("GIT_UNBOUND");
    expect(status.root).toBeNull();
    expect(status.branch).toBeNull();
    expect(status.dirty).toBeNull();
    expect(status.error).toBe("no root here");

    const branches = git.unboundGitBranches("no root here");
    expect(branches.state).toBe("unbound");
    expect(branches.code).toBe("GIT_UNBOUND");
    expect(branches.local).toEqual([]);
    expect(branches.remote).toEqual([]);
    expect(branches.error).toBe("no root here");
  });
});
