import { describe, expect, it } from "vitest";
import { formatPeerHandoff } from "../peerHandoff.js";

const base = {
  fromName: "agent-3",
  fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
  sourceLastOutput: "source artifact",
} as const;

describe("formatPeerHandoff", () => {
  it("defaults to a compact message without source-output", () => {
    const out = formatPeerHandoff({
      ...base,
      body: "fyi",
    });

    expect(out).toBe("[from agent-3] fyi");
    expect(out).not.toContain("<<<source-output");
    expect(out).not.toContain("source artifact");
  });

  it("can explicitly include source-output", () => {
    const out = formatPeerHandoff({
      ...base,
      body: "fyi",
      includeSource: true,
      sourceState: "running",
    });

    expect(out).toContain("[from agent-3");
    expect(out).toContain("Source state: running");
    expect(out).toContain("<<<source-output");
    expect(out).toContain("source artifact");
    expect(out).toContain("source-output>>>");
    expect(out).toContain("fyi");
  });

  it("does not wrap the body in continue/review/fork templates", () => {
    const out = formatPeerHandoff({
      ...base,
      body: "please audit this and then continue from it",
      includeSource: true,
    });
    expect(out).not.toContain("<peer-handoff");
    expect(out).not.toContain("review（审阅）");
    expect(out).not.toContain("continue（承接）");
    expect(out).not.toContain("fork（换路）");
    expect(out).toContain("please audit this and then continue from it");
  });

  it("labels urgent interrupt reasons", () => {
    const raw = formatPeerHandoff({
      ...base,
      body: "stop and read this",
      interruptReason: "the active task is using the wrong target",
    });
    expect(raw).toContain("Urgent interrupt reason: the active task is using the wrong target");
    expect(raw).toContain("stop and read this");
    expect(raw).not.toContain("source artifact");
  });
});
