export type LoopStatus =
  | "idle"
  | "running"
  | "paused"
  | "awaiting_review"
  | "done"
  | "failed";

export type LoopVerifierKind = "command" | "job" | "file-marker" | "peer-review";
export type LoopDoneWhenKind = "exit-0" | "file-contains" | "peer-lgtm";
export type LoopSessionPolicy = "resume" | "fresh-disk";
export type LoopSnapshotPolicy = "git-commit" | "none";

export interface LoopVerifier {
  kind: LoopVerifierKind;
  spec: string;
}

export interface LoopDoneWhen {
  kind: LoopDoneWhenKind;
  spec: string;
}

export interface LoopConfig {
  goal: string;
  verifier: LoopVerifier | null;
  doneWhen: LoopDoneWhen;
  maxIterations: number;
  maxTurnsPerIter: number | null;
  session: LoopSessionPolicy;
  snapshot: LoopSnapshotPolicy;
  permissionBump: string | null;
  allowedVerifierCmds: string[];
  teamId?: string;
  reviewerAgentId?: string;
  worktree?: boolean;
  recipe?: "tdd" | "ralph" | "pr-gate";
  previousPermissionMode?: string | null;
  previousSandboxMode?: string | null;
  boardRoot?: string | null;
}

export interface LoopIteration {
  n: number;
  result: "pass" | "fail" | "skip";
  summary: string;
  snapshot?: string | null;
}

export interface LoopTask {
  text: string;
  done: boolean;
}

export interface LoopState {
  iter: number;
  innerTurns: number;
  consecutiveFails: number;
  lastVerifyOk: boolean | null;
  lastVerifySummary: string;
  lastSnapshot: string | null;
  iterations: LoopIteration[];
}

export interface LoopView {
  agentId: string;
  teamId: string | null;
  status: LoopStatus;
  config: LoopConfig;
  iter: number;
  maxIterations: number;
  innerTurns: number;
  consecutiveFails: number;
  lastVerifyOk: boolean | null;
  lastVerifySummary: string;
  lastSnapshot: string | null;
  tasks: LoopTask[];
  iterations: LoopIteration[];
}

export type LoopDecision =
  | { action: "continue"; userInput: string }
  | { action: "outer-iter"; userInput: string; resetRuntime: boolean }
  | { action: "pause"; reason: string }
  | { action: "done"; summary: string }
  | { action: "awaiting_review"; userInput: string }
  | { action: "review-reject"; userInput: string }
  | { action: "noop" };

export class LoopConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LoopConfigError";
    this.code = code;
  }
}

const VERIFIER_KINDS = new Set<LoopVerifierKind>(["command", "job", "file-marker", "peer-review"]);
const DONE_KINDS = new Set<LoopDoneWhenKind>(["exit-0", "file-contains", "peer-lgtm"]);
export const DEFAULT_LOOP_DONE_WHEN: LoopDoneWhen = { kind: "file-contains", spec: "## DONE" };

export const DEFAULT_LOOP_MAX_ITERATIONS = 20;
export const LOOP_CONSECUTIVE_FAIL_LIMIT = 3;
export const LOOP_ITERATION_LOG_CAP = 20;

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseVerifier(raw: unknown): LoopVerifier | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const kind = textOf(v.kind) as LoopVerifierKind;
  const spec = textOf(v.spec);
  if (!VERIFIER_KINDS.has(kind) || !spec) return null;
  return { kind, spec };
}

function defaultDoneWhen(verifier: LoopVerifier | null, raw: unknown): LoopDoneWhen {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const kind = textOf(r.kind) as LoopDoneWhenKind;
    if (DONE_KINDS.has(kind)) {
      const fallback = kind === "file-contains" ? "## DONE" : kind === "peer-lgtm" ? "LGTM" : "";
      return { kind, spec: textOf(r.spec) || fallback };
    }
  }
  if (verifier?.kind === "peer-review") return { kind: "peer-lgtm", spec: "LGTM" };
  if (verifier?.kind === "file-marker") return { kind: "file-contains", spec: verifier.spec || "## DONE" };
  return { ...DEFAULT_LOOP_DONE_WHEN };
}

export function parseLoopConfig(raw: unknown): LoopConfig {
  if (!raw || typeof raw !== "object") {
    throw new LoopConfigError("LOOP_CONFIG_INVALID", "loop config must be an object");
  }
  const r = raw as Record<string, unknown>;
  const goal = textOf(r.goal);
  if (!goal) throw new LoopConfigError("LOOP_GOAL_REQUIRED", "loop goal is required");

  const verifier = parseVerifier(r.verifier);
  let doneWhen = defaultDoneWhen(verifier, r.doneWhen);
  if (!verifier && doneWhen.kind === "exit-0") doneWhen = { ...DEFAULT_LOOP_DONE_WHEN };

  const maxIterationsRaw = r.maxIterations;
  const maxIterations =
    typeof maxIterationsRaw === "number" && Number.isFinite(maxIterationsRaw) && maxIterationsRaw >= 1
      ? Math.min(Math.floor(maxIterationsRaw), 200)
      : DEFAULT_LOOP_MAX_ITERATIONS;
  const maxTurnsRaw = r.maxTurnsPerIter;
  const maxTurnsPerIter =
    typeof maxTurnsRaw === "number" && Number.isFinite(maxTurnsRaw) && maxTurnsRaw >= 1
      ? Math.floor(maxTurnsRaw)
      : null;
  const session = r.session === "fresh-disk" ? "fresh-disk" : "resume";
  const snapshot = r.snapshot === "git-commit" ? "git-commit" : "none";
  const cmds = Array.isArray(r.allowedVerifierCmds)
    ? r.allowedVerifierCmds.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : verifier?.spec
      ? [verifier.spec]
      : [];

  return {
    goal,
    verifier,
    doneWhen,
    maxIterations,
    maxTurnsPerIter,
    session,
    snapshot,
    permissionBump: textOf(r.permissionBump) || null,
    allowedVerifierCmds: cmds,
    ...(textOf(r.teamId) ? { teamId: textOf(r.teamId) } : {}),
    ...(textOf(r.reviewerAgentId) ? { reviewerAgentId: textOf(r.reviewerAgentId) } : {}),
    ...(r.worktree === true ? { worktree: true } : {}),
    ...(r.recipe === "tdd" || r.recipe === "ralph" || r.recipe === "pr-gate" ? { recipe: r.recipe } : {}),
    previousPermissionMode: textOf(r.previousPermissionMode) || null,
    previousSandboxMode: typeof r.previousSandboxMode === "string" ? r.previousSandboxMode : null,
    boardRoot: typeof r.boardRoot === "string" ? r.boardRoot : null,
  };
}

export function emptyLoopState(): LoopState {
  return {
    iter: 1,
    innerTurns: 0,
    consecutiveFails: 0,
    lastVerifyOk: null,
    lastVerifySummary: "",
    lastSnapshot: null,
    iterations: [],
  };
}

export function parseLoopState(raw: unknown): LoopState {
  const base = emptyLoopState();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const iter = typeof r.iter === "number" && r.iter >= 1 ? Math.floor(r.iter) : 1;
  const innerTurns = typeof r.innerTurns === "number" && r.innerTurns >= 0 ? Math.floor(r.innerTurns) : 0;
  const consecutiveFails =
    typeof r.consecutiveFails === "number" && r.consecutiveFails >= 0 ? Math.floor(r.consecutiveFails) : 0;
  const iterations = Array.isArray(r.iterations)
    ? r.iterations
        .filter((row): row is LoopIteration => {
          if (!row || typeof row !== "object") return false;
          const it = row as LoopIteration;
          return typeof it.n === "number" && (it.result === "pass" || it.result === "fail" || it.result === "skip");
        })
        .slice(-LOOP_ITERATION_LOG_CAP)
    : [];
  return {
    iter,
    innerTurns,
    consecutiveFails,
    lastVerifyOk: typeof r.lastVerifyOk === "boolean" ? r.lastVerifyOk : null,
    lastVerifySummary: typeof r.lastVerifySummary === "string" ? r.lastVerifySummary : "",
    lastSnapshot: typeof r.lastSnapshot === "string" ? r.lastSnapshot : null,
    iterations,
  };
}

export function loopViewOf(input: {
  agentId: string;
  teamId?: string | null;
  status: LoopStatus;
  config: LoopConfig;
  state: LoopState;
  tasks?: LoopTask[];
}): LoopView {
  return {
    agentId: input.agentId,
    teamId: input.teamId ?? input.config.teamId ?? null,
    status: input.status,
    config: input.config,
    iter: input.state.iter,
    maxIterations: input.config.maxIterations,
    innerTurns: input.state.innerTurns,
    consecutiveFails: input.state.consecutiveFails,
    lastVerifyOk: input.state.lastVerifyOk,
    lastVerifySummary: input.state.lastVerifySummary,
    lastSnapshot: input.state.lastSnapshot,
    tasks: input.tasks ?? [],
    iterations: input.state.iterations,
  };
}

export function parseTasksMarkdown(text: string): LoopTask[] {
  const tasks: LoopTask[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    tasks.push({ done: m[1] !== " ", text: m[2]!.trim() });
  }
  return tasks;
}

export function tasksToMarkdown(tasks: readonly LoopTask[]): string {
  const lines = ["# TASKS", ""];
  for (const task of tasks) {
    lines.push(`- [${task.done ? "x" : " "}] ${task.text}`);
  }
  if (!tasks.some((t) => !t.done)) lines.push("", "## DONE");
  return lines.join("\n") + "\n";
}

export function fileMarkerHit(text: string, marker: string): boolean {
  const needle = marker.trim() || "## DONE";
  return text.includes(needle) || text.includes("ALL_COMPLETE");
}

export function reviewLooksLikeLgtm(text: string): boolean {
  return /\bLGTM\b/i.test(text) || /批准|通过评审/.test(text);
}

export function loopStartPrompt(config: LoopConfig): string {
  const lines = [
    config.goal.trim(),
    "",
    "You are in an Ensemble Loop. Keep working until the goal is fully met.",
    "- Track remaining work in TASKS.md (create it if needed).",
    "- Write ## DONE in TASKS.md only when the entire goal is met. Do not write it early.",
    "- Do not stop just because you described a plan.",
  ];
  if (config.verifier) {
    lines.push(
      `- Ensemble will also run this check after you stop: ${config.verifier.kind} ${config.verifier.spec}. Do not claim done if it would fail.`,
    );
  }
  return lines.join("\n");
}

export function loopContinuePrompt(config: LoopConfig): string {
  return [
    `Goal (still in force):\n${config.goal}`,
    "This loop is not done: TASKS.md does not contain ## DONE.",
    "Continue the work. Update TASKS.md. Write ## DONE only when the entire goal is met.",
  ].join("\n\n");
}

export function decideLoopAfterVerify(input: {
  config: LoopConfig;
  state: LoopState;
  verifyOk: boolean;
  summary: string;
  markerHit: boolean;
  hasDiff: boolean;
  reviewText?: string;
}): LoopDecision {
  const { config, state, verifyOk, summary, markerHit, hasDiff, reviewText } = input;
  const failPrompt = [
    "VERIFY FAIL. The completion condition is not met. Continue. Do not stop until it passes.",
    summary.trim() ? `Failure summary:\n${summary.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!verifyOk) {
    if (state.consecutiveFails >= LOOP_CONSECUTIVE_FAIL_LIMIT && !hasDiff) {
      return {
        action: "pause",
        reason: `verifier failed ${state.consecutiveFails} times with no further diff`,
      };
    }
    if (config.maxTurnsPerIter != null && state.innerTurns >= config.maxTurnsPerIter) {
      return { action: "pause", reason: `inner-turn cap ${config.maxTurnsPerIter} reached` };
    }
    return { action: "continue", userInput: failPrompt };
  }

  if (config.doneWhen.kind === "peer-lgtm") {
    if (reviewText !== undefined) {
      if (reviewLooksLikeLgtm(reviewText)) {
        return { action: "done", summary: reviewText.trim() || "reviewer LGTM" };
      }
      return {
        action: "review-reject",
        userInput: `Reviewer rejected the work. Address this and continue:\n\n${reviewText.trim()}`,
      };
    }
    return {
      action: "awaiting_review",
      userInput: `Please review this loop against the goal:\n${config.goal}\n\nReply LGTM if it is done, otherwise list what to fix.`,
    };
  }

  if (config.doneWhen.kind === "file-contains" && !markerHit) {
    if (state.consecutiveFails >= LOOP_CONSECUTIVE_FAIL_LIMIT && !hasDiff) {
      return {
        action: "pause",
        reason: `no ## DONE and no further diff after ${state.consecutiveFails} turns`,
      };
    }
    if (state.iter >= config.maxIterations) {
      return { action: "pause", reason: `iteration cap ${config.maxIterations} reached` };
    }
    return {
      action: "outer-iter",
      resetRuntime: config.session === "fresh-disk",
      userInput: loopContinuePrompt(config),
    };
  }

  return { action: "done", summary: summary.trim() || "loop complete" };
}

export function formatLoopStatusLines(view: LoopView): string[] {
  const v = view.config.verifier;
  return [
    `loop            ${view.status}  ${view.iter}/${view.maxIterations}`,
    `verifier        ${v ? `${v.kind}  ${v.spec}` : "none"}  last=${
      view.lastVerifyOk == null ? "n/a" : view.lastVerifyOk ? "pass" : "fail"
    }`,
    `doneWhen        ${view.config.doneWhen.kind} ${view.config.doneWhen.spec}`.trim(),
    `session         ${view.config.session}`,
    `snapshot        ${view.lastSnapshot ?? view.config.snapshot}`,
    `stall           consecutive fail ${view.consecutiveFails}/${LOOP_CONSECUTIVE_FAIL_LIMIT}`,
  ];
}
