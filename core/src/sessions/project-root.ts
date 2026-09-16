// The agent's project root: the ONE directory a turn runs in.
//
// Everything that used to be codex-only about this (`codexWorkspace`, a
// provider-kind gate, a CLI default) was three different answers to one
// question. This module is the single place that answers it:
//
//   • what a stored root means       `projectRootOf(agent)`
//   • whether a path is usable       `inspectProjectRoot(path)`
//   • what the write path accepts    `normalizeProjectRoot(value)`
//   • where an unbound agent works   `scratchDirFor(agentId)`
//
// INSPECTION IS AN OUTCOME, NOT AN EXCEPTION. A turn's plan has to be able to
// report "the configured root is gone" without the whole `/status` report
// failing, so the check returns a verdict. The WRITE path is the opposite: a
// user setting a root that does not exist must be refused before it is stored,
// so `normalizeProjectRoot` throws a structured rejection.

import { constants, accessSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { ProjectRootErrorCode } from "@agentorch/shared";
import { ensureDataDir } from "../paths.js";

export interface ProjectRootInvalid {
  code: ProjectRootErrorCode;
  reason: string;
}

/** A project root the user asked for that cannot be stored. Structured on
 *  purpose: the API turns it into a declared 4xx code instead of the 500 an
 *  anonymous `Error` would produce, and the UI can say which rule failed. */
export class ProjectRootRejected extends Error {
  readonly code: ProjectRootErrorCode;
  readonly path: string;
  constructor(code: ProjectRootErrorCode, path: string, reason: string) {
    super(reason);
    this.name = "ProjectRootRejected";
    this.code = code;
    this.path = path;
  }
}

export const isProjectRootRejection = (err: unknown): err is ProjectRootRejected =>
  err instanceof ProjectRootRejected ||
  (typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("PROJECT_ROOT_"));

/** Inspect a directory WITHOUT throwing: a configured root that is unusable
 *  gets reported, not swallowed and not substituted. */
export function inspectProjectRoot(path: string): ProjectRootInvalid | null {
  if (!isAbsolute(path)) {
    return {
      code: "PROJECT_ROOT_NOT_ABSOLUTE",
      reason: `the project root must be an absolute path: ${path}`,
    };
  }
  if (!existsSync(path)) {
    return { code: "PROJECT_ROOT_NOT_FOUND", reason: `the project root does not exist: ${path}` };
  }
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch (err) {
    const code = (err as { code?: string }).code;
    // A directory we cannot even stat is not a missing one: EACCES/EPERM mean
    // it exists and we are not allowed in, and saying "does not exist" would
    // send the user (and the model) looking for the wrong problem.
    if (code === "EACCES" || code === "EPERM") {
      return {
        code: "PROJECT_ROOT_UNREADABLE",
        reason: `the project root cannot be read (${code}): ${path}`,
      };
    }
    return { code: "PROJECT_ROOT_NOT_FOUND", reason: `the project root cannot be read (${String(err)}): ${path}` };
  }
  if (!isDir) {
    return { code: "PROJECT_ROOT_NOT_A_DIRECTORY", reason: `the project root is not a directory: ${path}` };
  }
  try {
    // A working directory must be readable AND enterable — a directory with
    // --x alone cannot be listed, so a turn starting there would fail on the
    // first Glob. W_OK is deliberately NOT required: a read-only checkout is a
    // legitimate project, and the sandbox/permission layer already governs
    // writes.
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch {
    return { code: "PROJECT_ROOT_UNREADABLE", reason: `the project root is not readable: ${path}` };
  }
  return null;
}

/**
 * The identity of a path, for deciding whether two spellings name the SAME
 * directory. The user's spelling is what gets STORED (they should see it back),
 * but a conflict test that compared raw strings would call `D:\Repo` vs
 * `d:/repo/` vs `D:\Repo\.\` three different projects.
 *
 * Resolution order, most authoritative first:
 *   1. `realpath` — an existing directory resolves case, symlinks and `..` for
 *      us, on every platform.
 *   2. lexical normalization, then case folding — for a path that does not
 *      exist (or cannot be stated), so a comparison still has an answer.
 * Windows folds case (its filesystems are case-insensitive by volume default);
 * POSIX does not, because there `Repo` and `repo` really are two directories.
 */
export function projectRootIdentity(path: string): string {
  const lexical = normalize(resolve(path));
  let resolved = lexical;
  try {
    resolved = realpathSync.native(lexical);
  } catch {
    // Not resolvable (missing, or unreadable): the lexical form is the answer.
  }
  const stripped = stripTrailingSeparators(resolved);
  return process.platform === "win32" ? stripped.toLowerCase() : stripped;
}

function stripTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 1 && (path[end - 1] === sep || path[end - 1] === "/")) end -= 1;
  return path.slice(0, end);
}

/** Do two spellings name one directory? */
export function isSameProjectRoot(a: string, b: string): boolean {
  return projectRootIdentity(a) === projectRootIdentity(b);
}

/** The write-path rule. `undefined` = the caller said nothing (leave whatever is
 *  stored); `null`/"" = explicitly unbound; a string is inspected and refused
 *  with a structured code when it is unusable. */
export function normalizeProjectRoot(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  const invalid = inspectProjectRoot(trimmed);
  if (invalid) throw new ProjectRootRejected(invalid.code, trimmed, invalid.reason);
  return trimmed;
}

/** The legacy alias. An old client (or the cloud web UI) may still send
 *  `codexWorkspace`; when it is the ONLY field given it means the same thing.
 *  When both are given they must agree after normalization — two different
 *  directories in one request is a caller bug, not a merge order to pick. */
export function reconcileProjectRootInput(
  projectRoot: string | null | undefined,
  legacyCodexWorkspace: string | null | undefined,
): string | null | undefined {
  const canonical = normalizeProjectRoot(projectRoot);
  const legacy = normalizeProjectRoot(legacyCodexWorkspace);
  if (canonical === undefined) return legacy;
  if (legacy === undefined) return canonical;
  // Same DIRECTORY, not same string: `D:\Repo\` and `d:/repo` are one project
  // spelled twice, and a caller that normalized differently — or a Windows user
  // who fixed the case — must not be refused for it.
  if (!(canonical === null || legacy === null) && isSameProjectRoot(canonical, legacy)) {
    return canonical;
  }
  if (canonical !== legacy) {
    throw new ProjectRootRejected(
      "PROJECT_ROOT_CONFLICT",
      String(projectRoot),
      `projectRoot and the legacy codexWorkspace disagree (${String(projectRoot)} vs ${String(legacyCodexWorkspace)}); ` +
        "they are aliases of one field, so send one of them",
    );
  }
  return canonical;
}

/** Where an unbound agent works. Per agent, so two unbound agents never share a
 *  directory and neither one inherits whatever the process happened to be
 *  started in. */
export function scratchDirFor(agentId: string): string {
  return join(ensureDataDir(), "agents", agentId, "scratch");
}

/** Create the scratch directory, or say why the turn cannot run. Called at turn
 *  start rather than at plan time: resolving a plan is a read, and `/status`
 *  must not create directories. */
export function ensureScratchDir(agentId: string): { ok: true; path: string } | { ok: false; reason: string } {
  const path = scratchDirFor(agentId);
  try {
    mkdirSync(path, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `could not create the scratch directory ${path}: ${String(err)}` };
  }
  const invalid = inspectProjectRoot(path);
  if (invalid) return { ok: false, reason: invalid.reason };
  return { ok: true, path };
}
