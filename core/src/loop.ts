import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { JobManager } from "./jobs.js";
import { readTail } from "./jobs.js";
import { prisma, type Agent, type AgentLoop, type AgentLoopStatus } from "./db.js";
import type { WSHub } from "./ws/hub.js";
import {
  LOOP_CONSECUTIVE_FAIL_LIMIT,
  LOOP_ITERATION_LOG_CAP,
  LoopConfigError,
  decideLoopAfterVerify,
  emptyLoopState,
  fileMarkerHit,
  formatLoopStatusLines,
  loopStartPrompt,
  loopViewOf,
  parseLoopConfig,
  parseLoopState,
  parseReviewMarkdown,
  parseTasksMarkdown,
  reviewBoardApproved,
  reviewBoardNotices,
  reviewBoardToMarkdown,
  tasksToMarkdown,
  applyReviewAction,
  emptyReviewBoard,
  nextReviewActor,
  type LoopConfig,
  type LoopDecision,
  type LoopState,
  type LoopStatus,
  type LoopTask,
  type ReviewBoard,
  type ReviewRole,
  type LoopView,
} from "@agentorch/shared";
import type { LoopReviewArgs } from "./loop-review-tool.js";
import { addLoopWorktree, commitLoopSnapshot, loopWorkspaceFingerprint, readGitState } from "./git.js";
import { inspectProjectRoot, scratchDirFor } from "./sessions/project-root.js";
import { ensureLoopSkills, loopSkillName } from "./loop-skills.js";
import { prefillLoopFromProject } from "./loop-prefill.js";
import type { PermissionMode, SandboxMode } from "@agentorch/shared";

export type LoopHost = {
  sendMessage: (agentId: string, text: string) => Promise<unknown>;
  resetRuntimeSession: (agentId: string) => Promise<unknown>;
  persistLoopNotice: (agentId: string, text: string) => Promise<void>;
  patchAgent: (
    id: string,
    patch: {
      permissionMode?: PermissionMode;
      sandboxMode?: SandboxMode | null;
      projectRoot?: string | null;
    },
  ) => Promise<unknown>;
  toggleAgentSkill: (agentId: string, name: string, action: "enable" | "disable" | "auto") => Promise<unknown>;
  isAgentBusy: (agentId: string) => boolean;
};

const VERIFY_TIMEOUT_MS = 120_000;
const JOB_VERIFY_TIMEOUT_MS = 600_000;
const REVIEW_WAIT_MS = 30 * 60 * 1000;
const REVIEW_POLL_MS = 2_000;
const ACTIVE: ReadonlySet<LoopStatus> = new Set(["running", "paused", "awaiting_review"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) {
      fail();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        fail();
      },
      { once: true },
    );
  });
}

function rowView(row: AgentLoop, tasks: LoopTask[] = [], review: ReviewBoard = emptyReviewBoard()): LoopView {
  const config = parseLoopConfig(row.config);
  const state = parseLoopState(row.state);
  return loopViewOf({
    agentId: row.agentId,
    teamId: row.teamId,
    status: row.status,
    config,
    state,
    tasks,
    review,
  });
}

function readTasks(root: string | null): LoopTask[] {
  if (!root) return [];
  const path = join(root, "TASKS.md");
  if (!existsSync(path)) return [];
  try {
    return parseTasksMarkdown(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function writeTasks(root: string | null, tasks: LoopTask[]): void {
  if (!root) return;
  writeFileSync(join(root, "TASKS.md"), tasksToMarkdown(tasks), "utf8");
}

function reviewPath(root: string | null): string | null {
  return root ? join(root, "REVIEW.md") : null;
}

function readReview(root: string | null): ReviewBoard {
  const path = reviewPath(root);
  if (!path || !existsSync(path)) return emptyReviewBoard();
  try {
    return parseReviewMarkdown(readFileSync(path, "utf8"));
  } catch {
    return emptyReviewBoard();
  }
}

function writeReview(root: string | null, board: ReviewBoard): void {
  const path = reviewPath(root);
  if (!path) return;
  writeFileSync(path, reviewBoardToMarkdown(board), "utf8");
}

function markerPathText(root: string | null, spec: string): string {
  if (!root) return "";
  const file = spec.includes(".md") ? spec : "TASKS.md";
  const path = join(root, file);
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function clearCompletionMarker(root: string | null, config: LoopConfig): void {
  if (!root || config.doneWhen.kind === "exit-0") return;
  const marker = config.doneWhen.kind === "file-contains" ? config.doneWhen.spec : "## DONE";
  const path = join(root, marker.includes(".md") ? marker : "TASKS.md");
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = before.split(/(\r?\n)/).map((line) =>
    line.trim() === (marker || "## DONE") || line.trim() === "ALL_COMPLETE" ? "" : line,
  ).join("");
  if (after !== before) writeFileSync(path, after, "utf8");
}

function usableRoot(projectRoot: string | null | undefined, agentId: string): string | null {
  if (projectRoot && !inspectProjectRoot(projectRoot)) return projectRoot;
  return scratchDirFor(agentId);
}

function worktreePathFor(root: string, agentId: string, agentName: string): { path: string; branch: string } {
  const short = agentId.slice(0, 8);
  const slug = agentName.replace(/[^\w.-]+/g, "-").slice(0, 24) || "agent";
  return {
    path: join(dirname(root), `${basename(root)}-loop-${short}`),
    branch: `loop/${slug}-${short}`,
  };
}

export class LoopManager {
  private readonly verifying = new Set<string>();
  private readonly reviewWaits = new Map<string, AbortController>();
  private readonly reviewWaitMs: number;
  private readonly reviewPollMs: number;

  constructor(
    private readonly jobs: JobManager,
    private readonly hub: WSHub,
    private readonly host: LoopHost,
    timings?: { reviewWaitMs?: number; reviewPollMs?: number },
  ) {
    ensureLoopSkills();
    this.reviewWaitMs = timings?.reviewWaitMs ?? REVIEW_WAIT_MS;
    this.reviewPollMs = timings?.reviewPollMs ?? REVIEW_POLL_MS;
  }

  view(agentId: string): LoopView | null {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row) return null;
    const config = parseLoopConfig(row.config);
    const root = config.boardRoot ?? this.agentRoot(agentId);
    return rowView(row, readTasks(root), readReview(root));
  }

  listActive(): LoopView[] {
    return prisma.agentLoop
      .findMany()
      .filter((row) => ACTIVE.has(row.status))
      .map((row) => {
        const config = parseLoopConfig(row.config);
        const root = config.boardRoot ?? this.agentRoot(row.agentId);
        return rowView(row, readTasks(root), readReview(root));
      });
  }

  suggest(agentId: string) {
    return prefillLoopFromProject(this.agentRoot(agentId));
  }

  async start(agentId: string, raw: unknown): Promise<LoopView> {
    const agent = prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new LoopConfigError("LOOP_AGENT_NOT_FOUND", "agent not found");
    const existing = prisma.agentLoop.findUnique({ where: { agentId } });
    if (existing && ACTIVE.has(existing.status)) {
      throw new LoopConfigError("LOOP_ALREADY_RUNNING", "this agent already has an active loop");
    }
    const config = parseLoopConfig(raw);
    const root = usableRoot(agent.projectRoot, agentId);
    config.boardRoot = config.boardRoot ?? root;
    if (config.recipe) {
      await this.host.toggleAgentSkill(agentId, loopSkillName(config.recipe), "enable");
    }
    if (config.worktree && root) {
      const wt = worktreePathFor(root, agentId, agent.name);
      const added = await addLoopWorktree(root, wt.path, wt.branch);
      if (added.ok) {
        await this.host.patchAgent(agentId, { projectRoot: added.path });
      }
    }
    if (config.permissionBump === "acceptEdits" || config.permissionBump === "bypassPermissions") {
      const meta = (agent.metadata ?? {}) as Record<string, unknown>;
      config.previousPermissionMode = typeof meta.permissionMode === "string" ? meta.permissionMode : "default";
      const prevSandbox = typeof meta.sandboxMode === "string" ? meta.sandboxMode : null;
      const sandboxBump = prevSandbox === "read-only" ? ("workspace-write" as const) : null;
      if (sandboxBump) config.previousSandboxMode = prevSandbox;
      await this.host.patchAgent(agentId, {
        permissionMode: config.permissionBump as PermissionMode,
        ...(sandboxBump ? { sandboxMode: sandboxBump } : {}),
      });
    }
    const state = emptyLoopState();
    const row = this.upsert(agentId, {
      teamId: config.teamId ?? agent.teamId,
      status: "running",
      config,
      state,
    });
    const view = this.broadcast(row);
    const verifierLabel = config.verifier ? `${config.verifier.kind}:${config.verifier.spec}` : "none";
    await this.host.persistLoopNotice(
      agentId,
      `LOOP START · verifier=${verifierLabel} · session=${config.session} · snapshot=${config.snapshot}`,
    );
    void this.host.sendMessage(agentId, loopStartPrompt(config));
    return view;
  }

  async startTeam(teamId: string, raw: unknown, opts: { reviewerAgentId?: string; worktree?: boolean } = {}): Promise<LoopView[]> {
    const members = prisma.agent.findMany({ where: { teamId } }) as Agent[];
    if (members.length === 0) throw new LoopConfigError("LOOP_TEAM_EMPTY", "team has no members");
    const reviewer = opts.reviewerAgentId;
    const runners = members.filter((m) => m.id !== reviewer);
    if (runners.length === 0) throw new LoopConfigError("LOOP_TEAM_EMPTY", "team has no runners");
    const views: LoopView[] = [];
    for (const runner of runners) {
      const body = {
        ...(typeof raw === "object" && raw ? raw : {}),
        teamId,
        reviewerAgentId: reviewer,
        worktree: opts.worktree === true,
        doneWhen: reviewer ? { kind: "peer-lgtm", spec: "LGTM" } : undefined,
      };
      views.push(await this.start(runner.id, body));
    }
    return views;
  }

  async stop(agentId: string): Promise<LoopView | null> {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row) return null;
    this.abortReviewWait(agentId);
    const config = parseLoopConfig(row.config);
    await this.restorePermission(agentId, config);
    const next = this.upsert(agentId, { status: "done", config, state: parseLoopState(row.state) });
    await this.host.persistLoopNotice(agentId, "LOOP STOP");
    return this.broadcast(next);
  }

  async pause(agentId: string): Promise<LoopView | null> {
    this.abortReviewWait(agentId);
    return this.setStatus(agentId, "paused", "LOOP PAUSED");
  }

  async resume(agentId: string): Promise<LoopView | null> {
    this.abortReviewWait(agentId);
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row) return null;
    const config = parseLoopConfig(row.config);
    const state = parseLoopState(row.state);
    state.consecutiveFails = 0;
    const spent = state.iter >= config.maxIterations;
    if (spent) {
      state.iterations = [
        ...state.iterations,
        {
          n: 1,
          result: "skip" as const,
          summary: `manual resume: iteration counter reset (was ${state.iter}/${config.maxIterations})`,
          snapshot: null,
        },
      ].slice(-LOOP_ITERATION_LOG_CAP);
      state.iter = 1;
      state.innerTurns = 0;
    }
    const next = this.upsert(agentId, { status: "running", config, state });
    this.broadcast(next);
    await this.host.persistLoopNotice(
      agentId,
      spent ? `LOOP RESUME · iter 1/${config.maxIterations} (budget was spent)` : "LOOP RESUME",
    );
    void this.host.sendMessage(agentId, loopStartPrompt(config));
    return this.view(agentId);
  }

  async patch(
    agentId: string,
    raw: {
      doneWhen?: unknown;
      maxIterations?: number;
      resetAttempts?: boolean;
    },
  ): Promise<LoopView | null> {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row) return null;
    const base = parseLoopConfig(row.config);
    const config = parseLoopConfig({
      ...(row.config as object),
      ...(raw.doneWhen !== undefined ? { doneWhen: raw.doneWhen } : {}),
      ...(raw.maxIterations !== undefined ? { maxIterations: raw.maxIterations } : {}),
      verifier: base.verifier,
      goal: base.goal,
    });
    const state = parseLoopState(row.state);
    // Explicit "clear the counter" from the UI/slash path. Distinct from
    // resume: it does not kick a turn, it only re-arms the budget.
    if (raw.resetAttempts) {
      const was = state.iter;
      state.iter = 1;
      state.innerTurns = 0;
      state.consecutiveFails = 0;
      state.iterations = [
        ...state.iterations,
        {
          n: 1,
          result: "skip" as const,
          summary: `iteration counter reset by user (was ${was}/${config.maxIterations})`,
          snapshot: null,
        },
      ].slice(-LOOP_ITERATION_LOG_CAP);
    }
    const next = this.upsert(agentId, { status: row.status, config, state });
    return this.broadcast(next);
  }

  async writeBoard(agentId: string, tasks: LoopTask[]): Promise<LoopView | null> {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row) return null;
    const config = parseLoopConfig(row.config);
    writeTasks(config.boardRoot ?? this.agentRoot(agentId), tasks);
    return this.broadcast(row);
  }

  async verifyNow(agentId: string): Promise<LoopView | null> {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row) return null;
    const result = await this.runVerifier(agentId, parseLoopConfig(row.config));
    await this.host.persistLoopNotice(
      agentId,
      result.ok ? `VERIFY OK · ${result.summary}` : `VERIFY FAIL · ${result.summary}`,
    );
    const config = parseLoopConfig(row.config);
    const state = parseLoopState(row.state);
    state.lastVerifyOk = result.ok;
    state.lastVerifySummary = result.summary;
    const next = this.upsert(agentId, { status: row.status, config, state });
    return this.broadcast(next);
  }

  statusLines(agentId: string): string[] {
    const view = this.view(agentId);
    return view ? formatLoopStatusLines(view) : [];
  }

  async onTurnSettled(agentId: string, opts: { lastText: string }): Promise<{ userInput: string } | null> {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row || row.status === "done" || row.status === "failed" || row.status === "idle") return null;
    if (row.status === "paused" || row.status === "awaiting_review") return null;
    if (this.verifying.has(agentId)) return null;

    const config = parseLoopConfig(row.config);

    this.verifying.add(agentId);
    try {
      const state = parseLoopState(row.state);
      state.innerTurns += 1;
      const root = config.boardRoot ?? this.agentRoot(agentId);
      const marker = config.doneWhen.kind === "file-contains" ? config.doneWhen.spec : "## DONE";
      const board = markerPathText(root, marker || "TASKS.md");
      const markerHit = fileMarkerHit(board, marker);
      const ready = config.doneWhen.kind === "exit-0" || markerHit;
      const verify = ready
        ? await this.runVerifier(agentId, config)
        : { ok: true, summary: "Work in progress; completion check not run" };
      state.lastVerifyOk = ready ? verify.ok : null;
      state.lastVerifySummary = verify.summary;

      const git = root ? await readGitState(root).catch(() => null) : null;
      const workspace = git?.state === "ok" && git.root
        ? await loopWorkspaceFingerprint(git.root, git.head)
        : null;
      // Unknown repository state is not evidence of a stall. Outside git, the
      // board is the observable progress record that the loop asks to maintain.
      const observable = git?.state === "not-a-repo" || workspace !== null;
      const fingerprint = observable
        ? createHash("sha256").update(board).update(workspace ?? "").digest("hex")
        : null;
      const hasDiff = fingerprint === null || state.lastProgressFingerprint === null || fingerprint !== state.lastProgressFingerprint;
      state.lastProgressFingerprint = fingerprint;
      state.lastDoneCount = readTasks(root).filter((task) => task.done).length;
      if (!hasDiff && (!ready || !verify.ok)) state.consecutiveFails += 1;
      else state.consecutiveFails = 0;
      const decision = decideLoopAfterVerify({
        config,
        state,
        verifyOk: verify.ok,
        summary: verify.summary,
        markerHit,
        hasDiff,
      });
      if (decision.action === "awaiting_review") state.lastRunnerSummary = opts.lastText;
      return await this.applyDecision(agentId, config, state, decision, verify.ok);
    } finally {
      this.verifying.delete(agentId);
    }
  }

  private abortReviewWait(agentId: string): void {
    const ctrl = this.reviewWaits.get(agentId);
    if (!ctrl) return;
    ctrl.abort();
    this.reviewWaits.delete(agentId);
  }

  private startReviewWait(agentId: string): void {
    this.abortReviewWait(agentId);
    const ctrl = new AbortController();
    this.reviewWaits.set(agentId, ctrl);
    void this.runReviewWait(agentId, ctrl.signal).finally(() => {
      if (this.reviewWaits.get(agentId) === ctrl) this.reviewWaits.delete(agentId);
    });
  }

  private async runReviewWait(agentId: string, signal: AbortSignal): Promise<void> {
    let lastFingerprint = "";
    let lastChange = Date.now();
    try {
      while (!signal.aborted) {
        const row = prisma.agentLoop.findUnique({ where: { agentId } });
        if (!row || row.status !== "awaiting_review") return;
        const config = parseLoopConfig(row.config);
        const root = config.boardRoot ?? this.agentRoot(agentId);
        const board = readReview(root);
        const fingerprint = createHash("sha256").update(reviewBoardToMarkdown(board)).digest("hex");
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          lastChange = Date.now();
        }
        const tick = await this.tickReviewBoard(agentId, board);
        if (tick === "done" || tick === "paused") return;
        const reviewerId = config.reviewerAgentId;
        const expected = nextReviewActor(board);
        const expectedId = expected === "reviewer" ? reviewerId : expected === "developer" ? agentId : null;
        const busy = Boolean(expectedId && this.host.isAgentBusy(expectedId));
        if (!busy && Date.now() - lastChange >= this.reviewWaitMs) {
          const minutes = Math.max(1, Math.round(this.reviewWaitMs / 60_000));
          await this.noticeBoth(agentId, reviewerId, `LOOP PAUSED · 审阅黑板 ${minutes} 分钟无进展`);
          const paused = this.upsert(agentId, {
            status: "paused",
            config,
            state: parseLoopState(row.state),
          });
          this.broadcast(paused);
          return;
        }
        await sleep(this.reviewPollMs, signal);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      throw err;
    }
  }

  private async tickReviewBoard(agentId: string, board: ReviewBoard): Promise<"continue" | "done" | "paused"> {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row || row.status !== "awaiting_review") return "paused";
    const config = parseLoopConfig(row.config);
    const state = parseLoopState(row.state);
    if (reviewBoardApproved(board)) {
      const decision: LoopDecision = { action: "done", summary: "review board LGTM" };
      await this.applyDecision(agentId, config, state, decision, true);
      return "done";
    }
    return "continue";
  }

  reviewPromptFor(agentId: string): string {
    const blocks: string[] = [];
    const own = prisma.agentLoop.findUnique({ where: { agentId } });
    if (own && ACTIVE.has(own.status) && parseLoopConfig(own.config).reviewerAgentId) {
      blocks.push(this.formatReviewPromptBlock(own, "developer"));
    }
    const reviewed = prisma.agentLoop.findMany().filter((row) => {
      if (row.agentId === agentId || !ACTIVE.has(row.status)) return false;
      return parseLoopConfig(row.config).reviewerAgentId === agentId;
    });
    for (const row of reviewed) {
      blocks.push(this.formatReviewPromptBlock(row, "reviewer"));
    }
    return blocks.join("\n\n");
  }

  private formatReviewPromptBlock(row: AgentLoop, role: ReviewRole): string {
    const config = parseLoopConfig(row.config);
    const runner = prisma.agent.findUnique({ where: { id: row.agentId } });
    const root = config.boardRoot ?? this.agentRoot(row.agentId);
    const board = readReview(root);
    const open = board.items.filter((item) => item.status === "open");
    const lines = [
      "─── LOOP REVIEW BOARD ───",
      `You are the ${role} (runner: ${runner?.name ?? row.agentId}).`,
      `Loop status: ${row.status}`,
      `Goal: ${config.goal.trim()}`,
      "Do NOT peer_send to exchange this review. Use loop_review. Chat LGTM does not finish the loop.",
    ];
    if (row.status !== "awaiting_review") {
      lines.push("The board opens after ## DONE. Until then keep working TASKS.md.");
      return lines.join("\n");
    }
    if (role === "reviewer") {
      lines.push("Actions: loop_review read / post / reply / resolve / lgtm. lgtm only when every item is resolved (or there are none).");
    } else {
      lines.push("Actions: loop_review read, fix the work, then reply under each open item.");
    }
    lines.push(`Open items: ${open.length}/${board.items.length}`);
    for (const item of open) {
      lines.push(`- ${item.id} ${item.title}`);
    }
    return lines.join("\n");
  }

  async useReviewTool(fromAgentId: string, args: LoopReviewArgs): Promise<string> {
    const found = this.resolveReviewTarget(fromAgentId, args.runner);
    if (!found) {
      const reviewed = prisma.agentLoop.findMany().filter((row) => {
        if (!ACTIVE.has(row.status)) return false;
        return parseLoopConfig(row.config).reviewerAgentId === fromAgentId;
      });
      if (reviewed.length > 1) {
        const names = reviewed.map((row) => {
          const name = prisma.agent.findUnique({ where: { id: row.agentId } })?.name ?? row.agentId;
          return `${name} (${row.agentId})`;
        });
        return `error: pass runner as a name or UUID. Active boards: ${names.join(", ")}`;
      }
      return "error: no active LOOP review board for you (start a loop, or wait until you are the selected reviewer)";
    }
    const { row, role } = found;
    const config = parseLoopConfig(row.config);
    const root = config.boardRoot ?? this.agentRoot(row.agentId);
    if (args.action === "read") {
      return this.formatReviewRead(row, role, root);
    }
    if (row.status !== "awaiting_review") {
      return "error: the review board is only writable while the loop is awaiting review";
    }
    const prev = readReview(root);
    const applied = applyReviewAction(prev, role, {
      action: args.action,
      itemId: args.itemId,
      title: args.title,
      text: args.text,
    });
    if (!applied.ok) return `error: ${applied.error}`;
    writeReview(root, applied.board);
    this.broadcast(row);
    const notices = reviewBoardNotices(prev, applied.board);
    for (const notice of notices) {
      await this.noticeBoth(row.agentId, config.reviewerAgentId, notice);
    }
    if (row.status === "awaiting_review") {
      await this.tickReviewBoard(row.agentId, applied.board);
    }
    return this.formatReviewRead(row, role, root);
  }

  private resolveReviewTarget(
    fromAgentId: string,
    runner?: string,
  ): { row: AgentLoop; role: ReviewRole } | null {
    const wanted = (runner ?? "").trim().toLowerCase();
    const own = prisma.agentLoop.findUnique({ where: { agentId: fromAgentId } });
    if (own && ACTIVE.has(own.status) && !wanted) {
      return { row: own, role: "developer" };
    }
    const reviewed = prisma.agentLoop.findMany().filter((row) => {
      if (!ACTIVE.has(row.status)) return false;
      return parseLoopConfig(row.config).reviewerAgentId === fromAgentId;
    });
    if (wanted) {
      const hit = reviewed.find((row) => {
        if (row.agentId.toLowerCase() === wanted) return true;
        const agent = prisma.agent.findUnique({ where: { id: row.agentId } });
        return agent?.name.toLowerCase() === wanted;
      });
      if (hit) return { row: hit, role: "reviewer" };
      if (own && ACTIVE.has(own.status) && (own.agentId.toLowerCase() === wanted || prisma.agent.findUnique({ where: { id: own.agentId } })?.name.toLowerCase() === wanted)) {
        return { row: own, role: "developer" };
      }
      return null;
    }
    if (reviewed.length === 1) return { row: reviewed[0]!, role: "reviewer" };
    if (reviewed.length > 1) return null;
    return null;
  }

  private formatReviewRead(row: AgentLoop, role: ReviewRole, root: string | null): string {
    const config = parseLoopConfig(row.config);
    const runner = prisma.agent.findUnique({ where: { id: row.agentId } });
    const board = readReview(root);
    const tasks = markerPathText(root, "TASKS.md").trim() || "(empty)";
    const open = board.items.filter((item) => item.status === "open").length;
    const lines = [
      `role: ${role}`,
      `runner: ${runner?.name ?? row.agentId} (${row.agentId})`,
      `loop: ${row.status}`,
      `goal:\n${config.goal}`,
      root ? `boardRoot: ${root}` : "boardRoot: (none)",
      `openItems: ${open}/${board.items.length}`,
      "",
      "TASKS.md:",
      tasks,
      "",
      "REVIEW.md:",
      reviewBoardToMarkdown(board).trimEnd(),
    ];
    if (role === "reviewer") {
      const others = prisma.agentLoop.findMany().filter((other) => {
        if (other.id === row.id || !ACTIVE.has(other.status)) return false;
        return parseLoopConfig(other.config).reviewerAgentId === config.reviewerAgentId;
      });
      if (others.length > 0) {
        lines.push("", "other runners on loops you review:");
        for (const other of others) {
          const name = prisma.agent.findUnique({ where: { id: other.agentId } })?.name ?? other.agentId;
          lines.push(`- ${name} (${other.agentId}) status=${other.status}`);
        }
      }
    }
    return lines.join("\n");
  }

  private async noticeBoth(runnerId: string, reviewerId: string | undefined, text: string): Promise<void> {
    await this.host.persistLoopNotice(runnerId, text);
    if (reviewerId && reviewerId !== runnerId) {
      await this.host.persistLoopNotice(reviewerId, text);
    }
  }

  private async applyDecision(
    agentId: string,
    config: LoopConfig,
    state: LoopState,
    decision: LoopDecision,
    verifyOk: boolean,
  ): Promise<{ userInput: string } | null> {
    const pushIter = (result: "pass" | "fail" | "skip" | "progress", summary: string, snapshot?: string | null) => {
      state.iterations = [
        ...state.iterations,
        { n: state.iter, result, summary, snapshot: snapshot ?? null },
      ].slice(-LOOP_ITERATION_LOG_CAP);
    };

    if (decision.action === "pause") {
      this.abortReviewWait(agentId);
      if (!verifyOk) clearCompletionMarker(config.boardRoot ?? this.agentRoot(agentId), config);
      pushIter("fail", decision.reason);
      const next = this.upsert(agentId, { status: "paused", config, state });
      this.broadcast(next);
      await this.host.persistLoopNotice(agentId, `LOOP PAUSED · ${decision.reason}`);
      return null;
    }

    if (decision.action === "awaiting_review") {
      const root = config.boardRoot ?? this.agentRoot(agentId);
      writeReview(root, emptyReviewBoard());
      const next = this.upsert(agentId, { status: "awaiting_review", config, state });
      this.broadcast(next);
      const minutes = Math.max(1, Math.round(this.reviewWaitMs / 60_000));
      await this.noticeBoth(
        agentId,
        config.reviewerAgentId,
        `LOOP 已送审，请在审阅黑板上记录（空闲最多 ${minutes} 分钟）`,
      );
      this.startReviewWait(agentId);
      return null;
    }

    if (decision.action === "review-reject") {
      clearCompletionMarker(config.boardRoot ?? this.agentRoot(agentId), config);
      pushIter("fail", decision.userInput);
      if (state.iter >= config.maxIterations) {
        pushIter("fail", `iteration cap ${config.maxIterations} reached`);
        const paused = this.upsert(agentId, { status: "paused", config, state });
        this.broadcast(paused);
        await this.host.persistLoopNotice(agentId, `LOOP PAUSED · iteration cap ${config.maxIterations} reached`);
        return null;
      }
      state.iter += 1;
      state.innerTurns = 0;
      const next = this.upsert(agentId, { status: "running", config, state });
      this.broadcast(next);
      if (config.session === "fresh-disk") await this.host.resetRuntimeSession(agentId);
      await this.host.persistLoopNotice(
        agentId,
        `LOOP iter ${state.iter}/${config.maxIterations} · reviewer rejected`,
      );
      return { userInput: decision.userInput };
    }

    if (decision.action === "outer-iter") {
      clearCompletionMarker(config.boardRoot ?? this.agentRoot(agentId), config);
      let snapshot: string | null = state.lastSnapshot;
      if (config.snapshot === "git-commit") {
        const root = config.boardRoot ?? this.agentRoot(agentId);
        if (root) {
          const agent = prisma.agent.findUnique({ where: { id: agentId } });
          const committed = await commitLoopSnapshot(root, `loop(${agent?.name ?? agentId.slice(0, 8)}): iter ${state.iter}`);
          if (committed.ok) snapshot = committed.sha;
        }
      }
      pushIter(decision.result, state.lastVerifySummary || decision.userInput, snapshot);
      state.iter += 1;
      state.innerTurns = 0;
      state.lastSnapshot = snapshot;
      const next = this.upsert(agentId, { status: "running", config, state });
      this.broadcast(next);
      if (decision.resetRuntime) await this.host.resetRuntimeSession(agentId);
      const failBit = !verifyOk ? `VERIFY FAIL · ` : "";
      await this.host.persistLoopNotice(
        agentId,
        `${failBit}LOOP iter ${state.iter}/${config.maxIterations}`,
      );
      return { userInput: decision.userInput };
    }

    if (decision.action === "done") {
      this.abortReviewWait(agentId);
      let snapshot: string | null = state.lastSnapshot;
      if (config.snapshot === "git-commit") {
        const root = config.boardRoot ?? this.agentRoot(agentId);
        if (root) {
          const agent = prisma.agent.findUnique({ where: { id: agentId } });
          const committed = await commitLoopSnapshot(root, `loop(${agent?.name ?? agentId.slice(0, 8)}): done`);
          if (committed.ok) snapshot = committed.sha;
        }
      }
      pushIter(verifyOk ? "pass" : "skip", decision.summary, snapshot);
      state.lastSnapshot = snapshot;
      await this.restorePermission(agentId, config);
      const next = this.upsert(agentId, { status: "done", config, state });
      this.broadcast(next);
      await this.host.persistLoopNotice(
        agentId,
        `LOOP DONE · ${state.iter} iterations · snapshot ${snapshot ?? "none"}\n${decision.summary}`,
      );
      return null;
    }

    return null;
  }

  private async runVerifier(
    agentId: string,
    config: LoopConfig,
  ): Promise<{ ok: boolean; summary: string }> {
    if (!config.verifier) return { ok: true, summary: "no command verifier" };
    if (config.verifier.kind === "file-marker") {
      const text = markerPathText(config.boardRoot ?? this.agentRoot(agentId), config.verifier.spec);
      const ok = fileMarkerHit(text, config.verifier.spec);
      return { ok, summary: ok ? "file marker present" : `missing ${config.verifier.spec}` };
    }
    const agent = prisma.agent.findUnique({ where: { id: agentId } });
    const cwd = config.boardRoot ?? usableRoot(agent?.projectRoot ?? null, agentId) ?? process.cwd();
    const timeoutMs = config.verifier.kind === "job" ? JOB_VERIFY_TIMEOUT_MS : VERIFY_TIMEOUT_MS;
    const view = this.jobs.start({
      agentId,
      agentName: agent?.name ?? "loop",
      command: config.verifier.spec,
      cwd,
      timeoutMs,
    });
    const done = await this.jobs.wait(view.id, timeoutMs);
    const ok = done?.status === "exited" && done.exitCode === 0;
    const tail = done?.logPath ? readTail(done.logPath, 8_192) : done?.tail ?? "";
    const lines = tail.trim().split(/\r?\n/).slice(-40).join("\n");
    return {
      ok: !!ok,
      summary: lines || `${done?.status ?? "unknown"} exit ${done?.exitCode ?? "?"}`,
    };
  }

  private async restorePermission(agentId: string, config: LoopConfig): Promise<void> {
    if (!config.previousPermissionMode && !config.previousSandboxMode) return;
    await this.host.patchAgent(agentId, {
      ...(config.previousPermissionMode
        ? { permissionMode: config.previousPermissionMode as PermissionMode }
        : {}),
      ...(config.previousSandboxMode
        ? { sandboxMode: config.previousSandboxMode as SandboxMode }
        : {}),
    });
  }

  private upsert(
    agentId: string,
    input: { teamId?: string | null; status: AgentLoopStatus; config: LoopConfig; state: LoopState },
  ): AgentLoop {
    const existing = prisma.agentLoop.findUnique({ where: { agentId } });
    if (existing) {
      return prisma.agentLoop.update({
        where: { id: existing.id },
        data: {
          teamId: input.teamId ?? existing.teamId,
          status: input.status,
          config: input.config,
          state: input.state,
        },
      });
    }
    return prisma.agentLoop.create({
      data: {
        agentId,
        teamId: input.teamId ?? null,
        status: input.status,
        config: input.config,
        state: input.state,
      },
    });
  }

  private broadcast(row: AgentLoop): LoopView {
    const config = parseLoopConfig(row.config);
    const root = config.boardRoot ?? this.agentRoot(row.agentId);
    const view = rowView(row, readTasks(root), readReview(root));
    this.hub.sendToSession(row.agentId, { type: "loop_update", sessionId: row.agentId, loop: view });
    if (row.teamId) {
      const members = prisma.agent.findMany({ where: { teamId: row.teamId } }) as Agent[];
      for (const m of members) {
        if (m.id === row.agentId) continue;
        this.hub.sendToSession(m.id, { type: "loop_update", sessionId: row.agentId, loop: view });
      }
    }
    return view;
  }

  private agentRoot(agentId: string): string | null {
    const agent = prisma.agent.findUnique({ where: { id: agentId } });
    return usableRoot(agent?.projectRoot ?? null, agentId);
  }

  private async setStatus(agentId: string, status: AgentLoopStatus, notice: string): Promise<LoopView | null> {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row) return null;
    const next = this.upsert(agentId, {
      status,
      config: parseLoopConfig(row.config),
      state: parseLoopState(row.state),
    });
    await this.host.persistLoopNotice(agentId, notice);
    return this.broadcast(next);
  }
}

export { LoopConfigError };
