import "./loop-env.js";

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import { LoopManager, type LoopHost } from "../loop.js";
import { prefillLoopFromProject } from "../loop-prefill.js";
import { ensureLoopSkills, loopSkillName } from "../loop-skills.js";
import type { JobManager } from "../jobs.js";
import type { WSHub } from "../ws/hub.js";
import { DATA_DIR } from "../paths.js";

function mockJobs(exitCode: number, tail = "verifier output"): JobManager {
  return {
    start: () => ({ id: "job-loop" }),
    wait: async () => ({
      id: "job-loop",
      status: "exited",
      exitCode,
      logPath: "",
      tail,
    }),
  } as unknown as JobManager;
}

function mockHub(): WSHub {
  return { sendToSession: () => undefined, broadcast: () => undefined } as unknown as WSHub;
}

function mockHost(): LoopHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sendMessage: async (id, text) => {
      calls.push(`send:${id}:${text.slice(0, 40)}`);
    },
    resetRuntimeSession: async (id) => {
      calls.push(`reset:${id}`);
    },
    persistLoopNotice: async (id, text) => {
      calls.push(`notice:${id}:${text.slice(0, 40)}`);
    },
    patchAgent: async (id, patch) => {
      calls.push(`patch:${id}:${JSON.stringify(patch)}`);
    },
    sendPeerMessage: async (from, target, body) => {
      calls.push(`peer:${from}->${target}:${body.slice(0, 20)}`);
      return "ok";
    },
    toggleAgentSkill: async (id, name, action) => {
      calls.push(`skill:${id}:${name}:${action}`);
    },
  };
}

function seedAgent(name: string, root: string, extra: { teamId?: string } = {}) {
  return prisma.agent.create({
    data: { name, projectRoot: root, ...extra },
  });
}

/** A real repo with an uncommitted change, so `hasDiff` stays true and the
 *  no-progress circuit breaker does not mask the turn/attempt accounting. */
function gitInitWithDirtyFile(root: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  git("config", "user.email", "loop-test@example.test");
  git("config", "user.name", "loop-test");
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-m", "init");
  writeFileSync(join(root, "a.txt"), "a\nb\n");
}

describe("prefillLoopFromProject", () => {
  it("reads package.json scripts and AGENTS.md without touching settingSources", () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-prefill-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }),
    );
    writeFileSync(join(root, "AGENTS.md"), "完成条件\n- `npm test`\n");
    const hint = prefillLoopFromProject(root);
    expect(hint.source).toBe("agents-md");
    expect(hint.verifier).toEqual({ kind: "command", spec: "npm test" });
    expect(hint.testCommands).toContain("npm run test");
  });

  it("prefers a project verify.sh path over package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-hook-"));
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(root, ".claude", "hooks", "verify.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const hint = prefillLoopFromProject(root);
    expect(hint.source).toBe("project-hook");
    expect(hint.verifier?.spec).toContain("verify.sh");
  });
});

describe("ensureLoopSkills", () => {
  it("writes the three built-in recipes under DATA_DIR/skills", () => {
    ensureLoopSkills();
    for (const recipe of ["tdd", "ralph", "pr-gate"] as const) {
      const file = join(DATA_DIR, "skills", loopSkillName(recipe), "SKILL.md");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("Ensemble Loop");
    }
  });
});

describe("LoopManager stop-gate", () => {
  it("spans a multi-item board inside one attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-board-"));
    gitInitWithDirtyFile(root);
    const agent = seedAgent("board-many", root);
    const mgr = new LoopManager(mockJobs(0, "ok"), mockHub(), mockHost());
    await mgr.start(agent.id, {
      goal: "finish every item",
      verifier: { kind: "command", spec: "npm test" },
    });
    for (let i = 0; i < 5; i += 1) {
      const cont = await mgr.onTurnSettled(agent.id, { lastText: `item ${i + 1}` });
      expect(cont?.userInput).toMatch(/## DONE/);
    }
    // Five turns of board work, still attempt #1: tasks do not consume the
    // attempt budget. Only a failed full pass does.
    expect(mgr.view(agent.id)?.iter).toBe(1);
    expect(mgr.view(agent.id)?.innerTurns).toBe(5);
    expect(mgr.view(agent.id)?.status).toBe("running");
  });

  it("starts with only a goal and kicks until the agent writes ## DONE", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-agent-"));
    const agent = seedAgent("goal-only", root);
    const host = mockHost();
    const mgr = new LoopManager(mockJobs(1, "should not run"), mockHub(), host);
    await mgr.start(agent.id, { goal: "add dark mode" });
    expect(host.calls.some((c) => c.includes("add dark mode"))).toBe(true);
    const first = await mgr.onTurnSettled(agent.id, { lastText: "working" });
    expect(first?.userInput).toMatch(/## DONE/);
    expect(mgr.view(agent.id)?.status).toBe("running");
    writeFileSync(join(root, "TASKS.md"), "- [x] dark mode\n\n## DONE\n");
    const second = await mgr.onTurnSettled(agent.id, { lastText: "wrote done" });
    expect(second).toBeNull();
    expect(mgr.view(agent.id)?.status).toBe("done");
  });

  it("continues after a failed verifier", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-fail-"));
    const agent = seedAgent("fail", root);
    const host = mockHost();
    const mgr = new LoopManager(mockJobs(1, "boom"), mockHub(), host);
    await mgr.start(agent.id, {
      goal: "green",
      verifier: { kind: "command", spec: "npm test" },
    });
    const cont = await mgr.onTurnSettled(agent.id, { lastText: "I tried" });
    expect(cont?.userInput).toMatch(/VERIFY FAIL/);
    expect(mgr.view(agent.id)?.status).toBe("running");
    expect(host.calls.some((c) => c.includes("VERIFY FAIL"))).toBe(true);
  });

  it("finishes when the verifier exits 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-ok-"));
    const agent = seedAgent("ok", root);
    const mgr = new LoopManager(mockJobs(0, "ok"), mockHub(), mockHost());
    await mgr.start(agent.id, {
      goal: "green",
      verifier: { kind: "command", spec: "npm test" },
      doneWhen: { kind: "exit-0", spec: "" },
    });
    const cont = await mgr.onTurnSettled(agent.id, { lastText: "done" });
    expect(cont).toBeNull();
    expect(mgr.view(agent.id)?.status).toBe("done");
  });

  it("pauses after three consecutive fails with no diff", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-pause-"));
    const agent = seedAgent("pause", root);
    const mgr = new LoopManager(mockJobs(1, "still red"), mockHub(), mockHost());
    await mgr.start(agent.id, {
      goal: "green",
      verifier: { kind: "command", spec: "npm test" },
      doneWhen: { kind: "exit-0", spec: "" },
    });
    await mgr.onTurnSettled(agent.id, { lastText: "1" });
    await mgr.onTurnSettled(agent.id, { lastText: "2" });
    const third = await mgr.onTurnSettled(agent.id, { lastText: "3" });
    expect(third).toBeNull();
    expect(mgr.view(agent.id)?.status).toBe("paused");
  });

  it("fresh-disk keeps the same attempt while the marker is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-fresh-"));
    const agent = seedAgent("fresh", root);
    const host = mockHost();
    const mgr = new LoopManager(mockJobs(0, "unit ok"), mockHub(), host);
    await mgr.start(agent.id, {
      goal: "ship it",
      verifier: { kind: "command", spec: "npm test" },
      doneWhen: { kind: "file-contains", spec: "## DONE" },
      session: "fresh-disk",
    });
    const cont = await mgr.onTurnSettled(agent.id, { lastText: "one item" });
    expect(cont?.userInput).toMatch(/TASKS.md/);
    expect(host.calls.some((c) => c.startsWith("reset:"))).toBe(false);
    expect(mgr.view(agent.id)?.status).toBe("running");
    expect(mgr.view(agent.id)?.iter).toBe(1);
  });

  it("fresh-disk restarts only when ## DONE was written but the verifier failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-fresh-fail-"));
    writeFileSync(join(root, "TASKS.md"), "## DONE\n");
    const agent = seedAgent("fresh-fail", root);
    const host = mockHost();
    const mgr = new LoopManager(mockJobs(1, "still red"), mockHub(), host);
    await mgr.start(agent.id, {
      goal: "ship it",
      verifier: { kind: "command", spec: "npm test" },
      doneWhen: { kind: "file-contains", spec: "## DONE" },
      session: "fresh-disk",
    });
    const cont = await mgr.onTurnSettled(agent.id, { lastText: "declared done" });
    expect(cont?.userInput).toContain("VERIFY FAIL");
    expect(host.calls.some((c) => c.startsWith("reset:"))).toBe(true);
    expect(mgr.view(agent.id)?.status).toBe("running");
    expect(mgr.view(agent.id)?.iter).toBe(2);
  });

  it("file-marker verifier turns green when TASKS.md contains DONE", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-marker-"));
    writeFileSync(join(root, "TASKS.md"), "- [x] a\n\n## DONE\n");
    const agent = seedAgent("marker", root);
    const mgr = new LoopManager(mockJobs(1), mockHub(), mockHost());
    await mgr.start(agent.id, {
      goal: "board complete",
      verifier: { kind: "file-marker", spec: "## DONE" },
      doneWhen: { kind: "file-contains", spec: "## DONE" },
    });
    const cont = await mgr.onTurnSettled(agent.id, { lastText: "wrote done" });
    expect(cont).toBeNull();
    expect(mgr.view(agent.id)?.status).toBe("done");
  });

  it("peer-review waits for LGTM after the command is green", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-review-"));
    const reviewer = seedAgent("reviewer", root);
    const runner = seedAgent("runner", root);
    const host = mockHost();
    const mgr = new LoopManager(mockJobs(0, "tests pass"), mockHub(), host);
    await mgr.start(runner.id, {
      goal: "review this",
      verifier: { kind: "peer-review", spec: "npm test" },
      doneWhen: { kind: "peer-lgtm", spec: "LGTM" },
      reviewerAgentId: reviewer.id,
    });
    const cont = await mgr.onTurnSettled(runner.id, { lastText: "please review" });
    expect(cont).toBeNull();
    expect(mgr.view(runner.id)?.status).toBe("awaiting_review");
    expect(host.calls.some((c) => c.startsWith(`peer:${runner.id}->${reviewer.id}`))).toBe(true);

    await mgr.onTurnSettled(reviewer.id, { lastText: "LGTM looks good" });
    expect(mgr.view(runner.id)?.status).toBe("done");
  });

  it("force-enables the recipe skill on start", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-loop-recipe-"));
    const agent = seedAgent("recipe", root);
    const host = mockHost();
    const mgr = new LoopManager(mockJobs(0), mockHub(), host);
    await mgr.start(agent.id, {
      goal: "tdd",
      verifier: { kind: "command", spec: "npm test" },
      recipe: "tdd",
    });
    expect(host.calls.some((c) => c.includes("loop-tdd:enable"))).toBe(true);
  });
});

describe("three-runtime Stop-gate wiring", () => {
  it("hooks onTurnSettled only in SessionManager, not in runtimes", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const session = readFileSync(join(here, "../sessions/SessionManager.ts"), "utf8");
    expect(session).toContain("this.loops.onTurnSettled");
    for (const name of ["claude.ts", "openai.ts", "codex.ts"]) {
      const src = readFileSync(join(here, "../sessions/runtimes", name), "utf8");
      expect(src).not.toContain("onTurnSettled");
    }
  });
});
