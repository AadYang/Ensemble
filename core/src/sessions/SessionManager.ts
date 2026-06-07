import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { CanUseTool, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMessage } from "@agentorch/shared";
import { extractUsageEvents, buildMetaUsageEvent } from "../usage-extract.js";
import { chooseRuntime } from "./runtimes/index.js";
import type { RuntimeOptions } from "./runtimes/types.js";
import {
  makePeerMcpServer,
  makePeerSendHandler,
  makePeerQueryHandler,
  PEER_MCP_SERVER_NAME,
  PEER_SEND_TOOL_NAME,
  PEER_QUERY_TOOL_NAME,
} from "../peer-mcp.js";
import { makeHelpMcpServer, HELP_MCP_SERVER_NAME, ENSEMBLE_HELP_TOOL_NAME } from "../help-mcp.js";
import { buildEnsemblePrimer, formatEnsembleHelp } from "../help/index.js";
import {
  makeSkillMcpServer,
  SKILL_MCP_SERVER_NAME,
  SKILL_INVOKE_TOOL_NAME,
  SKILL_LIST_TOOL_NAME,
} from "../skill-mcp.js";
import {
  loadSkills,
  findSkill,
  pickActiveSkills,
  formatActiveSkills,
  formatSkillBody,
  readSkillBlocklist,
  readSkillForcelist,
} from "../skills/index.js";
import {
  makeAskUserMcpServer,
  makeAskUserHandler,
  ASK_USER_MCP_SERVER_NAME,
  ASK_USER_TOOL_NAME,
} from "../ask-user-mcp.js";
import type {
  AgentStatus as ProtoStatus,
  AgentSummary,
  PeerMode,
  PermissionDecision,
  PermissionMode,
  ReasoningEffort,
  SandboxMode,
} from "@agentorch/shared";
import { formatPeerHandoff } from "./peerHandoff.js";
import type { Agent as DbAgent } from "../db.js";
import { prisma } from "../db.js";
import type { WebSocket } from "@fastify/websocket";
import type { WSHub } from "../ws/hub.js";
import { getClaudeCliPath, getCodexCliPath } from "../cli-config.js";
import { ensureDataDir } from "../paths.js";
import { currentPlatformKey } from "../platform-key.js";

/** Stable cwd for the spawned claude CLI. The CLI scopes session files by
 * `~/.claude/projects/<encoded-cwd>/`, so if we let the CLI inherit our
 * sidecar's cwd, sessions become unfindable across reinstalls / launches
 * (Tauri's sidecar cwd may differ between runs). Pinning cwd to homedir
 * keeps sessions reachable for resume regardless of where the EXE lives. */
const STABLE_CWD = homedir();
const CODEX_DEFAULT_CWD = ensureDataDir();
const FIRST_MODEL_RESPONSE_TIMEOUT_MS = 60_000;
const TURN_COMPLETION_IDLE_TIMEOUT_MS = 60_000;

function isInternalSystemMessage(msg: unknown): boolean {
  return (
    msg !== null &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "system" &&
    (msg as { subtype?: unknown }).subtype === "thinking_tokens"
  );
}

function isTextDeltaStreamEvent(msg: unknown): boolean {
  if (!msg || typeof msg !== "object" || (msg as { type?: unknown }).type !== "stream_event") return false;
  const event = (msg as { event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } } }).event;
  return (
    event?.type === "content_block_delta" &&
    event.delta?.type === "text_delta" &&
    typeof event.delta.text === "string" &&
    event.delta.text.length > 0
  );
}

function assistantHasText(msg: unknown): boolean {
  if (!msg || typeof msg !== "object" || (msg as { type?: unknown }).type !== "assistant") return false;
  const blocks = (msg as { message?: { content?: Array<{ type?: unknown; text?: unknown }> } }).message?.content ?? [];
  return blocks.some((b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0);
}

function currentRuntimeFromProviderMeta(meta: unknown): { cliPath?: unknown; authPresent?: unknown } | null {
  if (!meta || typeof meta !== "object") return null;
  const runtimes = (meta as Record<string, unknown>).runtimes;
  if (!runtimes || typeof runtimes !== "object" || Array.isArray(runtimes)) return null;
  const runtime = (runtimes as Record<string, unknown>)[currentPlatformKey()];
  return runtime && typeof runtime === "object" ? runtime as { cliPath?: unknown; authPresent?: unknown } : null;
}

/** Locate the user-installed `claude` binary. The Agent SDK normally derives
 * its bundled cli.js from `import.meta.url`, but that's `undefined` in our
 * esbuild CJS bundle (SEA path) — so we hand the SDK an explicit path to a
 * native claude binary instead. The SDK detects native vs JS via extension
 * and spawns it directly, skipping the cli.js entry point entirely.
 *
 * Cached at module load so we don't shell out per send. Returns null when
 * the CLI isn't on PATH; sendMessage surfaces a friendly error if so. */
const LEGACY_CLAUDE_CLI_PATH: string | null = (() => {
  const cmd = process.platform === "win32" ? "where.exe claude" : "which claude";
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (first && existsSync(first)) return first;
  } catch {
    // not on PATH → fall through
  }
  return null;
})();

interface RunningSession {
  id: string;
  /** Unique per sendMessage invocation. Lets sendMessage's success/error/finally
   *  paths detect that `cancel()` already cleaned up state (entry removed) and
   *  skip their own DB updates — prevents a wedged-but-eventually-recovering
   *  runtime from overwriting the IDLE state cancel() force-set. */
  runId: string;
  abort: AbortController;
  seq: number;
  suspendCompletionIdleTimer?: () => void;
  /** Per-turn auto-allow cache, keyed by toolName. User clicking "Allow" on
   *  a permission dialog adds the tool name here; subsequent canUseTool calls
   *  with the same toolName during this turn skip the dialog. Cleared when
   *  the turn ends (running session destroyed in sendMessage's finally).
   *  Deny is NOT cached — the model gets per-call rejection feedback and may
   *  reasonably retry with different input. */
  autoAllowedTools: Set<string>;
}

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  toolName: string;
  input: Record<string, unknown>;
}

interface PendingUserQuestion {
  resolve: (choice: string) => void;
  question: string;
  options: string[];
}

interface ForceStopOptions {
  expectedRunId?: string;
  dbStatus: "IDLE" | "ERROR" | "DONE";
  protoStatus: "idle" | "error" | "done";
  error?: { code: string; message: string };
  logPrefix: string;
}

const dbToProto = (s: string): ProtoStatus => {
  switch (s) {
    case "IDLE": return "idle";
    case "RUNNING": return "running";
    case "AWAITING_PERMISSION": return "awaiting_permission";
    case "AWAITING_USER_INPUT": return "awaiting_user_input";
    case "ERROR": return "error";
    case "DONE": return "done";
    default: return "idle";
  }
};

const VALID_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
]);

export const readPermissionMode = (metadata: unknown): PermissionMode => {
  if (metadata && typeof metadata === "object" && "permissionMode" in metadata) {
    const m = (metadata as { permissionMode: unknown }).permissionMode;
    if (typeof m === "string" && VALID_PERMISSION_MODES.has(m as PermissionMode)) {
      return m as PermissionMode;
    }
  }
  return "default";
};

const VALID_SANDBOX_MODES: ReadonlySet<SandboxMode> = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

export const readSandboxOverride = (metadata: unknown): SandboxMode | null => {
  if (metadata && typeof metadata === "object" && "sandboxMode" in metadata) {
    const m = (metadata as { sandboxMode: unknown }).sandboxMode;
    if (typeof m === "string" && VALID_SANDBOX_MODES.has(m as SandboxMode)) {
      return m as SandboxMode;
    }
  }
  return null;
};

const VALID_REASONING_EFFORTS: ReadonlySet<ReasoningEffort> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const readReasoningEffortOverride = (metadata: unknown): ReasoningEffort | null => {
  if (metadata && typeof metadata === "object" && "reasoningEffort" in metadata) {
    const m = (metadata as { reasoningEffort: unknown }).reasoningEffort;
    if (typeof m === "string" && VALID_REASONING_EFFORTS.has(m as ReasoningEffort)) {
      return m as ReasoningEffort;
    }
  }
  return null;
};

const providerSupportsReasoningEffort = (kind: string | null | undefined): boolean =>
  kind === null ||
  kind === undefined ||
  kind === "anthropic-local" ||
  kind === "anthropic" ||
  kind === "openai-codex";

const readMetaString = (metadata: unknown, key: string): string | null => {
  if (metadata && typeof metadata === "object" && key in (metadata as object)) {
    const v = (metadata as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  }
  return null;
};

const readMetaBool = (metadata: unknown, key: string): boolean => {
  if (metadata && typeof metadata === "object" && key in (metadata as object)) {
    return Boolean((metadata as Record<string, unknown>)[key]);
  }
  return false;
};

const firstLine = (s: string): string => {
  const i = s.indexOf("\n");
  return (i < 0 ? s : s.slice(0, i)).trim();
};

const mergeMetadata = (cur: unknown, patch: Record<string, unknown>): object => {
  const base = (cur && typeof cur === "object" ? (cur as object) : {}) as Record<string, unknown>;
  return { ...base, ...patch };
};

const removeMetadataKeys = (cur: unknown, keys: string[]): object => {
  const base = (cur && typeof cur === "object" ? (cur as object) : {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...base };
  for (const key of keys) delete next[key];
  return next;
};

const normalizeCodexWorkspace = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error(`codexWorkspace must be an absolute path: ${trimmed}`);
  }
  if (!existsSync(trimmed)) {
    throw new Error(`codexWorkspace does not exist: ${trimmed}`);
  }
  if (!statSync(trimmed).isDirectory()) {
    throw new Error(`codexWorkspace must be a directory: ${trimmed}`);
  }
  return trimmed;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const agentRowToSummary = (row: DbAgent): AgentSummary => ({
  id: row.id,
  name: row.name,
  parentId: row.parentId,
  status: dbToProto(row.status),
  model: row.model,
  systemPrompt: row.systemPrompt,
  providerId: row.providerId,
  codexWorkspace: row.codexWorkspace,
  permissionMode: readPermissionMode(row.metadata),
  sandboxMode: readSandboxOverride(row.metadata),
  reasoningEffort: readReasoningEffortOverride(row.metadata),
  teamId: row.teamId,
  forcedSkills: Array.from(readSkillForcelist(row.metadata)),
  disabledSkills: Array.from(readSkillBlocklist(row.metadata)),
  closed: readMetaBool(row.metadata, "closed"),
  hasResumeInfo: readMetaString(row.metadata, "lastSessionId") !== null,
  createdAt: row.createdAt.toISOString(),
});

export class SessionManager {
  private running = new Map<string, RunningSession>();
  private pending = new Map<string, Map<string, PendingPermission>>();
  private pendingQuestions = new Map<string, Map<string, PendingUserQuestion>>();

  constructor(private hub: WSHub) {}

  async createAgent(opts: {
    name: string;
    systemPrompt?: string;
    model?: string;
    parentId?: string;
    providerId?: string;
    codexWorkspace?: string;
    teamId?: string | null;
  }) {
    // If caller didn't specify a provider, attach to the default one (creates anthropic-default
    // on first call). Keeps every agent self-describing about which provider runs it.
    let providerId = opts.providerId ?? null;
    if (!providerId) {
      const def = await prisma.provider.findFirst({
        where: { isDefault: true },
        orderBy: { createdAt: "asc" },
      });
      if (def) providerId = def.id;
    }
    const provider = providerId ? await prisma.provider.findUnique({ where: { id: providerId } }) : null;
    const codexWorkspace = normalizeCodexWorkspace(opts.codexWorkspace);
    if (codexWorkspace && provider?.kind !== "openai-codex") {
      throw new Error("codexWorkspace is only valid for openai-codex agents");
    }
    let teamId: string | null | undefined = opts.teamId;
    if (teamId) {
      const teamRow = await prisma.team.findUnique({ where: { id: teamId } });
      if (!teamRow) throw new Error(`team ${teamId} not found`);
    }
    const row = await prisma.agent.create({
      data: {
        name: opts.name,
        systemPrompt: opts.systemPrompt,
        model: opts.model ?? "claude-opus-4-7",
        parentId: opts.parentId,
        providerId,
        ...(codexWorkspace !== undefined ? { codexWorkspace } : {}),
        ...(teamId !== undefined ? { teamId } : {}),
      },
    });
    this.hub.broadcast({ type: "agent_created", agent: agentRowToSummary(row) });
    return row.id;
  }

  // W21 ───────────────────────────────────────────────────────────
  // Team CRUD. Teams are pure metadata + grouping; behavior lives in the
  // agents themselves. Deleting a team SET NULL on member agents (preserves
  // their data, they revert to ungrouped).
  // ────────────────────────────────────────────────────────────────

  async createTeam(opts: { name: string; description?: string }): Promise<string> {
    const row = await prisma.team.create({
      data: { name: opts.name, description: opts.description ?? null },
    });
    this.hub.broadcast({ type: "team_created", team: await this.teamSummary(row.id) });
    return row.id;
  }

  async patchTeam(id: string, patch: { name?: string; description?: string | null }): Promise<boolean> {
    const cur = await prisma.team.findUnique({ where: { id } });
    if (!cur) return false;
    const data: { name?: string; description?: string | null } = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (Object.keys(data).length === 0) return true;

    // Team name + description both flow into the TEAM CONTEXT block injected
    // into each member's systemPrompt. If we change either while a member has
    // a cached `lastSessionId`, the next turn resumes that session and the
    // CLI keeps using the OLD prompt — the edit appears to do nothing. Drop
    // resume pointers on every member so the next turn opens a fresh session.
    const nameChanged = patch.name !== undefined && patch.name !== cur.name;
    const descChanged = patch.description !== undefined && patch.description !== cur.description;
    await prisma.team.update({ where: { id }, data });
    if (nameChanged || descChanged) {
      const members = await prisma.agent.findMany({ where: { teamId: id } });
      for (const m of members) {
        if (readMetaString(m.metadata, "lastSessionId") === null) continue;
        const updated = await prisma.agent.update({
          where: { id: m.id },
          data: { metadata: removeMetadataKeys(m.metadata, ["lastSessionId"]) },
        });
        this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
      }
    }
    this.hub.broadcast({ type: "team_updated", team: await this.teamSummary(id) });
    return true;
  }

  async deleteTeam(id: string): Promise<boolean> {
    const cur = await prisma.team.findUnique({ where: { id } });
    if (!cur) return false;
    // SET NULL on members — preserves agents, they become ungrouped.
    const members = await prisma.agent.findMany({ where: { teamId: id } });
    for (const m of members) {
      await prisma.agent.update({ where: { id: m.id }, data: { teamId: null } });
      this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary({ ...m, teamId: null }) });
    }
    await prisma.team.delete({ where: { id } });
    this.hub.broadcast({ type: "team_deleted", teamId: id });
    return true;
  }

  async listTeams(): Promise<Awaited<ReturnType<typeof this.teamSummary>>[]> {
    const rows = await prisma.team.findMany({ orderBy: { createdAt: "asc" } });
    const out = [];
    for (const r of rows) out.push(await this.teamSummary(r.id));
    return out;
  }

  private async teamSummary(id: string) {
    const t = await prisma.team.findUnique({ where: { id } });
    if (!t) throw new Error(`team ${id} not found`);
    const members = await prisma.agent.findMany({
      where: { teamId: id },
      orderBy: { createdAt: "asc" },
    });
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      memberIds: members.map((m) => m.id),
      createdAt: t.createdAt.toISOString(),
    };
  }

  /** W21: produce the "TEAM CONTEXT" block injected into systemPrompt for
   *  team members. Returns empty when agent is ungrouped — caller falls back
   *  to the agent's plain systemPrompt.
   *
   *  CRITICAL FORMATTING DECISIONS (worked out the hard way):
   *  - The block must include the agent's own systemPrompt VERBATIM, not
   *    truncated. Earlier the role was a separate `base` section and team
   *    context only listed members with 80-char hints — the agent couldn't
   *    tie the two together.
   *  - The block must be IMPERATIVE: "you are X, do Y". Earlier wording
   *    ("you are part of team X. Members: ...") read as informational, and
   *    Claude Code's auto-loaded MEMORY.md (from ~/.claude/projects/<cwd>/)
   *    consistently outweighed it for "who am I + what am I doing".
   *  - Must explicitly tell the agent to ignore conflicting MEMORY context.
   *  - When this block is present, the caller MUST NOT also include the
   *    agent's bare systemPrompt — that creates two role declarations the
   *    model has to reconcile.
   */
  async buildTeamContext(agentId: string): Promise<string> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent?.teamId) return "";
    const team = await prisma.team.findUnique({ where: { id: agent.teamId } });
    if (!team) return "";
    const members = await prisma.agent.findMany({
      where: { teamId: agent.teamId },
      orderBy: { createdAt: "asc" },
    });
    const me = members.find((m) => m.id === agentId);
    const others = members.filter((m) => m.id !== agentId);

    const sep = "════════════════════════════════════════════════════════════";
    const lines: string[] = [];
    lines.push(sep);
    lines.push(`YOU ARE "${me?.name ?? agent.name}" — an agent on team "${team.name}".`);
    lines.push(sep);
    lines.push("");
    lines.push("This identity overrides any auto-loaded MEMORY.md / CLAUDE.md");
    lines.push("from your current working directory. Ignore project-memory");
    lines.push("references to unrelated projects when they conflict with the");
    lines.push("role / mission specified below.");
    lines.push("");

    if (me?.systemPrompt && me.systemPrompt.trim()) {
      lines.push("─── YOUR ROLE (verbatim from team setup) ───");
      lines.push("");
      lines.push(me.systemPrompt.trim());
      lines.push("");
    }

    if (team.description && team.description.trim()) {
      lines.push(`─── TEAM MISSION ("${team.name}") ───`);
      lines.push("");
      lines.push(team.description.trim());
      lines.push("");
    }

    if (others.length > 0) {
      lines.push("─── TEAMMATES (call them by name via peer_send / peer_query) ───");
      for (const m of others) {
        lines.push("");
        lines.push(`▸ ${m.name} [${m.model}]`);
        if (m.systemPrompt && m.systemPrompt.trim()) {
          const indented = m.systemPrompt
            .trim()
            .split("\n")
            .map((l) => `   ${l}`)
            .join("\n");
          lines.push(indented);
        }
      }
      lines.push("");
    }

    lines.push("─── TEAMMATE INTERACTION (READ CAREFULLY) ───");
    lines.push("");
    lines.push("Teammates DO NOT read your replies. They run only when you call a");
    lines.push("tool. Any text addressed at a teammate — @-mentions, \"@X 请回复\",");
    lines.push("\"ask Y for ...\", \"反方 你来说\", \"移交发言权\", \"hand off to Z\" —");
    lines.push("is INERT. It's just characters the user sees. The user is also NOT");
    lines.push("a router; don't say \"please relay this to X\" — they can't, and");
    lines.push("won't.");
    lines.push("");
    lines.push("EVERY cross-agent action goes through one of these two calls:");
    lines.push("");
    lines.push("  peer_send(target=\"<name>\", mode=<mode>, message=\"<cover note>\")");
    lines.push("       Fires a new turn for <target>. Returns immediately —");
    lines.push("       it does NOT wait for them to reply. Their answer (if any)");
    lines.push("       arrives later as a fresh turn directed at YOU.");
    lines.push("");
    lines.push("  peer_query(target=\"<name>\", limit=<N>)");
    lines.push("       Read-only DB pull of teammate's recent text turns. Does NOT");
    lines.push("       trigger them. Use when you need more context before acting.");
    lines.push("");
    lines.push("Intent → exact call:");
    lines.push("");
    lines.push("  notify / inform / report status .......... peer_send mode=raw");
    lines.push("  ask a question ........................... peer_send mode=raw");
    lines.push("                                              (answer comes back");
    lines.push("                                              as a future turn)");
    lines.push("  rebut / disagree / push back ............. peer_send mode=raw");
    lines.push("  request they do something ................ peer_send mode=raw");
    lines.push("  hand off your in-progress work ........... peer_send mode=continue");
    lines.push("  ask for an audit / second opinion ........ peer_send mode=review");
    lines.push("  ask for an independent take .............. peer_send mode=fork");
    lines.push("  multiple recipients ...................... one peer_send per target");
    lines.push("  read context before deciding ............. peer_query first");
    lines.push("  broadcast a statement to all .............. peer_send to each");
    lines.push("");
    lines.push("All peer_send modes auto-embed your latest assistant output as a");
    lines.push("<<<source-output>>> block for the recipient. So `message` is the");
    lines.push("cover note (\"here's my立论, your turn to rebut\"), NOT a repeat");
    lines.push("of what you just produced.");
    lines.push("");
    lines.push("Async, not synchronous: peer_send ends your turn. If you need a");
    lines.push("teammate's answer in real-time, you can't — wait for their reply");
    lines.push("turn, or peer_query if they've already said it.");
    lines.push("");
    lines.push(sep);
    lines.push("DIRECTIVE:");
    lines.push("  1. \"The team\" / \"team purpose\" = the sections above. They are");
    lines.push("     COMPLETE. Don't ask the user to re-explain.");
    lines.push("  2. Execute YOUR role in service of the team mission, starting now.");
    lines.push("");
    lines.push("END-OF-TURN CHECKLIST (MANDATORY — run this BEFORE ending each");
    lines.push("turn, EVEN IF your text reply already looks complete):");
    lines.push("");
    lines.push("  □ Does YOUR ROLE description above (or this turn's user request)");
    lines.push("    use any of these verbs in reference to a teammate:");
    lines.push("       通知 / 告知 / 报告 / 移交 / 提问 / 请求 / 询问 / 反驳 /");
    lines.push("       notify / tell / inform / report / hand off / ask /");
    lines.push("       request / forward / pass to / let X know");
    lines.push("    → If YES on any of them: you MUST call peer_send to that");
    lines.push("       teammate as part of THIS turn. The text reply you wrote");
    lines.push("       does not satisfy these verbs by itself — peer_send is the");
    lines.push("       only thing that actually delivers anything to a teammate.");
    lines.push("");
    lines.push("  □ Did your text reply say things like \"@X\", \"请 X 发言\",");
    lines.push("    \"等待 X 回复\", \"now X's turn\", \"hand over to X\", etc.?");
    lines.push("    → If YES: those phrases route nothing. Call peer_send to X now,");
    lines.push("       otherwise your turn ends silently and X never runs.");
    lines.push("");
    lines.push("  □ Does the team's flow logically need a teammate to act next");
    lines.push("    for the mission to progress? (e.g., debate round → other side;");
    lines.push("    pipeline step → next step's owner; coordinator → executor.)");
    lines.push("    → If YES: call peer_send to whoever should act next.");
    lines.push("");
    lines.push("If ALL three boxes are \"no\", you may end the turn with text only.");
    lines.push("Otherwise: emit the peer_send tool call(s) FIRST, then optionally");
    lines.push("a short confirmation text. Do NOT promise to call peer_send \"next");
    lines.push("time\" — call it now or it never happens.");
    lines.push(sep);

    return lines.join("\n");
  }

  async patchAgent(
    id: string,
    patch: {
      model?: string;
      permissionMode?: PermissionMode;
      name?: string;
      providerId?: string | null;
      codexWorkspace?: string | null;
      sandboxMode?: SandboxMode | null;
      reasoningEffort?: ReasoningEffort | null;
      systemPrompt?: string | null;
      teamId?: string | null;
    },
  ): Promise<AgentSummary | null> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return null;
    const data: {
      model?: string;
      metadata?: object;
      name?: string;
      providerId?: string | null;
      codexWorkspace?: string | null;
      systemPrompt?: string | null;
      teamId?: string | null;
    } = {};
    if (patch.model !== undefined) data.model = patch.model;
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.providerId !== undefined) data.providerId = patch.providerId;
    if (patch.permissionMode !== undefined) {
      data.metadata = mergeMetadata(cur.metadata, { permissionMode: patch.permissionMode });
    }
    if (patch.systemPrompt !== undefined) {
      const next = patch.systemPrompt === null ? null : patch.systemPrompt;
      data.systemPrompt = next;
      // The CLI / SDK resumes via lastSessionId, which already locked in the
      // OLD systemPrompt at session start. Drop the resume pointer so the next
      // turn opens a fresh session and the new prompt actually takes effect.
      if (next !== cur.systemPrompt) {
        data.metadata = removeMetadataKeys(data.metadata ?? cur.metadata, ["lastSessionId"]);
      }
    }
    if (patch.teamId !== undefined) {
      if (patch.teamId !== null) {
        const teamRow = await prisma.team.findUnique({ where: { id: patch.teamId } });
        if (!teamRow) throw new Error(`team ${patch.teamId} not found`);
      }
      data.teamId = patch.teamId;
      // Team membership affects the TEAM CONTEXT injected into systemPrompt
      // at runtime; drop lastSessionId so the next turn rebuilds context fresh.
      if (patch.teamId !== cur.teamId) {
        data.metadata = removeMetadataKeys(data.metadata ?? cur.metadata, ["lastSessionId"]);
      }
    }
    const targetProviderId = patch.providerId !== undefined ? patch.providerId : cur.providerId;
    const targetProvider = targetProviderId
      ? await prisma.provider.findUnique({ where: { id: targetProviderId } })
      : null;
    if (patch.codexWorkspace !== undefined) {
      const codexWorkspace = normalizeCodexWorkspace(patch.codexWorkspace);
      if (codexWorkspace && targetProvider?.kind !== "openai-codex") {
        throw new Error("codexWorkspace is only valid for openai-codex agents");
      }
      data.codexWorkspace = codexWorkspace;
      if (codexWorkspace !== cur.codexWorkspace) {
        data.metadata = removeMetadataKeys(data.metadata ?? cur.metadata, ["lastSessionId"]);
      }
    } else if (patch.providerId !== undefined && targetProvider?.kind !== "openai-codex" && cur.codexWorkspace) {
      data.codexWorkspace = null;
      data.metadata = removeMetadataKeys(data.metadata ?? cur.metadata, ["lastSessionId"]);
    }
    if (patch.sandboxMode !== undefined) {
      if (patch.sandboxMode !== null && targetProvider?.kind !== "openai-codex") {
        throw new Error("sandboxMode override is only valid for openai-codex agents");
      }
      const previousSandbox = readSandboxOverride(cur.metadata);
      const baseMeta = data.metadata ?? cur.metadata;
      data.metadata = patch.sandboxMode === null
        ? removeMetadataKeys(baseMeta, ["sandboxMode"])
        : mergeMetadata(baseMeta, { sandboxMode: patch.sandboxMode });
      if (patch.sandboxMode !== previousSandbox) {
        // Codex `exec resume` cannot accept a new --sandbox/--cd. Drop the
        // native resume pointer so the next user turn starts a fresh Codex
        // session with the newly selected sandbox.
        data.metadata = removeMetadataKeys(data.metadata, ["lastSessionId"]);
      }
    } else if (patch.providerId !== undefined && targetProvider?.kind !== "openai-codex" && readSandboxOverride(cur.metadata) !== null) {
      data.metadata = removeMetadataKeys(data.metadata ?? cur.metadata, ["sandboxMode"]);
    }
    if (patch.reasoningEffort !== undefined) {
      if (patch.reasoningEffort !== null && !providerSupportsReasoningEffort(targetProvider?.kind)) {
        throw new Error("reasoningEffort override is only valid for Claude Code or Codex agents");
      }
      const previousReasoningEffort = readReasoningEffortOverride(cur.metadata);
      const baseMeta = data.metadata ?? cur.metadata;
      data.metadata = patch.reasoningEffort === null
        ? removeMetadataKeys(baseMeta, ["reasoningEffort"])
        : mergeMetadata(baseMeta, { reasoningEffort: patch.reasoningEffort });
      if (patch.reasoningEffort !== previousReasoningEffort) {
        data.metadata = removeMetadataKeys(data.metadata, ["lastSessionId"]);
      }
    } else if (
      patch.providerId !== undefined &&
      !providerSupportsReasoningEffort(targetProvider?.kind) &&
      readReasoningEffortOverride(cur.metadata) !== null
    ) {
      data.metadata = removeMetadataKeys(data.metadata ?? cur.metadata, ["reasoningEffort"]);
    }
    if (Object.keys(data).length === 0) return agentRowToSummary(cur);
    const updated = await prisma.agent.update({ where: { id }, data });
    const summary = agentRowToSummary(updated);
    this.hub.broadcast({ type: "agent_updated", agent: summary });
    return summary;
  }

  async clearResumeForProviderSandboxChange(providerId: string): Promise<void> {
    const agents = await prisma.agent.findMany({ where: { providerId } });
    for (const a of agents) {
      // Agents with a per-agent sandbox override are unaffected by provider
      // default changes. Agents without native Codex resume info do not need
      // an update either.
      if (readSandboxOverride(a.metadata) !== null) continue;
      if (readMetaString(a.metadata, "lastSessionId") === null) continue;
      const updated = await prisma.agent.update({
        where: { id: a.id },
        data: { metadata: removeMetadataKeys(a.metadata, ["lastSessionId"]) },
      });
      this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
    }
  }

  async closeAgent(id: string): Promise<AgentSummary | null> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return null;
    // Abort running stream if any. resolvePermission will deny outstanding via cancel().
    this.cancel(id);
    const updated = await prisma.agent.update({
      where: { id },
      data: {
        status: "IDLE",
        metadata: mergeMetadata(cur.metadata, { closed: true }),
      },
    });
    const summary = agentRowToSummary(updated);
    this.hub.broadcast({ type: "agent_updated", agent: summary });
    this.hub.sendToSession(id, { type: "status", sessionId: id, status: "idle" });
    return summary;
  }

  async restartAgent(id: string): Promise<AgentSummary | null> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return null;
    const updated = await prisma.agent.update({
      where: { id },
      data: { metadata: mergeMetadata(cur.metadata, { closed: false }) },
    });
    const summary = agentRowToSummary(updated);
    this.hub.broadcast({ type: "agent_updated", agent: summary });
    return summary;
  }

  async deleteAgent(id: string): Promise<boolean> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return false;
    this.cancel(id);
    // Cascading FKs on Message / Permission / McpServer / PaneState will clean rows.
    await prisma.agent.delete({ where: { id } });
    this.hub.broadcast({ type: "agent_deleted", sessionId: id });
    return true;
  }

  /** /skill enable|disable|auto — persist the per-agent skill toggle list
   *  into Agent.metadata. `action="auto"` removes the skill from both lists
   *  (back to "eligible for auto-activation but not forced"). */
  async toggleAgentSkill(
    id: string,
    name: string,
    action: "enable" | "disable" | "auto",
  ): Promise<AgentSummary | null> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return null;
    const baseMeta = (cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}) as Record<string, unknown>;
    const forced = new Set<string>(
      (Array.isArray(baseMeta.forcedSkills) ? baseMeta.forcedSkills : []).filter(
        (x): x is string => typeof x === "string",
      ),
    );
    const disabled = new Set<string>(
      (Array.isArray(baseMeta.disabledSkills) ? baseMeta.disabledSkills : []).filter(
        (x): x is string => typeof x === "string",
      ),
    );
    forced.delete(name);
    disabled.delete(name);
    if (action === "enable") forced.add(name);
    else if (action === "disable") disabled.add(name);
    const next: Record<string, unknown> = { ...baseMeta };
    if (forced.size > 0) next.forcedSkills = Array.from(forced);
    else delete next.forcedSkills;
    if (disabled.size > 0) next.disabledSkills = Array.from(disabled);
    else delete next.disabledSkills;
    const updated = await prisma.agent.update({ where: { id }, data: { metadata: next } });
    const summary = agentRowToSummary(updated);
    this.hub.broadcast({ type: "agent_updated", agent: summary });
    return summary;
  }

  /** /clear — drop all messages for the agent and clear the runtime resume
   *  pointer so the next turn starts fresh. Does NOT touch UsageEvent /
   *  Permission audit trail (§3.2: cost data is decoupled from Message). */
  async clearAgentContext(id: string): Promise<boolean> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return false;
    this.cancel(id);
    await prisma.message.delete({ where: { agentId: id } });
    if (readMetaString(cur.metadata, "lastSessionId") !== null) {
      await prisma.agent.update({
        where: { id },
        data: { metadata: removeMetadataKeys(cur.metadata, ["lastSessionId"]) },
      });
    }
    this.hub.broadcast({ type: "agent_history_reset", sessionId: id, reason: "clear" });
    return true;
  }

  /** /compact — ask the model to summarize the conversation so far, then
   *  replace prior messages with that summary as a single system row and
   *  clear lastSessionId. Runtime-agnostic: pulls text from Message rows
   *  (the same view all three runtimes use one way or another) and calls
   *  quickQuery (which doesn't resume — clean fresh turn). */
  async compactAgent(id: string): Promise<{ summary: string } | null> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return null;
    this.cancel(id);

    const messages = await prisma.message.findMany({
      where: { agentId: id },
      orderBy: { seq: "asc" },
    });
    const lines: string[] = [];
    for (const m of messages) {
      if (m.type === "user") {
        const c = (m.payload as { message?: { content?: unknown } })?.message?.content;
        const text = typeof c === "string" ? c : "";
        if (text.trim()) lines.push(`User: ${text.trim()}`);
      } else if (m.type === "assistant") {
        const blocks =
          (m.payload as { message?: { content?: Array<{ type: string; text?: string }> } })
            ?.message?.content ?? [];
        const text = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text!)
          .join("");
        if (text.trim()) lines.push(`Assistant: ${text.trim()}`);
      }
    }
    if (lines.length === 0) {
      return { summary: "(empty conversation — nothing to compact)" };
    }
    const MAX_TRANSCRIPT_CHARS = 60000;
    let transcript = lines.join("\n\n");
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2) - 80;
      transcript = `${transcript.slice(0, half)}\n\n[... truncated ${transcript.length - half * 2} chars ...]\n\n${transcript.slice(-half)}`;
    }
    const prompt = [
      "Summarize the following conversation transcript in 5-12 sentences.",
      "Focus on: what the user asked for, key decisions, what's been done, what's still pending.",
      "Output plain text only — no markdown headers, no bullet markup.",
      "",
      "Transcript:",
      transcript,
    ].join("\n");

    const summary = (await this.quickQuery(id, prompt, 45_000)).trim() ||
      "(model returned empty summary)";

    // Wipe old rows + replace with one system row carrying the summary.
    await prisma.message.delete({ where: { agentId: id } });
    await prisma.message.create({
      data: {
        agentId: id,
        seq: 0,
        type: "system",
        payload: {
          type: "system",
          subtype: "compact",
          text: summary,
        },
      },
    });
    if (readMetaString(cur.metadata, "lastSessionId") !== null) {
      await prisma.agent.update({
        where: { id },
        data: { metadata: removeMetadataKeys(cur.metadata, ["lastSessionId"]) },
      });
    }
    this.hub.broadcast({
      type: "agent_history_reset",
      sessionId: id,
      reason: "compact",
      summary,
    });
    return { summary };
  }

  /** /status — runtime-agnostic snapshot of an agent's current state. */
  async getStatusReport(id: string): Promise<{
    name: string;
    providerName: string | null;
    providerKind: string | null;
    model: string;
    permissionMode: PermissionMode;
    sandboxMode: SandboxMode | null;
    reasoningEffort: ReasoningEffort | null;
    codexWorkspace: string | null;
    hasResumeInfo: boolean;
    closed: boolean;
    messages: number;
    enabledMcpServers: number;
  } | null> {
    const a = await prisma.agent.findUnique({ where: { id } });
    if (!a) return null;
    const provider = a.providerId
      ? await prisma.provider.findUnique({ where: { id: a.providerId } })
      : null;
    const msgCount = await prisma.message.count({ where: { agentId: id } });
    const mcpRows = await prisma.mcpServer.findMany({ where: { enabled: true } });
    return {
      name: a.name,
      providerName: provider?.name ?? null,
      providerKind: provider?.kind ?? null,
      model: a.model,
      permissionMode: readPermissionMode(a.metadata),
      sandboxMode: readSandboxOverride(a.metadata),
      reasoningEffort: readReasoningEffortOverride(a.metadata),
      codexWorkspace: a.codexWorkspace,
      hasResumeInfo: readMetaString(a.metadata, "lastSessionId") !== null,
      closed: readMetaBool(a.metadata, "closed"),
      messages: msgCount,
      enabledMcpServers: mcpRows.length,
    };
  }

  /** W14: side-channel one-shot query against an agent's runtime, used by
   *  meta UI operations (suggest-children, future telemetry helpers, etc.).
   *  Does NOT persist messages or broadcast on WS. Single-turn, no tools,
   *  no mcpServers, no canUseTool — purely "ask the model and return text".
   *  Hard 15s abort to keep the dialog responsive. */
  async quickQuery(agentId: string, prompt: string, abortMs = 15_000): Promise<string> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error("agent not found");
    let resolvedProvider: Awaited<ReturnType<typeof prisma.provider.findUnique>> = null;
    if (agent.providerId) {
      resolvedProvider = await prisma.provider.findUnique({ where: { id: agent.providerId } });
      if (resolvedProvider?.disabled) {
        throw new Error(`provider "${resolvedProvider.name}" is disabled`);
      }
    }
    const providerEnv: Record<string, string> = {};
    if (resolvedProvider) {
      if (resolvedProvider.baseUrl) providerEnv.ANTHROPIC_BASE_URL = resolvedProvider.baseUrl;
      if (resolvedProvider.apiKey) providerEnv.ANTHROPIC_API_KEY = resolvedProvider.apiKey;
    }
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") mergedEnv[k] = v;
    }
    Object.assign(mergedEnv, providerEnv);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), abortMs);

    const runtime = chooseRuntime(resolvedProvider?.kind ?? "anthropic-local");
    const runtimeCwd =
      resolvedProvider?.kind === "openai-codex"
        ? agent.codexWorkspace || CODEX_DEFAULT_CWD
        : STABLE_CWD;
    const runtimeOpts: RuntimeOptions = {
      sessionId: agentId,
      prompt,
      model: agent.model,
      permissionMode: "bypassPermissions",
      tools: [],
      allowedTools: [],
      canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
      includePartialMessages: false,
      abortController: abort,
      claudeCliPath: await getClaudeCliPath(),
      codexCliPath: await getCodexCliPath(),
      cwd: runtimeCwd,
      mcpServers: {},
      env: Object.keys(providerEnv).length > 0 ? mergedEnv : {},
      provider: resolvedProvider ?? {
        id: "",
        name: "anthropic-default",
        kind: "anthropic-local",
        baseUrl: null,
        apiKey: null,
        autoManaged: false,
        upstreamProvider: null,
        upstreamModel: null,
        models: [],
        isDefault: true,
        disabled: false,
        metadata: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      history: [],
      reasoningEffort: readReasoningEffortOverride(agent.metadata),
    };

    let accumulated = "";
    let resultMsg: unknown = null;
    try {
      for await (const event of runtime.query(runtimeOpts)) {
        if (event.type === "error") throw new Error(event.message);
        const msg = event.payload;
        if (msg.type === "assistant") {
          const blocks = (msg as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? [];
          const text = blocks
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text!)
            .join("");
          if (text) accumulated = text;
        }
        if (msg.type === "result") resultMsg = msg;
      }
    } finally {
      clearTimeout(timer);
    }

    // W17 Slice 10: quickQuery 入账。Recommendation prompts are not free —
    // typical ~500-700 tokens per call. Write a UsageEvent with source='meta'
    // attributed to the calling agent so the stats panel reflects the cost.
    // Best-effort: failures here don't affect the caller (they get their
    // accumulated text either way).
    if (resultMsg) {
      const events = extractUsageEvents(
        {
          agentId,
          agentName: agent.name,
          parentId: agent.parentId,
          providerId: resolvedProvider?.id ?? null,
          providerName: resolvedProvider?.name ?? "anthropic-default",
          providerKind: resolvedProvider?.kind ?? "anthropic-local",
        },
        resultMsg,
        "meta",
      );
      for (const ev of events) {
        try {
          await prisma.usageEvent.create({ data: ev });
        } catch (err) {
          console.warn(`[usage:quickQuery] failed to persist UsageEvent: ${(err as Error).message}`);
        }
      }
    }

    return accumulated;
  }

  /** Slice 5.3 (W16): spawn a subagent for a Task tool call.
   *  - inherits parent's model + provider + systemPrompt (per
   *    docs/plans/openai-task-handoff.md §3)
   *  - tracks `taskDepth` in metadata; refuses at depth 3
   *  - returns the subagent's final assistant text + its id (so caller can
   *    optionally surface it in the UI)
   *  Cross-runtime is allowed: subagent inherits parent providerId, which
   *  may resolve to a different runtime — that's intended per Slice 5 review.
   */
  async spawnTaskSubagent(
    parentId: string,
    description: string,
    prompt: string,
  ): Promise<{ finalText: string; subagentId: string }> {
    const parent = await prisma.agent.findUnique({ where: { id: parentId } });
    if (!parent) throw new Error(`Task: parent agent ${parentId} not found`);
    const parentMeta = (parent.metadata && typeof parent.metadata === "object"
      ? (parent.metadata as Record<string, unknown>)
      : {});
    const parentDepth = typeof parentMeta.taskDepth === "number" ? parentMeta.taskDepth : 0;
    if (parentDepth >= 3) {
      throw new Error(
        `Task depth cap reached (parent at depth ${parentDepth}, max 3). ` +
          "Decompose the work at the parent level or finish the current subtree first.",
      );
    }
    const child = await prisma.agent.create({
      data: {
        parentId,
        name: `task:${description.slice(0, 32)}`,
        model: parent.model,
        providerId: parent.providerId,
        systemPrompt: parent.systemPrompt,
        workspace: parent.workspace,
        codexWorkspace: parent.codexWorkspace,
        metadata: { taskDepth: parentDepth + 1, spawnedAsTaskFor: parentId },
      },
    });
    this.hub.broadcast({ type: "agent_created", agent: agentRowToSummary(child) });
    const result = await this.sendMessage(child.id, prompt);
    return { finalText: result?.finalText ?? "", subagentId: child.id };
  }

  async sendMessage(
    sessionId: string,
    userInput: string,
    opts?: {
      peerOrigin?: { fromAgentId: string; fromAgentName: string; mode: PeerMode };
    },
  ): Promise<{ finalText: string } | null> {
    if (this.running.has(sessionId)) {
      this.hub.sendToSession(sessionId, {
        type: "error",
        sessionId,
        code: "BUSY",
        message: "agent is already running, cancel before sending another message",
      });
      return null;
    }

    const agent = await prisma.agent.findUnique({ where: { id: sessionId } });
    if (!agent) {
      this.hub.sendToSession(sessionId, { type: "error", sessionId, code: "NOT_FOUND", message: "agent not found" });
      return null;
    }
    if (readMetaBool(agent.metadata, "closed")) {
      this.hub.sendToSession(sessionId, {
        type: "error",
        sessionId,
        code: "CLOSED",
        message: "agent is closed; restart it from settings before sending",
      });
      return null;
    }

    const lastMsg = await prisma.message.findFirst({
      where: { agentId: sessionId },
      orderBy: { seq: "desc" },
    });
    let seq = (lastMsg?.seq ?? -1) + 1;

    const abort = new AbortController();
    const runId = randomUUID();
    let staleResume = false;
    let firstModelResponseTimer: NodeJS.Timeout | null = null;
    let turnCompletionIdleTimer: NodeJS.Timeout | null = null;
    const clearFirstModelResponseTimer = () => {
      if (firstModelResponseTimer) {
        clearTimeout(firstModelResponseTimer);
        firstModelResponseTimer = null;
      }
    };
    const clearTurnCompletionIdleTimer = () => {
      if (turnCompletionIdleTimer) {
        clearTimeout(turnCompletionIdleTimer);
        turnCompletionIdleTimer = null;
      }
    };
    const armFirstModelResponseTimer = () => {
      clearFirstModelResponseTimer();
      firstModelResponseTimer = setTimeout(() => {
        void this.forceStopRun(sessionId, {
          expectedRunId: runId,
          dbStatus: "ERROR",
          protoStatus: "error",
          logPrefix: "runtime-timeout",
          error: {
            code: "PROVIDER_TIMEOUT",
            message:
              `provider request produced no model response within ${FIRST_MODEL_RESPONSE_TIMEOUT_MS / 1000}s. ` +
              "Verify the provider baseUrl, API key, and network connection.",
          },
        });
      }, FIRST_MODEL_RESPONSE_TIMEOUT_MS);
    };
    const armTurnCompletionIdleTimer = () => {
      clearTurnCompletionIdleTimer();
      turnCompletionIdleTimer = setTimeout(() => {
        void this.forceStopRun(sessionId, {
          expectedRunId: runId,
          dbStatus: "DONE",
          protoStatus: "done",
          logPrefix: "runtime-idle-after-output",
        });
      }, TURN_COMPLETION_IDLE_TIMEOUT_MS);
    };

    this.running.set(sessionId, {
      id: sessionId,
      runId,
      abort,
      seq,
      suspendCompletionIdleTimer: clearTurnCompletionIdleTimer,
      autoAllowedTools: new Set<string>(),
    });

    try {
    console.log(`[sendMessage] start agent=${sessionId.slice(0, 8)} run=${runId.slice(0, 8)} text="${userInput.slice(0, 40)}"`);
    await this.updateAgentStatus(sessionId, "RUNNING", "running");

    // Persist + broadcast the user input itself. SDK doesn't echo user prompts back
    // through its stream, so without this step a peer-relayed message would never
    // appear in the recipient's chat history.
    const userMsgPayload = {
      type: "user" as const,
      message: { role: "user", content: userInput },
      ...(opts?.peerOrigin ? { _peerOrigin: opts.peerOrigin } : {}),
    };
    const userPersisted = await prisma.message.create({
      data: {
        agentId: sessionId,
        seq,
        type: "user",
        payload: userMsgPayload,
      },
    });
    this.hub.sendToSession(sessionId, {
      type: "message",
      sessionId,
      seq: userPersisted.seq,
      msg: userMsgPayload as never,
    });
    seq++;

    const mcpServers = await this.loadEnabledMcpServers();
    const peerMcp = makePeerMcpServer(this, sessionId);
    const askUserMcp = makeAskUserMcpServer(this, sessionId);
    const helpMcp = makeHelpMcpServer();
    const permissionMode = readPermissionMode(agent.metadata);
    const lastSessionId = readMetaString(agent.metadata, "lastSessionId");
    let capturedSessionId: string | null = lastSessionId;
    let finalText = "";
    // Resolve provider env. anthropic-local (no baseUrl/apiKey) inherits process.env.
    // W16: openai-compat is now handled by OpenAIAgentRuntime (Slice 2+); during
    // Slice 1 we still route everything through the Claude SDK path. The
    // OpenAI runtime path will branch off once Slice 2 lands.
    const providerEnv: Record<string, string> = {};
    let resolvedProvider: Awaited<ReturnType<typeof prisma.provider.findUnique>> = null;
    if (agent.providerId) {
      resolvedProvider = await prisma.provider.findUnique({ where: { id: agent.providerId } });
      if (resolvedProvider) {
        if (resolvedProvider.disabled) {
          const reason = typeof resolvedProvider.metadata?.deprecatedReason === "string"
            ? resolvedProvider.metadata.deprecatedReason
            : "deprecated";
          throw new Error(
            `provider "${resolvedProvider.name}" is disabled (reason: ${reason}). ` +
              "use the migration button on the providers panel to convert it to a supported kind.",
          );
        }
        if (
          resolvedProvider.kind !== "anthropic-local" &&
          resolvedProvider.kind !== "openai-codex" &&
          !resolvedProvider.apiKey
        ) {
          throw new Error(`provider "${resolvedProvider.name}" is missing an API key.`);
        }
        // W16 Slice 6: musistudio gateway path removed. Provider env now
        // always populates ANTHROPIC_BASE_URL/API_KEY directly from the
        // provider row. autoManaged rows would have been disabled at startup
        // by migrateDeprecatedProviders, so we never reach this code path
        // for one. bedrock/vertex envs are likewise unreachable (kind enum
        // rejected at POST).
        if (resolvedProvider.baseUrl) providerEnv.ANTHROPIC_BASE_URL = resolvedProvider.baseUrl;
        if (resolvedProvider.apiKey) providerEnv.ANTHROPIC_API_KEY = resolvedProvider.apiKey;
      }
    }
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") mergedEnv[k] = v;
    }
    Object.assign(mergedEnv, providerEnv);

    const isClaudeKind =
      !resolvedProvider ||
      resolvedProvider.kind === "anthropic-local" ||
      resolvedProvider.kind === "anthropic";
    const claudeCliPath = isClaudeKind ? await getClaudeCliPath() : null;
    const isCodexProvider = resolvedProvider?.kind === "openai-codex";
    const codexCliPath = isCodexProvider ? await getCodexCliPath() : null;
    const platformRuntime = currentRuntimeFromProviderMeta(resolvedProvider?.metadata);

    // Skill registry context: workspace path (codex agents) + runtime kind
    // determines whether tool-restriction notes are shown as advisory or
    // explicitly marked as ignored (Codex case).
    const runtimeKindForSkills = resolvedProvider?.kind ?? "anthropic-local";
    const skillWorkspace = agent.codexWorkspace ?? undefined;
    const skillMcp = makeSkillMcpServer({
      workspace: skillWorkspace,
      runtimeKind: runtimeKindForSkills,
    });
    const allMcpServers = {
      ...mcpServers,
      [PEER_MCP_SERVER_NAME]: peerMcp,
      [ASK_USER_MCP_SERVER_NAME]: askUserMcp,
      [HELP_MCP_SERVER_NAME]: helpMcp,
      [SKILL_MCP_SERVER_NAME]: skillMcp,
    };

    if (isClaudeKind && !claudeCliPath) {
      throw new Error(
        `Claude Code CLI not configured for ${currentPlatformKey()}. Install from https://claude.ai/download ` +
          "or run `npm i -g @anthropic-ai/claude-code`, then restart Ensemble.",
      );
    }
    if (resolvedProvider?.kind === "anthropic-local" && platformRuntime && !platformRuntime.cliPath) {
      throw new Error(`Claude Code CLI is not available on ${currentPlatformKey()}. Configure it in Settings > CLI.`);
    }
    if (isCodexProvider) {
      if (!codexCliPath || (platformRuntime && !platformRuntime.cliPath)) {
        throw new Error(`Codex CLI is not available on ${currentPlatformKey()}. Configure it in Settings > CLI.`);
      }
      if (platformRuntime && platformRuntime.authPresent === false) {
        throw new Error(`Codex CLI is not logged in on ${currentPlatformKey()}. Run \`codex login\` for this OS.`);
      }
    }
    // staleResume is set by the stderr watcher if the CLI reports a missing
    // resume target; the catch path clears that cached session id.
      console.log(`[sendMessage] persisted user msg seq=${userPersisted.seq}, dispatching to runtime cli=${claudeCliPath ?? codexCliPath ?? "(sdk)"}`);
      // W16 Slice 1.6: dispatch via AgentRuntime abstraction instead of
      // directly calling the Claude SDK's query(). chooseRuntime falls back
      // to ClaudeAgentRuntime when no provider is bound (legacy default flow).
      const runtime = chooseRuntime(resolvedProvider?.kind ?? "anthropic-local");
      // W16 Slice 2.1: OpenAIAgentRuntime needs prior turns reconstructed
      // (no SDK-side resume concept). Read prior user/assistant messages from
      // db and hand them to the runtime — Claude side ignores `history`
      // (CLI session file is the source of truth there).
      const isCodexKind = resolvedProvider?.kind === "openai-codex";
      const isOpenAIKind =
        resolvedProvider?.kind === "openai-compat" ||
        resolvedProvider?.kind === "openai-local" ||
        isCodexKind;
      const priorMessages: SdkMessage[] =
        isOpenAIKind
          ? (await prisma.message.findMany({
              where: { agentId: sessionId },
              orderBy: { seq: "asc" },
            }))
              // Drop the user message we just persisted (it's opts.prompt) and
              // the system/init / stream_event / result rows — those don't
              // round-trip into the OpenAI Agents input items.
              .filter((m) => m.seq < userPersisted.seq)
              .filter((m) => m.type === "user" || m.type === "assistant")
              .map((m) => m.payload as SdkMessage)
          : [];
      const runtimeCwd = isCodexKind ? agent.codexWorkspace || CODEX_DEFAULT_CWD : STABLE_CWD;
      // W21: precompute team context (async DB read) so the systemPrompt IIFE
      // below stays synchronous. Empty string when agent isn't in a team.
      const teamContextSync = await this.buildTeamContext(sessionId);

      // Build the merged systemPrompt up-front. Done BEFORE runtimeOpts so we
      // can hash it and detect drift since the resumed session started — if
      // we updated buildEnsemblePrimer / buildTeamContext / etc. between
      // turns, the resumed CLI session still has the OLD prompt locked in and
      // our new directives never reach the model. Hash + clear-on-drift forces
      // a fresh session whenever the composed prompt changes.
      const planNotice =
        permissionMode === "plan"
          ? "You are in PLAN MODE.\n\n" +
            "Rules:\n" +
            "- Read / Grep / Glob freely to investigate.\n" +
            "- Do NOT call Edit, Write, or Bash — those tools will be denied while planning.\n" +
            "- When you have a clear approach, call ExitPlanMode with a markdown plan.\n" +
            "- The user reviews the plan and approves before any code is written."
          : "";
      const primer = buildEnsemblePrimer();
      const base = agent.systemPrompt ?? "";
      const teamContext = teamContextSync;
      const workspacesForSkills = skillWorkspace ? [skillWorkspace] : [];
      const allSkills = loadSkills(workspacesForSkills);
      const blocked = readSkillBlocklist(agent.metadata);
      const forced = readSkillForcelist(agent.metadata);
      const candidates = allSkills.filter((s) => !blocked.has(s.name));
      const autoActive = pickActiveSkills(userInput, candidates);
      const forcedSkills = candidates.filter((s) => forced.has(s.name));
      const seenSkills = new Set<string>();
      const activeSkills: typeof candidates = [];
      for (const s of [...forcedSkills, ...autoActive]) {
        if (seenSkills.has(s.name)) continue;
        seenSkills.add(s.name);
        activeSkills.push(s);
      }
      const skillsSection = formatActiveSkills(activeSkills, runtimeKindForSkills);
      // Order: primer → plan → skills → (team context OR base). Team context
      // already includes the agent's own systemPrompt verbatim, so when it's
      // present we drop `base` to avoid double role declarations.
      const tailRole = teamContext || base;
      const promptParts = [primer, planNotice, skillsSection, tailRole].filter((s) => s && s.length > 0);
      const mergedSystemPrompt = promptParts.join("\n\n---\n\n");

      // Stable hash of the assembled prompt (excluding the non-deterministic
      // skill set — skills are re-picked per turn based on user input, so
      // including them would invalidate resume every turn). What matters for
      // resume safety is: primer + plan + team-context + base. Skills are
      // additive and the model handles their churn gracefully.
      const promptStableSig = [primer, planNotice, tailRole].join("\n\n---\n\n");
      const promptHash = createHash("sha1").update(promptStableSig).digest("hex").slice(0, 16);
      const storedPromptHash = readMetaString(agent.metadata, "systemPromptHash");
      // If the assembled prompt's identity changed since we last persisted it,
      // the cached session is running with stale instructions. Drop the
      // resume pointer so the next turn opens a fresh CLI session and the
      // updated prompt actually reaches the model.
      const effectiveLastSessionId =
        storedPromptHash !== null && storedPromptHash !== promptHash ? null : lastSessionId;
      if (effectiveLastSessionId === null && lastSessionId !== null) {
        console.log(
          `[sendMessage] systemPrompt drift detected agent=${sessionId.slice(0, 8)} ` +
            `stored=${storedPromptHash} current=${promptHash} — clearing resume pointer`,
        );
      }
      const runtimeOpts: RuntimeOptions = {
        sessionId,
        prompt: userInput,
        model: agent.model,
        permissionMode,
        // `tools` restricts what the model can request. `allowedTools` is auto-approval
        // (bypasses canUseTool) — leave empty for built-ins so every tool use round-trips
        // to the user. peer_send and ask_user are system-level safe operations so we
        // auto-approve them.
        tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Task", "ExitPlanMode"],
        allowedTools: [
          PEER_SEND_TOOL_NAME,
          PEER_QUERY_TOOL_NAME,
          ASK_USER_TOOL_NAME,
          ENSEMBLE_HELP_TOOL_NAME,
          SKILL_INVOKE_TOOL_NAME,
          SKILL_LIST_TOOL_NAME,
        ],
        // W20: codex has no per-call approval protocol — its safety gate is
        // the sandboxMode declared at thread start. canUseTool would just
        // silently hang because codex never emits an approval event. Short-
        // circuit to auto-allow; sandboxMode handles refusal of risky ops.
        canUseTool: isCodexKind
          ? async () => ({ behavior: "allow" as const, updatedInput: {} })
          : this.makeCanUseTool(sessionId),
        includePartialMessages: true,
        // Pass AbortController so the runtime kills its underlying subprocess
        // when the user clicks cancel — without this, our for-await abort
        // check only fires when the runtime yields, so a hung run can't be cancelled.
        abortController: abort,
        // Required in SEA mode: the SDK normally derives its bundled cli.js
        // path from `import.meta.url`, but esbuild's CJS output makes that
        // undefined → fileURLToPath crashes. Hand it the user-installed
        // native claude binary so it spawns that directly.
        claudeCliPath: isClaudeKind ? claudeCliPath : null,
        codexCliPath,
        // Forward claude CLI stderr to our log AND watch for the
        // "No conversation found" pattern so we can self-heal if the local
        // session file got pruned/lost between runs.
        onStderr: (line) => {
          console.error(`[claude-cli ${sessionId.slice(0, 8)}] ${line}`);
          if (line.includes("No conversation found with session ID")) {
            staleResume = true;
          }
        },
        cwd: runtimeCwd,
        ...(effectiveLastSessionId ? { resume: effectiveLastSessionId } : {}),
        mcpServers: allMcpServers,
        env: Object.keys(providerEnv).length > 0 ? mergedEnv : {},
        ...(mergedSystemPrompt ? { systemPrompt: mergedSystemPrompt } : {}),
        provider: resolvedProvider ?? {
          // chooseRuntime defaulted to anthropic-local; provide a stub so
          // the runtime can read kind/baseUrl/apiKey without null guards.
          id: "",
          name: "anthropic-default",
          kind: "anthropic-local",
          baseUrl: null,
          apiKey: null,
          autoManaged: false,
          upstreamProvider: null,
          upstreamModel: null,
          models: [],
          isDefault: true,
          disabled: false,
          metadata: {},
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
        history: priorMessages,
        // W20: codex runtime reads sandboxMode from this blob (per-agent
        // override). Other runtimes ignore it.
        agentMetadata: agent.metadata,
        reasoningEffort: readReasoningEffortOverride(agent.metadata),
        // Slice 5.1: session-aware callbacks for OpenAIAgentRuntime to
        // register as NormalizedTools. Claude side ignores — same operations
        // already arrive via allMcpServers (peer + ask-user MCP). The closures
        // bind fromAgentId via the Slice 1.7 handler factories.
        peerSend: makePeerSendHandler(this, sessionId),
        peerQuery: makePeerQueryHandler(this, sessionId),
        askUser: makeAskUserHandler(this, sessionId),
        spawnTask: ({ description, prompt }) => this.spawnTaskSubagent(sessionId, description, prompt),
        ensembleHelp: async ({ topic }) => formatEnsembleHelp(topic),
        skillList: async () => {
          const workspaces = skillWorkspace ? [skillWorkspace] : [];
          const list = loadSkills(workspaces);
          if (list.length === 0) return "No skills loaded.";
          return list
            .map((s) => `${s.name} [${s.source}] — ${s.description}` + (s.tools ? ` (tools: ${s.tools.join(", ")})` : ""))
            .join("\n");
        },
        skillInvoke: async ({ name }) => {
          const workspaces = skillWorkspace ? [skillWorkspace] : [];
          const skill = findSkill(name, workspaces);
          if (!skill) {
            const all = loadSkills(workspaces).map((s) => s.name).join(", ") || "(none)";
            return `No skill named "${name}". Available: ${all}`;
          }
          return formatSkillBody(skill, runtimeKindForSkills);
        },
      };
      const stream = runtime.query(runtimeOpts);
      armFirstModelResponseTimer();

      let firstMsg = true;
      for await (const event of stream) {
        if (event.type === "error") {
          clearFirstModelResponseTimer();
          throw new Error(event.message);
        }
        const msg = event.payload;
        if (msg.type === "assistant" || msg.type === "result") {
          clearFirstModelResponseTimer();
        }
        if (msg.type === "result") {
          clearTurnCompletionIdleTimer();
        } else if (isTextDeltaStreamEvent(msg) || assistantHasText(msg)) {
          armTurnCompletionIdleTimer();
        }
        if (firstMsg) {
          console.log(`[sendMessage] first SDK msg type=${msg.type}`);
          firstMsg = false;
        }
        if (abort.signal.aborted) break;

        // Capture SDK session_id from the first message that exposes one,
        // so the next sendMessage can resume the conversation context.
        const incomingSid = (msg as { session_id?: string }).session_id;
        if (incomingSid && incomingSid !== capturedSessionId) {
          capturedSessionId = incomingSid;
        }

        if (isInternalSystemMessage(msg)) {
          continue;
        }

        if (msg.type === "stream_event") {
          this.hub.sendToSession(sessionId, { type: "message", sessionId, seq: -1, msg: msg as never });
          continue;
        }

        // Capture last assistant text so callers (e.g. scheme-B subagent) can grab the result.
        if (msg.type === "assistant") {
          const blocks = (msg as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? [];
          const text = blocks
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text!)
            .join("");
          if (text) finalText = text;
        }

        const persisted = await prisma.message.create({
          data: {
            agentId: sessionId,
            seq,
            type: msg.type,
            payload: msg as object,
          },
        });

        // W17.3: double-write usage events on every result message. Pure
        // helper; emits one row per model in the result's modelUsage map.
        // Pricing is resolved against pricing.json (Claude SDK's costUSD
        // is intentionally ignored — wrong for third-party anthropic-compat).
        if (msg.type === "result") {
          const events = extractUsageEvents(
            {
              agentId: sessionId,
              agentName: agent.name,
              parentId: agent.parentId,
              providerId: resolvedProvider?.id ?? null,
              providerName: resolvedProvider?.name ?? "anthropic-default",
              providerKind: resolvedProvider?.kind ?? "anthropic-local",
            },
            msg,
            "result",
          );
          for (const ev of events) {
            try {
              await prisma.usageEvent.create({ data: ev });
            } catch (err) {
              // Don't tear down the turn on accounting failure; just log.
              console.warn(`[usage] failed to persist UsageEvent: ${(err as Error).message}`);
            }
          }
        }

        this.hub.sendToSession(sessionId, {
          type: "message",
          sessionId,
          seq: persisted.seq,
          msg: msg as never,
        });

        seq++;
      }

      const persistData: { status: "DONE"; metadata?: object } = { status: "DONE" };
      const metaPatch: Record<string, unknown> = {};
      if (capturedSessionId && capturedSessionId !== effectiveLastSessionId) {
        metaPatch.lastSessionId = capturedSessionId;
      }
      // Always persist the current promptHash on success so the next turn can
      // detect drift correctly even if the hash didn't change this turn.
      if (storedPromptHash !== promptHash) {
        metaPatch.systemPromptHash = promptHash;
      }
      if (Object.keys(metaPatch).length > 0) {
        persistData.metadata = mergeMetadata(agent.metadata, metaPatch);
      }
      // Guard: cancel() may have already force-cleared state and set status
      // back to IDLE. If our runId no longer owns this.running, defer to cancel.
      if (this.running.get(sessionId)?.runId === runId) {
        const updated = await prisma.agent.update({ where: { id: sessionId }, data: persistData });
        this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
        this.hub.sendToSession(sessionId, { type: "status", sessionId, status: "done" });
      } else {
        console.log(`[sendMessage] run=${runId.slice(0, 8)} finished post-cancel; skipping DB update`);
      }
      return { finalText };
    } catch (err) {
      const aborted = abort.signal.aborted;
      const rawMsg = err instanceof Error ? err.message : String(err);
      console.log(`[sendMessage] caught err agent=${sessionId.slice(0, 8)} run=${runId.slice(0, 8)} aborted=${aborted} stale=${staleResume} err=${rawMsg}`);
      // Self-heal stale resume: clear the bad lastSessionId so the next send
      // starts a fresh CLI session instead of re-failing on the same lookup.
      const persistData: { status: "ERROR" | "IDLE"; metadata?: object } = {
        status: aborted ? "IDLE" : "ERROR",
      };
      if (staleResume) {
        const cur = (agent.metadata && typeof agent.metadata === "object" ? agent.metadata : {}) as Record<
          string,
          unknown
        >;
        const next: Record<string, unknown> = { ...cur };
        delete next.lastSessionId;
        persistData.metadata = next;
      }
      // Same guard as the success path. cancel() owns the canonical IDLE state
      // once it's removed this run from the map.
      if (this.running.get(sessionId)?.runId === runId) {
        const updated = await prisma.agent.update({ where: { id: sessionId }, data: persistData });
        this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
        if (!aborted) {
          const friendly = staleResume
            ? "Previous conversation session was lost (the CLI's local session file is gone). " +
              "Cleared cached session id — please send your message again to start fresh."
            : rawMsg;
          this.hub.sendToSession(sessionId, {
            type: "error",
            sessionId,
            code: staleResume ? "SESSION_LOST" : "QUERY_FAILED",
            message: friendly,
          });
        }
        this.hub.sendToSession(sessionId, { type: "status", sessionId, status: aborted ? "idle" : "error" });
      } else {
        console.log(`[sendMessage] run=${runId.slice(0, 8)} error post-cancel; skipping DB update`);
      }
      return null;
    } finally {
      clearFirstModelResponseTimer();
      clearTurnCompletionIdleTimer();
      // Only clear state if we're still the owner. After cancel() the entry
      // is gone; a brand-new sendMessage could already have set its own entry.
      // Without this guard a wedged old run's finally would corrupt the new run.
      if (this.running.get(sessionId)?.runId === runId) {
        this.running.delete(sessionId);
        this.pending.delete(sessionId);
        const qb = this.pendingQuestions.get(sessionId);
        if (qb) {
          for (const [, q] of qb) q.resolve("[run ended before answer]");
          this.pendingQuestions.delete(sessionId);
        }
      }
    }
  }

  private async loadEnabledMcpServers(): Promise<NonNullable<Options["mcpServers"]>> {
    const rows = await prisma.mcpServer.findMany({
      where: { agentId: null, enabled: true },
    });
    const out: NonNullable<Options["mcpServers"]> = {};
    for (const r of rows) {
      const cfg = r.config as Record<string, unknown>;
      if (r.transport === "stdio") {
        out[r.name] = {
          type: "stdio",
          command: String(cfg.command),
          args: Array.isArray(cfg.args) ? (cfg.args as string[]) : undefined,
          env: (cfg.env as Record<string, string> | undefined) ?? undefined,
        };
      } else if (r.transport === "http") {
        out[r.name] = {
          type: "http",
          url: String(cfg.url),
          headers: (cfg.headers as Record<string, string> | undefined) ?? undefined,
        };
      } else if (r.transport === "sse") {
        out[r.name] = {
          type: "sse",
          url: String(cfg.url),
          headers: (cfg.headers as Record<string, string> | undefined) ?? undefined,
        };
      }
    }
    return out;
  }

  /** Re-emit any unanswered permission requests to a freshly subscribed socket
   * so a client that reconnected mid-tool-use sees the dialog again. */
  replayPendingFor(sessionId: string, socket: WebSocket): void {
    const bucket = this.pending.get(sessionId);
    if (bucket) {
      for (const [reqId, entry] of bucket) {
        this.hub.sendTo(socket, {
          type: "permission_request",
          sessionId,
          reqId,
          toolName: entry.toolName,
          input: entry.input,
        });
      }
    }
    const qbucket = this.pendingQuestions.get(sessionId);
    if (qbucket) {
      for (const [reqId, entry] of qbucket) {
        this.hub.sendTo(socket, {
          type: "user_question",
          sessionId,
          reqId,
          question: entry.question,
          options: entry.options,
        });
      }
    }
  }

  /** Called by ask_user MCP tool. Suspends until the user clicks an option. */
  async askUser(sessionId: string, question: string, options: string[]): Promise<string> {
    const reqId = randomUUID();
    this.running.get(sessionId)?.suspendCompletionIdleTimer?.();
    await this.updateAgentStatus(sessionId, "AWAITING_USER_INPUT", "awaiting_user_input");
    this.hub.sendToSession(sessionId, {
      type: "user_question",
      sessionId,
      reqId,
      question,
      options,
    });

    const choice = await new Promise<string>((resolve) => {
      let bucket = this.pendingQuestions.get(sessionId);
      if (!bucket) {
        bucket = new Map();
        this.pendingQuestions.set(sessionId, bucket);
      }
      bucket.set(reqId, { resolve, question, options });
    });

    if (this.running.has(sessionId)) {
      await this.updateAgentStatus(sessionId, "RUNNING", "running");
    }
    return choice;
  }

  resolveUserQuestion(sessionId: string, reqId: string, choice: string): void {
    const bucket = this.pendingQuestions.get(sessionId);
    const entry = bucket?.get(reqId);
    if (!entry) return;
    bucket!.delete(reqId);
    entry.resolve(choice);
  }

  /** Resolve a peer-target string to an agent id. Tries id-equality first
   * (only when target looks like a UUID, since Prisma rejects malformed UUIDs
   * even on read), then exact name match, then case-insensitive name match.
   * Excludes self. */
  async resolvePeerTarget(fromAgentId: string, target: string): Promise<string | null> {
    const trimmed = target.trim();
    if (!trimmed || trimmed === fromAgentId) return null;
    if (UUID_RE.test(trimmed)) {
      const byId = await prisma.agent.findUnique({ where: { id: trimmed } });
      if (byId && byId.id !== fromAgentId) return byId.id;
    }
    const byName = await prisma.agent.findFirst({
      where: { name: trimmed, NOT: { id: fromAgentId } },
      orderBy: { createdAt: "desc" },
    });
    if (byName) return byName.id;
    const ci = await prisma.agent.findFirst({
      where: {
        name: { equals: trimmed, mode: "insensitive" },
        NOT: { id: fromAgentId },
      },
      orderBy: { createdAt: "desc" },
    });
    return ci?.id ?? null;
  }

  /** Pull the source agent's most recent assistant text — the artifact the
   * recipient should review. Walks Message rows newest-first, stopping when
   * we hit a `user` row (i.e., previous turn boundary). Joins text blocks
   * across the contiguous assistant run; drops tool_use noise. Caps at
   * MAX_REVIEW_CHARS to avoid blowing the recipient's context window.
   */
  private async fetchLastAssistantText(agentId: string): Promise<string | undefined> {
    const MAX_REVIEW_CHARS = 8000;
    // Pull last 80 rows newest-first; any sensible last-turn fits.
    const rows = await prisma.message.findMany({
      where: { agentId },
      orderBy: { seq: "desc" },
      take: 80,
    });
    const texts: string[] = [];
    for (const row of rows) {
      if (row.type === "user") break;
      if (row.type !== "assistant") continue;
      const blocks = (row.payload as { message?: { content?: Array<{ type: string; text?: string }> } })
        ?.message?.content ?? [];
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("");
      if (text.trim()) texts.unshift(text.trim());
    }
    if (texts.length === 0) return undefined;
    const joined = texts.join("\n\n");
    if (joined.length <= MAX_REVIEW_CHARS) return joined;
    const half = Math.floor(MAX_REVIEW_CHARS / 2) - 40;
    return `${joined.slice(0, half)}\n\n[... ${joined.length - half * 2} chars truncated ...]\n\n${joined.slice(-half)}`;
  }

  /** Called by the peer_query MCP tool. Read-only fetch of another agent's
   *  recent text turns, so the calling agent can pull more context on demand
   *  (e.g., a handoff recipient feels the embedded source-output is too short
   *  and wants more of the source's prior trajectory). Does NOT cause the
   *  target agent to run — pure DB read.
   *
   *  Walks user+assistant rows newest-first, stops once we've accumulated
   *  `limit` user-message boundaries (default 20, max 50). Drops tool_use
   *  noise — only text content is returned. Output capped at MAX_QUERY_CHARS
   *  via head+tail truncation. */
  async fetchPeerHistory(
    fromAgentId: string,
    target: string,
    limit: number = 20,
  ): Promise<string> {
    const MAX_TURNS = 50;
    const MAX_QUERY_CHARS = 12000;
    const sanitized = Math.max(1, Math.min(MAX_TURNS, Math.floor(limit) || 20));

    const targetId = await this.resolvePeerTarget(fromAgentId, target);
    if (!targetId) return `error: no peer agent matches "${target}" (excluding self)`;
    const targetAgent = await prisma.agent.findUnique({ where: { id: targetId } });
    if (!targetAgent) return `error: peer agent ${targetId} not found`;

    // No `in` operator on our DB shim — fetch newest 400 rows and JS-filter to
     // user|assistant. Plenty of headroom for sanitized<=50 user-turn cap.
    const rows = await prisma.message.findMany({
      where: { agentId: targetId },
      orderBy: { seq: "desc" },
      take: 400,
    });

    const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
    let userBoundaries = 0;
    for (const row of rows) {
      if (row.type !== "user" && row.type !== "assistant") continue;
      if (row.type === "user") {
        const content = (row.payload as { message?: { content?: unknown } })?.message?.content;
        const text = typeof content === "string" ? content : "";
        if (text.trim()) turns.unshift({ role: "user", text: text.trim() });
        userBoundaries++;
        if (userBoundaries >= sanitized) break;
      } else if (row.type === "assistant") {
        const blocks =
          (row.payload as { message?: { content?: Array<{ type: string; text?: string }> } })
            ?.message?.content ?? [];
        const text = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text!)
          .join("");
        if (text.trim()) turns.unshift({ role: "assistant", text: text.trim() });
      }
    }

    if (turns.length === 0) {
      return `peer "${targetAgent.name}" (id=${targetId.slice(0, 8)}) has no text history yet.`;
    }
    const header = `peer agent: ${targetAgent.name} (id=${targetId.slice(0, 8)}) — last ${turns.length} text turns (oldest → newest):\n\n`;
    const body = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
    const full = header + body;
    if (full.length <= MAX_QUERY_CHARS) return full;
    const half = Math.floor(MAX_QUERY_CHARS / 2) - 60;
    return `${full.slice(0, half)}\n\n[... ${full.length - half * 2} chars truncated ...]\n\n${full.slice(-half)}`;
  }

  /** Called by the peer_send MCP tool. Validates and forwards a peer message.
   * Fire-and-forget: returns once the message has been queued, does NOT await
   * the recipient's reply (that would block the parent's stream). */
  async sendPeerMessage(
    fromAgentId: string,
    target: string,
    body: string,
    mode: PeerMode = "raw",
  ): Promise<string> {
    const fromAgent = await prisma.agent.findUnique({ where: { id: fromAgentId } });
    if (!fromAgent) return `error: source agent ${fromAgentId} not found`;

    const targetId = await this.resolvePeerTarget(fromAgentId, target);
    if (!targetId) return `error: no peer agent matches "${target}" (excluding self)`;
    const targetAgent = await prisma.agent.findUnique({ where: { id: targetId } });
    if (!targetAgent) return `error: peer agent ${targetId} not found`;
    if (readMetaBool(targetAgent.metadata, "closed")) {
      return `error: peer agent "${targetAgent.name}" is closed; user must restart it before it can receive messages`;
    }
    if (this.running.has(targetId)) {
      return `error: peer agent "${targetAgent.name}" is busy (mid-run); try again after it finishes`;
    }

    const sourceLastOutput = await this.fetchLastAssistantText(fromAgent.id);
    const formatted = formatPeerHandoff({
      fromName: fromAgent.name,
      fromId: fromAgent.id,
      receiverMetadata: targetAgent.metadata,
      mode,
      body,
      sourceLastOutput,
    });
    void this.sendMessage(targetId, formatted, {
      peerOrigin: {
        fromAgentId: fromAgent.id,
        fromAgentName: fromAgent.name,
        mode,
      },
    }).catch((err) => {
      console.error(`[peer_send] sendMessage to ${targetId} failed:`, err);
    });
    return `delivered to "${targetAgent.name}" (id=${targetId.slice(0, 8)}, mode=${mode})`;
  }

  private async forceStopRun(sessionId: string, opts: ForceStopOptions): Promise<boolean> {
    const r = this.running.get(sessionId);
    if (opts.expectedRunId && (!r || r.runId !== opts.expectedRunId)) {
      return false;
    }

    if (r) {
      console.log(`[${opts.logPrefix}] abort agent=${sessionId.slice(0, 8)} run=${r.runId.slice(0, 8)}`);
      try { r.abort.abort(); } catch { /* signal already aborted */ }
    } else {
      console.log(`[${opts.logPrefix}] no live run for agent=${sessionId.slice(0, 8)}; cleaning stale state`);
    }

    this.running.delete(sessionId);
    const sessionPending = this.pending.get(sessionId);
    if (sessionPending) {
      for (const [, p] of sessionPending) {
        p.resolve({ behavior: "deny", message: opts.error?.message ?? "Cancelled by user." });
      }
      sessionPending.clear();
      this.pending.delete(sessionId);
    }
    const sessionQuestions = this.pendingQuestions.get(sessionId);
    if (sessionQuestions) {
      for (const [, q] of sessionQuestions) {
        q.resolve(opts.error ? `[${opts.error.message}]` : "[cancelled by user]");
      }
      sessionQuestions.clear();
      this.pendingQuestions.delete(sessionId);
    }

    try {
      const updated = await prisma.agent.update({
        where: { id: sessionId },
        data: { status: opts.dbStatus },
      });
      this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
      if (opts.error) {
        this.hub.sendToSession(sessionId, {
          type: "error",
          sessionId,
          code: opts.error.code,
          message: opts.error.message,
        });
      }
      this.hub.sendToSession(sessionId, { type: "status", sessionId, status: opts.protoStatus });
    } catch (err) {
      console.warn(`[${opts.logPrefix}] DB reset for agent=${sessionId.slice(0, 8)} failed: ${(err as Error).message}`);
    }
    return true;
  }

  private async updateAgentStatus(
    sessionId: string,
    dbStatus: "IDLE" | "RUNNING" | "AWAITING_PERMISSION" | "AWAITING_USER_INPUT",
    protoStatus: "idle" | "running" | "awaiting_permission" | "awaiting_user_input",
  ): Promise<void> {
    const updated = await prisma.agent.update({
      where: { id: sessionId },
      data: { status: dbStatus },
    });
    this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
    this.hub.sendToSession(sessionId, { type: "status", sessionId, status: protoStatus });
  }

  /** Authoritatively cancel a run.
   *
   *  Previously cancel() only signalled the AbortController and left the
   *  DB/UI state cleanup to sendMessage's finally block. That works when the
   *  runtime unwinds promptly — but a wedged codex CLI (e.g., grandchild MCP
   *  process keeping stdio pipes open on Windows) can keep sendMessage
   *  suspended on `await closePromise` forever, so the agent stays
   *  RUNNING from the user's perspective with no way out short of restarting
   *  Ensemble.
   *
   *  Now cancel() unconditionally force-clears in-memory + DB state and
   *  broadcasts IDLE. sendMessage's success / error / finally paths use a
   *  runId guard to detect that cancel won the race and skip their own
   *  updates so they can't undo the IDLE state. */
  async cancel(sessionId: string): Promise<void> {
    const r = this.running.get(sessionId);
    if (r) {
      console.log(`[cancel] abort agent=${sessionId.slice(0, 8)} run=${r.runId.slice(0, 8)}`);
      try { r.abort.abort(); } catch { /* signal already aborted */ }
    } else {
      // No in-memory run — but the DB might still say RUNNING because a
      // previous core process crashed mid-turn or a runtime hang outlived its
      // sendMessage call. Continue to the DB reset below; better to leave
      // the agent IDLE than stuck.
      console.log(`[cancel] no live run for agent=${sessionId.slice(0, 8)}; cleaning stale state`);
    }

    // Drop in-memory state synchronously so sendMessage's runId guard fires
    // and a fresh send_message can be accepted without races.
    this.running.delete(sessionId);
    const sessionPending = this.pending.get(sessionId);
    if (sessionPending) {
      for (const [, p] of sessionPending) {
        p.resolve({ behavior: "deny", message: "Cancelled by user." });
      }
      sessionPending.clear();
      this.pending.delete(sessionId);
    }
    const sessionQuestions = this.pendingQuestions.get(sessionId);
    if (sessionQuestions) {
      for (const [, q] of sessionQuestions) {
        q.resolve("[cancelled by user]");
      }
      sessionQuestions.clear();
      this.pendingQuestions.delete(sessionId);
    }

    // Authoritative DB reset. We deliberately do NOT touch metadata — only the
    // status flips back to IDLE. lastSessionId / sandboxMode / etc. survive.
    try {
      await this.updateAgentStatus(sessionId, "IDLE", "idle");
    } catch (err) {
      // Agent might have been deleted concurrently — log and move on.
      console.warn(`[cancel] DB reset for agent=${sessionId.slice(0, 8)} failed: ${(err as Error).message}`);
    }
  }

  /** Reset all RUNNING / AWAITING_* agents to IDLE at startup.
   *
   *  By definition no agent can actually be running when core has just
   *  booted, so any row left in those states is stale — usually from a
   *  previous crash, a wedged codex CLI, or an Ensemble restart while a
   *  run was in flight. Without this recovery the agent stays "running"
   *  forever from the UI's perspective and can't be cancelled, because
   *  there's no in-memory AbortController to signal. */
  async recoverStaleSessions(): Promise<void> {
    try {
      // The internal Prisma-shaped wrapper (core/src/db.ts) doesn't ship
      // `{ in: [...] }` or `updateMany` — just OR-of-equals + per-row update.
      const stuck = await prisma.agent.findMany({
        where: {
          OR: [
            { status: "RUNNING" },
            { status: "AWAITING_PERMISSION" },
            { status: "AWAITING_USER_INPUT" },
          ],
        },
      });
      if (stuck.length === 0) return;
      console.warn(
        `[recover] resetting ${stuck.length} stale agent(s) to IDLE: ${stuck
          .map((a) => `${a.name}(${a.id.slice(0, 8)}/${a.status})`)
          .join(", ")}`,
      );
      for (const a of stuck) {
        const updated = await prisma.agent.update({
          where: { id: a.id },
          data: { status: "IDLE" },
        });
        this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
      }
    } catch (err) {
      console.error(`[recover] failed: ${(err as Error).message}`);
    }
  }

  async resolvePermission(sessionId: string, reqId: string, decision: PermissionDecision) {
    const sessionPending = this.pending.get(sessionId);
    const entry = sessionPending?.get(reqId);
    if (!entry) return;
    sessionPending!.delete(reqId);
    entry.resolve(decision);

    // Per-turn auto-allow: remember "Allow" decisions by tool name so the
    // model can keep using the same tool this turn without re-prompting.
    // Bounded by RunningSession lifetime (cleared on next turn). Deny is
    // intentionally NOT cached.
    if (decision.behavior === "allow") {
      const running = this.running.get(sessionId);
      if (running) running.autoAllowedTools.add(entry.toolName);
    }

    const updatedInput =
      decision.behavior === "allow"
        ? ((decision.updatedInput as object | undefined) ?? null)
        : null;

    await prisma.permission.update({
      where: { id: reqId },
      data: {
        decision: decision.behavior,
        updatedInput: updatedInput ?? undefined,
        decidedAt: new Date(),
      },
    });
  }

  private makeCanUseTool(sessionId: string): CanUseTool {
    return async (toolName, input) => {
      // Note: SDK CLI 0.1.x auto-handles the built-in Task tool internally — it never
      // reaches this callback. Scheme-B subagents are user-driven via create_agent {parentId}.

      // Slice 5.4: plan-mode write-tool auto-deny. The model should follow
      // the systemPrompt notice (see runtimeOpts.systemPrompt), but if it
      // still calls Edit/Write/Bash we reject without a UI prompt.
      const agent = await prisma.agent.findUnique({ where: { id: sessionId } });
      const mode = agent ? readPermissionMode(agent.metadata) : "default";
      const WRITE_TOOLS = new Set(["Edit", "Write", "Bash"]);
      if (mode === "plan" && WRITE_TOOLS.has(toolName)) {
        return {
          behavior: "deny",
          message:
            "Denied: plan mode forbids write tools. " +
            "Call ExitPlanMode with your proposal so the user can approve before any code is written.",
        };
      }

      // Per-turn auto-allow shortcut: if user already clicked "Allow" on this
      // tool during the current turn, skip the dialog and pass the call through
      // with the original input. Resets next turn (new RunningSession). Plan
      // mode's hard-deny above still runs first.
      const runningEarly = this.running.get(sessionId);
      if (runningEarly?.autoAllowedTools.has(toolName)) {
        return { behavior: "allow", updatedInput: input as Record<string, unknown> };
      }

      const reqId = randomUUID();

      await prisma.permission.create({
        data: {
          id: reqId,
          agentId: sessionId,
          toolName,
          input: input as object,
        },
      });

      this.running.get(sessionId)?.suspendCompletionIdleTimer?.();
      await this.updateAgentStatus(sessionId, "AWAITING_PERMISSION", "awaiting_permission");
      this.hub.sendToSession(sessionId, { type: "permission_request", sessionId, reqId, toolName, input });

      const decision = await new Promise<PermissionDecision>((resolve) => {
        let bucket = this.pending.get(sessionId);
        if (!bucket) {
          bucket = new Map();
          this.pending.set(sessionId, bucket);
        }
        bucket.set(reqId, { resolve, toolName, input });
      });

      // Only flip back to running if the session is still active. cancel() may have settled this.
      if (this.running.has(sessionId)) {
        await this.updateAgentStatus(sessionId, "RUNNING", "running");
      }

      const result: PermissionResult =
        decision.behavior === "allow"
          ? {
              behavior: "allow",
              updatedInput: (decision.updatedInput as Record<string, unknown> | undefined) ?? input,
            }
          : {
              behavior: "deny",
              message: decision.message ?? "Denied by user.",
            };
      return result;
    };
  }
}
