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
  parseTasksMarkdown,
  tasksToMarkdown,
  type LoopConfig,
  type LoopDecision,
  type LoopState,
  type LoopStatus,
  type LoopTask,
  type LoopView,
} from "@agentorch/shared";
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
  sendPeerMessage: (
    fromAgentId: string,
    target: string,
    body: string,
    mode: "review",
  ) => Promise<string>;
  toggleAgentSkill: (agentId: string, name: string, action: "enable" | "disable" | "auto") => Promise<unknown>;
};

const VERIFY_TIMEOUT_MS = 120_000;
const JOB_VERIFY_TIMEOUT_MS = 600_000;
const ACTIVE: ReadonlySet<LoopStatus> = new Set(["running", "paused", "awaiting_review"]);

function rowView(row: AgentLoop, tasks: LoopTask[] = []): LoopView {
  const config = parseLoopConfig(row.config);
  const state = parseLoopState(row.state);
  return loopViewOf({
    agentId: row.agentId,
    teamId: row.teamId,
    status: row.status,
    config,
    state,
    tasks,
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

  constructor(
    private readonly jobs: JobManager,
    private readonly hub: WSHub,
    private readonly host: LoopHost,
  ) {
    ensureLoopSkills();
  }

  view(agentId: string): LoopView | null {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row) return null;
    const config = parseLoopConfig(row.config);
    return rowView(row, readTasks(config.boardRoot ?? this.agentRoot(agentId)));
  }

  listActive(): LoopView[] {
    return prisma.agentLoop
      .findMany()
      .filter((row) => ACTIVE.has(row.status))
      .map((row) => {
        const config = parseLoopConfig(row.config);
        return rowView(row, readTasks(config.boardRoot ?? this.agentRoot(row.agentId)));
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
    const config = parseLoopConfig(row.config);
    await this.restorePermission(agentId, config);
    const next = this.upsert(agentId, { status: "done", config, state: parseLoopState(row.state) });
    await this.host.persistLoopNotice(agentId, "LOOP STOP");
    return this.broadcast(next);
  }

  async pause(agentId: string): Promise<LoopView | null> {
    return this.setStatus(agentId, "paused", "LOOP PAUSED");
  }

  async resume(agentId: string): Promise<LoopView | null> {
    const row = prisma.agentLoop.findUnique({ where: { agentId } });
    if (!row) return null;
    const config = parseLoopConfig(row.config);
    const state = parseLoopState(row.state);
    // Resume keeps the informational turn count within the same attempt.
    state.consecutiveFails = 0;
    // The attempt cap is a safety valve, not a verdict: a human clicking
    // "resume" outranks it. Resuming an already-exhausted budget would leave
    // the chip at 10/10 and pause again on the next failed attempt, so refill
    // the counter and record that a human did it.
    const spent = state.iter >= config.maxIterations;
    if (spent) {
      state.iterations = [
        ...state.iterations,
        {
          n: 1,
          result: "skip" as const,
          summary: `manual resume: attempt counter reset (was ${state.iter}/${config.maxIterations})`,
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
      spent ? `LOOP RESUME · attempt 1/${config.maxIterations} (budget was spent)` : "LOOP RESUME",
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
          summary: `attempt counter reset by user (was ${was}/${config.maxIterations})`,
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
    await this.finishReview(agentId, opts.lastText);
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
      return await this.applyDecision(agentId, config, state, decision, verify.ok);
    } finally {
      this.verifying.delete(agentId);
    }
  }

  private async finishReview(reviewerId: string, lastText: string): Promise<void> {
    const runners = prisma.agentLoop.findMany().filter((row) => {
      if (row.status !== "awaiting_review") return false;
      try {
        return parseLoopConfig(row.config).reviewerAgentId === reviewerId;
      } catch {
        return false;
      }
    });
    for (const row of runners) {
      const config = parseLoopConfig(row.config);
      const state = parseLoopState(row.state);
      const decision = decideLoopAfterVerify({
        config,
        state,
        verifyOk: true,
        summary: lastText,
        markerHit: true,
        hasDiff: true,
        reviewText: lastText,
      });
      const cont = await this.applyDecision(row.agentId, config, state, decision, true);
      if (cont) void this.host.sendMessage(row.agentId, cont.userInput);
    }
  }

  private async applyDecision(
    agentId: string,
    config: LoopConfig,
    state: LoopState,
    decision: LoopDecision,
    verifyOk: boolean,
  ): Promise<{ userInput: string } | null> {
    const pushIter = (result: "pass" | "fail" | "skip", summary: string, snapshot?: string | null) => {
      state.iterations = [
        ...state.iterations,
        { n: state.iter, result, summary, snapshot: snapshot ?? null },
      ].slice(-LOOP_ITERATION_LOG_CAP);
    };

    if (decision.action === "continue") {
      const next = this.upsert(agentId, { status: "running", config, state });
      this.broadcast(next);
      if (!verifyOk) {
        // A green verifier on the "not finished yet" path is not a failure; it
        // used to be announced as VERIFY FAIL, which read as a contradiction.
        await this.host.persistLoopNotice(
          agentId,
          `VERIFY FAIL · iter ${state.iter} · consecutive ${state.consecutiveFails}/${LOOP_CONSECUTIVE_FAIL_LIMIT}\n${state.lastVerifySummary}`,
        );
      }
      return { userInput: decision.userInput };
    }

    if (decision.action === "pause") {
      if (!verifyOk) clearCompletionMarker(config.boardRoot ?? this.agentRoot(agentId), config);
      pushIter("fail", decision.reason);
      const next = this.upsert(agentId, { status: "paused", config, state });
      this.broadcast(next);
      await this.host.persistLoopNotice(agentId, `LOOP PAUSED · ${decision.reason}`);
      return null;
    }

    if (decision.action === "awaiting_review") {
      const next = this.upsert(agentId, { status: "awaiting_review", config, state });
      this.broadcast(next);
      if (config.reviewerAgentId) {
        await this.host.sendPeerMessage(agentId, config.reviewerAgentId, decision.userInput, "review");
      }
      await this.host.persistLoopNotice(agentId, "LOOP awaiting review");
      return null;
    }

    if (decision.action === "review-reject") {
      clearCompletionMarker(config.boardRoot ?? this.agentRoot(agentId), config);
      pushIter("fail", decision.userInput);
      // A rejected review is a finished attempt that FAILED: advance the
      // attempt budget here, not on every turn the reviewer has not replied.
      if (state.iter >= config.maxIterations) {
        pushIter("fail", `iteration cap ${config.maxIterations} reached`);
        const paused = this.upsert(agentId, { status: "paused", config, state });
        this.broadcast(paused);
        await this.host.persistLoopNotice(agentId, `LOOP PAUSED · iteration cap ${config.maxIterations} reached`);
        return null;
      }
      state.iter += 1;
      state.innerTurns = 0;
      state.consecutiveFails = 0;
      const next = this.upsert(agentId, { status: "running", config, state });
      this.broadcast(next);
      if (config.session === "fresh-disk") await this.host.resetRuntimeSession(agentId);
      await this.host.persistLoopNotice(
        agentId,
        `LOOP attempt ${state.iter}/${config.maxIterations} · reviewer rejected`,
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
      // `outer-iter` is only produced for a rejected full attempt now
      // (## DONE written, verifier still red), so the iteration log records a
      // failure and the notice says which attempt is starting.
      pushIter("fail", state.lastVerifySummary, snapshot);
      state.iter += 1;
      state.innerTurns = 0;
      state.consecutiveFails = 0;
      state.lastSnapshot = snapshot;
      const next = this.upsert(agentId, { status: "running", config, state });
      this.broadcast(next);
      if (decision.resetRuntime) await this.host.resetRuntimeSession(agentId);
      await this.host.persistLoopNotice(agentId, `LOOP attempt ${state.iter}/${config.maxIterations}`);
      return { userInput: decision.userInput };
    }

    if (decision.action === "done") {
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
    const view = rowView(row, readTasks(config.boardRoot ?? this.agentRoot(row.agentId)));
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
