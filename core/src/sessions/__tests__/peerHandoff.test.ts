import { describe, expect, it } from "vitest";
import { formatPeerHandoff } from "../peerHandoff.js";

const base = {
  fromName: "agent-3",
  fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
  receiverMetadata: null,
  sourceLastOutput: "source artifact",
} as const;

describe("formatPeerHandoff", () => {
  it("raw mode defaults to a compact message without source-output", () => {
    const out = formatPeerHandoff({
      ...base,
      mode: "raw",
      body: "fyi",
    });

    expect(out).toBe("[from agent-3] fyi");
    expect(out).not.toContain("<<<source-output");
    expect(out).not.toContain("source artifact");
  });

  it("raw mode can explicitly include source-output", () => {
    const out = formatPeerHandoff({
      ...base,
      mode: "raw",
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

  it("continue, review, and fork auto-include source-output", () => {
    for (const mode of ["continue", "review", "fork"] as const) {
      const out = formatPeerHandoff({
        ...base,
        mode,
        body: `${mode} note`,
      });

      expect(out, mode).toContain(`<peer-handoff mode="${mode}"`);
      expect(out, mode).toContain("\n<<<source-output\n");
      expect(out, mode).toContain("source artifact");
      expect(out, mode).toContain(`${mode} note`);
    }
  });

  it("non-raw modes can explicitly omit source-output", () => {
    const out = formatPeerHandoff({
      ...base,
      mode: "review",
      body: "review without source",
      includeSource: false,
    });

    expect(out).toContain(`<peer-handoff mode="review"`);
    expect(out).not.toContain("\n<<<source-output\n");
    expect(out).not.toContain("source artifact");
  });

  it("omits source-output when no sourceLastOutput is available", () => {
    const out = formatPeerHandoff({
      fromName: base.fromName,
      fromId: base.fromId,
      receiverMetadata: null,
      mode: "review",
      body: "review",
    });

    expect(out).not.toContain("\n<<<source-output\n");
  });

  it("labels urgent interrupt reasons", () => {
    const raw = formatPeerHandoff({
      ...base,
      mode: "raw",
      body: "stop and read this",
      interruptReason: "the active task is using the wrong target",
    });
    expect(raw).toContain("Urgent interrupt reason: the active task is using the wrong target");
    expect(raw).toContain("stop and read this");
    expect(raw).not.toContain("source artifact");

    const review = formatPeerHandoff({
      ...base,
      mode: "review",
      body: "audit urgently",
      interruptReason: "security fix is about to be reverted",
    });
    expect(review).toContain("Urgent interrupt reason from source agent:");
    expect(review).toContain("security fix is about to be reverted");
    expect(review).toContain("source artifact");
  });
});
