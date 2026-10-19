import { describe, expect, it } from "vitest";
import {
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

  it("kicks the outer loop when ## DONE is missing", () => {
    const cfg = parseLoopConfig({ goal: "ship it" });
    const d = decideLoopAfterVerify({
      config: cfg,
      state,
      verifyOk: true,
      summary: "ok",
      markerHit: false,
      hasDiff: true,
    });
    expect(d.action).toBe("outer-iter");
    if (d.action === "outer-iter") {
      expect(d.resetRuntime).toBe(false);
      expect(d.userInput).toContain("## DONE");
      expect(d.userInput).toContain("ship it");
    }
  });

  it("resets the runtime on fresh-disk when the marker is missing", () => {
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
    expect(d.action).toBe("outer-iter");
    if (d.action === "outer-iter") expect(d.resetRuntime).toBe(true);
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
