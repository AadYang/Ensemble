import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TURNS_PER_ITER,
  LoopConfigError,
  decideLoopAfterVerify,
  emptyLoopState,
  fileMarkerHit,
  loopStartPrompt,
  parseLoopConfig,
  parseTasksMarkdown,
  reviewLooksLikeLgtm,
  tasksToMarkdown,
} from "./loop";

const withCommand = {
  goal: "tests green",
  verifier: { kind: "command" as const, spec: "npm test" },
};

describe("parseLoopConfig", () => {
  it("starts with only a goal; verifier is optional", () => {
    const cfg = parseLoopConfig({ goal: "ship the login fix" });
    expect(cfg.goal).toBe("ship the login fix");
    expect(cfg.verifier).toBeNull();
    expect(cfg.doneWhen).toEqual({ kind: "file-contains", spec: "## DONE" });
    expect(cfg.session).toBe("resume");
    expect(cfg.maxIterations).toBe(20);
  });

  it("treats an empty verifier spec as no verifier", () => {
    const cfg = parseLoopConfig({ goal: "x", verifier: { kind: "command", spec: "  " } });
    expect(cfg.verifier).toBeNull();
  });

  it("refuses a loop with no goal", () => {
    expect(() => parseLoopConfig({ verifier: { kind: "command", spec: "npm test" } })).toThrow(LoopConfigError);
  });

  it("keeps an optional command as a false-completion catch, not as doneWhen", () => {
    const cfg = parseLoopConfig(withCommand);
    expect(cfg.verifier).toEqual({ kind: "command", spec: "npm test" });
    expect(cfg.doneWhen).toEqual({ kind: "file-contains", spec: "## DONE" });
  });

  it("honours an explicit exit-0 doneWhen for TDD", () => {
    const cfg = parseLoopConfig({ ...withCommand, doneWhen: { kind: "exit-0", spec: "" } });
    expect(cfg.doneWhen).toEqual({ kind: "exit-0", spec: "" });
  });

  it("forces file-contains when there is no verifier but doneWhen is exit-0", () => {
    const cfg = parseLoopConfig({ goal: "x", doneWhen: { kind: "exit-0" } });
    expect(cfg.doneWhen).toEqual({ kind: "file-contains", spec: "## DONE" });
  });
});

describe("loopStartPrompt", () => {
  it("tells the agent to write ## DONE and does not ask the user for a script", () => {
    const cfg = parseLoopConfig({ goal: "add dark mode" });
    const text = loopStartPrompt(cfg);
    expect(text).toContain("add dark mode");
    expect(text).toContain("## DONE");
    expect(text).toContain("TASKS.md");
  });
});

describe("decideLoopAfterVerify", () => {
  const state = emptyLoopState();

  it("continues on a failed optional verifier", () => {
    const config = parseLoopConfig({ ...withCommand, doneWhen: { kind: "exit-0", spec: "" } });
    const d = decideLoopAfterVerify({
      config,
      state,
      verifyOk: false,
      summary: "1 failing",
      markerHit: false,
      hasDiff: true,
    });
    expect(d.action).toBe("continue");
  });

  it("pauses after consecutive fails with no diff", () => {
    const config = parseLoopConfig({ ...withCommand, doneWhen: { kind: "exit-0", spec: "" } });
    const d = decideLoopAfterVerify({
      config,
      state: { ...state, consecutiveFails: 3 },
      verifyOk: false,
      summary: "still red",
      markerHit: false,
      hasDiff: false,
    });
    expect(d).toEqual({
      action: "pause",
      reason: "verifier failed 3 times with no further diff",
    });
  });

  it("completes when an explicit exit-0 verifier passes", () => {
    const config = parseLoopConfig({ ...withCommand, doneWhen: { kind: "exit-0", spec: "" } });
    const d = decideLoopAfterVerify({
      config,
      state,
      verifyOk: true,
      summary: "ok",
      markerHit: false,
      hasDiff: false,
    });
    expect(d.action).toBe("done");
  });

  it("keeps working in the same attempt while ## DONE is missing", () => {
    const cfg = parseLoopConfig({ goal: "ship it" });
    const d = decideLoopAfterVerify({
      config: cfg,
      state,
      verifyOk: true,
      summary: "ok",
      markerHit: false,
      hasDiff: true,
    });
    expect(d.action).toBe("continue");
    if (d.action === "continue") {
      expect(d.userInput).toContain("## DONE");
      expect(d.userInput).toContain("ship it");
    }
  });

  it("does not restart a fresh-disk loop just because the board is unfinished", () => {
    const cfg = parseLoopConfig({
      goal: "ship it",
      session: "fresh-disk",
      doneWhen: { kind: "file-contains", spec: "## DONE" },
    });
    const d = decideLoopAfterVerify({
      config: cfg,
      state,
      verifyOk: true,
      summary: "ok",
      markerHit: false,
      hasDiff: true,
    });
    expect(d.action).toBe("continue");
  });

  it("counts an attempt when ## DONE was written but verification failed", () => {
    const cfg = parseLoopConfig({ goal: "ship it", session: "fresh-disk" });
    const d = decideLoopAfterVerify({
      config: cfg,
      state,
      verifyOk: false,
      summary: "2 failing",
      markerHit: true,
      hasDiff: true,
    });
    expect(d.action).toBe("outer-iter");
    if (d.action === "outer-iter") {
      expect(d.resetRuntime).toBe(true);
      expect(d.userInput).toContain("VERIFY FAIL");
    }
  });

  it("does not consume an attempt for a verifier that is still red mid-work", () => {
    const cfg = parseLoopConfig({ goal: "ship it" });
    const d = decideLoopAfterVerify({
      config: cfg,
      state: { ...state, consecutiveFails: 1 },
      verifyOk: false,
      summary: "1 failing",
      markerHit: false,
      hasDiff: true,
    });
    expect(d.action).toBe("continue");
  });

  it("pauses at the per-attempt turn cap when the board did not advance", () => {
    const cfg = parseLoopConfig({ goal: "ship it", maxTurnsPerIter: 5 });
    const d = decideLoopAfterVerify({
      config: cfg,
      state: { ...state, innerTurns: 5 },
      verifyOk: true,
      summary: "ok",
      markerHit: false,
      hasDiff: true,
      progressed: false,
    });
    expect(d).toEqual({ action: "pause", reason: "inner-turn cap 5 reached" });
  });

  it("extends the turn ceiling instead of pausing when the board advanced", () => {
    // A 50-turn ceiling stopped an agent that had just ticked 75 of 89 items.
    // Progress, not tick count, decides whether the ceiling brakes.
    const cfg = parseLoopConfig({ goal: "ship it", maxTurnsPerIter: 5 });
    const d = decideLoopAfterVerify({
      config: cfg,
      state: { ...state, innerTurns: 5 },
      verifyOk: true,
      summary: "ok",
      markerHit: false,
      hasDiff: true,
      progressed: true,
    });
    expect(d.action).toBe("continue");
    expect(d).toMatchObject({ extendTurns: true });
  });

  it("uses the default turn cap when the config does not set one", () => {
    const cfg = parseLoopConfig({ goal: "ship it" });
    const d = decideLoopAfterVerify({
      config: cfg,
      state: { ...state, innerTurns: DEFAULT_MAX_TURNS_PER_ITER },
      verifyOk: true,
      summary: "ok",
      markerHit: false,
      hasDiff: true,
    });
    expect(d.action).toBe("pause");
  });

  it("pauses a goal-only loop that stalls with no diff", () => {
    const cfg = parseLoopConfig({ goal: "ship it" });
    const d = decideLoopAfterVerify({
      config: cfg,
      state: { ...state, consecutiveFails: 3 },
      verifyOk: true,
      summary: "ok",
      markerHit: false,
      hasDiff: false,
    });
    expect(d.action).toBe("pause");
  });

  it("completes a goal-only loop when the agent wrote ## DONE", () => {
    const cfg = parseLoopConfig({ goal: "ship it" });
    const d = decideLoopAfterVerify({
      config: cfg,
      state,
      verifyOk: true,
      summary: "ok",
      markerHit: true,
      hasDiff: true,
    });
    expect(d.action).toBe("done");
  });
});

describe("tasks markdown", () => {
  it("round-trips checkboxes", () => {
    const parsed = parseTasksMarkdown("- [x] a\n- [ ] b\n");
    expect(parsed).toEqual([
      { done: true, text: "a" },
      { done: false, text: "b" },
    ]);
    expect(parseTasksMarkdown(tasksToMarkdown(parsed))).toEqual(parsed);
  });
});

describe("markers", () => {
  it("recognises DONE and LGTM", () => {
    expect(fileMarkerHit("foo\n## DONE\n", "## DONE")).toBe(true);
    expect(reviewLooksLikeLgtm("LGTM, ship it")).toBe(true);
    expect(reviewLooksLikeLgtm("needs tests")).toBe(false);
  });
});
