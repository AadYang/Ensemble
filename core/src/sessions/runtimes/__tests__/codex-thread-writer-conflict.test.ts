import { describe, expect, it } from "vitest";
import { isCodexThreadWriterConflict, buildCodexRuntimeErrorEvent } from "../codex.js";
import { isRuntimeCodexThreadWriterConflictSignal } from "../../SessionManager.js";

// Regression guard for the decoupled-process bug:
//   "codex exec exited with code 1 … thread-store conflict: thread <id> already
//    has an active writer … thread/resume failed"
//
// A previous codex process still holding the thread-store writer lock makes the
// next `codex exec resume` on the same thread fail. Instead of wedging the
// agent in ERROR, Ensemble must classify this as recoverable + resume-scoped so
// it clears the cached thread id and auto-continues on a fresh thread.
describe("Codex thread-store writer conflict", () => {
  const ACTIVE_WRITER =
    "codex exec exited with code 1\n" +
    "ERROR codex_core::session: Failed to create session: thread-store conflict: " +
    "thread 01a06b42-e113-7fa3-821c-b9f387b941d8 already has an active writer\n" +
    "Error: thread/resume: thread/resume failed: thread 01a06b42-e113-7fa3-821c-b9f387b941d8 " +
    "already has an active writer (code -32600)";

  it("detects the active-writer / thread-store conflict message", () => {
    expect(isCodexThreadWriterConflict(ACTIVE_WRITER)).toBe(true);
    expect(isCodexThreadWriterConflict("thread-store conflict: already has an active writer")).toBe(true);
    expect(isCodexThreadWriterConflict("failed to initialize thread persistence")).toBe(true);
  });

  it("does NOT misclassify unrelated errors", () => {
    expect(isCodexThreadWriterConflict("model overloaded")).toBe(false);
    expect(isCodexThreadWriterConflict("stream disconnected before completion")).toBe(false);
  });

  it("emits a recoverable, resume-scoped RuntimeErrorEvent with the dedicated code", () => {
    const ev = buildCodexRuntimeErrorEvent(ACTIVE_WRITER, {
      usedNativeResume: true,
      turnStarted: true,
      turnCompleted: false,
    });
    expect(ev.code).toBe("CODEX_THREAD_WRITER_CONFLICT");
    expect(ev.recoverable).toBe(true);
    expect(ev.resumeScoped).toBe(true);
  });

  it("classifies regardless of whether the turn had started (fails at session create)", () => {
    const ev = buildCodexRuntimeErrorEvent(ACTIVE_WRITER, {
      usedNativeResume: true,
      turnStarted: false,
      turnCompleted: false,
    });
    expect(ev.code).toBe("CODEX_THREAD_WRITER_CONFLICT");
    expect(ev.recoverable).toBe(true);
  });

  it("SessionManager recognizes the recovery signal", () => {
    expect(isRuntimeCodexThreadWriterConflictSignal("CODEX_THREAD_WRITER_CONFLICT", true)).toBe(true);
    expect(isRuntimeCodexThreadWriterConflictSignal("CODEX_THREAD_WRITER_CONFLICT", false)).toBe(false);
    expect(isRuntimeCodexThreadWriterConflictSignal("CODEX_EVENT_STREAM_LAGGED", true)).toBe(false);
    expect(isRuntimeCodexThreadWriterConflictSignal(undefined, true)).toBe(false);
  });
});
