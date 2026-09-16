import { describe, expect, it } from "vitest";
import {
  gitRefLabel,
  gitSwitchBlock,
  isDirty,
  localNameForRemoteRef,
  parseGitStatusV2,
  parseLocalBranches,
  parseRemoteBranches,
  parseUpstreamTrack,
  validateBranchName,
  validateRefArgument,
} from "./git";

// git's own output, copied from a real repository. The parsers are the half of
// this feature that cannot be exercised by running git — a shape read wrong
// here shows up as a wrong branch name on screen, not as a failing command.

describe("validateBranchName", () => {
  it("accepts the names people actually use", () => {
    for (const name of ["main", "feature/git-chip", "fix/v1.2.3", "release-0.0.33", "a", "user/name_1"]) {
      expect(validateBranchName(name), name).toEqual({ ok: true });
    }
  });

  it("refuses a leading dash — the one rule that is about argv, not refs", () => {
    // Without this, `git checkout -b --upload-pack=...` is a command injection
    // through an argv array: git reads the value as an option, not a ref.
    expect(validateBranchName("-b").ok).toBe(false);
    expect(validateBranchName("--force").ok).toBe(false);
  });

  it("refuses control characters, whitespace and the ref-grammar escapes", () => {
    for (const name of ["has space", "tab\there", "nul\u0000byte", "a..b", "a@{b", "@", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a//b", "/lead", "trail/", "end.", "a/.hidden", "a.lock"]) {
      expect(validateBranchName(name).ok, JSON.stringify(name)).toBe(false);
    }
  });

  it("refuses empty and over-long names", () => {
    expect(validateBranchName("").ok).toBe(false);
    expect(validateBranchName("x".repeat(256)).ok).toBe(false);
    expect(validateBranchName("x".repeat(255)).ok).toBe(true);
  });

  it("explains WHY, because the picker prints the reason", () => {
    const check = validateBranchName("has space");
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("whitespace");
  });
});

describe("validateRefArgument", () => {
  it("allows the start points a branch can legitimately come from", () => {
    for (const ref of ["main", "origin/main", "HEAD~2", "v1.0.0", "abc1234", "HEAD^{commit}"]) {
      expect(validateRefArgument(ref).ok, ref).toBe(true);
    }
  });

  it("still refuses a leading dash, whitespace and control characters", () => {
    for (const ref of ["-x", "a b", "a\u0000b", ""]) {
      expect(validateRefArgument(ref).ok, JSON.stringify(ref)).toBe(false);
    }
  });
});

describe("parseGitStatusV2", () => {
  it("reads branch, upstream, ahead/behind and the dirty tally", () => {
    const out = [
      "# branch.oid 0123456789abcdef0123456789abcdef01234567",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -3",
      "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
      "1 .M N... 100644 100644 100644 aaa bbb unstaged.txt",
      "1 MM N... 100644 100644 100644 aaa bbb both.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\told.txt",
      "? untracked.txt",
      "? another-untracked.txt",
    ].join("\n");
    const facts = parseGitStatusV2(out);
    expect(facts.branch).toBe("feature/x");
    expect(facts.detached).toBe(false);
    expect(facts.head).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(facts.upstream).toBe("origin/feature/x");
    expect(facts.ahead).toBe(2);
    expect(facts.behind).toBe(3);
    // `MM` is honestly one of each; the rename counts on its index side only.
    expect(facts.dirty).toEqual({ staged: 3, unstaged: 2, untracked: 2 });
  });

  it("reports a clean repository as zeroes, not as null", () => {
    const facts = parseGitStatusV2(
      ["# branch.oid aaaa", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +0 -0"].join("\n"),
    );
    expect(facts.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
    expect(facts.ahead).toBe(0);
    expect(facts.behind).toBe(0);
  });

  it("has no branch on a detached HEAD, and keeps the commit", () => {
    const facts = parseGitStatusV2(["# branch.oid deadbeef", "# branch.head (detached)"].join("\n"));
    expect(facts.branch).toBeNull();
    expect(facts.detached).toBe(true);
    expect(facts.head).toBe("deadbeef");
  });

  it("has no commit on an unborn branch, and keeps the name", () => {
    const facts = parseGitStatusV2(["# branch.oid (initial)", "# branch.head main"].join("\n"));
    expect(facts.branch).toBe("main");
    expect(facts.head).toBeNull();
    expect(facts.detached).toBe(false);
  });

  it("reports no upstream as absent, not as zero", () => {
    const facts = parseGitStatusV2(["# branch.oid aaaa", "# branch.head main"].join("\n"));
    expect(facts.upstream).toBeNull();
    expect(facts.ahead).toBeNull();
    expect(facts.behind).toBeNull();
  });

  it("counts an unmerged path on both sides and ignores unknown lines", () => {
    const facts = parseGitStatusV2(
      ["# branch.head main", "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.txt", "X something new"].join(
        "\n",
      ),
    );
    expect(facts.dirty).toEqual({ staged: 1, unstaged: 1, untracked: 0 });
  });
});

describe("parseUpstreamTrack", () => {
  it("reads each form git emits", () => {
    expect(parseUpstreamTrack("[ahead 1, behind 2]")).toEqual({ ahead: 1, behind: 2, gone: false });
    expect(parseUpstreamTrack("[ahead 3]")).toEqual({ ahead: 3, behind: null, gone: false });
    expect(parseUpstreamTrack("[behind 4]")).toEqual({ ahead: null, behind: 4, gone: false });
    // "gone" is not "no upstream": one is a deleted branch, the other a branch
    // that was never pushed.
    expect(parseUpstreamTrack("[gone]")).toEqual({ ahead: null, behind: null, gone: true });
    expect(parseUpstreamTrack("")).toEqual({ ahead: null, behind: null, gone: false });
  });
});

describe("parseLocalBranches", () => {
  it("splits on tabs so an empty field cannot shift the ones after it", () => {
    const out = [
      "main\t*\torigin/main\t[ahead 1, behind 2]\t2026-09-01T10:00:00+08:00",
      "feature/x\t\t\t\t2026-09-02T11:00:00+08:00",
      "never-pushed\t\t\t\t",
    ].join("\n");
    const branches = parseLocalBranches(out);
    expect(branches).toHaveLength(3);
    expect(branches[0]).toEqual({
      name: "main",
      current: true,
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
      lastCommitAt: "2026-09-01T10:00:00+08:00",
    });
    expect(branches[1]).toEqual({
      name: "feature/x",
      current: false,
      upstream: null,
      ahead: null,
      behind: null,
      lastCommitAt: "2026-09-02T11:00:00+08:00",
    });
    expect(branches[2]?.lastCommitAt).toBeNull();
  });

  it("returns nothing for empty output rather than a phantom entry", () => {
    expect(parseLocalBranches("")).toEqual([]);
    expect(parseLocalBranches("\n")).toEqual([]);
  });
});

describe("parseRemoteBranches", () => {
  it("drops the symbolic <remote>/HEAD alias", () => {
    const branches = parseRemoteBranches(["origin/HEAD", "origin/main", "origin/feature/x", ""].join("\n"));
    expect(branches.map((b) => b.name)).toEqual(["origin/main", "origin/feature/x"]);
  });

  it("de-duplicates repeated refs", () => {
    expect(parseRemoteBranches("origin/main\norigin/main").map((b) => b.name)).toEqual(["origin/main"]);
  });
});

describe("localNameForRemoteRef", () => {
  it("strips the remote prefix only when the first component IS a remote", () => {
    expect(localNameForRemoteRef("origin/feature/x", ["origin", "upstream"])).toBe("feature/x");
    expect(localNameForRemoteRef("upstream/main", ["origin", "upstream"])).toBe("main");
    // A local branch literally called `origin/thing` is not a remote ref, and
    // stripping its prefix would point the user at a different branch.
    expect(localNameForRemoteRef("origin/thing", ["upstream"])).toBe("origin/thing");
    expect(localNameForRemoteRef("plain", [])).toBe("plain");
  });
});

describe("gitSwitchBlock", () => {
  it("refuses a mid-turn agent even in a healthy repository", () => {
    expect(gitSwitchBlock("ok", true)).toBe("running");
    expect(gitSwitchBlock("unbound", true)).toBe("running");
  });

  it("allows a healthy repository when nothing is running", () => {
    expect(gitSwitchBlock("ok", false)).toBeNull();
  });

  it("passes through the reason the repository cannot be switched", () => {
    expect(gitSwitchBlock("unbound", false)).toBe("unbound");
    expect(gitSwitchBlock("unavailable", false)).toBe("unavailable");
    expect(gitSwitchBlock("not-a-repo", false)).toBe("not-a-repo");
  });
});

describe("gitRefLabel", () => {
  it("names the branch when there is one", () => {
    expect(gitRefLabel("main", "0123456789abcdef")).toBe("main");
  });

  it("names the commit on a detached HEAD", () => {
    expect(gitRefLabel(null, "0123456789abcdef")).toBe("0123456");
  });

  it("says nothing for an unborn branch — the caller has words for it", () => {
    expect(gitRefLabel(null, null)).toBeNull();
  });
});

describe("isDirty", () => {
  it("is false for a clean repository and for counts we never read", () => {
    expect(isDirty({ staged: 0, unstaged: 0, untracked: 0 })).toBe(false);
    expect(isDirty(null)).toBe(false);
  });

  it("is true when any of the three has anything", () => {
    expect(isDirty({ staged: 1, unstaged: 0, untracked: 0 })).toBe(true);
    expect(isDirty({ staged: 0, unstaged: 1, untracked: 0 })).toBe(true);
    expect(isDirty({ staged: 0, unstaged: 0, untracked: 1 })).toBe(true);
  });
});
