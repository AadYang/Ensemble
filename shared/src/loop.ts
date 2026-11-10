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
  /** Legacy field accepted for persisted configs; no longer a budget. */
  maxTurnsPerIter: null;
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
  result: "pass" | "fail" | "skip" | "progress";
  summary: string;
  snapshot?: string | null;
}

export interface LoopTask {
  text: string;
  done: boolean;
}

export type ReviewRole = "reviewer" | "developer";
export type ReviewItemStatus = "open" | "resolved";
export type ReviewBoardStatus = "open" | "lgtm";

export interface ReviewReply {
  author: ReviewRole;
  text: string;
}

export interface ReviewItem {
  id: string;
  status: ReviewItemStatus;
  title: string;
  replies: ReviewReply[];
}

export interface ReviewBoard {
  status: ReviewBoardStatus;
  items: ReviewItem[];
}

export type ReviewToolAction = "read" | "post" | "reply" | "resolve" | "lgtm";

export interface LoopState {
  iter: number;
  innerTurns: number;
  consecutiveFails: number;
  lastVerifyOk: boolean | null;
  lastVerifySummary: string;
  lastSnapshot: string | null;
  /** Checked items as of the previous turn; retained for existing saved states. */
  lastDoneCount: number;
  lastProgressFingerprint: string | null;
  lastRunnerSummary: string;
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
  review: ReviewBoard;
  iterations: LoopIteration[];
}

export type LoopDecision =
  | { action: "outer-iter"; userInput: string; resetRuntime: boolean; result: "progress" | "fail" }
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

export const DEFAULT_LOOP_MAX_ITERATIONS = 50;
export const LOOP_CONSECUTIVE_FAIL_LIMIT = 3;
export const LOOP_ITERATION_LOG_CAP = 50;

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
  if (textOf(r.reviewerAgentId) && doneWhen.kind !== "peer-lgtm") {
    doneWhen = { kind: "peer-lgtm", spec: "LGTM" };
  }

  const maxIterationsRaw = r.maxIterations;
  const maxIterations =
    typeof maxIterationsRaw === "number" && Number.isFinite(maxIterationsRaw) && maxIterationsRaw >= 1
      ? Math.min(Math.floor(maxIterationsRaw), 200)
      : DEFAULT_LOOP_MAX_ITERATIONS;
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
    maxTurnsPerIter: null,
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
    lastDoneCount: 0,
    lastProgressFingerprint: null,
    lastRunnerSummary: "",
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
          return (
            typeof it.n === "number" &&
            (it.result === "pass" || it.result === "fail" || it.result === "skip" || it.result === "progress")
          );
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
    lastDoneCount:
      typeof r.lastDoneCount === "number" && r.lastDoneCount >= 0 ? Math.floor(r.lastDoneCount) : 0,
    lastProgressFingerprint: typeof r.lastProgressFingerprint === "string" ? r.lastProgressFingerprint : null,
    lastRunnerSummary: typeof r.lastRunnerSummary === "string" ? r.lastRunnerSummary : "",
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
  review?: ReviewBoard;
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
    review: input.review ?? emptyReviewBoard(),
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

export function emptyReviewBoard(): ReviewBoard {
  return { status: "open", items: [] };
}

function lastReviewAuthor(item: ReviewItem): ReviewRole | null {
  const last = item.replies[item.replies.length - 1];
  return last?.author ?? null;
}

export function reviewBoardApproved(board: ReviewBoard): boolean {
  return board.status === "lgtm" && board.items.every((item) => item.status === "resolved");
}

export function nextReviewActor(board: ReviewBoard): ReviewRole | null {
  if (reviewBoardApproved(board)) return null;
  const needsDeveloper = board.items.some(
    (item) => item.status === "open" && lastReviewAuthor(item) !== "developer",
  );
  return needsDeveloper ? "developer" : "reviewer";
}

export function parseReviewMarkdown(text: string): ReviewBoard {
  const board = emptyReviewBoard();
  let current: ReviewItem | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const status = /^Status:\s*(LGTM|open|awaiting)\s*$/i.exec(line);
    if (status) {
      board.status = /^lgtm$/i.test(status[1] ?? "") ? "lgtm" : "open";
      continue;
    }
    if (/^##\s*LGTM\s*$/i.test(line)) {
      board.status = "lgtm";
      continue;
    }
    const heading = /^##\s+(R\d+)\s+\[(open|resolved)\]\s+(.+?)\s*$/i.exec(line);
    if (heading) {
      current = {
        id: heading[1]!.toUpperCase(),
        status: heading[2]!.toLowerCase() === "resolved" ? "resolved" : "open",
        title: heading[3]!.trim(),
        replies: [],
      };
      board.items.push(current);
      continue;
    }
    const reply = /^-\s+(reviewer|developer)\s*:\s*(.*)$/i.exec(line);
    if (reply && current) {
      current.replies.push({
        author: reply[1]!.toLowerCase() === "developer" ? "developer" : "reviewer",
        text: reply[2]!.trim(),
      });
    }
  }
  if (board.status === "lgtm" && board.items.some((item) => item.status === "open")) {
    board.status = "open";
  }
  return board;
}

export function reviewBoardToMarkdown(board: ReviewBoard): string {
  const lines = ["# LOOP Review Board", "", `Status: ${board.status === "lgtm" ? "LGTM" : "open"}`, ""];
  for (const item of board.items) {
    lines.push(`## ${item.id} [${item.status}] ${item.title}`);
    for (const reply of item.replies) {
      lines.push(`- ${reply.author}: ${reply.text}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function nextReviewItemId(board: ReviewBoard): string {
  let max = 0;
  for (const item of board.items) {
    const n = Number(/^R(\d+)$/i.exec(item.id)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return `R${max + 1}`;
}

export function applyReviewAction(
  board: ReviewBoard,
  role: ReviewRole,
  op: { action: ReviewToolAction; itemId?: string; title?: string; text?: string },
): { ok: true; board: ReviewBoard } | { ok: false; error: string } {
  if (op.action === "read") return { ok: true, board };
  if (op.action === "post") {
    if (role !== "reviewer") return { ok: false, error: "only the reviewer can post a finding; reply under an item instead" };
    const title = (op.title ?? "").trim() || (op.text ?? "").trim().split(/\r?\n/)[0]?.slice(0, 120) || "finding";
    const text = (op.text ?? "").trim();
    if (!text) return { ok: false, error: "post requires text" };
    const item: ReviewItem = {
      id: nextReviewItemId(board),
      status: "open",
      title,
      replies: [{ author: "reviewer", text }],
    };
    return { ok: true, board: { status: "open", items: [...board.items, item] } };
  }
  if (op.action === "reply") {
    const id = (op.itemId ?? "").trim().toUpperCase();
    const text = (op.text ?? "").trim();
    if (!id) return { ok: false, error: "reply requires itemId" };
    if (!text) return { ok: false, error: "reply requires text" };
    const idx = board.items.findIndex((item) => item.id.toUpperCase() === id);
    if (idx < 0) return { ok: false, error: `no review item ${id}` };
    const items = board.items.map((item, i) =>
      i === idx ? { ...item, replies: [...item.replies, { author: role, text }] } : item,
    );
    return { ok: true, board: { ...board, items } };
  }
  if (op.action === "resolve") {
    if (role !== "reviewer") return { ok: false, error: "only the reviewer can resolve an item" };
    const id = (op.itemId ?? "").trim().toUpperCase();
    if (!id) return { ok: false, error: "resolve requires itemId" };
    const idx = board.items.findIndex((item) => item.id.toUpperCase() === id);
    if (idx < 0) return { ok: false, error: `no review item ${id}` };
    const items = board.items.map((item, i) => (i === idx ? { ...item, status: "resolved" as const } : item));
    return { ok: true, board: { ...board, items } };
  }
  if (op.action === "lgtm") {
    if (role !== "reviewer") return { ok: false, error: "only the reviewer can mark LGTM" };
    if (board.items.some((item) => item.status === "open")) {
      return { ok: false, error: "resolve every open item before LGTM" };
    }
    return { ok: true, board: { ...board, status: "lgtm" } };
  }
  return { ok: false, error: `unknown action ${String(op.action)}` };
}

export function reviewBoardNotices(prev: ReviewBoard, next: ReviewBoard): string[] {
  const notices: string[] = [];
  const prevById = new Map(prev.items.map((item) => [item.id, item]));
  for (const item of next.items) {
    const old = prevById.get(item.id);
    if (!old) {
      notices.push(`LOOP 审阅黑板 · 新意见 ${item.id}: ${item.title}`);
      continue;
    }
    if (item.replies.length > old.replies.length) {
      for (const reply of item.replies.slice(old.replies.length)) {
        notices.push(
          reply.author === "developer"
            ? `LOOP 审阅黑板 · ${item.id} 开发已回复`
            : `LOOP 审阅黑板 · ${item.id} 审阅已回复`,
        );
      }
    }
    if (old.status === "open" && item.status === "resolved") {
      notices.push(`LOOP 审阅黑板 · ${item.id} 已结案`);
    }
  }
  if (prev.status !== "lgtm" && next.status === "lgtm") {
    notices.push("LOOP 审阅黑板 · LGTM");
  }
  return notices;
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
    "You are in an Ensemble Loop. Each time you stop, Ensemble starts the next iteration.",
    "- Track remaining work in TASKS.md (create it if needed) as ONE `- [ ]` checklist.",
    "- This iteration: do only the first unfinished item. Mark it `- [x]` in TASKS.md, then stop.",
    "- Do not finish the whole board in one turn. The loop board reads checkboxes only; progress written as prose is invisible to it.",
    "- Do not move finished items into narrative sections and do not leave them unchecked.",
    "- Write ## DONE in TASKS.md only when every item is done and the entire goal is met. Do not write it early.",
    "- Do not stop just because you described a plan.",
  ];
  if (config.reviewerAgentId) {
    lines.push(
      "- After ## DONE, Ensemble opens a LOOP review board. Do not peer_send the reviewer. Use loop_review to read findings and reply under each open item.",
    );
  }
  if (config.verifier) {
    lines.push(
      `- Ensemble may run this check: ${config.verifier.kind} ${config.verifier.spec}. Do not write ## DONE if it would fail.`,
    );
  }
  return lines.join("\n");
}

export function loopContinuePrompt(config: LoopConfig): string {
  return [
    `Goal (still in force):\n${config.goal}`,
    "This loop is not done. Next iteration: do only the first unfinished item in TASKS.md. Mark it `- [x]`, then stop. Write ## DONE only when the entire goal is met.",
  ].join("\n\n");
}

function nextIteration(
  config: LoopConfig,
  state: LoopState,
  userInput: string,
  result: "progress" | "fail",
): LoopDecision {
  if (state.iter >= config.maxIterations) {
    return { action: "pause", reason: `iteration cap ${config.maxIterations} reached` };
  }
  return {
    action: "outer-iter",
    resetRuntime: config.session === "fresh-disk",
    userInput,
    result,
  };
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
    "VERIFY FAIL. The completion condition is not met. Do the next unfinished item, then stop. Ensemble will start the next iteration.",
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
    return nextIteration(config, state, failPrompt, "fail");
  }

  if (config.doneWhen.kind !== "exit-0" && !markerHit && reviewText === undefined) {
    if (state.consecutiveFails >= LOOP_CONSECUTIVE_FAIL_LIMIT && !hasDiff) {
      return {
        action: "pause",
        reason: `no ## DONE and no further diff after ${state.consecutiveFails} turns`,
      };
    }
    return nextIteration(config, state, loopContinuePrompt(config), hasDiff ? "progress" : "fail");
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
      userInput: `Please review this loop on the LOOP review board. Use loop_review. Do not peer_send.\nGoal:\n${config.goal}`,
    };
  }

  return { action: "done", summary: summary.trim() || "loop complete" };
}

export function formatLoopStatusLines(view: LoopView): string[] {
  const v = view.config.verifier;
  return [
    `loop            ${view.status}  iter ${view.iter}/${view.maxIterations}`,
    `verifier        ${v ? `${v.kind}  ${v.spec}` : "none"}  last=${
      // No verifier means nothing was checked. Reporting `pass` here made
      // "no command verifier" look like a green gate.
      !v || view.lastVerifyOk == null ? "n/a" : view.lastVerifyOk ? "pass" : "fail"
    }`,
    `doneWhen        ${view.config.doneWhen.kind} ${view.config.doneWhen.spec}`.trim(),
    `session         ${view.config.session}`,
    `snapshot        ${view.lastSnapshot ?? view.config.snapshot}`,
    `stall           consecutive fail ${view.consecutiveFails}/${LOOP_CONSECUTIVE_FAIL_LIMIT}`,
  ];
}
