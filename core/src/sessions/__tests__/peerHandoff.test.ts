import { describe, it, expect } from "vitest";
import { formatPeerHandoff } from "../peerHandoff.js";

describe("formatPeerHandoff", () => {
  it("review mode embeds sourceLastOutput in a source-output block", () => {
    const out = formatPeerHandoff({
      fromName: "agent-3",
      fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
      receiverMetadata: null,
      mode: "review",
      body: "他总结的对么",
      sourceLastOutput: "README 主要内容如下：Ensemble 是一个桌面级多 agent ...",
    });
    expect(out).toContain("<<<source-output");
    expect(out).toContain("README 主要内容如下");
    expect(out).toContain("source-output>>>");
    expect(out).toContain("Operator's accompanying note");
    expect(out).toContain("他总结的对么");
  });

  it("continue mode embeds sourceLastOutput as the trajectory to continue from", () => {
    const out = formatPeerHandoff({
      fromName: "agent-3",
      fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
      receiverMetadata: null,
      mode: "continue",
      body: "继续做下去",
      sourceLastOutput: "已完成步骤 1-3，进行中：步骤 4 ...",
    });
    expect(out).toContain("\n<<<source-output\n");
    expect(out).toContain("已完成步骤 1-3");
    expect(out).toContain("Operator's accompanying note");
    expect(out).toContain("继续做下去");
  });

  it("fork mode embeds sourceLastOutput as the path to avoid retracing", () => {
    const out = formatPeerHandoff({
      fromName: "agent-3",
      fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
      receiverMetadata: null,
      mode: "fork",
      body: "换个思路重做",
      sourceLastOutput: "我试过用 regex 解析 HTML，效果很差",
    });
    expect(out).toContain("\n<<<source-output\n");
    expect(out).toContain("regex 解析 HTML");
    expect(out).toContain("换个思路重做");
  });

  it("non-raw modes without sourceLastOutput omit the embedded block", () => {
    for (const mode of ["review", "continue", "fork"] as const) {
      const out = formatPeerHandoff({
        fromName: "agent-3",
        fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
        receiverMetadata: null,
        mode,
        body: "x",
      });
      expect(out, `${mode}: should not embed when missing`).not.toContain("\n<<<source-output\n");
    }
  });

  it("raw mode embeds sourceLastOutput when provided (compact form)", () => {
    const out = formatPeerHandoff({
      fromName: "agent-3",
      fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
      receiverMetadata: null,
      mode: "raw",
      body: "fyi",
      sourceLastOutput: "README 摘要：xxx",
    });
    expect(out).toContain("[from agent-3 (id=7f7359a4)]");
    expect(out).toContain("<<<source-output");
    expect(out).toContain("README 摘要：xxx");
    expect(out).toContain("source-output>>>");
    expect(out).toContain("fyi");
    // no instruction prose for raw
    expect(out).not.toContain("你正在以");
  });

  it("labels source state when source output is live or interrupted", () => {
    const review = formatPeerHandoff({
      fromName: "agent-3",
      fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
      receiverMetadata: null,
      mode: "review",
      body: "review",
      sourceState: "interrupted",
      sourceLastOutput: "partial work",
    });
    expect(review).toContain("Source state: interrupted");

    const raw = formatPeerHandoff({
      fromName: "agent-3",
      fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
      receiverMetadata: null,
      mode: "raw",
      body: "fyi",
      sourceState: "running",
      sourceLastOutput: "live work",
    });
    expect(raw).toContain("Source state: running");
  });

  it("raw mode without sourceLastOutput keeps the legacy compact form", () => {
    const out = formatPeerHandoff({
      fromName: "agent-3",
      fromId: "7f7359a4-4bdf-4671-901c-1d12d6a6c0b4",
      receiverMetadata: null,
      mode: "raw",
      body: "hi",
    });
    expect(out).toBe("[from agent-3] hi");
  });
});
