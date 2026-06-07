import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compareSemver, MIN_CODEX_VERSION, resolveClaudeExecutable } from "../cli-config.js";

describe("compareSemver", () => {
  it("returns 0 for identical versions", () => {
    expect(compareSemver("0.132.0", "0.132.0")).toBe(0);
  });

  it("returns -1 when a is strictly older", () => {
    expect(compareSemver("0.131.5", "0.132.0")).toBe(-1);
    expect(compareSemver("0.132.0", "0.133.0")).toBe(-1);
    expect(compareSemver("0.132.0", "1.0.0")).toBe(-1);
  });

  it("returns 1 when a is strictly newer", () => {
    expect(compareSemver("0.132.1", "0.132.0")).toBe(1);
    expect(compareSemver("0.133.0", "0.132.0")).toBe(1);
    expect(compareSemver("1.0.0", "0.999.999")).toBe(1);
  });

  it("compares segments numerically", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(compareSemver("0.132.0", "0.99.0")).toBe(1);
  });

  it("treats a pre-release suffix as older than the bare release", () => {
    expect(compareSemver("0.132.0-rc1", "0.132.0")).toBe(-1);
    expect(compareSemver("0.132.0", "0.132.0-rc1")).toBe(1);
  });

  it("handles malformed inputs without throwing", () => {
    expect(compareSemver("", "0.132.0")).toBe(-1);
    expect(compareSemver("not-a-version", "0.132.0")).toBe(-1);
    expect(compareSemver("garbage", "garbage")).toBe(0);
  });
});

describe("MIN_CODEX_VERSION boundary", () => {
  it("exposes 0.132.0", () => {
    expect(MIN_CODEX_VERSION).toBe("0.132.0");
  });

  it("flags 0.131.x as too old", () => {
    expect(compareSemver("0.131.0", MIN_CODEX_VERSION)).toBe(-1);
    expect(compareSemver("0.131.99", MIN_CODEX_VERSION)).toBe(-1);
  });

  it("accepts 0.132.0 and newer", () => {
    expect(compareSemver("0.132.0", MIN_CODEX_VERSION)).toBe(0);
    expect(compareSemver("0.132.1", MIN_CODEX_VERSION)).toBe(1);
    expect(compareSemver("0.140.0", MIN_CODEX_VERSION)).toBe(1);
  });
});

describe("resolveClaudeExecutable", () => {
  it("resolves npm shim paths to the native Claude executable", () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-claude-shim-"));
    const npmRoot = join(root, "npm");
    const binRoot = join(npmRoot, "node_modules", "@anthropic-ai", "claude-code", "bin");
    mkdirSync(binRoot, { recursive: true });
    const shim = join(npmRoot, process.platform === "win32" ? "claude.cmd" : "claude");
    const native = join(binRoot, process.platform === "win32" ? "claude.exe" : "claude");
    writeFileSync(shim, "shim");
    writeFileSync(native, "native");

    expect(resolveClaudeExecutable(shim)).toBe(native);
  });
});
