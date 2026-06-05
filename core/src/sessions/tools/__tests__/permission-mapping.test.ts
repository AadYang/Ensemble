// Slice 4.3: lock in the permissionMode → needsApproval mapping.
// The table in docs/plans/openai-permission-state-machine.md §3 is the
// canonical source — these assertions track 1:1.

import { describe, it, expect } from "vitest";
import { shouldRequireApproval } from "../index.js";

describe("shouldRequireApproval", () => {
  describe("default mode — gate writes + shell, free reads", () => {
    it("read-only tools never gate", () => {
      expect(shouldRequireApproval("default", "Read")).toBe(false);
      expect(shouldRequireApproval("default", "Grep")).toBe(false);
      expect(shouldRequireApproval("default", "Glob")).toBe(false);
    });
    it("write + shell gate", () => {
      expect(shouldRequireApproval("default", "Edit")).toBe(true);
      expect(shouldRequireApproval("default", "Write")).toBe(true);
      expect(shouldRequireApproval("default", "Bash")).toBe(true);
    });
  });

  describe("acceptEdits — only Bash still gates", () => {
    it("Edit / Write auto-accept", () => {
      expect(shouldRequireApproval("acceptEdits", "Edit")).toBe(false);
      expect(shouldRequireApproval("acceptEdits", "Write")).toBe(false);
    });
    it("Bash still gates (workspace escape)", () => {
      expect(shouldRequireApproval("acceptEdits", "Bash")).toBe(true);
    });
    it("read-only tools still free", () => {
      expect(shouldRequireApproval("acceptEdits", "Read")).toBe(false);
    });
  });

  describe("bypassPermissions / dontAsk — total bypass", () => {
    for (const mode of ["bypassPermissions", "dontAsk"] as const) {
      it(`${mode}: every tool auto-approves`, () => {
        for (const t of ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]) {
          expect(shouldRequireApproval(mode, t)).toBe(false);
        }
      });
    }
  });

  describe("plan mode — same gating as default (Slice 4 deferred)", () => {
    it("treats writes/shell like default", () => {
      expect(shouldRequireApproval("plan", "Edit")).toBe(true);
      expect(shouldRequireApproval("plan", "Write")).toBe(true);
      expect(shouldRequireApproval("plan", "Bash")).toBe(true);
    });
    it("read-only tools still free", () => {
      expect(shouldRequireApproval("plan", "Read")).toBe(false);
    });
  });

  describe("unknown tool name — fail closed (gate)", () => {
    it("anything not in the read-only set falls into default gating logic", () => {
      // Future tool names not yet on the read-only list default to gated under
      // default/plan, free under bypass/dontAsk — same logic as Bash.
      expect(shouldRequireApproval("default", "FutureTool")).toBe(true);
      expect(shouldRequireApproval("bypassPermissions", "FutureTool")).toBe(false);
    });
  });
});
