import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { CanUseTool, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentStatusReport,
  LivenessProbeKind,
  LivenessTerminalReason,
  PeerContactIdentity,
  RunPlanSettingField,
  RunPlanStatusView,
  SdkMessage,
  SettingInvalidation,
  SettingsImpactReport,
  SettingsImpactRequest,
} from "@agentorch/shared";
import { peerContactAllowed, reasoningReport, runPlanStatusView, samePeerCircle } from "@agentorch/shared";
import type { ReasoningReport } from "@agentorch/shared";
import { LivenessController } from "../liveness-controller.js";
import type { LivenessRunHooks } from "../liveness-controller.js";
import type { LivenessSnapshot } from "../capability/liveness.js";
import { newLivenessSignals, resolveLivenessPolicy } from "../capability/liveness.js";
import { extractUsageEvents, buildMetaUsageEvent } from "../usage-extract.js";
import {
  contextUsageFromUsedTokens,
  liveOccupancy,
  occupancyDeltaFromStreamEvent,
  occupancyAfterPersistedMessage,
  occupancyTokensFromLastCall,
  occupancyTokensFromResultContextUsage,
  reportedContextWindowFromResult,
  estimateStreamTokens,
  shouldEncodeLiveStreamOccupancy,
  shouldPublishLiveContext,
} from "../context-usage.js";
import {
  compactionThreshold,
  reasoningLevelsEntry,
  requestedRuntimeWindow,
  scopeForAgent,
  vendorScopeForModel,
  type EffectiveWindowContext,
} from "../context-window.js";
import { probeCodexVersion } from "../cli-config.js";
import { chooseRuntime, runtimeScopeForKind } from "./runtimes/index.js";
import { takeUntilAbort } from "./abort-iterable.js";
import type {
  AgentRuntime,
  RuntimeErrorCode,
  RuntimeErrorEvent,
  RuntimeOptions,
  TransportFallbackInfo,
} from "./runtimes/types.js";
import {
  attachPlanHistory,
  attachPlanSkills,
  planSkillsFromSelection,
  resolveRunPlan,
} from "../capability/run-plan.js";
import type {
  ResolvedRunPlan,
  RunPlanContext,
  RunPlanHistory,
  RunPlanSkills,
  TransportPreference,
} from "../capability/types.js";
import {
  readProviderTransportPreference,
  resolveTransportFacts,
} from "../capability/transport.js";
import type { TransportErrorClass } from "../capability/transport-errors.js";
import {
  normalizeCodexUsageSnapshot,
  type CodexUsageSnapshot,
} from "./runtimes/codex-usage.js";
import {
  makePeerMcpServer,
  makePeerSendHandler,
  makePeerQueryHandler,
  makeConversationSearchHandler,
  PEER_MCP_SERVER_NAME,
  PEER_SEND_TOOL_NAME,
  PEER_QUERY_TOOL_NAME,
  CONVERSATION_SEARCH_TOOL_NAME,
} from "../peer-mcp.js";
import { makeHelpMcpServer, HELP_MCP_SERVER_NAME, ENSEMBLE_HELP_TOOL_NAME } from "../help-mcp.js";
import { JobManager } from "../jobs.js";
import {
  makeJobsMcpServer,
  JOBS_MCP_SERVER_NAME,
  JOB_STATUS_TOOL_NAME,
  JOB_WAIT_TOOL_NAME,
} from "../jobs-mcp.js";
import {
  makeArtifactMcpServer,
  ARTIFACT_MCP_SERVER_NAME,
  ARTIFACT_READ_TOOL_NAME,
  ARTIFACT_SEARCH_TOOL_NAME,
  type ArtifactReadArgs,
  type ArtifactSearchArgs,
} from "../artifact-mcp.js";
import {
  ARTIFACT_DEFAULT_PAGE_BYTES,
  ARTIFACT_INLINE_FRACTION,
  artifactPreview,
  createArtifact,
  createArtifactFromSpool,
  decideArtifactInline,
  handleOf,
  previewBytesFor,
  readArtifactPage,
  renderArtifactResult,
  searchArtifact,
  type ArtifactBodySource,
  type ArtifactHandle,
  type ArtifactReadResult,
  type ArtifactSearchResult,
} from "../artifacts.js";
import type { ToolOutputSink } from "./tools/types.js";
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
  formatSkillListForTool,
  skillInvokeToolResult,
  readSkillBlocklist,
  readSkillForcelist,
  readSkillAutoActivation,
  selectSkills,
  renderSkillSelection,
} from "../skills/index.js";
import {
  makeAskUserMcpServer,
  makeAskUserHandler,
  ASK_USER_MCP_SERVER_NAME,
  ASK_USER_TOOL_NAME,
} from "../ask-user-mcp.js";
import { makeSubagentMcpServer, SUBAGENT_MCP_SERVER_NAME, SUBAGENT_TOOL_NAME } from "../subagent-mcp.js";
import type {
  AgentStatus as ProtoStatus,
  AgentSummary,
  ContextUsage,
  PeerCorrelationKind,
  PeerIncludeSource,
  PeerMode,
  PermissionDecision,
  PermissionMode,
  ReasoningEffort,
  SandboxMode,
} from "@agentorch/shared";
import { parseReasoningChoice, REASONING_SYNTAX_RULE } from "@agentorch/shared";
import { formatPeerHandoff } from "./peerHandoff.js";
import {
  classifyBackgroundTaskMessage,
  applyBackgroundTaskDelta,
  shouldFinalizeTurn,
  backgroundTaskInterruptedMessage,
  backgroundTaskOrphanedMessage,
  type BackgroundTaskInfo,
} from "./backgroundTasks.js";
import {
  formatSubagentFinishedNotice,
  subagentFinishedSystemPayload,
  type SubagentTerminalOutcome,
} from "./subagentFinish.js";
import type { Agent as DbAgent, Job as DbJob, Message as DbMessage, PendingTurn as DbPendingTurn } from "../db.js";
import { prisma, sqliteDb, transaction } from "../db.js";
import {
  SUMMARY_VERSION,
  archiveRows,
  nextGeneration,
  readGeneration,
  readGenerationRange,
  listGenerations,
  restoreGenerationToActive,
  type RestoreOutcome,
  renderArchivedTranscript,
  sourceHashOf,
  contentHashOf,
  summarizerTextOf,
} from "../message-archive.js";
import { countTokens } from "../local-tokenizer.js";
import {
  makeTokenMeasurer,
  resolveHistoryBudget,
  windowFractionBudget,
  type HistoryTurn,
} from "../capability/history-budget.js";
import { chatTextForLocalRebuild } from "./local-rebuild-prompt.js";
import type { RunPlanHistoryStrategy } from "@agentorch/shared";
import {
  resolveServerConversation,
  serverConversationSignature,
  serverConversationSupportFact,
  withServerConversation,
  withServerConversationRejection,
  withoutServerConversation,
} from "../capability/server-conversation.js";
import { summarizeLayered, type CompactSourceTurn } from "../capability/layered-compact.js";
import type { WebSocket } from "@fastify/websocket";
import type { WSHub } from "../ws/hub.js";
import { createStreamEventWsBatcher } from "../ws/stream-event-batch.js";
import { CLI_INSTALL_INFO, getClaudeCliPath, getCodexCliPath } from "../cli-config.js";
import { ensureDataDir } from "../paths.js";
import {
  ProjectRootRejected,
  ensureScratchDir,
  inspectProjectRoot,
  isProjectRootRejection,
  normalizeProjectRoot,
  reconcileProjectRootInput,
  scratchDirFor,
  type ProjectRootInvalid,
} from "./project-root.js";
import {
  isProjectInstructionsRejection,
  loadProjectInstructions,
  renderProjectInstructionsBlock,
} from "./project-instructions.js";
import { currentPlatformKey } from "../platform-key.js";
import {
  conversationSearchOutcome,
  type ConversationSearchArgs,
} from "../conversation-search.js";

// There is no process-wide cwd any more. Every turn's working directory comes
// from `runPlan.execution.projectRoot`, which is either the agent's own project
// or that agent's scratch directory — never the sidecar's cwd, never the home
// directory, never the data dir. The old `STABLE_CWD = homedir()` existed to
// make Claude Code's session files findable across launches; that job now
// belongs to a stable per-agent scratch directory (see project-root.ts), which
// is reachable for resume AND does not pretend the user's home is a project.
const CODEX_DEFAULT_SANDBOX: SandboxMode = "danger-full-access";
const CODEX_RESUME_SIGNATURE_KEY = "codexResumeSignature";
const CODEX_RESUME_SIGNATURE_VERSION = 1;
const RESUME_METADATA_KEYS = ["lastSessionId", "codexUsageSnapshot", CODEX_RESUME_SIGNATURE_KEY] as const;
/** Set on a detached subagent once its terminal state has been reported to the
 *  parent — makes the notification idempotent across runs and restarts. */
const SUBAGENT_SETTLED_KEY = "subagentTerminalNotified";

/** Why a spawned subagent was archived. Recorded in its metadata so the
 *  transcript says what ended it, and so a failed task is never indistinguishable
 *  from one that simply finished. */
export type SubagentRetirementReason = "task-completed" | "task-failed" | "interrupted";
// The history character caps that used to live here (28 messages / 18 000
// chars / 6 000 per message, and the interrupted/peer variants) are gone. They
// were applied silently and inconsistently with the window the model actually
// has: a marker in message #29 simply stopped existing, with nothing in the
// transcript, the plan or /status to say so. History is now sized by the token
// budget the plan carries (`capability/history-budget.ts`), and anything that
// does not fit is reported as overflow for the ranged compact path to cover.
const COMPACT_START_TEXT = "Compacting conversation context...";
const COMPACT_FAILURE_PREFIX = "Context compact failed:";
/** Claude Code / Codex treat this as their own slash, not as a user sentence. */
const NATIVE_COMPACT_SLASH = "/compact";
// Phase 4: these are SUSPICION thresholds. They used to be kill deadlines —
// crossing one called forceStopRun and persisted the turn as an ERROR, which
// meant silence alone could end a run. Now crossing one produces a visible
// warning and a health check, and only hard evidence (see
// `capability/liveness.ts`) can end the run. The numbers are unchanged so the
// behaviour change is the one that was asked for and nothing else.
const RUNTIME_IDLE_TIMEOUT_DEFAULT_MS = 20 * 60 * 1000;
// A DETACHED background subagent has nobody watching it: the parent already
// moved on, so suspicion is raised sooner — again only suspicion.
const BACKGROUND_SUBAGENT_IDLE_TIMEOUT_DEFAULT_MS = 5 * 60 * 1000;

const flushVisibleState = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
/** `await` of a resolved async return only drains microtasks. Fastify WS/HTTP
 *  sit in the poll phase — without setImmediate, create_agent waits behind
 *  every thinking delta. */
const EVENT_LOOP_YIELD_EVERY_N = 8;
const EVENT_LOOP_YIELD_MIN_MS = 16;

function readPositiveMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readRuntimeIdleTimeoutMs(): number {
  return readPositiveMs(process.env.ENSEMBLE_RUNTIME_IDLE_TIMEOUT_MS, RUNTIME_IDLE_TIMEOUT_DEFAULT_MS);
}

function readBackgroundSubagentIdleTimeoutMs(): number {
  return readPositiveMs(
    process.env.ENSEMBLE_BG_TASK_IDLE_TIMEOUT_MS,
    BACKGROUND_SUBAGENT_IDLE_TIMEOUT_DEFAULT_MS,
  );
}

// The stall warning's user-facing sentence used to live here, as a
// `liveness_status` system message written into the transcript. It is gone with
// the message: the ONE sentence describing a run's liveness is now
// `describeLiveness` (capability/liveness.ts), which `/status` prints and which
// every `liveness_update` carries. Two sentences about one run is how the
// transcript and the status report start disagreeing about whether the run was
// merely quiet or actually over.

function isInternalSystemMessage(msg: unknown): boolean {
  return (
    msg !== null &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "system" &&
    (msg as { subtype?: unknown }).subtype === "thinking_tokens"
  );
}

function textDeltaFromStreamEvent(msg: unknown): string | null {
  if (!msg || typeof msg !== "object" || (msg as { type?: unknown }).type !== "stream_event") return null;
  const event = (msg as { event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } } }).event;
  const isTextDelta =
    event?.type === "content_block_delta" &&
    event.delta?.type === "text_delta" &&
    typeof event.delta.text === "string" &&
    event.delta.text.length > 0;
  if (!isTextDelta) return null;
  return event.delta!.text as string;
}

function assistantTextFromMessage(msg: unknown): string {
  if (!msg || typeof msg !== "object" || (msg as { type?: unknown }).type !== "assistant") return "";
  const blocks = (msg as { message?: { content?: Array<{ type?: unknown; text?: unknown }> } }).message?.content ?? [];
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
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
  userInput: string;
  startedSeq: number;
  userMessageSeq?: number;
  peerOrigin?: SendMessageOptions["peerOrigin"];
  startedAt: string;
  pendingTurnHighWaterId: number;
  sawResult?: boolean;
  interruptedPersisted?: boolean;
  /** Per-run SUSPICION threshold. Set for a detached background subagent so a
   *  quiet runtime is questioned (and the warning reported to the parent) much
   *  sooner than the 20-minute global default. It no longer arms a timer: it is
   *  read when the plan is resolved, and the LivenessController does the timing. */
  idleTimeoutMs?: number;
  nonInteractive?: boolean;
  blockedFreshnessAction?: FreshnessBlockedAction;
  freshnessContinuationUsed?: boolean;
  /** How many freshness-continuation turns have already chained to reconcile a
   *  blocked outbound draft. Bounded by MAX_FRESHNESS_CONTINUATIONS. */
  freshnessContinuationCount?: number;
  /** Per-turn auto-allow cache, keyed by toolName. User clicking "Allow" on
   *  a permission dialog adds the tool name here; subsequent canUseTool calls
   *  with the same toolName during this turn skip the dialog. Cleared when
   *  the turn ends (running session destroyed in sendMessage's finally).
   *  Deny is NOT cached — the model gets per-call rejection feedback and may
   *  reasonably retry with different input. */
  autoAllowedTools: Set<string>;
  clearResumeOnAbort?: boolean;
}

interface LiveTranscript {
  current: string;
  finalized: string[];
}

interface LiveContextState {
  model: string;
  windowInput: EffectiveWindowContext;
  promptTokens: number;
  streamedTokens: number;
  pendingStreamText: string;
  lastEmitAt: number;
  lastEmittedUsed: number;
}

interface InterruptedTurnPayload {
  type: "system";
  subtype: "interrupted_turn";
  reason: string;
  runId: string;
  userSeq: number;
  userRequest: string;
  partialAssistantText?: string;
  interruptedAt: string;
  peerOrigin?: SendMessageOptions["peerOrigin"];
}

interface PeerSourceSnapshot {
  sourceRunState: "running" | "interrupted" | "completed" | "empty";
  lastCompletedAssistantText?: string;
  latestInterruptedContext?: InterruptedTurnPayload;
  liveText?: string;
  sourceUserRequest?: string;
  sourceOutput?: string;
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
  drainQueued?: boolean;
  interruptedReason?: string;
}

type SendMessageOptions = {
  peerOrigin?: {
    fromAgentId: string;
    fromAgentName: string;
    mode: PeerMode;
    messageId?: string;
    correlationId?: string;
    correlationKind?: PeerCorrelationKind;
    replyToCorrelationId?: string;
    sourceRunId?: string;
    causalRunId?: string;
    coalescibleSourceOutput?: boolean;
  };
  /** Marks a turn that carries an automatic "your detached subagent reached a
   *  terminal state" notice. Same delivery semantics as `peerOrigin` (run now
   *  when idle, queue when busy) but WITHOUT the peer freshness/correlation
   *  machinery — a terminal notification must never be deferred or dropped.
   *  Consecutive notices are coalesced into one turn. */
  subagentOrigin?: { childId: string; childName: string };
  autoRecoveryAttempt?: "codex-event-stream-lagged" | "codex-thread-writer-conflict";
  suppressUserMessage?: boolean;
  freshnessContinuationForRunId?: string;
  freshnessContinuationCount?: number;
  nonInteractive?: boolean;
  suppressRuntimeMetadata?: boolean;
};

type PeerSendOptions = {
  includeSource?: PeerIncludeSource;
  interrupt?: boolean;
  interruptReason?: string;
  messageId?: string;
  correlationId?: string;
  correlationKind?: PeerCorrelationKind;
  replyToCorrelationId?: string;
  causalRunId?: string;
};

type FreshnessBlockedAction = {
  tool: "peer_send" | "ask_user";
  targetAgentId?: string;
  targetAgentName?: string;
  correlationId?: string;
  replyToCorrelationId?: string;
  /** Preserved outbound peer_send draft. When a peer_send is freshness-blocked
   *  the body/mode would otherwise be discarded — recovery then depends on the
   *  agent reconstructing it from volatile context (silent loss if the context
   *  was compacted or the agent misjudges). Keeping the exact draft lets the
   *  automatic freshness-continuation turn re-present it verbatim so the message
   *  is never dropped; it is delivered once the peer inbox settles. */
  peerSendDraft?: { body: string; mode: PeerMode };
};

/** Upper bound on chained freshness-continuation turns. Each continuation
 *  re-presents the preserved draft alongside any freshly-arrived inbound peer
 *  messages; if the resend is blocked again by yet-newer inbound, the draft is
 *  carried into the next continuation. The cap prevents a pathological loop if
 *  a peer never stops sending, without ever silently discarding the draft
 *  during normal operation (the inbox settles within a round or two). */
const MAX_FRESHNESS_CONTINUATIONS = 5;

type DrainQueuedOptions = {
  preferPeerAfterId?: number;
  freshnessContinuationRun?: RunningSession;
};

type QueuedPeerTurn = {
  row: DbPendingTurn;
  origin: NonNullable<SendMessageOptions["peerOrigin"]>;
};

function normalizeQueuedTurnOpts(raw: unknown): SendMessageOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: SendMessageOptions = {};
  const autoRecoveryAttempt = (raw as { autoRecoveryAttempt?: unknown }).autoRecoveryAttempt;
  if (
    autoRecoveryAttempt === "codex-event-stream-lagged" ||
    autoRecoveryAttempt === "codex-thread-writer-conflict"
  ) {
    out.autoRecoveryAttempt = autoRecoveryAttempt;
  }
  if ((raw as { suppressUserMessage?: unknown }).suppressUserMessage === true) {
    out.suppressUserMessage = true;
  }
  const subagentOrigin = (raw as { subagentOrigin?: unknown }).subagentOrigin;
  if (subagentOrigin && typeof subagentOrigin === "object") {
    const s = subagentOrigin as Record<string, unknown>;
    if (typeof s.childId === "string" && typeof s.childName === "string") {
      out.subagentOrigin = { childId: s.childId, childName: s.childName };
    }
  }
  const peerOrigin = (raw as { peerOrigin?: unknown }).peerOrigin;
  if (peerOrigin && typeof peerOrigin === "object") {
    const p = peerOrigin as Record<string, unknown>;
    const mode = p.mode;
    if (
      typeof p.fromAgentId === "string" &&
      typeof p.fromAgentName === "string" &&
      (mode === "continue" || mode === "review" || mode === "fork" || mode === "raw")
    ) {
      out.peerOrigin = {
        fromAgentId: p.fromAgentId,
        fromAgentName: p.fromAgentName,
        mode,
        ...(typeof p.messageId === "string" ? { messageId: p.messageId } : {}),
        ...(typeof p.correlationId === "string" ? { correlationId: p.correlationId } : {}),
        ...(p.correlationKind === "decision" || p.correlationKind === "request"
          ? { correlationKind: p.correlationKind }
          : {}),
        ...(typeof p.replyToCorrelationId === "string" ? { replyToCorrelationId: p.replyToCorrelationId } : {}),
        ...(typeof p.sourceRunId === "string" ? { sourceRunId: p.sourceRunId } : {}),
        ...(typeof p.causalRunId === "string" ? { causalRunId: p.causalRunId } : {}),
        ...(p.coalescibleSourceOutput === true ? { coalescibleSourceOutput: true } : {}),
      };
    }
  }
  const freshnessContinuationForRunId = (raw as { freshnessContinuationForRunId?: unknown }).freshnessContinuationForRunId;
  if (typeof freshnessContinuationForRunId === "string") {
    out.freshnessContinuationForRunId = freshnessContinuationForRunId;
  }
  const freshnessContinuationCount = (raw as { freshnessContinuationCount?: unknown }).freshnessContinuationCount;
  if (typeof freshnessContinuationCount === "number" && Number.isFinite(freshnessContinuationCount)) {
    out.freshnessContinuationCount = freshnessContinuationCount;
  }
  if ((raw as { nonInteractive?: unknown }).nonInteractive === true) {
    out.nonInteractive = true;
  }
  if ((raw as { suppressRuntimeMetadata?: unknown }).suppressRuntimeMetadata === true) {
    out.suppressRuntimeMetadata = true;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function peerCorrelationFamily(peerOrigin: {
  correlationId?: string;
  replyToCorrelationId?: string;
}): Set<string> {
  const family = new Set<string>();
  if (peerOrigin.correlationId?.trim()) family.add(peerOrigin.correlationId.trim());
  if (peerOrigin.replyToCorrelationId?.trim()) family.add(peerOrigin.replyToCorrelationId.trim());
  return family;
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
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

/** The per-agent reasoning override, read through the ONE shared rule.
 *
 *  There is no local whitelist here any more: a level is an open token
 *  (`@agentorch/shared` → reasoning.ts), and which tokens a MODEL supports is a
 *  capability question answered by the registry, not by a list in this file.
 *
 *  Three stored shapes all read as "no override":
 *    • the key is absent            — nothing was ever set
 *    • the value is the literal
 *      "inherit" (or null)          — the same state, never a second shape
 *    • the value is not a legal
 *      token                        — a hand-edited file. Reading it as a level
 *                                     would send a level that does not exist;
 *                                     inventing one would be worse. The same
 *                                     policy the transport reader uses. */
export interface StoredReasoningOverride {
  /** The level a runtime will send; null when nothing is sent. */
  level: ReasoningEffort | null;
  /** Set when the stored value is present but unusable — the hand-edited case
   *  above. Nothing is sent AND nothing is rewritten, but the value is reported
   *  so a reader can say why. Returning only `level` would make this shape
   *  indistinguishable from "inherit", which reads as if the user had chosen
   *  the runtime default when in fact their setting was dropped. */
  unusable: { raw: unknown; reason: string } | null;
}

export const readReasoningOverride = (metadata: unknown): StoredReasoningOverride => {
  if (metadata && typeof metadata === "object" && "reasoningEffort" in metadata) {
    const raw = (metadata as { reasoningEffort: unknown }).reasoningEffort;
    const parsed = parseReasoningChoice(raw);
    if (parsed.kind === "level") return { level: parsed.level, unusable: null };
    return { level: null, unusable: parsed.kind === "invalid" ? { raw, reason: parsed.reason } : null };
  }
  return { level: null, unusable: null };
};

export const readReasoningEffortOverride = (metadata: unknown): ReasoningEffort | null =>
  readReasoningOverride(metadata).level;

/** The user's wall-clock ceiling on one run, as stored on the agent.
 *
 *  Read with the same policy the reasoning reader uses for a hand-edited file:
 *  three shapes all mean "no ceiling" and nothing is invented from them.
 *    • the key is absent            — nothing was ever set
 *    • the value is null            — the same state, the shape "clear" writes
 *    • the value is not a positive
 *      integer                      — a file edited by hand. Coercing it would
 *                                     arm a deadline the user never typed, and
 *                                     the phase-4 rule is explicit that only an
 *                                     explicit user decision may end a run for
 *                                     taking too long. The write path refuses
 *                                     these; this is the second line of defence.
 *
 *  The value is a duration in milliseconds, and it is read on the turn path —
 *  an absent key costs one property lookup and produces `null`. */
export const readMaxRunDurationMsOverride = (metadata: unknown): number | null => {
  if (!metadata || typeof metadata !== "object" || !("maxRunDurationMs" in metadata)) return null;
  const raw = (metadata as { maxRunDurationMs: unknown }).maxRunDurationMs;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return null;
  return raw;
};

/** A reasoning patch the model's capabilities do not allow.
 *
 *  Structured on purpose: the UI has to be able to say WHICH model lacks WHICH
 *  level and on whose authority, and the API turns it into a 400 rather than the
 *  500 a bare throw would produce. Nothing is persisted when this is thrown —
 *  `patchAgent` refuses before the write. */
export interface ReasoningRejectionDetail {
  code: "REASONING_EFFORT_UNSUPPORTED";
  /** What the caller asked for, verbatim. */
  requested: string;
  /** The model the value was checked against. */
  model: string;
  /** The levels that model is known to support; empty when the value was not
   *  even a legal token, or when there is no ladder to compare against. */
  supportedLevels: string[];
  /** Where `supportedLevels` (or the syntax rule) comes from. */
  source: string;
  reason: string;
}

export class ReasoningEffortRejected extends Error {
  readonly detail: ReasoningRejectionDetail;
  constructor(detail: ReasoningRejectionDetail) {
    super(detail.reason);
    this.name = "ReasoningEffortRejected";
    this.detail = detail;
  }
}

export function isReasoningRejection(err: unknown): err is ReasoningEffortRejected {
  return err instanceof ReasoningEffortRejected;
}

/** A change that would invalidate stored settings, submitted without the user's
 *  confirmation. Carries the report so the caller can show the SAME prompt the
 *  preflight would have shown — a second computation here is a second answer. */
export class SettingsInvalidationRejected extends Error {
  readonly impact: SettingsImpactReport;
  constructor(impact: SettingsImpactReport) {
    super(
      "this change would invalidate stored settings that the user has not confirmed: " +
        impact.invalidated.map((i) => `${i.field} (${i.current} → ${i.next ?? "(cleared)"}: ${i.reason})`).join("; "),
    );
    this.name = "SettingsInvalidationRejected";
    this.impact = impact;
  }
}

export function isSettingsInvalidationRejection(err: unknown): err is SettingsInvalidationRejected {
  return err instanceof SettingsInvalidationRejected;
}

/** Check a reasoning value against the model's capability registry.
 *
 *  Deliberately says NOTHING about the provider kind: a kind can only decide
 *  whether an adapter knows how to express a setting (which is the adapter's
 *  job, reported as a structured runtime error), never which levels a model
 *  has. The old kind whitelist both excluded `openai-local` by omission and let
 *  an unsupported level through on the kinds it did list. */
function assertReasoningAllowed(
  model: string,
  providerId: string | null,
  effort: string,
): void {
  const known = reasoningLevelsEntry(model, vendorScopeForModel(model), { providerId });
  // `ok: false` means a user override exists but is unusable. That is not
  // evidence the model lacks the level, so the value is allowed through — the
  // plan reports the broken override as a rejected capability fact instead.
  if (!known || !known.ok || known.levels.includes(effort)) return;
  throw new ReasoningEffortRejected({
    code: "REASONING_EFFORT_UNSUPPORTED",
    requested: effort,
    model,
    supportedLevels: known.levels,
    source: known.source,
    reason:
      `model "${model}" supports the reasoning levels ${known.levels.join(", ")} ` +
      `(${known.source}); "${effort}" is not one of them`,
  });
}

const readProviderDefaultSandbox = (metadata: unknown): SandboxMode => {
  if (metadata && typeof metadata === "object" && "defaultSandbox" in metadata) {
    const m = (metadata as { defaultSandbox: unknown }).defaultSandbox;
    if (typeof m === "string" && VALID_SANDBOX_MODES.has(m as SandboxMode)) {
      return m as SandboxMode;
    }
  }
  return CODEX_DEFAULT_SANDBOX;
};

/** The reasoning half of `/status` now lives in `shared/src/run-plan-view.ts`,
 *  beside the rest of the plan's UI contract, so the core and the UI cannot end
 *  up with two declarations of it. Re-exported here because every existing
 *  caller (and the tests) import it from this module. */
export type { ReasoningReport };
export { reasoningReport };

const planModeNotice = (permissionMode: PermissionMode): string =>
  permissionMode === "plan"
    ? "You are in PLAN MODE.\n\n" +
      "Rules:\n" +
      "- Read / Grep / Glob freely to investigate.\n" +
      "- Do NOT call Edit, Write, or Bash - those tools will be denied while planning.\n" +
      "- When you have a clear approach, call ExitPlanMode with a markdown plan.\n" +
      "- The user reviews the plan and approves before any code is written."
    : "";

/** Exported so `/status` and a caller that has to reconstruct the same hash
 *  (tests, and any future client that explains WHY a resume was dropped) use the
 *  one implementation instead of a copy that drifts. */
export const hashStableSystemPrompt = (opts: {
  permissionMode: PermissionMode;
  teamContext: string;
  baseSystemPrompt: string;
  projectInstructions?: string | null;
}): string => {
  const tailRole = opts.teamContext || opts.baseSystemPrompt;
  const promptStableSig = [
    buildEnsemblePrimer(),
    planModeNotice(opts.permissionMode),
    opts.projectInstructions ?? "",
    tailRole,
  ].join("\n\n---\n\n");
  return createHash("sha1").update(promptStableSig).digest("hex").slice(0, 16);
};

const readMetaString = (metadata: unknown, key: string): string | null => {
  if (metadata && typeof metadata === "object" && key in (metadata as object)) {
    const v = (metadata as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  }
  return null;
};

export const buildCodexResumeSignature = (opts: {
  providerId: string | null;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  sandboxMode: SandboxMode;
  cwd: string;
  systemPromptHash: string;
}): string => {
  const stable = {
    version: CODEX_RESUME_SIGNATURE_VERSION,
    providerId: opts.providerId ?? "",
    model: opts.model,
    reasoningEffort: opts.reasoningEffort ?? "",
    sandboxMode: opts.sandboxMode,
    cwd: opts.cwd,
    systemPromptHash: opts.systemPromptHash,
    mcpShape: "ensemble-codex-stdio-v1",
  };
  return createHash("sha1").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
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

type RuntimeErrorDetails = {
  runtimeCode?: RuntimeErrorCode;
  runtimeRecoverable?: boolean;
  runtimeResumeScoped?: boolean;
  /** Structured classification of a failed provider request. Carried on the
   *  error object so a caller downstream cannot reduce "the endpoint answered
   *  404 for /responses" to a message string and lose what decided it. */
  transportClassification?: TransportErrorClass;
  httpStatus?: number | null;
  upstreamCode?: string | null;
  upstreamType?: string | null;
  transport?: string;
};

class MessagePersistenceError extends Error {
  readonly code = "MESSAGE_PERSISTENCE_FAILED" as const;

  constructor(stage: string, cause: unknown) {
    super(
      `could not persist the ${stage} message: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "MessagePersistenceError";
  }
}

const runtimeErrorFromEvent = (event: RuntimeErrorEvent): Error & RuntimeErrorDetails => {
  const err = new Error(event.message) as Error & RuntimeErrorDetails;
  if (event.code !== undefined) err.runtimeCode = event.code;
  if (event.recoverable !== undefined) err.runtimeRecoverable = event.recoverable;
  if (event.resumeScoped !== undefined) err.runtimeResumeScoped = event.resumeScoped;
  if (event.classification !== undefined) err.transportClassification = event.classification;
  if (event.httpStatus !== undefined) err.httpStatus = event.httpStatus;
  if (event.upstreamCode !== undefined) err.upstreamCode = event.upstreamCode;
  if (event.upstreamType !== undefined) err.upstreamType = event.upstreamType;
  if (event.transport !== undefined) err.transport = event.transport;
  return err;
};

export const isRuntimeResumeRecoverySignal = (
  code: unknown,
  recoverable: unknown,
  resumeScoped: unknown,
  usedResumeSessionId: string | null,
): boolean =>
  usedResumeSessionId !== null &&
  code === "RESUME_TURN_INTERRUPTED" &&
  recoverable === true &&
  resumeScoped === true;

export const isRuntimeCodexEventStreamRecoverySignal = (
  code: unknown,
  recoverable: unknown,
): boolean => code === "CODEX_EVENT_STREAM_LAGGED" && recoverable === true;

export const isRuntimeCodexThreadWriterConflictSignal = (
  code: unknown,
  recoverable: unknown,
): boolean => code === "CODEX_THREAD_WRITER_CONFLICT" && recoverable === true;

// Legacy fallback for runtimes/CLI versions that still flatten transport
// failures to text. New Codex recovery uses RuntimeErrorEvent.code instead.
export const isResumeScopedStreamFailure = (rawMsg: string, usedResumeSessionId: string | null): boolean => {
  if (!usedResumeSessionId) return false;
  const msg = rawMsg.toLowerCase();
  if (isTransientTimeoutFailure(msg)) return false;
  return (
    msg.includes("stream disconnected before completion") ||
    msg.includes("failed to send websocket request") ||
    msg.includes("os error 10053") ||
    msg.includes("connection reset") ||
    msg.includes("connection aborted")
  );
};

const isTransientTimeoutFailure = (msg: string): boolean =>
  msg.includes("request timed out") ||
  msg.includes("timed out") ||
  /\btimeout\b/.test(msg);

/** The rows that count as prior context for the next turn: completed turns
 *  only, plus the latest unresolved interrupted turn (whose partial output is
 *  exactly what a "continue" has to resume from), with the user row it belongs
 *  to removed so the request is not stated twice.
 *
 *  Extracted so the two consumers below — the runtime's message list and the
 *  budget resolver's turn list — filter identically. They used to be two code
 *  paths, which is how the plan could report a different history than the
 *  runtime received. */
const completedHistoryRows = (
  rows: Array<{ type: string; payload: unknown; seq?: number }>,
): Array<{ type: string; payload: unknown; seq?: number }> => {
  const lastResultIndex = rows.map((row) => row.type).lastIndexOf("result");
  const latestUnresolvedInterruptedIndex = findLatestInterruptedTurnIndex(rows, lastResultIndex + 1);
  let completedRows =
    lastResultIndex >= 0
      ? rows.slice(0, lastResultIndex + 1).filter((row) => {
          if (row.type !== "system") return true;
          return parseInterruptedTurnPayload(row.payload) === null;
        })
      : rows.slice(0, trailingCompleteHistoryEnd(rows));
  if (latestUnresolvedInterruptedIndex >= 0) {
    const latestInterrupted = rows[latestUnresolvedInterruptedIndex]!;
    const interruptedPayload = parseInterruptedTurnPayload(latestInterrupted.payload);
    if (interruptedPayload) {
      const matchingUserIndex = rows.findIndex((row) => {
        if (row.type !== "user") return false;
        const seqMatches = typeof row.seq === "number" && row.seq === interruptedPayload.userSeq;
        const textMatches = messageRowText(row).trim() === interruptedPayload.userRequest.trim();
        return seqMatches || textMatches;
      });
      const rowsBeforeInterruptedUser =
        matchingUserIndex >= 0
          ? rows.slice(0, matchingUserIndex).filter((row) => row.type !== "result")
          : completedRows;
      completedRows = [...rowsBeforeInterruptedUser, latestInterrupted];
    }
  }
  return completedRows;
};

export const runtimeHistoryFromCompletedTurns = (
  rows: Array<{ type: string; payload: unknown; seq?: number }>,
): SdkMessage[] => runtimeHistoryTurnsFromCompletedRows(rows).map((entry) => entry.message);

/** The same prior context, in the shape the budget resolver needs. */
export const runtimeHistoryTurnsFromCompletedRows = (
  rows: Array<{ type: string; payload: unknown; seq?: number }>,
): RuntimeHistoryTurn[] => runtimeHistoryTurns(completedHistoryRows(rows));

export const buildRuntimeHistoryForTurn = (
  rows: Array<{ type: string; payload: unknown; seq?: number }>,
): SdkMessage[] => runtimeHistoryFromCompletedTurns(rows);

/** One prior turn, in both shapes the turn needs: the budget resolver measures
 *  and counts the `turn`, the runtime is handed the `message`. They are built
 *  together so the two can never describe different sets. */
export interface RuntimeHistoryTurn {
  turn: HistoryTurn;
  message: SdkMessage;
}

/** Rows → turns, with the seq each turn came from (so the compact path can
 *  name the range it must cover) and nothing truncated. */
function runtimeHistoryTurns(
  rows: Array<{ type: string; payload: unknown; seq?: number }>,
): RuntimeHistoryTurn[] {
  const out: RuntimeHistoryTurn[] = [];
  for (const row of rows) {
    const message = rowToRuntimeHistoryMessage(row);
    if (!message) continue;
    const turn = historyTurnForRow(row, message);
    if (!turn.pinned && !turn.text.trim()) continue;
    out.push({ turn, message });
  }
  return out;
}

function historyTurnForRow(
  row: { type: string; payload: unknown; seq?: number },
  message: SdkMessage,
): HistoryTurn {
  const seq = typeof row.seq === "number" ? row.seq : null;
  const text = runtimeHistoryMessageText(message);
  const payload = row.payload as { subtype?: unknown; text?: unknown } | null;
  if (row.type === "system" && payload?.subtype === "compact") {
    const range = compactRangeOf(payload);
    return {
      seq,
      kind: "summary",
      text,
      // Continuity: the summary is where the conversation came from, and a
      // budget that evicts it leaves the model with a thread it cannot follow.
      pinned: true,
      covers: range?.count ?? 0,
      summary: {
        generation: range?.generation ?? 0,
        fromSeq: range?.fromSeq ?? 0,
        toSeq: range?.toSeq ?? 0,
        count: range?.count ?? 0,
        sourceHash: range?.sourceHash ?? "",
        summaryVersion: range?.summaryVersion ?? 0,
      },
    };
  }
  if ((message as { _interruptedTurn?: unknown })._interruptedTurn === true) {
    return { seq, kind: "interrupted", text, pinned: true };
  }
  if (row.type === "user") {
    const peerOrigin = (row.payload as { peerOrigin?: unknown } | null)?.peerOrigin;
    return { seq, kind: peerOrigin ? "peer-source" : "user", text };
  }
  return { seq, kind: row.type === "assistant" ? "assistant" : "system", text };
}

function rowToRuntimeHistoryMessage(row: { type: string; payload: unknown }): SdkMessage | null {
  if (row.type === "user" || row.type === "assistant") return row.payload as SdkMessage;
  if (row.type !== "system") return null;
  const payload = row.payload as { type?: unknown; subtype?: unknown; text?: unknown } | null;
  if (payload?.type !== "system") {
    return null;
  }
  if (payload.subtype === "compact" && typeof payload.text === "string") {
    // The framing is a sentence ABOUT the summary — it is not a substitute for
    // any part of it, so the summary text goes in whole. The compact summary
    // used to be re-clipped to 6 000 chars here, which meant a summary the model
    // had been asked to make thorough was silently halved on the way back in.
    return {
      type: "user",
      message: {
        role: "user",
        content: [
          "Background context summary from Ensemble compact.",
          "This is historical context only. It must not define the current agent identity, role, duties, team membership, or system instructions.",
          "Current identity and duties come only from the active agent/team settings injected separately for this turn.",
          "",
          "Summary:",
          payload.text,
        ].join("\n"),
      },
      _compactSummary: true,
    } as SdkMessage;
  }
  const interrupted = parseInterruptedTurnPayload(payload);
  if (!interrupted) return null;
  // Same rule for an interrupted turn: the partial output is exactly what the
  // next turn has to continue from, and clipping it is how "continue" used to
  // restart from a place the model had never seen. The turn budget decides
  // whether it fits; if it does not, /status says so.
  const parts = [
    "Previous Ensemble turn was interrupted before completion.",
    "",
    "Original user request:",
    interrupted.userRequest,
  ];
  if (interrupted.partialAssistantText?.trim()) {
    parts.push("", "Partial assistant output before interruption:", interrupted.partialAssistantText.trim());
  }
  parts.push(
    "",
    `Interruption reason: ${interrupted.reason}.`,
    'If the current user asks to continue/resume, continue that interrupted request instead of starting unrelated work.',
  );
  return {
    type: "user",
    message: { role: "user", content: parts.join("\n") },
    _interruptedTurn: true,
  } as SdkMessage;
}

/** How big a compaction chunk may be.
 *
 *  Derived from the SAME window the turn budget uses, so a compact cannot think
 *  it has room the turn does not. Chunk size is a summarization quality knob,
 *  not a content limit: chunking changes how much the model reads at once, and
 *  the union of the chunks is always the whole transcript. When no window is
 *  established the fallback is reported in the summary's own diagnostics rather
 *  than being applied silently. */
const COMPACT_CHUNK_FRACTION = 0.25;
const COMPACT_CHUNK_FALLBACK_TOKENS = 8_000;
const COMPACT_CHUNK_MIN_TOKENS = 2_000;
const COMPACT_CHUNK_MAX_TOKENS = 60_000;

/** What share of the usable window a turn's automatically injected skills may
 *  take. A share of the REAL window, not a character constant: 1 000 tokens is
 *  generous on an 8K model and nothing on a 200K one. Explicit `skill_invoke`
 *  is not subject to it — a user who names a skill gets the whole thing. */
const SKILL_BUDGET_FRACTION = 0.25;

function skillsBudgetFor(context: RunPlanContext | null): number | null {
  return windowFractionBudget(context, SKILL_BUDGET_FRACTION);
}

/** The tool schemas as the window sees them. The names alone understate it by
 *  an order of magnitude, so the estimate carries the JSON envelope each tool
 *  description occupies. It is a measured-adjacent number either way: the point
 *  is that it is subtracted and shown, not that it is to the token. */
function toolSchemaOverheadText(toolNames: string[]): string {
  return JSON.stringify(
    toolNames.map((name) => ({
      name,
      description: "…",
      input_schema: { type: "object", properties: {} },
      __envelope: "tool schema as serialized into the request",
    })),
  );
}

/** Whether the Responses route can genuinely continue a server-side
 *  conversation for this plan.
 *
 *  This is a claim about IMPLEMENTATION, not about the provider's family. The
 *  Responses path now does obtain and reuse a response id (`previous_response_id`,
 *  see runtimes/openai.ts), and that id is bound to the resolved provider +
 *  model + project root + system-prompt hash by
 *  `capability/server-conversation.ts`. Whether the ROUTE earns the claim is
 *  decided by evidence the endpoint itself provides (`serverConversationFacts`),
 *  never by the provider's family name. */
function supportsServerConversationFor(plan: ResolvedRunPlan): boolean {
  if (plan.identity.runtime !== "openai") return false;
  // A server-side conversation only exists on an HTTP route. The native CLIs
  // resume their own sessions (a different strategy with a different owner), and
  // `unknown` is not a route anyone can continue.
  if (plan.transport.resolved !== "responses") return false;
  // `runtime-observed`, `provider-discovered` or `catalog-confirmed` only: a
  // value that came from a user preference or from the `unknown` rung is a wish,
  // not a finding, and a continuation named on the strength of a wish would
  // silently drop the transcript the route never stored. `provider-discovered`
  // qualifies here for the same reason it qualifies in transport.ts: it is what
  // the endpoint's own identity (api.openai.com over Responses) establishes,
  // not something a user asked for.
  const origin = plan.facts.supportsServerConversation.origin;
  return (
    plan.facts.supportsServerConversation.value === true &&
    (origin === "runtime-observed" || origin === "provider-discovered" || origin === "catalog-confirmed")
  );
}

function isPromptTooLongResult(msg: { type?: string; is_error?: unknown; result?: unknown }): boolean {
  if (msg.type !== "result" || msg.is_error !== true) return false;
  return typeof msg.result === "string" && /prompt is too long/i.test(msg.result);
}

/** Why the turn is using the strategy it is. Printed by /status verbatim, so a
 *  reader can tell a genuine native session from a local rebuild. */
function historyStrategyReasonFor(args: {
  strategy: RunPlanHistoryStrategy;
  resumeInvalidReason: string | null;
  isOpenAIKind: boolean;
}): string {
  if (args.strategy === "runtime-session") {
    return "the native CLI session is resumed, so it holds the conversation; the plan's budget describes the same transcript without claiming to be the context";
  }
  if (args.strategy === "server-conversation") {
    return "a server-side conversation id this process holds was reused for this route";
  }
  if (args.resumeInvalidReason !== null) {
    return `the cached resume was invalidated (${args.resumeInvalidReason}), so this turn rebuilds the transcript locally`;
  }
  if (args.isOpenAIKind) {
    return "this route carries the transcript in the request body; no server-side continuation id is held for it";
  }
  return "no resumable native session is cached for this agent, so the transcript is rebuilt locally";
}

function compactChunkBudgets(context: RunPlanContext | null): { chunkTokens: number; mergeTokens: number } {
  const window = context?.effectiveWindow ?? null;
  if (window === null) {
    return { chunkTokens: COMPACT_CHUNK_FALLBACK_TOKENS, mergeTokens: COMPACT_CHUNK_FALLBACK_TOKENS };
  }
  const usable = window - (context?.outputReserve ?? 0);
  const chunkTokens = Math.min(
    COMPACT_CHUNK_MAX_TOKENS,
    Math.max(COMPACT_CHUNK_MIN_TOKENS, Math.floor(usable * COMPACT_CHUNK_FRACTION)),
  );
  return { chunkTokens, mergeTokens: chunkTokens };
}

function runtimeOwnsNativeCompact(runtime: string): boolean {
  return runtime === "claude" || runtime === "codex";
}

/** The compact generation a summary row carries, when it has one. Summaries
 *  written before phase 3 have the text but no range: they are reported as
 *  generation 0 with a zero range rather than invented numbers. */
function compactRangeOf(payload: unknown): {
  generation: number;
  fromSeq: number;
  toSeq: number;
  count: number;
  sourceHash: string;
  summaryVersion: number;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.subtype !== "compact") return null;
  const range = p.messageRange as { fromSeq?: unknown; toSeq?: unknown; count?: unknown } | undefined;
  return {
    generation: typeof p.generation === "number" ? p.generation : 0,
    fromSeq: typeof range?.fromSeq === "number" ? range.fromSeq : 0,
    toSeq: typeof range?.toSeq === "number" ? range.toSeq : 0,
    count: typeof range?.count === "number" ? range.count : 0,
    sourceHash: typeof p.sourceHash === "string" ? p.sourceHash : "",
    summaryVersion: typeof p.summaryVersion === "number" ? p.summaryVersion : 0,
  };
}

function runtimeHistoryMessageText(msg: SdkMessage): string {
  return chatTextForLocalRebuild(msg)?.text ?? "";
}

function messageRowText(row: { type: string; payload: unknown }): string {
  if (row.type === "user") {
    const content = (row.payload as { message?: { content?: unknown } })?.message?.content;
    return typeof content === "string" ? content : "";
  }
  if (row.type === "assistant") return assistantTextFromMessage(row.payload);
  if (row.type === "system") {
    const payload = row.payload as { type?: unknown; subtype?: unknown; text?: unknown } | null;
    if (payload?.type === "system" && payload.subtype === "compact" && typeof payload.text === "string") {
      return payload.text;
    }
    const interrupted = parseInterruptedTurnPayload(payload);
    if (interrupted) {
      return [interrupted.userRequest, interrupted.partialAssistantText ?? ""].filter(Boolean).join("\n\n");
    }
    return "";
  }
  return "";
}

function transcriptLinesFromRows(rows: Array<{ type: string; payload: unknown }>): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const text = messageRowText(row).trim();
    if (!text) continue;
    if (row.type === "user") lines.push(`User: ${text}`);
    else if (row.type === "assistant") lines.push(`Assistant: ${text}`);
    else if (row.type === "system") lines.push(`Prior context: ${text}`);
  }
  return lines;
}

// trimRuntimeHistory / clampRuntimeHistoryMessage used to live here: a 28-message,
// 18 000-char, 6 000-char-per-message trimmer applied to every runtime history.
// They are gone. Sizing history is the budget resolver's job
// (`capability/history-budget.ts`), which measures against the real window and
// reports what it left out, instead of guessing with character constants and
// saying nothing.

function parseInterruptedTurnPayload(payload: unknown): InterruptedTurnPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "system" || p.subtype !== "interrupted_turn") return null;
  if (typeof p.reason !== "string" || typeof p.runId !== "string" || typeof p.userRequest !== "string") return null;
  if (typeof p.userSeq !== "number" || typeof p.interruptedAt !== "string") return null;
  const partialAssistantText = typeof p.partialAssistantText === "string" ? p.partialAssistantText : undefined;
  const peerOrigin =
    p.peerOrigin && typeof p.peerOrigin === "object"
      ? normalizeQueuedTurnOpts({ peerOrigin: p.peerOrigin })?.peerOrigin
      : undefined;
  return {
    type: "system",
    subtype: "interrupted_turn",
    reason: p.reason,
    runId: p.runId,
    userSeq: p.userSeq,
    userRequest: p.userRequest,
    ...(partialAssistantText ? { partialAssistantText } : {}),
    interruptedAt: p.interruptedAt,
    ...(peerOrigin ? { peerOrigin } : {}),
  };
}

function findLatestInterruptedTurnIndex(rows: Array<{ type: string; payload: unknown }>, startIndex = 0): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (i < startIndex) break;
    const row = rows[i]!;
    if (row.type === "system" && parseInterruptedTurnPayload(row.payload)) return i;
  }
  return -1;
}

function trailingCompleteHistoryEnd(rows: Array<{ type: string }>): number {
  let end = rows.length;
  while (end > 0 && rows[end - 1]?.type === "user") end--;
  return end;
}

/** The agent's canonical project root as configured, or null when unbound.
 *
 *  Read from `projectRoot` ONLY. The legacy `codexWorkspace` column is not
 *  consulted here: the backfill in db.ts already moved every value that was
 *  there into the canonical column, and reading both would make the alias a
 *  second source again. */
const projectRootOf = (row: { projectRoot: string | null }): { path: string; invalid: ProjectRootInvalid | null } | null => {
  const stored = row.projectRoot?.trim();
  if (!stored) return null;
  return { path: stored, invalid: inspectProjectRoot(stored) };
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
  projectRoot: row.projectRoot,
  // Compatibility echo for a client that has not been updated yet: the SAME
  // canonical value, never the retired column. An old client can therefore
  // neither read a stale directory nor write one back (its writes are
  // translated, see reconcileProjectRootInput).
  codexWorkspace: row.projectRoot,
  permissionMode: readPermissionMode(row.metadata),
  sandboxMode: readSandboxOverride(row.metadata),
  reasoningEffort: readReasoningEffortOverride(row.metadata),
  // The user's wall-clock ceiling on one run. Emitted on the SUMMARY (not only
  // in `/status`) because it is a stored agent setting like the ones above it,
  // and because the cloud sync has to carry it: a setting that only exists in
  // one of the two places an agent is described is a setting the synced copy
  // silently lacks. Same name, same semantics, both sides.
  maxRunDurationMs: readMaxRunDurationMsOverride(row.metadata),
  teamId: row.teamId,
  subagentKind: readMetaBool(row.metadata, "backgroundTask")
    ? "background"
    : readMetaString(row.metadata, "spawnedAsTaskFor") !== null
      ? "task"
      : null,
  forcedSkills: Array.from(readSkillForcelist(row.metadata)),
  disabledSkills: Array.from(readSkillBlocklist(row.metadata)),
  closed: readMetaBool(row.metadata, "closed"),
  hasResumeInfo: readMetaString(row.metadata, "lastSessionId") !== null,
  createdAt: row.createdAt.toISOString(),
});

export class SessionManager {
  private running = new Map<string, RunningSession>();

  /** Per-kind runtime/CLI version cache — see runtimeVersionFor. */
  private runtimeVersionCache = new Map<string, string | null>();
  private queuedTurns = new Map<string, Map<number, (result: { finalText: string } | null) => void>>();
  private drainingQueues = new Map<string, string>();
  private pendingDrainOptions = new Map<string, DrainQueuedOptions>();
  private liveTranscripts = new Map<string, LiveTranscript>();
  private readonly streamWs = createStreamEventWsBatcher({
    send: (sessionId, payload) => this.hub.sendToSession(sessionId, payload),
  });
  private pending = new Map<string, Map<string, PendingPermission>>();
  private pendingQuestions = new Map<string, Map<string, PendingUserQuestion>>();
  private contextUsageByAgent = new Map<string, ContextUsage>();
  private liveContextByAgent = new Map<string, LiveContextState>();
  /** The plan the LAST turn actually ran under, per agent. `/status` reads this
   *  rather than resolving its own: a status report that re-derives the
   *  transport can disagree with the request the runtime sent, which is the
   *  bug the plan exists to remove. */
  private runPlanByAgent = new Map<string, ResolvedRunPlan>();
  /** The most recent automatic transport switch, per agent. A route change the
   *  user did not ask for has to be visible somewhere; `/status` is that place. */
  private transportFallbackByAgent = new Map<string, TransportFallbackInfo>();

  /** Long-running work whose OWNER IS THIS PROCESS, not a turn — see jobs.ts.
   *
   *  Deliberately a field of the manager and not of `runMessageNow`: a job is
   *  spawned by core, so recycling a session (context overflow, provider swap,
   *  turn abort) cannot reach it. The only writer of a terminal state is the
   *  child's own close event or an explicit cancel. `onUpdate` fires exactly on
   *  those transitions plus boot reconciliation, which is why it is the single
   *  place a transcript notice is emitted from. */
  readonly jobs = new JobManager({
    onUpdate: (job) => {
      this.notifyJobSettled(job);
    },
  });

  /** Phase 4: THE liveness authority. One per process; every run registers here
   *  and `/status` reads its snapshot. Nothing else in this file forms an
   *  opinion about whether a run is alive — the timers that used to live here
   *  are gone, and the runtime's own observations arrive as signals. */
  private readonly liveness = new LivenessController({
    onTerminate: (t) => {
      this.handleLivenessTermination(t);
    },
    onStateChange: (snapshot, previous) => {
      this.broadcastLivenessState(snapshot, previous);
    },
  });

  constructor(
    private hub: WSHub,
    private runtimeResolver: (kind: string) => AgentRuntime = chooseRuntime,
  ) {
    this.liveness.start();
    // Runs that were open when the previous core process died did NOT finish.
    // Reporting them as such is the whole reason the record is persisted, so
    // the recovery happens here, at construction, before anything can start a
    // new run and before any status read can be answered from a stale map.
    this.liveness.recoverOrphans();
  }

  /** What a run's liveness looks like right now, for `/status`. Reads the one
   *  controller — never a re-derivation from `this.running`, which is a
   *  bookkeeping map and knows nothing about silence or evidence. */
  livenessReportFor(agentId: string): {
    live: LivenessSnapshot | null;
    last: LivenessSnapshot | null;
    description: string | null;
  } {
    return this.liveness.report(agentId);
  }

  /** Phase 4: stop the single watchdog on the way down.
   *
   *  Deliberately does NOT close the open `RunLiveness` rows. A run that was in
   *  flight when the process went away did not finish, and the next boot's
   *  `recoverOrphans` is what says so — writing `completed` here would make a
   *  killed process indistinguishable from a turn that produced its result. */
  dispose(): void {
    this.streamWs.flushAll();
    this.liveness.stop();
  }

  /** The bridge from "the controller concluded this run is dead" to the
   *  abort/kill tree. The controller decides; the session layer acts. */
  private handleLivenessTermination(t: {
    runId: string;
    agentId: string;
    code: LivenessTerminalReason;
    reason: string;
    snapshot: LivenessSnapshot;
  }): void {
    const r = this.running.get(t.agentId);
    if (!r || r.runId !== t.runId) {
      console.warn(
        `[liveness] ${t.code} for agent=${t.agentId.slice(0, 8)} run=${t.runId.slice(0, 8)} ` +
          `but that run is no longer the live one; recording only: ${t.reason}`,
      );
      return;
    }
    this.liveness.noteStopRequested(t.runId);
    try {
      r.abort.abort();
    } catch {
      /* signal already aborted */
    }
    void this.forceStopRun(t.agentId, {
      expectedRunId: t.runId,
      dbStatus: "ERROR",
      protoStatus: "error",
      logPrefix: `liveness-${t.code}`,
      error: { code: t.code, message: t.reason },
    });
  }

  /** Every state transition, on the wire, as it happens.
   *
   *  Phase 4 first wrote the warning into the TRANSCRIPT as a `liveness_status`
   *  system message. That was wrong twice over:
   *
   *    * it put a row in the message stream whose `seq` was read from the DB
   *      (`nextMessageSeq`) while the live turn held its own local `seq` for the
   *      same agent, so the next event the turn persisted collided with it on
   *      the `(agentId, seq)` unique index — the same race as pre-dispatch
   *      compact;
   *    * it delivered STATE as transcript noise, and only for one of the states,
   *      so the UI had to read a message to learn something `/status` already
   *      knew.
   *
   *  There is no second durable copy here: `RunLiveness` is the record. This is
   *  the live channel, and it carries the server's own projection (built by the
   *  controller, from the snapshot it just made, against its own clock) rather
   *  than the inputs a client would have to interpret. */
  private broadcastLivenessState(snapshot: LivenessSnapshot, previous: string): void {
    console.log(
      `[liveness] agent=${snapshot.agentId.slice(0, 8)} run=${snapshot.runId.slice(0, 8)} ` +
        `${previous} → ${snapshot.state}`,
    );
    // No `state === previous` re-check: the controller calls this from a real
    // transition only (`setState`, `terminate` and `end` each return early when
    // nothing changed), and a rule copied here is a rule that can disagree.
    this.hub.sendToSession(snapshot.agentId, {
      type: "liveness_update",
      sessionId: snapshot.agentId,
      liveness: this.liveness.updateFor(snapshot),
    });
  }

  /** The plan a turn resolved, on the wire, as the ONE view-model.
   *
   *  Without this the UI had to ask `/status` for a snapshot that is only
   *  written when the turn STARTS, so the settings page showed a stale plan for
   *  the whole first turn and had nothing at all before it. Worse, a component
   *  with no plan available tends to infer one from the provider kind or the
   *  model name — which is exactly the second resolver the view-model exists to
   *  remove.
   *
   *  `source: "last-turn"` always: this is a turn's OWN plan, the snapshot the
   *  runtime was handed, never a status read's prediction. */
  private broadcastRunPlan(sessionId: string, plan: ResolvedRunPlan): void {
    this.hub.sendToSession(sessionId, {
      type: "run_plan",
      sessionId,
      plan: runPlanStatusView({ plan, source: "last-turn" }),
    });
  }

  /** Build the reporting surface a runtime is handed for ONE run. Every call
   *  lands on the controller, keyed by this run: a runtime never touches state,
   *  it only says what it saw. */
  private makeLivenessReporter(runId: string, hooks: LivenessRunHooks): RuntimeOptions["liveness"] {
    return {
      childProcessStarted: (info) => this.liveness.noteChildProcess(runId, { kind: "started", pid: info.pid }),
      childProcessExited: (info) =>
        this.liveness.noteChildProcess(runId, {
          kind: "exited",
          pid: info.pid,
          exitCode: info.exitCode,
          signal: info.signal,
        }),
      streamClosed: (abnormal) => this.liveness.noteStreamClosed(runId, abnormal),
      resultSeen: () => this.liveness.noteResultSeen(runId),
      toolProgress: () => this.liveness.noteToolProgress(runId),
      registerProbe: (probe) => {
        hooks.probe = () => probe();
      },
    };
  }

  /** Resolve the turn's ONE capability snapshot.
   *
   *  Everything a turn needs to know about what it may do — the transport
   *  above all — is decided here and nowhere else. The probe this may run is
   *  the only network call it adds, and only for `openai-compat` + `auto` with
   *  no fresh verdict; `allowProbe: false` is for side-channel queries that
   *  must not touch the network before a real turn needs the answer. */
  private async resolveTurnPlan(input: {
    provider: { id: string; kind: string; baseUrl: string | null; apiKey: string | null; metadata?: unknown } | null;
    model: string;
    reasoningEffort: ReasoningEffort | null;
    allowProbe: boolean;
    /** The agent this plan is for. Required so the plan can name the agent's
     *  scratch directory: an unbound agent's working directory is a fact about
     *  the agent, and leaving it out would make every unbound turn unrunnable. */
    agentId: string;
    /** The agent's configured project root plus its inspection verdict, from
     *  `projectRootOf`. Omitted = unbound. */
    projectRoot?: { path: string; invalid: ProjectRootInvalid | null } | null;
    /** The user's explicit wall-clock ceiling for this run, from
     *  `readMaxRunDurationMsOverride`. Omitted/null = NO ceiling, which is the
     *  default and the only state in which a clock cannot end a run (see
     *  capability/liveness.ts). The plan records where the number came from, so
     *  a run ended with RUNTIME_WALL_CLOCK_LIMIT can name its authority. */
    maxRunDurationMs?: number | null;
  }): Promise<ResolvedRunPlan> {
    const kind = input.provider?.kind ?? "anthropic-local";
    const runtime = runtimeScopeForKind(kind);
    const transportPreference = readProviderTransportPreference(input.provider?.metadata);
    const transportFacts = await resolveTransportFacts({
      runtime,
      providerId: input.provider?.id ?? null,
      providerKind: input.provider?.kind ?? null,
      baseUrl: input.provider?.baseUrl ?? null,
      apiKey: input.provider?.apiKey ?? null,
      model: input.model,
      preference: transportPreference,
      allowProbe: input.allowProbe,
    });
    const preferences: {
      transport?: TransportPreference;
      reasoningEffort?: string;
      maxRunDurationMs?: number | null;
    } = {};
    if (transportPreference) preferences.transport = transportPreference;
    if (input.reasoningEffort) preferences.reasoningEffort = input.reasoningEffort;
    // Carried as the user's preference, not as a policy this file decided: the
    // planner resolves it (and rejects a nonsensical value rather than coercing
    // one), and the plan's `liveness.hardDeadlineMs` is the only thing the
    // run ever consults. `undefined` is left off entirely so "never set" and
    // "set to null" stay distinguishable in the plan's diagnostics.
    if (input.maxRunDurationMs !== undefined) preferences.maxRunDurationMs = input.maxRunDurationMs;
    return resolveRunPlan({
      // Phase 4: the two idle-timeout environment variables survive as SUSPICION
      // thresholds and nothing else. They no longer represent a deadline, so
      // they are passed as the number after which a run is questioned — and the
      // source travels with the value so `/status` can say where it came from
      // instead of presenting an env default as a decision.
      livenessSuspectedAfterMs: this.livenessSuspectAfter(input.agentId),
      providerId: input.provider?.id ?? null,
      runtime,
      runtimeVersion: await this.runtimeVersionFor(kind),
      model: input.model,
      transportFacts,
      preferences,
      // The runtime's own compaction trigger, resolved HERE so the plan and the
      // native parameter the CLI is handed cannot be two different numbers.
      // Supplied by the caller for the same reason the project root is: the
      // planner reads no files and probes no CLI.
      compactionThreshold: compactionThreshold(input.model, {
        runtime,
        vendor: vendorScopeForModel(input.model),
        runtimeVersion: await this.runtimeVersionFor(kind),
      }),
      // The plan records what the caller inspected; it never touches the disk
      // itself. See project-root.ts for why the verdict, not the path, is what
      // travels.
      projectRoot: {
        configured: input.projectRoot ?? null,
        scratchPath: scratchDirFor(input.agentId),
      },
      // Whether this route can continue a SERVER-stored conversation. Resolved
      // here because this is the layer that holds the provider row (its base URL
      // and the rejection it last gave us); the planner only carries the answer.
      // The transport value read is the one the plan will report, so the fact and
      // the route it describes cannot disagree.
      serverConversationFacts: serverConversationSupportFact({
        runtime,
        transport: transportFacts.value ?? "unknown",
        baseUrl: input.provider?.baseUrl ?? null,
        providerMetadata: input.provider?.metadata ?? null,
      }),
    });
  }

  /** Phase 4: the silence threshold a run of this session is SUSPECTED after.
   *
   *  That is the whole job this number has left. It used to arm a per-session
   *  timer whose expiry called `forceStopRun` with `RUNTIME_IDLE_TIMEOUT` — a
   *  clock, not evidence, ending a turn. The timing now lives in exactly one
   *  place (`LivenessController`), fed from the plan's `suspectedAfterMs`, and
   *  this method only decides which threshold the plan is resolved with. A
   *  detached background subagent keeps its shorter threshold; the per-session
   *  override it sets is read here and nowhere else. */
  private getRuntimeIdleTimeoutMs(sessionId?: string): number {
    if (sessionId) {
      const override = this.running.get(sessionId)?.idleTimeoutMs;
      if (override) return override;
    }
    return readRuntimeIdleTimeoutMs();
  }

  /** Which threshold a run of this agent is suspected after, and where the
   *  number came from. `undefined` hands the policy its own default, which is
   *  the honest answer when neither the per-run override nor the environment
   *  said anything. */
  private livenessSuspectAfter(
    agentId: string,
  ): { value: number; source: "default" | "env-compat" | "background-task" } | undefined {
    const override = this.running.get(agentId)?.idleTimeoutMs;
    if (override) return { value: override, source: "background-task" };
    if (process.env.ENSEMBLE_RUNTIME_IDLE_TIMEOUT_MS) {
      return { value: readRuntimeIdleTimeoutMs(), source: "env-compat" };
    }
    return undefined;
  }

  private beginDrain(sessionId: string): string {
    const token = randomUUID();
    this.drainingQueues.set(sessionId, token);
    return token;
  }

  private finishDrain(sessionId: string, token: string): void {
    if (this.drainingQueues.get(sessionId) === token) {
      this.drainingQueues.delete(sessionId);
      const options = this.pendingDrainOptions.get(sessionId);
      this.pendingDrainOptions.delete(sessionId);
      this.drainQueuedTurns(sessionId, options);
    }
  }

  private pendingTurnHighWaterId(sessionId: string): number {
    const row = prisma.pendingTurn.findFirst({
      where: { agentId: sessionId },
      orderBy: { id: "desc" },
    });
    return row?.id ?? 0;
  }

  async createAgent(opts: {
    name: string;
    systemPrompt?: string;
    model?: string;
    parentId?: string;
    providerId?: string;
    projectRoot?: string;
    /** Legacy alias of `projectRoot`. Translated, never stored as-is; see
     *  reconcileProjectRootInput for the conflict rule. */
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
    // No provider-kind gate: a project root is where the work happens, and
    // every runtime can be pointed at a directory. Which KIND of provider runs
    // the agent has nothing to do with whether it has a project.
    const projectRoot = reconcileProjectRootInput(opts.projectRoot, opts.codexWorkspace);
    let teamId: string | null | undefined = opts.teamId;
    if (teamId) {
      const teamRow = await prisma.team.findUnique({ where: { id: teamId } });
      if (!teamRow) throw new Error(`team ${teamId} not found`);
    }
    const row = await prisma.agent.create({
      data: {
        name: opts.name,
        systemPrompt: opts.systemPrompt,
        model: opts.model ?? "claude-opus-4-8",
        parentId: opts.parentId,
        providerId,
        // `codexWorkspace: null` when an explicit root is given, for the same
        // reason patchAgent does it: the value a legacy client sent must not be
        // left on the row for a later backfill to re-read.
        ...(projectRoot !== undefined ? { projectRoot, codexWorkspace: null } : {}),
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
      await this.clearResumeForTeamMembers(id);
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
      const updated = await prisma.agent.update({
        where: { id: m.id },
        data: {
          teamId: null,
          metadata: removeMetadataKeys(m.metadata, [...RESUME_METADATA_KEYS]),
        },
      });
      this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
    }
    await prisma.team.delete({ where: { id } });
    this.hub.broadcast({ type: "team_deleted", teamId: id });
    return true;
  }

  private async clearResumeForTeamMembers(teamId: string, excludeAgentId?: string): Promise<void> {
    const members = await prisma.agent.findMany({ where: { teamId } });
    for (const m of members) {
      if (m.id === excludeAgentId) continue;
      const updated = await prisma.agent.update({
        where: { id: m.id },
        data: { metadata: removeMetadataKeys(m.metadata, [...RESUME_METADATA_KEYS]) },
      });
      this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
    }
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
    lines.push("HARD BOUNDARY: peer_send / peer_query reach ONLY the teammates listed");
    lines.push("above. Never message an agent outside this team — even one with the");
    lines.push("same name. Same name, other team = a different agent. The tool refuses");
    lines.push("it. Do not guess UUIDs of outsiders.");
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
    lines.push("       includeSource defaults to auto: raw=false, continue/review/fork=true.");
    lines.push("       Emergency only: interrupt=true requires interruptReason and may");
    lines.push("       stop the target's current run. Do not use it for ordinary messages.");
    lines.push("");
    lines.push("  peer_query(target=\"<name>\", limit=<N>)");
    lines.push("       Read-only DB pull of teammate's recent text turns. Does NOT");
    lines.push("       trigger them. Use when you need more context before acting.");
    lines.push("  conversation_search(query=\"<keywords>\", scope=\"team|self|agent\", target?)");
    lines.push("       Read-only keyword lookup across prior user/assistant messages. Does NOT run agents.");
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
    lines.push("Raw peer_send does not embed source-output by default. For continue/review/fork,");
    lines.push("`message` is the cover note and Ensemble adds a bounded source-output block.");
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

  /** The stored settings a proposed change would invalidate, and why.
   *
   *  Bookkeeping over the agent row, the target provider and the model registry.
   *  It writes nothing and resolves no plan, so it is safe to run on every write
   *  path — which is the point: `patchAgent` refuses to write until the user has
   *  confirmed exactly these fields, and a guard that could itself fail would be
   *  a guard that sometimes does not run.
   *
   *  Each entry is a value the write would LOSE. `next: null` is not a
   *  prediction: it is a promise about the write, and `patchAgent` honours it by
   *  clearing that field only once the field appears in `confirmInvalidated`. */
  private async settingsInvalidations(
    cur: DbAgent,
    patch: SettingsImpactRequest,
  ): Promise<SettingInvalidation[]> {
    const out: SettingInvalidation[] = [];
    const targetProviderId = patch.providerId !== undefined ? patch.providerId : cur.providerId;
    const targetModel = patch.model ?? cur.model;
    const targetProvider = targetProviderId
      ? await prisma.provider.findUnique({ where: { id: targetProviderId } })
      : null;

    // A per-agent Codex sandbox override cannot survive a move to a provider
    // that is not Codex. This is the clear that used to happen silently.
    const currentSandbox = readSandboxOverride(cur.metadata);
    if (
      patch.sandboxMode === undefined &&
      patch.providerId !== undefined &&
      currentSandbox !== null &&
      targetProvider?.kind !== "openai-codex"
    ) {
      out.push({
        field: "sandbox",
        current: currentSandbox,
        next: null,
        code: "SANDBOX_OVERRIDE_INVALID_FOR_PROVIDER",
        reason:
          `a per-agent sandbox override is only valid for an openai-codex agent, and this change selects a ` +
          `${targetProvider?.kind ?? "provider this server cannot resolve"} provider — the override would be cleared`,
      });
    }

    // A reasoning level the new model's ladder does not contain. Nothing forces
    // this clear today, which is the worst version: the level stays stored and
    // the plan silently drops it at turn time, so the user's setting is inert
    // with nothing to point at. Announcing it and clearing it on confirmation is
    // the same outcome, said out loud.
    const currentReasoning = readReasoningEffortOverride(cur.metadata);
    if (
      patch.reasoningEffort === undefined &&
      (patch.model !== undefined || patch.providerId !== undefined) &&
      currentReasoning !== null
    ) {
      try {
        assertReasoningAllowed(targetModel, targetProviderId, currentReasoning);
      } catch (err) {
        if (isReasoningRejection(err)) {
          out.push({
            field: "reasoning",
            current: currentReasoning,
            next: null,
            code: err.detail.code,
            reason:
              `${err.detail.reason} — keeping "${currentReasoning}" would store a level this model does not have, ` +
              "so the change clears it unless you confirm",
          });
        }
      }
    }

    // An unusable project root is NOT an invalidation: a model or provider
    // switch cannot make a directory stop existing, and turns already refuse
    // with the verdict in the plan. Reporting it here would ask the user to
    // confirm something the change did not cause.
    return out;
  }

  /** What a proposed change would cost, computed WITHOUT writing anything.
   *
   *  This is also the only plan-PREVIEW entry there is. The settings form calls
   *  it as the draft changes, so "this would clear your reasoning level" and
   *  "this value cannot be set at all" are things the user reads before they
   *  happen rather than discoveries they make afterwards. Null = no such agent.
   *
   *  Read-only in the strict sense: it resolves through the same
   *  `resolveTurnPlan` chain a turn uses with `allowProbe: false`, so it never
   *  writes, never probes, and never fetches. The plan it returns is labelled
   *  `source: "preview"` because the configuration it was resolved from is an
   *  uncommitted draft — a plan to look at, not a plan an agent is running. */
  async agentSettingsImpact(
    id: string,
    patch: SettingsImpactRequest,
  ): Promise<SettingsImpactReport | null> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return null;
    const invalidated = await this.settingsInvalidations(cur, patch);

    // The plan the proposal would resolve to. Best effort BY DESIGN: some
    // proposals legitimately cannot resolve before they are written (an unknown
    // provider kind), and that is reported rather than thrown — the invalidation
    // list is what the confirmation is FOR, and it does not depend on this.
    let nextPlan: RunPlanStatusView | null = null;
    let resolutionError: string | null = null;
    try {
      const providerId = patch.providerId !== undefined ? patch.providerId : cur.providerId;
      const provider = providerId ? await prisma.provider.findUnique({ where: { id: providerId } }) : null;
      const clearingReasoning = invalidated.some((i) => i.field === "reasoning");
      const parsed = patch.reasoningEffort === undefined ? null : parseReasoningChoice(patch.reasoningEffort);
      const reasoningEffort =
        patch.reasoningEffort === undefined
          ? clearingReasoning
            ? null
            : readReasoningEffortOverride(cur.metadata)
          : parsed?.kind === "level"
            ? parsed.level
            : null;
      const proposedRoot = patch.projectRoot !== undefined ? patch.projectRoot : cur.projectRoot;
      const storedRoot = proposedRoot?.trim();
      const plan = await this.resolveTurnPlan({
        provider,
        model: patch.model ?? cur.model,
        reasoningEffort,
        maxRunDurationMs:
          patch.maxRunDurationMs !== undefined ? patch.maxRunDurationMs : readMaxRunDurationMsOverride(cur.metadata),
        allowProbe: false,
        agentId: id,
        projectRoot: storedRoot ? { path: storedRoot, invalid: inspectProjectRoot(storedRoot) } : null,
      });
      nextPlan = runPlanStatusView({ plan, source: "preview" });
    } catch (err) {
      resolutionError = err instanceof Error ? err.message : String(err);
    }

    return {
      invalidated,
      requiresConfirmation: invalidated.length > 0,
      nextPlan,
      resolutionError,
      rejection: this.previewRejection(cur, patch),
    };
  }

  /** Whether a proposal is one the WRITE path would refuse, asked of the same
   *  validators the write path uses.
   *
   *  Not a second rule book: `assertReasoningAllowed` is the function
   *  `patchAgent` throws from (`REASONING_EFFORT_UNSUPPORTED`), and the project
   *  root's code comes off the very verdict the plan carries. The point is that
   *  the form can show the refusal the API would answer with before the user
   *  submits, instead of letting them submit and read a 400 as a failure.
   *
   *  Only values THIS proposal names are considered: a rejected capability the
   *  plan reports about the agent's existing configuration is not a reason to
   *  block an unrelated edit. */
  private previewRejection(
    cur: { model: string; providerId: string | null },
    patch: SettingsImpactRequest,
  ): SettingsImpactReport["rejection"] {
    const model = patch.model ?? cur.model;
    const providerId = patch.providerId !== undefined ? patch.providerId : cur.providerId;
    if (patch.reasoningEffort !== undefined) {
      const parsed = parseReasoningChoice(patch.reasoningEffort);
      if (parsed?.kind === "level") {
        try {
          assertReasoningAllowed(model, providerId, parsed.level);
        } catch (err) {
          if (isReasoningRejection(err)) {
            return { field: "reasoning", code: err.detail.code, detail: err.detail.reason };
          }
          throw err;
        }
      } else if (parsed?.kind === "invalid") {
        return { field: "reasoning", code: "REASONING_EFFORT_INVALID", detail: parsed.reason };
      }
    }
    if (patch.projectRoot !== undefined && patch.projectRoot !== null) {
      const trimmed = patch.projectRoot.trim();
      const invalid = trimmed ? inspectProjectRoot(trimmed) : null;
      if (invalid) return { field: "project", code: invalid.code, detail: invalid.reason };
    }
    if (patch.maxRunDurationMs !== undefined && patch.maxRunDurationMs !== null) {
      const asked = Number(patch.maxRunDurationMs);
      if (!Number.isFinite(asked) || asked <= 0) {
        return {
          field: "liveness",
          code: "MAX_RUN_DURATION_INVALID",
          detail:
            `a run deadline must be a positive number of milliseconds or null; ` +
            `${JSON.stringify(patch.maxRunDurationMs)} is neither, so it would be refused with a 400`,
        };
      }
    }
    // Everything else the preview plan reports as rejected (a transport the
    // route will not take, a history budget it clamps) is a fact about how the
    // turn WOULD run, not a refusal of this write: `patchAgent` applies the
    // patch and the plan records the rejection. Blocking the write on it would
    // refuse an edit the API accepts, so only the three refusals above — the
    // ones the write path really throws — are returned here. The rest reaches
    // the user through `nextPlan.diagnostics` / `nextPlan.settings`.
    return null;
  }

  async patchAgent(
    id: string,
    patch: {
      /** Fields the user has CONFIRMED losing, from `agentSettingsImpact`. A
       *  write that would invalidate anything not named here is refused. */
      confirmInvalidated?: RunPlanSettingField[];
      model?: string;
      permissionMode?: PermissionMode;
      name?: string;
      providerId?: string | null;
      projectRoot?: string | null;
      /** Legacy alias of `projectRoot`; translated by reconcileProjectRootInput. */
      codexWorkspace?: string | null;
      sandboxMode?: SandboxMode | null;
      reasoningEffort?: ReasoningEffort | null;
      /** The user's wall-clock ceiling on one run, in milliseconds; `null`
       *  clears it. Absent is the default and means NO ceiling — the only state
       *  in which a clock cannot end a run. */
      maxRunDurationMs?: number | null;
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
      projectRoot?: string | null;
      /** Written ONLY as null, to tombstone the legacy column (see the
       *  project-root block below). Never carries a path. */
      codexWorkspace?: string | null;
      systemPrompt?: string | null;
      teamId?: string | null;
    } = {};
    // Confirm-on-invalidate, before ANY write-side bookkeeping runs. Several
    // branches below drop a stored value (a sandbox override on a provider
    // switch today; a reasoning level the new model cannot take), and the rule is
    // that the user is told which fields and why BEFORE the value goes. Nothing
    // below this point has touched the database, so refusing here is a complete
    // refusal: no partial patch, and no silently cleared field.
    const invalidated = await this.settingsInvalidations(cur, patch);
    if (invalidated.length > 0) {
      const confirmed = new Set(patch.confirmInvalidated ?? []);
      const unconfirmed = invalidated.filter((i) => !confirmed.has(i.field));
      if (unconfirmed.length > 0) {
        throw new SettingsInvalidationRejected({
          invalidated,
          requiresConfirmation: true,
          nextPlan: null,
          resolutionError: null,
          // The refusal here is about an UNCONFIRMED clear, not about a value the
          // plan rejected: `rejection` names the latter. The client already has
          // `invalidated` to render.
          rejection: null,
        });
      }
    }
    /** Fields the user confirmed losing. Their clears below are announced, not
     *  silent — which is the whole difference this gate buys. */
    const confirmedClear = new Set(invalidated.map((i) => i.field));
    let nextMetadata: object | undefined;
    const mergeNextMetadata = (patchMeta: Record<string, unknown>): void => {
      nextMetadata = mergeMetadata(nextMetadata ?? cur.metadata, patchMeta);
    };
    const removeNextMetadataKeys = (keys: string[]): void => {
      nextMetadata = removeMetadataKeys(nextMetadata ?? cur.metadata, keys);
    };
    const clearResumeMetadata = (): void => {
      removeNextMetadataKeys([...RESUME_METADATA_KEYS]);
    };
    if (patch.model !== undefined) {
      data.model = patch.model;
      // Native CLI resume threads are not model-agnostic. Reusing a cached
      // thread after changing the agent model can make Codex resume an old
      // backend/session shape while Ensemble believes it is running the new
      // model.
      if (patch.model !== cur.model) {
        clearResumeMetadata();
      }
    }
    const nameChanged = patch.name !== undefined && patch.name !== cur.name;
    if (patch.name !== undefined) {
      data.name = patch.name;
      if (nameChanged) {
        clearResumeMetadata();
      }
    }
    if (patch.providerId !== undefined) {
      data.providerId = patch.providerId;
      if (patch.providerId !== cur.providerId) {
        // Native runtime session ids are provider-scoped. Even if the model
        // string happens to match, the prior Claude/Codex/compat session must
        // not be resumed under a different provider implementation.
        clearResumeMetadata();
      }
    }
    if (patch.permissionMode !== undefined) {
      const previousPermissionMode = readPermissionMode(cur.metadata);
      mergeNextMetadata({ permissionMode: patch.permissionMode });
      if (patch.permissionMode !== previousPermissionMode) {
        clearResumeMetadata();
      }
    }
    if (patch.systemPrompt !== undefined) {
      const next = patch.systemPrompt === null ? null : patch.systemPrompt;
      data.systemPrompt = next;
      // The CLI / SDK resumes via lastSessionId, which already locked in the
      // OLD systemPrompt at session start. Drop the resume pointer so the next
      // turn opens a fresh session and the new prompt actually takes effect.
      if (next !== cur.systemPrompt) {
        clearResumeMetadata();
      }
    }
    const teamChanged = patch.teamId !== undefined && patch.teamId !== cur.teamId;
    if (patch.teamId !== undefined) {
      if (patch.teamId !== null) {
        const teamRow = await prisma.team.findUnique({ where: { id: patch.teamId } });
        if (!teamRow) throw new Error(`team ${patch.teamId} not found`);
      }
      data.teamId = patch.teamId;
      // Team membership affects the TEAM CONTEXT injected into systemPrompt
      // at runtime; drop lastSessionId so the next turn rebuilds context fresh.
      if (teamChanged) {
        clearResumeMetadata();
      }
    }
    const targetProviderId = patch.providerId !== undefined ? patch.providerId : cur.providerId;
    const targetProvider = targetProviderId
      ? await prisma.provider.findUnique({ where: { id: targetProviderId } })
      : null;
    // No provider-kind branch here any more. The old code cleared the workspace
    // whenever the agent moved to a non-Codex provider, which silently threw
    // away the user's project on a provider switch — the same class of edit the
    // reasoning contract forbids. A project root belongs to the agent.
    if (patch.projectRoot !== undefined || patch.codexWorkspace !== undefined) {
      const projectRoot = reconcileProjectRootInput(patch.projectRoot, patch.codexWorkspace);
      data.projectRoot = projectRoot ?? null;
      // Tombstone the legacy column in the same write. Not a second source of
      // truth — it is cleared, never set — but it has to be cleared, or the
      // next boot's idempotent backfill would find a stale legacy value beside
      // a now-NULL canonical one and silently REBIND the agent the user just
      // unbound.
      data.codexWorkspace = null;
      if ((projectRoot ?? null) !== cur.projectRoot) {
        // The CLI/SDK resume pointer was opened in the previous directory and
        // cannot be moved to a new one, so a real turn must not reuse it.
        clearResumeMetadata();
      }
    }
    if (patch.sandboxMode !== undefined) {
      if (patch.sandboxMode !== null && targetProvider?.kind !== "openai-codex") {
        throw new Error("sandboxMode override is only valid for openai-codex agents");
      }
      const previousSandbox = readSandboxOverride(cur.metadata);
      if (patch.sandboxMode === null) {
        removeNextMetadataKeys(["sandboxMode"]);
      } else {
        mergeNextMetadata({ sandboxMode: patch.sandboxMode });
      }
      if (patch.sandboxMode !== previousSandbox) {
        // Codex `exec resume` cannot accept a new --sandbox/--cd. Drop the
        // native resume pointer so the next user turn starts a fresh Codex
        // session with the newly selected sandbox.
        clearResumeMetadata();
      }
    } else if (
      patch.providerId !== undefined &&
      targetProvider?.kind !== "openai-codex" &&
      readSandboxOverride(cur.metadata) !== null
    ) {
      // Reached only when the user confirmed it: an unconfirmed clear threw
      // above, so this line is an ANNOUNCED loss, never a silent one. The resume
      // pointer is already gone by here — a providerId change drops it above.
      removeNextMetadataKeys(["sandboxMode"]);
    }
    // A stored reasoning level the target model cannot take, cleared because the
    // user confirmed LOSING it. Without this branch the level would stay in
    // metadata while the plan dropped it at turn time — an inert setting the user
    // could see and not explain. The resume pointer is already gone: a model or
    // provider change drops it above.
    if (patch.reasoningEffort === undefined && confirmedClear.has("reasoning")) {
      removeNextMetadataKeys(["reasoningEffort"]);
    }
    if (patch.reasoningEffort !== undefined) {
      // An open level, validated in three steps and refused BEFORE anything is
      // written: syntax (the token reaches TOML/argv), then the model's ladder
      // when we have one. `null` and the literal "inherit" both mean "clear",
      // and clearing is always allowed.
      const parsed = parseReasoningChoice(patch.reasoningEffort);
      if (parsed.kind === "invalid") {
        throw new ReasoningEffortRejected({
          code: "REASONING_EFFORT_UNSUPPORTED",
          requested: typeof patch.reasoningEffort === "string" ? patch.reasoningEffort : String(patch.reasoningEffort),
          model: patch.model ?? cur.model,
          supportedLevels: [],
          source: `reasoning-level syntax: ${REASONING_SYNTAX_RULE}`,
          reason: parsed.reason,
        });
      }
      const previousReasoningEffort = readReasoningEffortOverride(cur.metadata);
      let nextReasoningEffort: ReasoningEffort | null = null;
      if (parsed.kind === "clear") {
        removeNextMetadataKeys(["reasoningEffort"]);
      } else {
        assertReasoningAllowed(patch.model ?? cur.model, targetProviderId, parsed.level);
        nextReasoningEffort = parsed.level;
        mergeNextMetadata({ reasoningEffort: parsed.level });
      }
      if (nextReasoningEffort !== previousReasoningEffort) {
        clearResumeMetadata();
      }
    }
    if (patch.maxRunDurationMs !== undefined) {
      // The user's own ceiling for a run: a positive whole number of
      // milliseconds, or null to clear. Refused BEFORE the write rather than
      // coerced — a deadline the user did not type is worse than no deadline,
      // and the reader would silently neutralize a bad value, which is exactly
      // the kind of unannounced edit this refuses to make. (The HTTP layer
      // validates the same shape; this catches a value that arrived another
      // way.) Note what does NOT happen here: changing the ceiling does not
      // drop the native resume pointer. Unlike a sandbox or a reasoning level,
      // it is not a parameter the CLI was launched with, so it cannot make a
      // resumed session inconsistent.
      const value = patch.maxRunDurationMs;
      if (value === null) {
        removeNextMetadataKeys(["maxRunDurationMs"]);
      } else if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        mergeNextMetadata({ maxRunDurationMs: value });
      } else {
        throw new Error(
          `maxRunDurationMs must be a positive whole number of milliseconds or null; ${JSON.stringify(value)} is neither`,
        );
      }
    }
    // Switching to a provider kind that cannot EXPRESS the setting no longer
    // deletes the override: expressibility is the adapter's answer and it
    // arrives as a structured runtime error, while silently dropping the user's
    // setting on a provider switch is the kind of unannounced edit the plan
    // forbids. (Phase 5 adds the confirm-on-invalidate UI on top of this.)
    if (nextMetadata !== undefined) data.metadata = nextMetadata;
    if (Object.keys(data).length === 0) return agentRowToSummary(cur);
    const updated = await prisma.agent.update({ where: { id }, data });
    const summary = agentRowToSummary(updated);
    this.hub.broadcast({ type: "agent_updated", agent: summary });
    if (nameChanged && cur.teamId) {
      await this.clearResumeForTeamMembers(cur.teamId, id);
    }
    if (teamChanged) {
      const touchedTeamIds = new Set<string>();
      if (cur.teamId) touchedTeamIds.add(cur.teamId);
      if (patch.teamId) touchedTeamIds.add(patch.teamId);
      for (const teamId of touchedTeamIds) {
        await this.clearResumeForTeamMembers(teamId, id);
      }
    }
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
        data: { metadata: removeMetadataKeys(a.metadata, [...RESUME_METADATA_KEYS]) },
      });
      this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
    }
  }

  async closeAgent(id: string): Promise<AgentSummary | null> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return null;
    // Abort running stream if any. resolvePermission will deny outstanding via cancel().
    this.clearQueuedTurns(id);
    await this.cancel(id);
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

  async resetRuntimeSession(id: string): Promise<AgentSummary | null> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return null;
    if (
      this.running.has(id) ||
      this.drainingQueues.has(id) ||
      this.pending.has(id) ||
      this.pendingQuestions.has(id)
    ) {
      this.clearQueuedTurns(id);
      await this.forceStopRun(id, {
        dbStatus: "IDLE",
        protoStatus: "idle",
        logPrefix: "reset-runtime-session",
        error: {
          code: "RUNTIME_SESSION_RESET",
          message: "Runtime session reset requested. Stopped the active turn and cleared saved resume metadata.",
        },
        drainQueued: false,
        interruptedReason: "runtime session reset",
      });
    }
    const latest = await prisma.agent.findUnique({ where: { id } });
    if (!latest) return null;
    const updated = await prisma.agent.update({
      where: { id },
      data: { metadata: removeMetadataKeys(latest.metadata, [...RESUME_METADATA_KEYS]) },
    });
    const summary = agentRowToSummary(updated);
    this.hub.broadcast({ type: "agent_updated", agent: summary });
    return summary;
  }

  async deleteAgent(id: string): Promise<boolean> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return false;
    this.clearQueuedTurns(id);
    await this.cancel(id);
    // Cascading FKs on Message / Permission / McpServer / PaneState will clean rows.
    await prisma.agent.delete({ where: { id } });
    this.runPlanByAgent.delete(id);
    this.transportFallbackByAgent.delete(id);
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
    this.clearQueuedTurns(id);
    await this.cancel(id);
    await prisma.message.delete({ where: { agentId: id } });
    await prisma.agent.update({
      where: { id },
      data: { metadata: removeMetadataKeys(cur.metadata, [...RESUME_METADATA_KEYS]) },
    });
    this.hub.broadcast({ type: "agent_history_reset", sessionId: id, reason: "clear" });
    this.clearLiveContext(id);
    this.setContextUsage(id, null);
    return true;
  }

  /** /compact — ask the native CLI to compact when a session exists; otherwise
   *  summarize locally. The pane is then replaced with that summary and the
   *  originals move to MessageArchive. */
  async compactAgent(id: string): Promise<{ summary: string } | null> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return null;
    this.clearQueuedTurns(id);
    if (
      this.running.has(id) ||
      this.drainingQueues.has(id) ||
      this.pending.has(id) ||
      this.pendingQuestions.has(id)
    ) {
      await this.cancel(id);
    }
    const runId = randomUUID();
    const startedSeq = this.nextMessageSeq(id);
    this.running.set(id, {
      id,
      runId,
      abort: new AbortController(),
      seq: startedSeq,
      userInput: "/compact",
      startedSeq,
      startedAt: new Date().toISOString(),
      pendingTurnHighWaterId: this.pendingTurnHighWaterId(id),
      autoAllowedTools: new Set<string>(),
    });
    try {
      await this.appendCompactStatusMessage(id, COMPACT_START_TEXT);
      await this.updateAgentStatus(id, "RUNNING", "running");
      await flushVisibleState();
      if (!this.isRunOwner(id, runId)) {
        return { summary: "(compact cancelled)" };
      }
      // The chunk budget comes from the plan, so a compact reads the transcript
      // in the same sized helpings the turn would have had room for. A plan
      // that cannot resolve is not fatal to a compact: the fallback chunk size
      // is recorded in the summary's diagnostics.
      let compactPlan: ResolvedRunPlan | null = null;
      try {
        const provider = cur.providerId ? await prisma.provider.findUnique({ where: { id: cur.providerId } }) : null;
        compactPlan = await this.resolveTurnPlan({
          provider: provider
            ? {
                id: provider.id,
                kind: provider.kind,
                baseUrl: provider.baseUrl,
                apiKey: provider.apiKey,
                metadata: provider.metadata,
              }
            : null,
          model: cur.model,
          reasoningEffort: readReasoningEffortOverride(cur.metadata),
          maxRunDurationMs: readMaxRunDurationMsOverride(cur.metadata),
          allowProbe: false,
          agentId: id,
          projectRoot: projectRootOf(cur),
        });
      } catch (err) {
        console.error(
          `[compact] plan resolution failed for agent=${id.slice(0, 8)}: ` +
            `${err instanceof Error ? err.message : String(err)} — using the fallback chunk budget`,
        );
      }
      // Phase 4: compact is a run too, and it registers with the same single
      // authority the turns do. Its policy comes from the plan when one
      // resolved; the fallback describes a helper run honestly — no wall-clock
      // ceiling, and NO probe capability, which means a health check on it can
      // only ever answer `unknown` and nothing can end it for being quiet. That
      // matters because compact's model calls are bounded by their own explicit
      // deadlines (see quickQuery), not by silence.
      this.liveness.begin({
        runId,
        agentId: id,
        policy:
          compactPlan?.liveness ??
          resolveLivenessPolicy({ runtime: "unknown", hardDeadlineMs: null }),
      });
      const out = await this.compactNow(cur, compactPlan, () => this.isRunOwner(id, runId));
      if (this.isRunOwner(id, runId)) {
        const updated = await prisma.agent.update({ where: { id }, data: { status: "IDLE" } });
        this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
        this.hub.sendToSession(id, { type: "status", sessionId: id, status: "idle" });
      }
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isRunOwner(id, runId)) {
        await this.appendCompactStatusMessage(id, `${COMPACT_FAILURE_PREFIX} ${message}`);
        const updated = await prisma.agent.update({ where: { id }, data: { status: "IDLE" } });
        this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
        this.hub.sendToSession(id, { type: "status", sessionId: id, status: "idle" });
      }
      throw err;
    } finally {
      if (this.isRunOwner(id, runId)) {
        // Phase 4: compact is a run too. It has no runtime process, so its
        // health checks answer `unknown` and NOTHING can end it for being quiet
        // — which is the point of registering it here rather than leaving it
        // outside the liveness record entirely.
        this.liveness.end(runId, "completed", "completed");
        this.running.delete(id);
        this.drainQueuedTurns(id);
      }
    }
  }

  /** Prefer the CLI's own compact when a native session exists. Ensemble only
   *  summarizes when there is no compact owner (OpenAI in-process, or no
   *  lastSessionId). */
  private async compactNow(
    cur: DbAgent,
    plan: ResolvedRunPlan | null,
    shouldContinue?: () => boolean,
    upperBoundSeq?: number,
  ): Promise<{ summary: string }> {
    const resumeId = readMetaString(cur.metadata, "lastSessionId");
    if (plan && runtimeOwnsNativeCompact(plan.identity.runtime) && resumeId) {
      try {
        const native = await this.compactViaNativeSession(cur, plan, resumeId, shouldContinue, upperBoundSeq);
        if (native) return native;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code;
        if (code === "NATIVE_COMPACT_FAILED" || code === "RUNTIME_WALL_CLOCK_LIMIT") throw err;
        console.error(
          `[compact] native CLI compact did not complete for agent=${cur.id.slice(0, 8)}: ${message} — falling back to local summary`,
        );
      }
    }
    return this.compactAgentHistory(cur, plan, shouldContinue, upperBoundSeq);
  }

  private async compactViaNativeSession(
    cur: DbAgent,
    plan: ResolvedRunPlan,
    resumeId: string,
    shouldContinue?: () => boolean,
    upperBoundSeq?: number,
  ): Promise<{ summary: string } | null> {
    const id = cur.id;
    const messages = (
      await prisma.message.findMany({
        where: { agentId: id },
        orderBy: { seq: "asc" },
      })
    ).filter((row) => upperBoundSeq === undefined || row.seq <= upperBoundSeq);
    if (messages.length === 0) {
      return { summary: "(nothing in range — no row was archived and no summary was written)" };
    }

    let resolvedProvider: Awaited<ReturnType<typeof prisma.provider.findUnique>> = null;
    if (cur.providerId) {
      resolvedProvider = await prisma.provider.findUnique({ where: { id: cur.providerId } });
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

    const run = this.running.get(id);
    const abort = run?.abort ?? new AbortController();
    let capturedSummary = "";
    const runtime = this.runtimeResolver(resolvedProvider?.kind ?? "anthropic-local");
    const runtimeOpts: RuntimeOptions = {
      sessionId: id,
      prompt: NATIVE_COMPACT_SLASH,
      model: cur.model,
      permissionMode: "bypassPermissions",
      tools: [],
      allowedTools: [],
      canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
      includePartialMessages: false,
      abortController: abort,
      claudeCliPath: await getClaudeCliPath(),
      codexCliPath: await getCodexCliPath(),
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
      resume: resumeId,
      runPlan: plan,
      captureCompactSummary: (text) => {
        capturedSummary = text;
      },
    };

    const deadlineMs = plan.liveness.hardDeadlineMs;
    let abortReason: string | null = null;
    const timer =
      deadlineMs === null
        ? null
        : setTimeout(() => {
            abortReason = `this compact reached the user's maxRunDurationMs of ${deadlineMs}ms (RUNTIME_WALL_CLOCK_LIMIT)`;
            abort.abort();
          }, deadlineMs);

    let assistantText = "";
    let commandText = "";
    let boundary = false;
    let compactOk = false;
    let compactFailed: string | null = null;
    let resultMsg: unknown = null;
    try {
      for await (const event of runtime.query(runtimeOpts)) {
        if (event.type === "error") {
          if (event.code === "PROJECT_ROOT_NOT_FOUND") return null;
          throw Object.assign(new Error(event.message), { code: event.code });
        }
        const msg = event.payload as Record<string, unknown> | null;
        if (!msg || typeof msg !== "object") continue;
        if (msg.type === "system" && msg.subtype === "compact_boundary") boundary = true;
        if (msg.type === "system" && msg.subtype === "status") {
          if (msg.compact_result === "success") compactOk = true;
          if (msg.compact_result === "failed") {
            compactFailed = typeof msg.compact_error === "string" ? msg.compact_error : "CLI compact failed";
          }
        }
        if (
          msg.type === "system" &&
          (msg.subtype === "local_command_output" || msg.subtype === "informational") &&
          typeof msg.content === "string" &&
          msg.content.trim()
        ) {
          commandText = msg.content.trim();
        }
        if (msg.type === "assistant") {
          const text = assistantTextFromMessage(msg).trim();
          if (text) assistantText = text;
        }
        if (msg.type === "result") resultMsg = msg;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (abortReason !== null) {
      const err = new Error(abortReason) as Error & { code?: string };
      err.code = "RUNTIME_WALL_CLOCK_LIMIT";
      throw err;
    }
    if (compactFailed) {
      const err = new Error(compactFailed) as Error & { code?: string };
      err.code = "NATIVE_COMPACT_FAILED";
      throw err;
    }
    const cliDidCompact = compactOk || boundary || capturedSummary.trim().length > 0;
    if (!cliDidCompact) return null;
    if (shouldContinue && !shouldContinue()) {
      return { summary: capturedSummary || assistantText || commandText || "(compact cancelled)" };
    }

    if (resultMsg) {
      const events = extractUsageEvents(
        {
          agentId: id,
          agentName: cur.name,
          parentId: cur.parentId,
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
          console.warn(`[usage:compact] failed to persist UsageEvent: ${(err as Error).message}`);
        }
      }
    }

    const summary =
      capturedSummary.trim() ||
      commandText ||
      assistantText ||
      "Conversation compacted by the native CLI. Originals are in the Ensemble archive.";
    return this.commitCompactReplacement(cur, messages, summary, {
      diagnostics: [
        `native ${plan.identity.runtime} CLI compacted session ${resumeId.slice(0, 8)} (slash ${NATIVE_COMPACT_SLASH})`,
      ],
      chunkCount: 1,
      layers: [
        {
          level: 0,
          index: 0,
          fromSeq: messages[0]!.seq,
          toSeq: messages[messages.length - 1]!.seq,
          count: messages.length,
          sourceHash: "",
          summaryVersion: SUMMARY_VERSION,
          text: summary,
        },
      ],
      keepResume: true,
    });
  }

  private async commitCompactReplacement(
    cur: DbAgent,
    messages: DbMessage[],
    summary: string,
    extras: {
      diagnostics: string[];
      chunkCount: number;
      layers: unknown[];
      keepResume: boolean;
      sourceHash?: string;
      messageRange?: { fromSeq: number; toSeq: number; count: number };
    },
  ): Promise<{ summary: string }> {
    const id = cur.id;
    const generation = nextGeneration(id);
    const archivedAt = Math.floor(Date.now() / 1000);
    const lastSeq = messages[messages.length - 1]!.seq;
    const fromSeq = messages[0]!.seq;
    const sourceHash =
      extras.sourceHash ??
      sourceHashOf(
        messages.map((row) => ({
          originalSeq: row.seq,
          contentHash: contentHashOf({
            originalMessageId: row.id,
            originalSeq: row.seq,
            type: row.type,
            payload: row.payload,
            createdAt: Math.floor(row.createdAt.getTime() / 1000),
          }),
        })),
      );
    const messageRange = extras.messageRange ?? { fromSeq, toSeq: lastSeq, count: messages.length };
    const layers = (extras.layers as Array<Record<string, unknown>>).map((layer) =>
      layer.sourceHash ? layer : { ...layer, sourceHash },
    );
    const summaryPayload = {
      type: "system" as const,
      subtype: "compact" as const,
      text: summary,
      generation,
      messageRange,
      sourceHash,
      summaryVersion: SUMMARY_VERSION,
      chunkCount: extras.chunkCount,
      layers,
      diagnostics: extras.diagnostics,
    };
    transaction(() => {
      archiveRows(id, generation, messages, archivedAt);
      const stored = readGeneration(id, generation);
      const recomputed = sourceHashOf(stored);
      if (recomputed !== sourceHash) {
        throw new Error(
          `compact refused: the archived records do not reproduce the summarized range ` +
            `(${recomputed.slice(0, 12)} ≠ ${sourceHash.slice(0, 12)})`,
        );
      }
      sqliteDb
        .prepare("DELETE FROM Message WHERE agentId = ? AND seq <= ? AND seq >= ?")
        .run(id, lastSeq, fromSeq);
      sqliteDb.prepare("INSERT INTO Message (agentId, seq, type, payload, createdAt) VALUES (?, ?, ?, ?, ?)").run(
        id,
        lastSeq,
        "system",
        JSON.stringify(summaryPayload),
        archivedAt,
      );
    });
    if (!extras.keepResume) {
      await prisma.agent.update({
        where: { id },
        data: { metadata: removeMetadataKeys(cur.metadata, [...RESUME_METADATA_KEYS]) },
      });
    }
    this.hub.broadcast({
      type: "agent_history_reset",
      sessionId: id,
      reason: "compact",
      summary,
    });
    this.clearLiveContext(id);
    this.setContextUsage(id, null);
    return { summary };
  }

  /** Summarize the whole conversation, in layers that provably cover it, and
   *  replace the summarized rows with the summary — keeping the originals in
   *  MessageArchive, in the same transaction.
   *
   *  Three things changed from the version this replaces, and each of them was
   *  a way for content to disappear:
   *    • the transcript is no longer cut to a 60 000-character head+tail window
   *      before summarizing (the middle of a long conversation was deleted by a
   *      summarizer that never saw it),
   *    • the summary is no longer re-clipped at 6 000 chars on the way back into
   *      the next turn's context, and
   *    • the rows are archived rather than deleted, so the summary can be
   *      checked against what it claims to cover and the originals can be read
   *      or restored afterwards.
   *
   *  `upperBoundSeq` is the INCLUSIVE end of the range this compact owns — and
   *  it is the whole contract with the caller, because getting it wrong is how
   *  a pre-dispatch compact used to archive the very user message that
   *  triggered it:
   *
   *    • the automatic (pre-dispatch) trigger passes the last seq BEFORE the
   *      current user turn, so only prior rows are summarized and the current
   *      request survives in its own row,
   *    • `/compact` passes nothing and covers every active row, which is what a
   *      user typing the command asked for,
   *    • the DELETE uses the SAME bound, and the summary is written at the last
   *      seq the deletion freed — below the current user turn, and never
   *      competing for a seq with the runtime events that follow it.
   */
  private async compactAgentHistory(
    cur: DbAgent,
    plan: ResolvedRunPlan | null,
    shouldContinue?: () => boolean,
    upperBoundSeq?: number,
  ): Promise<{ summary: string }> {
    const id = cur.id;
    const messages = (
      await prisma.message.findMany({
        where: { agentId: id },
        orderBy: { seq: "asc" },
      })
    ).filter((row) => upperBoundSeq === undefined || row.seq <= upperBoundSeq);
    if (messages.length === 0) {
      return { summary: "(nothing in range — no row was archived and no summary was written)" };
    }
    // EVERY row this compact is about to remove is a row the summary has to
    // account for — including one with no readable text (a status notice, a
    // tool-only turn). Filtering those out is how the summary's range came to
    // describe a SMALLER set than the archive held, which the transaction below
    // then rejected: the hash is over the archived records, so the two sets have
    // to be the same set. A text-less row contributes an empty body and still
    // carries its position and its hash into the range the summary claims.
    const turns: CompactSourceTurn[] = messages.map((row) => ({
      messageId: row.id,
      seq: row.seq,
      type: row.type,
      payload: row.payload,
      // Unix seconds, the same value the archive stores, so the content hash
      // computed here is the one recomputed from the archive row.
      createdAt: Math.floor(row.createdAt.getTime() / 1000),
      // The readable body the summarizer sees. `messageRowText` covers the
      // conversation rows; `summarizerTextOf` adds what it drops — tool calls
      // and their results — because a transcript summarized without those loses
      // exactly the paths, commands and error codes a summary is for.
      text: messageRowText(row).trim() || summarizerTextOf(row.payload),
    }));
    if (turns.every((turn) => turn.text.length === 0)) {
      return { summary: "(empty conversation — nothing to compact)" };
    }

    const measurer = makeTokenMeasurer((text) => countTokens(cur.model, text));
    const budgets = compactChunkBudgets(plan?.context ?? null);
    // ONE absolute deadline for the whole compact, fixed here and never
    // re-derived. `plan.liveness.hardDeadlineMs` is a DURATION, so handing it
    // to every layer is how each summarizer call used to get a fresh full
    // window: a four-layer compact under a 90 s ceiling spent 360 s and no
    // layer could tell. From here on the deadline is an INSTANT, and what a
    // layer is given is what is still left of it.
    //
    // `null` — the default, and the answer when the plan never resolved — is
    // no ceiling at all. A summarizer reading a transcript in full is the last
    // call that should be killed for taking a while, and a fixed helper
    // deadline was exactly what the old hardcoded 60 000 ms was.
    const planDeadlineMs = plan?.liveness.hardDeadlineMs ?? null;
    const deadlineAtMs = planDeadlineMs === null ? null : Date.now() + planDeadlineMs;
    const remainingBudgetMs = (): number | null => (deadlineAtMs === null ? null : deadlineAtMs - Date.now());
    const layered = await summarizeLayered({
      turns,
      chunkTokens: budgets.chunkTokens,
      mergeTokens: budgets.mergeTokens,
      summaryVersion: SUMMARY_VERSION,
      measure: measurer.count,
      summarize: async (prompt) => {
        const remaining = remainingBudgetMs();
        // A layer that starts with nothing left does not get a new window: the
        // deadline it is past has already been spent, and the honest answer is
        // the same structured refusal a fired timer would have produced.
        if (remaining !== null && remaining <= 0) {
          const err = new Error(
            `this compact's ${planDeadlineMs}ms deadline (the user's maxRunDurationMs) was already spent before the ` +
              "next summary layer started, and a later layer does not get a fresh full window " +
              "(RUNTIME_WALL_CLOCK_LIMIT)",
          ) as Error & { code?: string };
          err.code = "RUNTIME_WALL_CLOCK_LIMIT";
          throw err;
        }
        const text = (await this.quickQuery(id, prompt, remaining)).trim();
        return text || "(model returned empty summary)";
      },
    });
    if (shouldContinue && !shouldContinue()) {
      return { summary: layered.text };
    }

    return this.commitCompactReplacement(cur, messages, layered.text, {
      diagnostics: [
        ...layered.diagnostics,
        ...(plan === null
          ? ["no run plan was resolved for this compact, so the chunk budget came from the fallback"]
          : []),
      ],
      chunkCount: layered.chunkCount,
      layers: layered.layers,
      keepResume: false,
      sourceHash: layered.sourceHash,
      messageRange: layered.messageRange,
    });
  }

  /** The archived originals of one compaction generation, verbatim.
   *
   *  The read entry the archive exists for: it returns the full records (so a
   *  caller can see exactly what was stored, including tool_use / tool_result
   *  payloads) plus a readable transcript of them, and the source hash
   *  RECOMPUTED from those records — the same value the summary claims. A
   *  mismatch is the honest signal that a summary no longer matches its
   *  originals. */
  async readArchivedGeneration(
    id: string,
    generation: number,
    range?: { fromSeq?: number; toSeq?: number } | null,
  ): Promise<{
    agentId: string;
    generation: number;
    records: Array<{
      originalMessageId: number;
      originalSeq: number;
      type: string;
      payload: unknown;
      createdAt: number;
      archivedAt: number;
      contentHash: string;
    }>;
    text: string;
    sourceHash: string;
  } | null> {
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return null;
    // A half-specified range is still a range: the archive is ordered by
    // originalSeq, so an omitted bound means "from the start" / "to the end".
    const records =
      range && (range.fromSeq !== undefined || range.toSeq !== undefined)
        ? readGenerationRange(id, generation, range.fromSeq ?? null, range.toSeq ?? null)
        : readGeneration(id, generation);
    if (records.length === 0) return null;
    return {
      agentId: id,
      generation,
      records,
      text: renderArchivedTranscript(records),
      sourceHash: sourceHashOf(records),
    };
  }

  /** Which compaction generations this agent has, newest last. */
  async listArchivedGenerations(id: string): Promise<ReturnType<typeof listGenerations>> {
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return [];
    return listGenerations(id);
  }

  /** Put an archived generation back at its original seqs, replacing the compact
   *  summary that stood for it. Returns the outcome (including "already
   *  restored" and "no active summary") rather than a bare count, so a caller
   *  cannot report a no-op as a restore. Null = no such generation. */
  async restoreArchivedGeneration(id: string, generation: number): Promise<RestoreOutcome | null> {
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return null;
    const result = restoreGenerationToActive(id, generation);
    if (!result) return null;
    // Only a restore that actually changed the history is announced as one.
    if (result.status === "restored") {
      this.hub.broadcast({ type: "agent_history_reset", sessionId: id, reason: "restore" });
    }
    return result;
  }

  /** /status — runtime-agnostic snapshot of an agent's current state. */
  async getStatusReport(id: string): Promise<AgentStatusReport | null> {
    const a = await prisma.agent.findUnique({ where: { id } });
    if (!a) return null;
    const provider = a.providerId
      ? await prisma.provider.findUnique({ where: { id: a.providerId } })
      : null;
    const msgCount = await prisma.message.count({ where: { agentId: id } });
    const mcpRows = await prisma.mcpServer.findMany({ where: { enabled: true } });
    const providerKind = provider?.kind ?? null;
    const permissionMode = readPermissionMode(a.metadata);
    const sandboxOverride = readSandboxOverride(a.metadata);
    const providerDefaultSandbox =
      provider?.metadata && typeof provider.metadata === "object"
        ? (provider.metadata as Record<string, unknown>).defaultSandbox
        : undefined;
    const providerHasDefaultSandbox =
      typeof providerDefaultSandbox === "string" &&
      VALID_SANDBOX_MODES.has(providerDefaultSandbox as SandboxMode);
    const isCodex = providerKind === "openai-codex";
    const effectiveSandboxMode = isCodex
      ? sandboxOverride ?? readProviderDefaultSandbox(provider?.metadata)
      : null;
    // The same field the runtimes run in — reported even when the configured
    // root is unusable, which is why it is read off the plan below rather than
    // recomputed here.
    const configuredProjectRoot = projectRootOf(a);
    const teamContext = await this.buildTeamContext(id);
    const storedSystemPromptHash = readMetaString(a.metadata, "systemPromptHash");
    const storedReasoning = readReasoningOverride(a.metadata);
    const roleSource = a.teamId ? "team" : a.systemPrompt?.trim() ? "base" : "empty";
    // The LAST TURN's plan is the honest answer for "what is this agent running
    // as" — it is the snapshot the SDK was driven with. Only when no turn has
    // run yet in this process do we resolve one, and we say so: a fresh
    // resolution is a prediction, not a record. It never probes (a status read
    // must not hit the network), so it cannot establish a new transport fact.
    const lastTurnPlan = this.runPlanByAgent.get(id);
    let plan = lastTurnPlan ?? null;
    let planSource: "last-turn" | "fresh-resolution" | "none" = plan ? "last-turn" : "none";
    if (!plan) {
      try {
        plan = await this.resolveTurnPlan({
          provider,
          model: a.model,
          reasoningEffort: storedReasoning.level,
          maxRunDurationMs: readMaxRunDurationMsOverride(a.metadata),
          allowProbe: false,
          agentId: id,
          projectRoot: configuredProjectRoot,
        });
        planSource = "fresh-resolution";
      } catch {
        // An unresolvable route (unknown provider kind) leaves the status
        // report without a plan rather than failing the whole report. A bad
        // PROJECT ROOT deliberately does not land here: it is a verdict the
        // plan carries (see resolveProjectRoot), so /status still answers.
        plan = null;
      }
    }
    let statusProjectInstructions: string | null = null;
    if (
      plan &&
      (plan.identity.runtime === "openai" || plan.identity.runtime === "claude") &&
      plan.execution.projectRoot.source === "agent"
    ) {
      try {
        statusProjectInstructions = renderProjectInstructionsBlock(
          loadProjectInstructions(plan.execution.projectRoot.value),
        );
      } catch (err) {
        // Status remains readable even when the next turn will refuse to run.
        // Hash the failure marker so a cached native session is never reported
        // as current after its project instructions became unreadable.
        statusProjectInstructions = `<project-instructions-unreadable>${
          err instanceof Error ? err.message : String(err)
        }</project-instructions-unreadable>`;
      }
    }
    const systemPromptHash = hashStableSystemPrompt({
      permissionMode,
      teamContext,
      baseSystemPrompt: a.systemPrompt ?? "",
      projectInstructions: statusProjectInstructions,
    });
    // THE projection, built once here and reused by every field below. Two
    // consumers (this report and the `run_plan` broadcast a turn sends) call the
    // same function on the same plan, which is what makes the settings page and
    // `/status` agree by construction rather than by discipline.
    const view = plan ? runPlanStatusView({ plan, source: planSource }) : null;
    return {
      name: a.name,
      providerId: a.providerId,
      providerName: provider?.name ?? null,
      providerKind,
      model: a.model,
      roleSource,
      teamId: a.teamId,
      roleWeak: roleSource === "empty",
      permissionMode,
      sandboxMode: sandboxOverride,
      effectiveSandboxMode,
      sandboxSource: !isCodex
        ? "n/a"
        : sandboxOverride
          ? "agent"
          : providerHasDefaultSandbox
            ? "provider"
            : "default",
      reasoningEffort: storedReasoning.level,
      storedReasoningUnusable: storedReasoning.unusable,
      projectRoot: a.projectRoot,
      // Compatibility echo: the same canonical value, never the retired column.
      codexWorkspace: a.projectRoot,
      // The directory the runtimes and tools actually use, from the plan — the
      // plan's `value` is null whenever the root is unusable, and NOTHING here
      // may fall back to the configured path: reporting a directory the next
      // turn will refuse to start in is exactly the kind of second answer this
      // contract removes. `projectRootState.configuredPath` + `.invalid` say
      // what the user asked for and which rule it failed.
      runtimeCwd: plan?.execution.projectRoot.value ?? null,
      projectRootState: plan
        ? {
            value: plan.execution.projectRoot.value,
            configuredPath: plan.execution.projectRoot.configuredPath,
            source: plan.execution.projectRoot.source,
            state: plan.execution.projectRoot.state,
            invalid: plan.execution.projectRoot.invalid,
          }
        : null,
      systemPromptHash,
      storedSystemPromptHash,
      systemPromptHashMatchesStored: storedSystemPromptHash === systemPromptHash,
      hasResumeInfo: readMetaString(a.metadata, "lastSessionId") !== null,
      hasCodexResumeSignature: readMetaString(a.metadata, CODEX_RESUME_SIGNATURE_KEY) !== null,
      hasCodexUsageSnapshot:
        a.metadata !== null &&
        typeof a.metadata === "object" &&
        "codexUsageSnapshot" in a.metadata,
      closed: readMetaBool(a.metadata, "closed"),
      messages: msgCount,
      enabledMcpServers: mcpRows.length,
      contextUsage: this.contextUsageByAgent.get(id) ?? null,
      planView: view,
      // Every value below is read OFF the view-model above. There is no second
      // resolution here: the echo exists for wire compatibility and would be a
      // bug the moment it disagreed.
      runPlan: view
        ? {
            transport: view.identity.transport,
            transportOrigin: view.transport.origin,
            transportConfidence: view.transport.confidence,
            transportSource: view.transportSource,
            requestedTransport: view.transport.requested,
            fallbackAllowed: view.transport.fallbackAllowed,
            fallbackTarget: view.transport.fallbackTarget,
            fallbackReason: view.transport.fallbackReason,
            reasoning: view.reasoning,
            runtime: view.identity.runtime,
            runtimeVersion: view.identity.runtimeVersion,
            planHash: view.planHash,
            resolvedAt: view.resolvedAt,
            diagnostics: view.diagnostics,
          }
        : null,
      runPlanSource: planSource,
      lastTransportFallback: this.transportFallbackByAgent.get(id) ?? null,
      // ONE source: the controller. `/status` does not consult `running`, the
      // agent's DB status, or its own clock — three answers to "is it alive" is
      // what phase 4 removed.
      liveness: {
        ...this.liveness.report(id),
        policy: plan?.liveness ?? null,
      },
      history: plan?.history ?? null,
      skills: (() => {
        const workspace = configuredProjectRoot?.path ?? null;
        const workspaces = workspace ? [workspace] : [];
        const discovered = loadSkills(workspaces).length;
        return {
          turn: plan?.skills ?? null,
          blocked: [...readSkillBlocklist(a.metadata)].sort(),
          forced: [...readSkillForcelist(a.metadata)].sort(),
          discovered,
          // The auto-activation switch, from the one place that reads it.
          autoActivationEnabled: readSkillAutoActivation(a.metadata),
        };
      })(),
      archivedGenerations: (await this.listArchivedGenerations(id)).map((g) => ({
        generation: g.generation,
        fromSeq: g.fromSeq,
        toSeq: g.toSeq,
        count: g.count,
        sourceHash: g.sourceHash,
        archivedAt: g.archivedAt,
      })),
    };
  }

  /** W14: side-channel one-shot query against an agent's runtime, used by
   *  meta UI operations (suggest-children, future telemetry helpers, etc.).
   *  Does NOT persist messages or broadcast on WS. Single-turn, no tools,
   *  no mcpServers, no canUseTool — purely "ask the model and return text".
   *
   *  Phase 4: `abortMs` is an EXPLICIT caller deadline and defaults to `null`,
   *  which means no deadline at all. It used to default to a hard 15 s that
   *  fired on SILENCE — the same "we heard nothing, so we killed it" rule the
   *  phase removes, applied to a helper call where it was even less defensible:
   *  a slow model on a large prompt is not a broken one. A caller that has a
   *  real reason to bound the wait (a UI dialog waiting on the answer) passes
   *  one, and that deadline is honoured with a structured reason. The USER's own
   *  ceiling (`maxRunDurationMs`) is the only other deadline that may apply, and
   *  it applies here because it is the user's, not ours. */
  async quickQuery(agentId: string, prompt: string, abortMs: number | null = null): Promise<string> {
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
    // Why the abort fired, as data. An abort with no reason is indistinguishable
    // from a crash, and the caller cannot tell the user which one happened.
    let abortReason: string | null = null;

    const runtime = this.runtimeResolver(resolvedProvider?.kind ?? "anthropic-local");
    // A side-channel query still runs under a plan (the OpenAI runtime refuses
    // to guess a transport), but it must not probe: this path exists to answer
    // a UI question quickly, not to spend the user's latency on discovery.
    const quickPlan = await this.resolveTurnPlan({
      provider: resolvedProvider
        ? {
            id: resolvedProvider.id,
            kind: resolvedProvider.kind,
            baseUrl: resolvedProvider.baseUrl,
            apiKey: resolvedProvider.apiKey,
            metadata: resolvedProvider.metadata,
          }
        : null,
      model: agent.model,
      reasoningEffort: readReasoningEffortOverride(agent.metadata),
      maxRunDurationMs: readMaxRunDurationMsOverride(agent.metadata),
      allowProbe: false,
      agentId,
      projectRoot: projectRootOf(agent),
    });
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
      runPlan: quickPlan,
    };

    // The deadlines that may apply, in order of authority: the user's ceiling
    // from the plan, then the caller's own. No deadline at all is the default
    // and a complete answer.
    const userDeadlineMs = quickPlan.liveness.hardDeadlineMs;
    const deadlineMs =
      userDeadlineMs !== null && abortMs !== null
        ? Math.min(userDeadlineMs, abortMs)
        : (userDeadlineMs ?? abortMs);
    const deadlineSource =
      deadlineMs === null
        ? null
        : deadlineMs === userDeadlineMs
          ? "the user's maxRunDurationMs"
          : "the caller's explicit deadline";
    const timer =
      deadlineMs === null
        ? null
        : setTimeout(() => {
            abortReason =
              `this helper call reached ${deadlineSource} of ${deadlineMs}ms and was stopped ` +
              "(RUNTIME_WALL_CLOCK_LIMIT). Nothing about silence ended it";
            abort.abort();
          }, deadlineMs);

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
      if (timer) clearTimeout(timer);
    }

    // A deadline that fired is REPORTED, not swallowed into an empty string.
    // The caller asked for text and did not get it; the reason is the only part
    // of that answer they can act on.
    if (abortReason !== null) {
      const err = new Error(abortReason) as Error & { code?: string };
      err.code = "RUNTIME_WALL_CLOCK_LIMIT";
      throw err;
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
    opts: { background?: boolean; projectRoot?: string | null } = {},
  ): Promise<{ finalText: string; subagentId: string; background?: boolean }> {
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
    const background = opts.background === true;
    // The child works where the parent works. An omitted override inherits the
    // parent's canonical root VERBATIM — re-inspecting it here would make a
    // child outlive a root the parent's own turn just validated, and a child is
    // not the place to discover the parent's directory is gone. An EXPLICIT
    // override is a fresh user-facing input, so it goes through the same
    // validation as every other write path.
    const childProjectRoot =
      opts.projectRoot === undefined
        ? parent.projectRoot
        : normalizeProjectRoot(opts.projectRoot);
    // PERMISSIONS ARE THE PARENT'S, not a reset to the default. A subagent is
    // the same work continuing one level down, so "the parent does not have to
    // ask for this" has to stay true for the child — otherwise every write a
    // background task makes stops on an approval popup the parent would never
    // have shown, and the delegated work stalls on a human who is not watching
    // that pane. Copied at spawn (a child is not retroactively re-gated when
    // the parent's mode later changes); the child's own settings can still
    // override either one.
    const parentPermissionMode = readPermissionMode(parent.metadata);
    const parentSandboxMode = readSandboxOverride(parent.metadata);
    const child = await prisma.agent.create({
      data: {
        parentId,
        name: `${background ? "bg" : "task"}:${description.slice(0, 32)}`,
        model: parent.model,
        providerId: parent.providerId,
        systemPrompt: parent.systemPrompt,
        projectRoot: childProjectRoot ?? null,
        // Inherit the parent's team so a team member's subagent nests INSIDE the
        // team group in the sidebar (nested under the member) instead of falling
        // to the ungrouped top level — the tree groups by teamId first, then
        // builds the parent/child nesting within each group.
        teamId: parent.teamId,
        metadata: {
          taskDepth: parentDepth + 1,
          spawnedAsTaskFor: parentId,
          // Kept so the terminal notification can name the real work rather
          // than the truncated agent name.
          backgroundTaskDescription: description,
          ...(background ? { backgroundTask: true } : {}),
          permissionMode: parentPermissionMode,
          // Only written when the parent HAS an override: an absent key means
          // "no override" and must not be re-stated as an explicit null, which
          // is the shape the sandbox-apply path reads as a stored choice.
          ...(parentSandboxMode ? { sandboxMode: parentSandboxMode } : {}),
        },
      },
    });
    // Broadcast so the child immediately appears nested under its parent in the
    // sidebar tree (the store subscribes on agent_created). This is what makes
    // both blocking subagents AND background tasks visible in the left list.
    this.hub.broadcast({ type: "agent_created", agent: agentRowToSummary(child) });
    if (background) {
      // Fire-and-forget: the child runs detached in its own session/run. The
      // parent turn is NOT blocked — it gets the child id back immediately and
      // continues. The child's progress is visible in its own pane + the tree's
      // live status. Aligns with the unattended-continuous-dev mission: a long
      // job runs in the background instead of holding the parent hostage.
      void this.sendMessage(child.id, prompt).catch((err) => {
        console.error(`[subagent:bg] child ${child.id.slice(0, 8)} failed:`, err);
        // The child never reached runMessageNow's terminal paths, so the parent
        // would otherwise never hear about a background task that failed to
        // start. settleBackgroundSubagent is idempotent.
        void this.settleBackgroundSubagent(child.id, parentId, {
          status: "ERROR",
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => { /* already logged above */ });
      });
      return { finalText: "", subagentId: child.id, background: true };
    }
    let result: { finalText: string } | null = null;
    try {
      result = await this.sendMessage(child.id, prompt);
    } catch (err) {
      // The run threw: the child still ends here, so it is still retired —
      // archived as failed rather than left behind as a live-looking agent.
      await this.retireSubagent(child.id).catch(() => { /* best effort */ });
      throw err;
    }
    // The blocking child's whole life was this one call, so the answer being in
    // hand IS its terminal state: archive + deactivate now instead of leaving
    // it in the tree as a live agent forever. `await`ed so the state is settled
    // by the time the parent's tool call returns.
    await this.retireSubagent(child.id).catch(() => { /* best effort */ });
    // The child's answer is stored whole as an artifact before the parent sees
    // any of it, and what the parent's tool result carries is the same text
    // when it fits the parent's window — or a preview plus the handle when it
    // does not. MAX_FINAL_TEXT (4 000 characters, applied right here) is gone:
    // it deleted the second half of a report and left the parent with no way to
    // learn that it had.
    const finalText = result?.finalText ?? "";
    if (!finalText.trim()) return { finalText, subagentId: child.id };
    const presented = this.presentResult({
      agentId: parentId,
      model: parent.model,
      kind: "subagent-final",
      body: finalText,
    });
    return { finalText: presented.text, subagentId: child.id };
  }

  /** Retire a spawned subagent: its task is over, so it stops being a live
   *  agent and is kept only as a record.
   *
   *  A subagent exists for ONE task. Until this existed, a finished child stayed
   *  a live agent: it kept a row in the tree, stayed re-runnable, stayed
   *  messageable by anyone, and the parent's background-task strip listed it
   *  forever until a human dismissed it one by one. That is the "N subagents
   *  that never go away" shape — the child is a COST of a task, not a standing
   *  member of the workspace.
   *
   *  Retiring sets the same `closed` state the user's own close action sets
   *  (input disabled, sendMessage refused, peer contact refused) and stamps
   *  `archivedAt` for the audit trail. Nothing is deleted: the transcript, the
   *  artifacts and the summary all stay readable, and the user can restart the
   *  agent from Settings if it really is wanted again as a standing agent.
   *
   *  Idempotent, and a no-op for anything that was not spawned by an agent —
   *  this must never close a user's own agent.
   *
   *  Deliberately NOT `closeAgent`: that path cancels a live run, and this runs
   *  from inside the child's own terminal handling (cancelling there would
   *  fight the run that is finalizing). Queued turns are dropped instead, so a
   *  retired child cannot be woken by a turn nobody can act on. */
  async retireSubagent(childId: string, reason?: SubagentRetirementReason): Promise<void> {
    const row = await prisma.agent.findUnique({ where: { id: childId } });
    if (!row) return;
    // Only agent-spawned children. A user-created agent (even a nested one) is
    // the user's to close, not this lifecycle's.
    if (readMetaString(row.metadata, "spawnedAsTaskFor") === null) return;
    if (readMetaBool(row.metadata, "closed")) return;
    this.clearQueuedTurns(childId);
    const updated = await prisma.agent.update({
      where: { id: childId },
      data: {
        metadata: mergeMetadata(row.metadata, {
          closed: true,
          archivedAt: new Date().toISOString(),
          // A caller that watched the run end says why; otherwise the row's own
          // terminal status is the record of how it ended.
          archivedReason: reason ?? (row.status === "ERROR" ? "task-failed" : "task-completed"),
        }),
      },
    });
    this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
  }

  /** Report a detached subagent's terminal state to its parent.
   *
   *  Delivery is peer_send-shaped: the parent runs a new turn immediately when
   *  idle and gets the notice queued (coalesced with any sibling notice) when
   *  busy — never an interrupt. That queued prompt is the only channel that
   *  reaches the model on all three runtimes: Claude resumes its own CLI
   *  session, Codex gets a fresh `codex exec` prompt, OpenAI replays DB history,
   *  so a DB-only system row reaches none of them reliably. The system row is
   *  still written, because the USER should see the outcome immediately even
   *  while the parent is wedged. Idempotent via SUBAGENT_SETTLED_KEY. */
  private async settleBackgroundSubagent(
    childId: string,
    parentId: string,
    outcome: SubagentTerminalOutcome,
  ): Promise<void> {
    const child = await prisma.agent.findUnique({ where: { id: childId } });
    if (!child) return;
    if (readMetaBool(child.metadata, SUBAGENT_SETTLED_KEY)) return;
    const description = readMetaString(child.metadata, "backgroundTaskDescription") ?? undefined;
    // Claim the notification BEFORE delivering anything, so two terminal paths
    // racing (abort + error) can't both notify the parent.
    const claimed = await prisma.agent.update({
      where: { id: childId },
      data: { metadata: mergeMetadata(child.metadata, { [SUBAGENT_SETTLED_KEY]: true }) },
    });
    // The child's own lifecycle ends with its task, whatever the parent's state
    // is: archive + deactivate it (idempotent). Done here, before the parent is
    // even looked at, so a closed or deleted parent can never leave a finished
    // child standing as a live agent.
    await this.retireSubagent(
      childId,
      outcome.status === "ERROR" ? "task-failed" : outcome.status === "IDLE" ? "interrupted" : "task-completed",
    ).catch((err) => {
      console.error(`[subagent:bg] retire child ${childId.slice(0, 8)} failed:`, err);
    });
    const parent = await prisma.agent.findUnique({ where: { id: parentId } });
    if (!parent) return;
    const identity = { id: child.id, name: child.name };
    // Same rule as the blocking path: the durable copy is written first, and the
    // notice the parent receives carries the whole answer when it fits or a
    // preview + handle when it does not.
    const settledText = outcome.finalText?.trim()
      ? this.presentResult({
          agentId: parentId,
          model: parent.model,
          kind: "subagent-final",
          body: outcome.finalText,
        }).text
      : outcome.finalText;
    const full: SubagentTerminalOutcome = {
      ...outcome,
      ...(settledText ? { finalText: settledText } : {}),
      ...(description ? { description } : {}),
    };
    // 1) Durable record + immediate UI visibility in the parent's transcript.
    await this.appendBackgroundTaskNotice(parentId, subagentFinishedSystemPayload(identity, full));
    if (readMetaBool(parent.metadata, "closed")) return;
    // The CURRENT row, not `claimed`: the child was archived just above, and
    // broadcasting the pre-archive summary would undo that in the sidebar —
    // the tree would show a finished child as a live agent again.
    const settledRow = (await prisma.agent.findUnique({ where: { id: childId } })) ?? claimed;
    this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(settledRow) });
    // 2) The channel the model actually reads on its next turn.
    void this.sendMessage(parentId, formatSubagentFinishedNotice(identity, full), {
      subagentOrigin: { childId, childName: child.name },
    }).catch((err) => {
      console.error(
        `[subagent:bg] notify parent ${parentId.slice(0, 8)} about ${childId.slice(0, 8)} failed:`,
        err,
      );
    });
  }

  private enqueueTurn(
    sessionId: string,
    userInput: string,
    opts?: SendMessageOptions,
  ): Promise<{ finalText: string } | null> {
    return new Promise((resolve) => {
      const peerOrigin = opts?.peerOrigin;
      let row: { id: number };
      if (opts?.subagentOrigin) {
        // Coalesce: several detached subagents reaching terminal while the
        // parent is busy must not queue several wake-up turns. The first queued
        // notice absorbs the rest (text appended) so the parent is woken once
        // with every result already at hand.
        const existing = this.findQueuedSubagentFinishedTurn(sessionId);
        if (existing) {
          prisma.pendingTurn.update({
            where: { id: existing.id },
            data: { userInput: `${existing.userInput}\n\n${userInput}` },
          });
          this.queuedTurns.get(sessionId)?.get(existing.id)?.(null);
          row = existing;
        } else {
          row = prisma.pendingTurn.create({
            data: { agentId: sessionId, userInput, opts: opts ?? {} },
          });
        }
      } else if (peerOrigin) {
        const existing =
          this.findQueuedPeerHandoff(sessionId, peerOrigin) ??
          this.findQueuedPeerCorrelationDuplicate(sessionId, peerOrigin);
        if (existing) {
          prisma.pendingTurn.update({
            where: { id: existing.id },
            data: { userInput, opts: opts ?? {} },
          });
          this.queuedTurns.get(sessionId)?.get(existing.id)?.(null);
          row = existing;
        } else {
          row = prisma.pendingTurn.create({
            data: { agentId: sessionId, userInput, opts: opts ?? {} },
          });
        }
      } else {
        row = prisma.pendingTurn.create({
          data: { agentId: sessionId, userInput, opts: opts ?? {} },
        });
      }
      let bucket = this.queuedTurns.get(sessionId);
      if (!bucket) {
        bucket = new Map();
        this.queuedTurns.set(sessionId, bucket);
      }
      bucket.set(row.id, resolve);
      this.hub.sendToSession(sessionId, {
        type: "status",
        sessionId,
        status: "running",
      });
    });
  }

  /** First queued turn carrying a detached-subagent terminal notice, if any.
   *  Same role as findQueuedPeerHandoff, minus the freshness semantics: a
   *  terminal notification is never superseded, only merged. */
  private findQueuedSubagentFinishedTurn(
    sessionId: string,
  ): { id: number; userInput: string } | null {
    const rows = prisma.pendingTurn.findMany({
      where: { agentId: sessionId },
      orderBy: { id: "asc" },
    });
    for (const row of rows) {
      if (normalizeQueuedTurnOpts(row.opts)?.subagentOrigin) {
        return { id: row.id, userInput: row.userInput };
      }
    }
    return null;
  }

  private findQueuedPeerHandoff(
    sessionId: string,
    peerOrigin: NonNullable<SendMessageOptions["peerOrigin"]>,
  ): { id: number } | null {
    // Only live in-flight source-output handoffs are superseded. Plain body
    // messages, completed-source messages, and includeSource=false handoffs
    // must remain FIFO and later merge into a peer batch.
    if (!peerOrigin.sourceRunId || !peerOrigin.coalescibleSourceOutput) return null;
    const rows = prisma.pendingTurn.findMany({
      where: { agentId: sessionId },
      orderBy: { id: "asc" },
    });
    for (const row of rows) {
      const existing = normalizeQueuedTurnOpts(row.opts)?.peerOrigin;
      if (!existing) continue;
      if (
        existing.coalescibleSourceOutput === true &&
        existing.fromAgentId === peerOrigin.fromAgentId &&
        existing.mode === peerOrigin.mode &&
        (existing.sourceRunId ?? null) === (peerOrigin.sourceRunId ?? null)
      ) {
        return { id: row.id };
      }
    }
    return null;
  }

  private findQueuedPeerCorrelationDuplicate(
    sessionId: string,
    peerOrigin: NonNullable<SendMessageOptions["peerOrigin"]>,
  ): { id: number } | null {
    const family = peerCorrelationFamily(peerOrigin);
    if (family.size === 0 && !peerOrigin.messageId) return null;
    const rows = prisma.pendingTurn.findMany({
      where: { agentId: sessionId },
      orderBy: { id: "asc" },
    });
    for (const row of rows) {
      const existing = normalizeQueuedTurnOpts(row.opts)?.peerOrigin;
      if (!existing || existing.fromAgentId !== peerOrigin.fromAgentId) continue;
      if (peerOrigin.messageId && existing.messageId === peerOrigin.messageId) return { id: row.id };
      if (setsIntersect(family, peerCorrelationFamily(existing))) {
        return { id: row.id };
      }
    }
    return null;
  }

  private queuedPeerTurnsSince(sessionId: string, afterId: number): QueuedPeerTurn[] {
    const highWater = Number.isFinite(afterId) ? afterId : 0;
    const rows = prisma.pendingTurn.findMany({
      where: { agentId: sessionId },
      orderBy: { id: "asc" },
    });
    const out: QueuedPeerTurn[] = [];
    for (const row of rows) {
      if (row.id <= highWater) continue;
      const origin = normalizeQueuedTurnOpts(row.opts)?.peerOrigin;
      if (origin) out.push({ row, origin });
    }
    return out;
  }

  private findFreshnessBlockingPeerTurns(
    run: RunningSession,
    action: FreshnessBlockedAction,
  ): QueuedPeerTurn[] {
    const queued = this.queuedPeerTurnsSince(run.id, run.pendingTurnHighWaterId);
    return queued.filter(({ origin }) => {
      const actionCorrelationIds = new Set(
        [action.correlationId, action.replyToCorrelationId].filter((v): v is string => Boolean(v)),
      );
      const originCorrelationIds = new Set(
        [origin.correlationId, origin.replyToCorrelationId].filter((v): v is string => Boolean(v)),
      );
      const correlationRelated =
        actionCorrelationIds.size > 0 &&
        [...actionCorrelationIds].some((id) => originCorrelationIds.has(id));
      if (correlationRelated) return true;
      if (action.targetAgentId) return origin.fromAgentId === action.targetAgentId;
      return true;
    });
  }

  private formatFreshnessBlockedResult(action: FreshnessBlockedAction, queued: QueuedPeerTurn[]): string {
    const sendText = action.tool === "peer_send"
      ? `peer_send to "${action.targetAgentName ?? action.targetAgentId ?? "peer"}" was not sent.`
      : "ask_user was not opened.";
    const sources = Array.from(new Set(queued.map(({ origin }) => origin.fromAgentName))).join(", ");
    const correlations = Array.from(
      new Set(
        queued
          .flatMap(({ origin }) => [origin.correlationId, origin.replyToCorrelationId])
          .filter((v): v is string => Boolean(v)),
      ),
    );
    return [
      `freshness-blocked: newer inbound peer message(s) are already queued for this agent from ${sources || "peer agents"}.`,
      sendText,
      correlations.length > 0 ? `Related correlation id(s): ${correlations.join(", ")}.` : "",
      action.tool === "peer_send"
        ? "Your message content is preserved by Ensemble and will be re-presented to you automatically (with the fresh inbox) so it is not lost. Process the queued inbound peer message(s) first, then resend (merging new context) or skip it."
        : "Process the queued inbound peer message(s) first, then decide whether to cancel, merge, or resend the action with updated context.",
    ].filter(Boolean).join(" ");
  }

  private formatFreshnessContinuation(run: RunningSession, rows: DbPendingTurn[]): string {
    const action = run.blockedFreshnessAction;
    const draft = action?.tool === "peer_send" ? action.peerSendDraft : undefined;
    const lines = [
      "Ensemble freshness check: newer peer message(s) arrived while your previous run was active.",
      action
        ? `A stale ${action.tool} action was blocked. Reconcile the queued peer input before acting again.`
        : "Reconcile the queued peer input before continuing.",
      "Do not ask the human for input in this reconciliation turn. Cancel, merge, or resend only if still needed.",
      `Original run id: ${run.runId}`,
    ];
    if (draft) {
      const targetLabel = action?.targetAgentName ?? action?.targetAgentId ?? "peer";
      lines.push(
        "",
        `Your earlier peer_send to "${targetLabel}" (mode=${draft.mode}) was blocked and NOT delivered. ` +
          "Its exact content is preserved below so you do not need to reconstruct it. " +
          "After reading the fresh inbox, RESEND it with peer_send if it is still valid (merge the new context if helpful), " +
          "or explicitly skip it only if the fresh input makes it obsolete. If you do nothing it will not be delivered.",
        `<blocked-outbound-draft tool="peer_send" target="${targetLabel}" mode="${draft.mode}">`,
        // Whole, not head+tail clipped: this is the message the agent is being
        // told to resend, and a clipped draft is a different message that it
        // would then send believing it was the same one.
        draft.body.trim(),
        "</blocked-outbound-draft>",
      );
    }
    lines.push(
      "",
      `<fresh-peer-inbox count="${rows.length}">`,
    );
    rows.forEach((row, idx) => {
      const origin = normalizeQueuedTurnOpts(row.opts)?.peerOrigin;
      lines.push(
        `--- message ${idx + 1} id=${row.id} queuedAt=${row.createdAt.toISOString()}`,
        `From: ${origin?.fromAgentName ?? "unknown"}${origin?.fromAgentId ? ` (id=${origin.fromAgentId.slice(0, 8)})` : ""}`,
        `Mode: ${origin?.mode ?? "raw"}`,
      );
      if (origin?.correlationId) lines.push(`Correlation: ${origin.correlationId}`);
      if (origin?.correlationKind) lines.push(`Correlation kind: ${origin.correlationKind}`);
      if (origin?.replyToCorrelationId) lines.push(`Reply to correlation: ${origin.replyToCorrelationId}`);
      // The fresh peer input whole: the reconciliation turn's job is to merge
      // it with the blocked draft, and half of it would merge into half a
      // decision. Its size is accounted for by the turn's budget.
      lines.push("", row.userInput.trim(), "");
    });
    lines.push("</fresh-peer-inbox>");
    return lines.join("\n");
  }

  private runEndDrainOptions(run: RunningSession): DrainQueuedOptions | undefined {
    const queued = this.queuedPeerTurnsSince(run.id, run.pendingTurnHighWaterId);
    if (queued.length === 0) return undefined;
    // Auto-reconcile whenever a stale peer_send/ask_user was blocked: schedule a
    // non-interactive continuation that re-presents the preserved draft with the
    // fresh inbox instead of dropping it. This chains across repeated blocks
    // (carrying the draft forward via {...run}) so the message survives until the
    // peer inbox settles — bounded by MAX_FRESHNESS_CONTINUATIONS so a peer that
    // never stops sending can't spin forever.
    const continuationCount = run.freshnessContinuationCount ?? 0;
    if (run.blockedFreshnessAction && continuationCount < MAX_FRESHNESS_CONTINUATIONS) {
      return {
        preferPeerAfterId: run.pendingTurnHighWaterId,
        freshnessContinuationRun: {
          ...run,
          freshnessContinuationUsed: true,
          freshnessContinuationCount: continuationCount + 1,
        },
      };
    }
    return { preferPeerAfterId: run.pendingTurnHighWaterId };
  }

  private drainQueuedTurns(sessionId: string, drainOpts: DrainQueuedOptions = {}): void {
    if (this.running.has(sessionId) || this.drainingQueues.has(sessionId)) {
      if (Object.keys(drainOpts).length > 0) this.pendingDrainOptions.set(sessionId, drainOpts);
      return;
    }
    const rows = prisma.pendingTurn.findMany({
      where: { agentId: sessionId },
      orderBy: { id: "asc" },
    });
    if (rows.length === 0) {
      this.queuedTurns.delete(sessionId);
      return;
    }
    const nextRows = this.takeNextQueuedTurnSegment(rows, drainOpts);
    for (const row of nextRows) {
      prisma.pendingTurn.delete({ where: { id: row.id } });
    }
    const resolvers = nextRows
      .map((row) => {
        const resolver = this.queuedTurns.get(sessionId)?.get(row.id);
        this.queuedTurns.get(sessionId)?.delete(row.id);
        return resolver;
      })
      .filter((resolve): resolve is (result: { finalText: string } | null) => void => Boolean(resolve));
    if (this.queuedTurns.get(sessionId)?.size === 0) this.queuedTurns.delete(sessionId);
    const userInput = drainOpts.freshnessContinuationRun
      ? this.formatFreshnessContinuation(drainOpts.freshnessContinuationRun, nextRows)
      : this.formatQueuedTurnSegment(nextRows);
    const runOpts = drainOpts.freshnessContinuationRun
      ? {
          freshnessContinuationForRunId: drainOpts.freshnessContinuationRun.runId,
          ...(typeof drainOpts.freshnessContinuationRun.freshnessContinuationCount === "number"
            ? { freshnessContinuationCount: drainOpts.freshnessContinuationRun.freshnessContinuationCount }
            : {}),
          nonInteractive: true,
          suppressRuntimeMetadata: true,
          suppressUserMessage: true,
        }
      : nextRows.length === 1
        ? normalizeQueuedTurnOpts(nextRows[0]!.opts)
        : undefined;
    const drainToken = this.beginDrain(sessionId);
    void this.runMessageNow(sessionId, userInput, runOpts)
      .then((result) => {
        for (const resolve of resolvers) resolve(result);
      })
      .catch((err) => {
        console.error(`[queued-turn] sendMessage to ${sessionId} failed:`, err);
        for (const resolve of resolvers) resolve(null);
      })
      .finally(() => {
        this.finishDrain(sessionId, drainToken);
      });
  }

  private takeNextQueuedTurnSegment(rows: DbPendingTurn[], opts: DrainQueuedOptions = {}): DbPendingTurn[] {
    if (opts.freshnessContinuationRun && opts.preferPeerAfterId !== undefined) {
      return rows.filter((row) => row.id > opts.preferPeerAfterId! && normalizeQueuedTurnOpts(row.opts)?.peerOrigin);
    }
    let first = rows[0];
    if (opts.preferPeerAfterId !== undefined) {
      const preferred = rows.find((row) => row.id > opts.preferPeerAfterId! && normalizeQueuedTurnOpts(row.opts)?.peerOrigin);
      if (preferred) first = preferred;
    }
    if (!first) return [];
    if (!normalizeQueuedTurnOpts(first.opts)?.peerOrigin) return [first];
    const segment: DbPendingTurn[] = [];
    for (const row of rows.slice(rows.indexOf(first))) {
      if (!normalizeQueuedTurnOpts(row.opts)?.peerOrigin) break;
      segment.push(row);
    }
    return segment;
  }

  private formatQueuedTurnSegment(rows: DbPendingTurn[]): string {
    if (rows.length === 1) return rows[0]!.userInput;
    const lines = [`<peer-batch count="${rows.length}">`];
    rows.forEach((row, idx) => {
      const origin = normalizeQueuedTurnOpts(row.opts)?.peerOrigin;
      lines.push(
        `--- message ${idx + 1} id=${row.id} queuedAt=${row.createdAt.toISOString()}`,
        `From: ${origin?.fromAgentName ?? "unknown"}${origin?.fromAgentId ? ` (id=${origin.fromAgentId.slice(0, 8)})` : ""}`,
        `Mode: ${origin?.mode ?? "raw"}`,
      );
      if (origin?.messageId) lines.push(`Message id: ${origin.messageId}`);
      if (origin?.correlationId) lines.push(`Correlation: ${origin.correlationId}`);
      if (origin?.correlationKind) lines.push(`Correlation kind: ${origin.correlationKind}`);
      if (origin?.replyToCorrelationId) lines.push(`Reply to correlation: ${origin.replyToCorrelationId}`);
      if (origin?.sourceRunId) lines.push(`Source run: ${origin.sourceRunId.slice(0, 8)}`);
      if (origin?.causalRunId) lines.push(`Causal run: ${origin.causalRunId.slice(0, 8)}`);
      lines.push("", row.userInput.trim(), "");
    });
    lines.push("</peer-batch>");
    return lines.join("\n");
  }

  private clearQueuedTurns(sessionId: string): void {
    this.pendingDrainOptions.delete(sessionId);
    const rows = prisma.pendingTurn.findMany({ where: { agentId: sessionId } });
    for (const row of rows) {
      prisma.pendingTurn.delete({ where: { id: row.id } });
    }
    const q = this.queuedTurns.get(sessionId);
    this.queuedTurns.delete(sessionId);
    if (!q) return;
    for (const resolve of q.values()) resolve(null);
  }

  private recordLiveTranscript(sessionId: string, msg: unknown): void {
    const delta = textDeltaFromStreamEvent(msg);
    if (delta !== null) {
      const live = this.liveTranscripts.get(sessionId) ?? { current: "", finalized: [] };
      live.current += delta;
      this.liveTranscripts.set(sessionId, live);
      return;
    }

    const assistantText = assistantTextFromMessage(msg);
    if (assistantText.length > 0) {
      const live = this.liveTranscripts.get(sessionId) ?? { current: "", finalized: [] };
      const finalized = assistantText.trim();
      if (finalized && finalized !== live.current.trim()) live.finalized.push(finalized);
      else if (finalized) live.finalized.push(live.current.trim());
      live.current = "";
      this.liveTranscripts.set(sessionId, live);
      return;
    }

    if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "result") {
      this.liveTranscripts.delete(sessionId);
    }
  }

  private formatLiveTranscript(sessionId: string): string | null {
    const live = this.liveTranscripts.get(sessionId);
    if (!live) return null;
    const parts = [...live.finalized];
    if (live.current.trim()) parts.push(live.current.trim());
    const text = parts.join("\n\n").trim();
    if (!text) return null;
    // No character clip: this is what the peer has actually said so far, and
    // head+tail clipping it hid the middle of a sentence the reader was being
    // asked to reason about. The receiving turn's budget accounts for it.
    return [
      `target is currently running; live assistant output visible so far:`,
      "",
      "[assistant/live]",
      text,
    ].join("\n");
  }

  private liveAssistantText(sessionId: string): string | null {
    const live = this.liveTranscripts.get(sessionId);
    if (!live) return null;
    const text = [...live.finalized, live.current].filter((part) => part.trim()).join("\n\n").trim();
    return text || null;
  }

  private latestInterruptedTurn(agentId: string): InterruptedTurnPayload | null {
    const rows = prisma.message.findMany({
      where: { agentId, type: "system" },
      orderBy: { seq: "desc" },
      take: 20,
    });
    for (const row of rows) {
      const payload = parseInterruptedTurnPayload(row.payload);
      if (payload) return payload;
    }
    return null;
  }

  private nextMessageSeq(agentId: string): number {
    const last = prisma.message.findFirst({
      where: { agentId },
      orderBy: { seq: "desc" },
    });
    return (last?.seq ?? -1) + 1;
  }

  private isRunOwner(sessionId: string, runId: string): boolean {
    return this.running.get(sessionId)?.runId === runId;
  }

  /** Persist + broadcast a background-task lifecycle notice (interrupted /
   *  orphaned) on `sessionId`. Uses its own DB-derived seq rather than the turn
   *  loop's local counter — the counter can be stale after an abort — and
   *  returns it so an in-loop caller can resync. Never silently dropped: this is
   *  the only durable trace of a task whose terminal notification never came. */
  private async appendBackgroundTaskNotice(
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    const row = await prisma.message.create({
      data: { agentId: sessionId, seq: this.nextMessageSeq(sessionId), type: "system", payload },
    });
    this.hub.sendToSession(sessionId, {
      type: "message",
      sessionId,
      seq: row.seq,
      msg: payload as never,
    });
    return row.seq;
  }

  /** Report a job's TERMINAL state into the owning agent's transcript.
   *
   *  The `Job` row is the record of truth (jobs.ts owns it); this is how the
   *  agent — and the human reading its chat — ever LEARNS the outcome. Without
   *  it, a job that outlived its session would settle in SQLite and nobody
   *  would be told: the same silent loss the job primitive exists to remove,
   *  just moved one layer down.
   *
   *  Written through the existing background-task notice path on purpose: the
   *  result is an ordinary system message, so it is durable, broadcast to any
   *  attached client, and replayed by the existing resync — no new envelope,
   *  no new UI plumbing for the message itself.
   *
   *  A `lost` job is reported as lost. Terminal-and-unknown is never rendered
   *  as terminal-and-fine. */
  private jobSettledPayload(job: DbJob): Record<string, unknown> {
    const short = job.id.slice(0, 8);
    const where = `job ${short} (\`${job.command}\`)`;
    let text: string;
    switch (job.status) {
      case "exited":
        text = `${where} finished: exit 0.`;
        break;
      case "failed":
        text = `${where} failed: exit ${job.exitCode ?? "unknown"}.`;
        break;
      case "cancelled":
        text = `${where} was cancelled${job.exitCode === null ? "" : ` (exit ${job.exitCode})`}.`;
        break;
      default:
        text = `${where} was LOST: ${job.lostReason ?? "the process is gone and no exit was recorded"}.`;
        break;
    }
    text += ` Full output: ${job.logPath}`;
    return {
      type: "system",
      subtype: "job_settled",
      jobId: job.id,
      status: job.status,
      exitCode: job.exitCode,
      command: job.command,
      logPath: job.logPath,
      text,
    };
  }

  /** Atomically append one terminal job notice and mark it delivered.
   *
   * The Message insert and Job marker share a BEGIN IMMEDIATE transaction, so
   * a crash can leave neither or both, never a duplicate-on-restart half-state.
   * This runs only while the agent has no active turn: a turn owns a local
   * sequence cursor, and inserting between two yielded runtime messages was the
   * exact race that used to abort the turn with Message(agentId,seq) UNIQUE. */
  private persistJobSettledNotice(job: DbJob): void {
    const agentId = job.agentId;
    if (!agentId || this.running.has(agentId)) return;
    const payload = this.jobSettledPayload(job);
    let insertedSeq: number | null = null;
    transaction(() => {
      const fresh = sqliteDb
        .prepare("SELECT status, transcriptNotifiedAt FROM Job WHERE id = ? LIMIT 1")
        .get(job.id) as { status?: string; transcriptNotifiedAt?: number | null } | undefined;
      if (!fresh || fresh.status === "running" || fresh.transcriptNotifiedAt != null) return;
      const agentExists = sqliteDb
        .prepare("SELECT 1 AS ok FROM Agent WHERE id = ? LIMIT 1")
        .get(agentId) as { ok?: number } | undefined;
      if (!agentExists?.ok) return;
      const latest = sqliteDb
        .prepare("SELECT COALESCE(MAX(seq), -1) AS seq FROM Message WHERE agentId = ?")
        .get(agentId) as { seq: number };
      insertedSeq = Number(latest.seq) + 1;
      const now = Math.floor(Date.now() / 1000);
      sqliteDb
        .prepare("INSERT INTO Message (agentId, seq, type, payload, createdAt) VALUES (?, ?, 'system', ?, ?)")
        .run(agentId, insertedSeq, JSON.stringify(payload), now);
      const updated = sqliteDb
        .prepare("UPDATE Job SET transcriptNotifiedAt = ? WHERE id = ? AND transcriptNotifiedAt IS NULL")
        .run(now, job.id);
      if (Number(updated.changes) !== 1) {
        throw new Error(`job ${job.id} transcript marker was concurrently claimed`);
      }
    });
    if (insertedSeq !== null) {
      this.hub.sendToSession(agentId, {
        type: "message",
        sessionId: agentId,
        seq: insertedSeq,
        msg: payload as never,
      });
    }
  }

  /** Flush terminal notices that were deferred while an agent turn owned the
   * transcript sequence, including notices left pending by a core restart. */
  flushSettledJobNotices(agentId?: string): void {
    const rows = sqliteDb
      .prepare(
        `SELECT * FROM Job
         WHERE status <> 'running' AND transcriptNotifiedAt IS NULL
           AND (? IS NULL OR agentId = ?)
         ORDER BY endedAt ASC, startedAt ASC`,
      )
      .all(agentId ?? null, agentId ?? null) as unknown as DbJob[];
    for (const raw of rows) {
      const job = prisma.job.findUnique({ where: { id: raw.id } });
      if (job) this.persistJobSettledNotice(job);
    }
  }

  private notifyJobSettled(job: DbJob): void {
    try {
      if (!job.agentId) return;
      if (this.running.has(job.agentId)) {
        // Live visibility without mutating the transcript. The durable Job row
        // remains pending and is appended after the run releases its sequence.
        this.hub.sendToSession(job.agentId, {
          type: "message",
          sessionId: job.agentId,
          seq: -1,
          msg: this.jobSettledPayload(job) as never,
        });
        return;
      }
      this.persistJobSettledNotice(job);
    } catch (err) {
      // The Job row remains unnotified and the next flush/restart retries it.
      console.error(`[jobs] could not report job ${job.id} to its agent: ${String(err)}`);
    }
  }

  private async appendCompactStatusMessage(sessionId: string, text: string): Promise<number> {
    const payload = { type: "system" as const, subtype: "compact_status", text };
    const row = await prisma.message.create({
      data: {
        agentId: sessionId,
        seq: this.nextMessageSeq(sessionId),
        type: "system",
        payload,
      },
    });
    this.hub.sendToSession(sessionId, {
      type: "message",
      sessionId,
      seq: row.seq,
      msg: payload as never,
    });
    return row.seq;
  }

  /** Update (or clear) the live context-usage indicator for one agent and push
   *  it to that agent's subscribers. Used after every turn result, and reset to
   *  null on /clear and /compact (the billing UsageEvent table is deliberately
   *  NOT the source here — it survives those resets). */
  private setContextUsage(sessionId: string, usage: ContextUsage | null): void {
    if (usage) {
      this.contextUsageByAgent.set(sessionId, usage);
    } else {
      this.contextUsageByAgent.delete(sessionId);
    }
    this.hub.sendToSession(sessionId, { type: "context_usage", sessionId, usage });
  }

  private clearLiveContext(sessionId: string): void {
    this.liveContextByAgent.delete(sessionId);
  }

  private async contextWindowInput(
    model: string,
    providerKind: string,
    providerId: string | null,
    sessionObserved: number | null,
  ): Promise<EffectiveWindowContext> {
    const windowCtx = scopeForAgent(
      model,
      providerKind,
      await this.runtimeVersionFor(providerKind),
      providerId,
    );
    return {
      ...windowCtx,
      sessionObserved,
      requested: requestedRuntimeWindow(model, windowCtx),
    };
  }

  private async seedLiveContext(
    sessionId: string,
    model: string,
    windowInput: EffectiveWindowContext,
    _systemPrompt: string | null | undefined,
  ): Promise<void> {
    const stored = this.contextUsageByAgent.get(sessionId)?.usedTokens ?? null;
    const fromLastResult =
      stored != null && stored > 0
        ? stored
        : ((await this.latestResultOccupancy(sessionId)) ?? (await this.latestOccupancyTokens(sessionId, 0)));
    const promptTokens = fromLastResult != null && fromLastResult > 0 ? fromLastResult : 0;
    this.liveContextByAgent.set(sessionId, {
      model,
      windowInput,
      promptTokens,
      streamedTokens: 0,
      pendingStreamText: "",
      lastEmitAt: 0,
      lastEmittedUsed: 0,
    });
    this.publishLiveContext(sessionId, { force: true });
  }

  private flushPendingStreamOccupancy(live: LiveContextState): void {
    if (!live.pendingStreamText) return;
    live.streamedTokens += estimateStreamTokens(live.pendingStreamText.length);
    live.pendingStreamText = "";
  }

  private publishLiveContext(sessionId: string, opts: { force: boolean }): void {
    const live = this.liveContextByAgent.get(sessionId);
    if (!live) return;
    const now = Date.now();
    if (
      !shouldEncodeLiveStreamOccupancy({
        force: opts.force,
        now,
        lastEmitAt: live.lastEmitAt,
      })
    ) {
      return;
    }
    this.flushPendingStreamOccupancy(live);
    const used = liveOccupancy(live.promptTokens, live.streamedTokens);
    if (
      !shouldPublishLiveContext({
        force: opts.force,
        now,
        lastEmitAt: live.lastEmitAt,
        lastUsed: live.lastEmittedUsed,
        nextUsed: used,
      })
    ) {
      return;
    }
    const usage = contextUsageFromUsedTokens(live.model, live.windowInput, used);
    live.lastEmitAt = now;
    live.lastEmittedUsed = used;
    this.setContextUsage(sessionId, usage);
  }

  private noteLiveStreamOccupancy(sessionId: string, msg: unknown): void {
    const delta = occupancyDeltaFromStreamEvent(msg);
    if (delta === null) return;
    const live = this.liveContextByAgent.get(sessionId);
    if (!live) return;
    const firstStream = live.streamedTokens === 0 && live.pendingStreamText.length === 0;
    live.pendingStreamText += delta;
    this.publishLiveContext(sessionId, { force: firstStream });
  }

  private async refreshLiveContextAfterPersist(
    sessionId: string,
    msg: unknown,
    sinceSeq: number,
  ): Promise<void> {
    const live = this.liveContextByAgent.get(sessionId);
    if (!live) return;
    this.flushPendingStreamOccupancy(live);
    const type = (msg as { type?: unknown }).type;
    if (type === "assistant") {
      live.promptTokens = occupancyAfterPersistedMessage({
        providerOccupancy: await this.latestOccupancyTokens(sessionId, sinceSeq),
        livePromptTokens: live.promptTokens,
        streamedTokens: live.streamedTokens,
      });
      live.streamedTokens = 0;
      this.publishLiveContext(sessionId, { force: true });
      return;
    }
    if (type === "user") {
      live.promptTokens = occupancyAfterPersistedMessage({
        providerOccupancy: null,
        livePromptTokens: live.promptTokens,
        streamedTokens: live.streamedTokens,
      });
      live.streamedTokens = 0;
      this.publishLiveContext(sessionId, { force: true });
    }
  }

  /** Cached runtime/CLI version per provider kind, for the window-profile
   *  match. An observed effective window is only reused on the SAME runtime
   *  version: a CLI upgrade (or a server-side policy change) can move it, and a
   *  stale ceiling is worse than an honest "unknown". Null → no reuse. Probed
   *  at most once per kind per process; failures stay null (silently unknown). */
  private runtimeVersionFor(kind: string): Promise<string | null> {
    if (kind !== "openai-codex") return Promise.resolve(null);
    const cached = this.runtimeVersionCache.get(kind);
    if (cached !== undefined) return Promise.resolve(cached);
    return (async () => {
      let version: string | null = null;
      try {
        const path = await getCodexCliPath();
        if (path) version = probeCodexVersion(path);
      } catch {
        version = null;
      }
      this.runtimeVersionCache.set(kind, version);
      return version;
    })();
  }

  /** Occupancy of the most recent API call (prompt + that call's output), when
   *  the runtime writes per-call usage onto its assistant rows (Claude,
   *  including third-party anthropic-compat upstreams). Null → caller falls
   *  back to live occupancy or a local count.
   *
   *  Bounded to the CURRENT turn (rows from the user message that started it):
   *  an agent whose provider kind changed leaves older assistant rows carrying
   *  another runtime's usage behind, and a scan across turns would freeze the
   *  bar on that stale number forever. A turn persists one row per content
   *  block, so the newest 24 rows are still enough to reach the last call. */
  private async latestOccupancyTokens(agentId: string, sinceSeq: number): Promise<number | null> {
    const rows = await prisma.message.findMany({
      where: { agentId, type: "assistant" },
      orderBy: { seq: "desc" },
      take: 24,
    });
    return occupancyTokensFromLastCall(
      [...rows].reverse().filter((row) => (row.seq ?? 0) >= sinceSeq),
    );
  }

  /** Last result's provider occupancy, for seeding the live bar without
   *  re-tokenizing the whole transcript at the start of every turn. */
  private async latestResultOccupancy(agentId: string): Promise<number | null> {
    const row = await prisma.message.findFirst({
      where: { agentId, type: "result" },
      orderBy: { seq: "desc" },
      select: { payload: true },
    });
    return occupancyTokensFromResultContextUsage(row?.payload);
  }

  private interruptedTurnAlreadyPersisted(sessionId: string, run: RunningSession): boolean {
    if (run.userMessageSeq === undefined) return false;
    const rows = prisma.message.findMany({
      where: { agentId: sessionId, type: "system" },
      orderBy: { seq: "desc" },
      take: 50,
    });
    return rows.some((row) => {
      const payload = parseInterruptedTurnPayload(row.payload);
      return payload?.runId === run.runId && payload.userSeq === run.userMessageSeq;
    });
  }

  private async persistInterruptedTurn(
    sessionId: string,
    run: RunningSession,
    reason: string,
    liveTextOverride?: string | null,
  ): Promise<InterruptedTurnPayload | null> {
    if (run.interruptedPersisted || run.sawResult || run.userMessageSeq === undefined) return null;
    if (this.interruptedTurnAlreadyPersisted(sessionId, run)) {
      run.interruptedPersisted = true;
      return null;
    }
    // Stored and replayed in full: the interrupted request plus the partial
    // output is exactly the context a "continue" needs, and clipping it at
    // 8 000 / 6 000 chars meant the continuation started from a place the model
    // had never been shown. The turn budget decides what fits, visibly.
    const userRequest = run.userInput.trim();
    if (!userRequest) return null;
    const liveText = liveTextOverride !== undefined ? liveTextOverride : this.liveAssistantText(sessionId);
    const payload: InterruptedTurnPayload = {
      type: "system",
      subtype: "interrupted_turn",
      reason,
      runId: run.runId,
      userSeq: run.userMessageSeq,
      userRequest,
      ...(liveText ? { partialAssistantText: liveText } : {}),
      interruptedAt: new Date().toISOString(),
      ...(run.peerOrigin ? { peerOrigin: run.peerOrigin } : {}),
    };
    const row = await prisma.message.create({
      data: {
        agentId: sessionId,
        seq: this.nextMessageSeq(sessionId),
        type: "system",
        payload,
      },
    });
    run.interruptedPersisted = true;
    this.hub.sendToSession(sessionId, {
      type: "message",
      sessionId,
      seq: row.seq,
      msg: payload as never,
    });
    return payload;
  }

  async sendMessage(
    sessionId: string,
    userInput: string,
    opts?: SendMessageOptions,
  ): Promise<{ finalText: string } | null> {
    if (this.running.has(sessionId) || this.drainingQueues.has(sessionId)) {
      return this.enqueueTurn(sessionId, userInput, opts);
    }
    const drainToken = this.beginDrain(sessionId);
    try {
      return await this.runMessageNow(sessionId, userInput, opts);
    } finally {
      this.finishDrain(sessionId, drainToken);
    }
  }

  private async runMessageNow(
    sessionId: string,
    userInput: string,
    opts?: SendMessageOptions,
  ): Promise<{ finalText: string } | null> {
    let agent = await prisma.agent.findUnique({ where: { id: sessionId } });
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

    // A detached background subagent owes its parent a terminal notification
    // once this run ends (see settleBackgroundSubagent). Read once — the spawn
    // metadata is immutable for the life of the child.
    const backgroundParentId = readMetaBool(agent.metadata, "backgroundTask")
      ? readMetaString(agent.metadata, "spawnedAsTaskFor")
      : null;
    let subagentTerminalStatus: SubagentTerminalOutcome["status"] | null = null;
    let subagentTerminalError: string | null = null;

    const lastMsg = await prisma.message.findFirst({
      where: { agentId: sessionId },
      orderBy: { seq: "desc" },
    });
    let seq = (lastMsg?.seq ?? -1) + 1;

    const abort = new AbortController();
    const runId = randomUUID();
    const pendingTurnHighWaterId = this.pendingTurnHighWaterId(sessionId);
    let staleResume = false;
    let usedResumeSessionId: string | null = null;
    let usedServerConversationId: string | null = null;
    let resumeInvalidReasonForRun: string | null = null;
    let promptTooLong = false;
    let autoRecoverAfterRun: { userInput: string; opts: SendMessageOptions } | null = null;
    let autoRecoveryPromise: Promise<{ finalText: string } | null> | null = null;
    // Declared outside the try so the detached-subagent notification in the
    // `finally` block can read the child's final output.
    let finalText = "";
    this.running.set(sessionId, {
      id: sessionId,
      runId,
      abort,
      seq,
      userInput,
      startedSeq: seq,
      peerOrigin: opts?.peerOrigin,
      startedAt: new Date().toISOString(),
      pendingTurnHighWaterId,
      autoAllowedTools: new Set<string>(),
      ...(backgroundParentId ? { idleTimeoutMs: readBackgroundSubagentIdleTimeoutMs() } : {}),
      ...(opts?.freshnessContinuationForRunId ? { freshnessContinuationUsed: true } : {}),
      ...(typeof opts?.freshnessContinuationCount === "number"
        ? { freshnessContinuationCount: opts.freshnessContinuationCount }
        : {}),
      ...(opts?.nonInteractive ? { nonInteractive: true } : {}),
    });

    try {
    console.log(`[sendMessage] start agent=${sessionId.slice(0, 8)} run=${runId.slice(0, 8)} text="${userInput.slice(0, 40)}"`);

    await this.updateAgentStatus(sessionId, "RUNNING", "running");

    // Persist + broadcast the user input itself. SDK doesn't echo user prompts back
    // through its stream, so without this step a peer-relayed message would never
    // appear in the recipient's chat history.
    const userMsgPayload = opts?.suppressUserMessage
      ? null
      : {
          type: "user" as const,
          message: { role: "user", content: userInput },
          ...(opts?.peerOrigin ? { _peerOrigin: opts.peerOrigin } : {}),
        };
    let userPersisted: DbMessage | null = null;
    if (userMsgPayload) {
      try {
        userPersisted = await prisma.message.create({
          data: {
            agentId: sessionId,
            seq,
            type: "user",
            payload: userMsgPayload,
          },
        });
      } catch (cause) {
        throw new MessagePersistenceError("user", cause);
      }
    }
    if (userPersisted && userMsgPayload) {
      this.hub.sendToSession(sessionId, {
        type: "message",
        sessionId,
        seq: userPersisted.seq,
        msg: userMsgPayload as never,
      });
    }
    const activeRunAfterUser = this.running.get(sessionId);
    if (activeRunAfterUser?.runId === runId && userPersisted) {
      activeRunAfterUser.userMessageSeq = userPersisted.seq;
      activeRunAfterUser.seq = seq + 1;
    }
    if (userPersisted) seq++;

    const mcpServers = await this.loadEnabledMcpServers();
    const peerMcp = makePeerMcpServer(this, sessionId);
    const askUserMcp = makeAskUserMcpServer(this, sessionId);
    const subagentMcp = makeSubagentMcpServer(this, sessionId);
    const helpMcp = makeHelpMcpServer();
    const permissionMode = readPermissionMode(agent.metadata);
    const lastSessionId = readMetaString(agent.metadata, "lastSessionId");
    let capturedSessionId: string | null = lastSessionId;
    let latestCodexUsageSnapshot: CodexUsageSnapshot | null = null;
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

    // ── the turn's single capability resolution ──────────────────────────
    // Resolved ONCE, before any argument is built, and handed to the runtime,
    // to the tools and to `/status` alike. Nothing downstream may re-derive the
    // transport or the working directory: a second answer is how the UI ends up
    // describing a route (or a directory) the SDK is not using. The probe this
    // may run is cached 24h per provider + base URL.
    // `let`: the resolution below produces the plan's SHAPE (transport, root,
    // runtime, model), and the turn's history and skills decisions — both of
    // which need the resolved context budget — are attached to it further down
    // before dispatch. One plan object, completed in place, deep-frozen again
    // (and re-hashed) by the attach step.
    let turnPlan = await this.resolveTurnPlan({
      provider: resolvedProvider
        ? {
            id: resolvedProvider.id,
            kind: resolvedProvider.kind,
            baseUrl: resolvedProvider.baseUrl,
            apiKey: resolvedProvider.apiKey,
            metadata: resolvedProvider.metadata,
          }
        : null,
      model: agent.model,
      reasoningEffort: readReasoningEffortOverride(agent.metadata),
      maxRunDurationMs: readMaxRunDurationMsOverride(agent.metadata),
      allowProbe: true,
      agentId: sessionId,
      projectRoot: projectRootOf(agent),
    });
    this.runPlanByAgent.set(sessionId, turnPlan);
    // NO broadcast here. At this point the plan has no history and no skills
    // attached, so its `history` is the placeholder (`status: "unavailable"`,
    // `counting: "unmeasured"`) — broadcasting it as `source: "last-turn"`
    // claimed, for the whole setup window, that the turn was running with facts
    // it had not been given yet, and every client rendered that as degraded.
    // The ONE broadcast per turn is at the end of setup, after the transcript
    // and skills are attached: the plan the runtime is actually dispatched with.
    this.transportFallbackByAgent.delete(sessionId);
    // Phase 4: register this run with the ONE liveness authority, here — after
    // the plan (which carries the thresholds and the probe capability this route
    // actually has) and before any runtime is dispatched. `hooks` is handed over
    // as a mutable holder so the runtime can register the probe it can answer
    // from inside the run, where the process handle exists.
    const livenessHooks: LivenessRunHooks = {};
    this.liveness.begin({ runId, agentId: sessionId, policy: turnPlan.liveness, hooks: livenessHooks });
    const projectRoot = turnPlan.execution.projectRoot;
    if (projectRoot.value === null) {
      // A turn with nowhere to run is refused, not relocated. Falling back to
      // scratch here would write the user's work into a directory they never
      // chose and will never look in — the exact silent substitution the plan
      // exists to prevent. `/status` reports the same verdict without failing.
      const code = projectRoot.invalid?.code ?? "PROJECT_ROOT_NOT_FOUND";
      const reason = projectRoot.invalid?.reason ?? "no working directory could be resolved for this turn";
      this.hub.sendToSession(sessionId, { type: "error", sessionId, code, message: reason });
      return null;
    }
    const runtimeCwd = projectRoot.value;
    // An unbound agent works in its own scratch directory; create it now, at
    // the start of the turn that needs it (resolving a plan is a read, and
    // `/status` must not create directories).
    if (projectRoot.source === "scratch") {
      const scratch = ensureScratchDir(sessionId);
      if (!scratch.ok) {
        this.hub.sendToSession(sessionId, { type: "error", sessionId, code: "SCRATCH_UNWRITABLE", message: scratch.reason });
        return null;
      }
    }

    // Skill registry context: the project root (workspace) + runtime kind
    // determines whether tool-restriction notes are shown as advisory or
    // explicitly marked as ignored (Codex case).
    //
    // A scratch directory is NOT a project: an unbound agent gets the user- and
    // ensemble-level skills and nothing from `.agents/skills` of a directory
    // that exists only to keep its session files off the home dir.
    const runtimeKindForSkills = resolvedProvider?.kind ?? "anthropic-local";
    const skillWorkspace = projectRoot.source === "agent" ? projectRoot.value : undefined;
    // The turn's skill budget, derived ONCE from the plan. The auto-selection
    // below and the EXPLICIT skill_invoke tool are both bounded by this same
    // number: a tool call happens mid-turn, so the dynamic remainder is not
    // knowable there, and the section budget is its conservative bound. Without
    // it, an explicit invoke could inject an unbounded body into a context that
    // has no room for it — the one path that used to bypass the plan entirely.
    const skillsBudget = skillsBudgetFor(turnPlan.context);
    const skillMeasure = (text: string): number | null => countTokens(agent.model, text) || null;
    const skillMcp = makeSkillMcpServer({
      workspace: skillWorkspace,
      runtimeKind: runtimeKindForSkills,
      tokenBudget: skillsBudget,
      measure: skillMeasure,
    });
    const artifactMcp = makeArtifactMcpServer({
      read: (args) => this.artifactRead(args),
      search: (args) => this.artifactSearch(args),
    });
    // The API that makes long work survivable. Bound to the PROCESS-wide
    // manager, so a job started in this turn is still addressable from a turn
    // that starts after the session was recycled, and `defaultCwd` is this
    // turn's project root so a job runs where the agent believes it does.
    const jobsMcp = makeJobsMcpServer({
      jobs: this.jobs,
      agentId: sessionId,
      agentName: agent.name,
      defaultCwd: runtimeCwd,
    });
    const allMcpServers = {
      ...mcpServers,
      [PEER_MCP_SERVER_NAME]: peerMcp,
      [ASK_USER_MCP_SERVER_NAME]: askUserMcp,
      [SUBAGENT_MCP_SERVER_NAME]: subagentMcp,
      [HELP_MCP_SERVER_NAME]: helpMcp,
      [SKILL_MCP_SERVER_NAME]: skillMcp,
      [ARTIFACT_MCP_SERVER_NAME]: artifactMcp,
      [JOBS_MCP_SERVER_NAME]: jobsMcp,
    };

    if (isClaudeKind && !claudeCliPath) {
      throw new Error(
        `Claude Code CLI not configured for ${currentPlatformKey()}. Install it with ` +
          `\`${CLI_INSTALL_INFO.claude.recommendedInstallCommand}\`, then refresh Settings > CLI.`,
      );
    }
    if (resolvedProvider?.kind === "anthropic-local" && platformRuntime && !platformRuntime.cliPath) {
      throw new Error(`Claude Code CLI is not available on ${currentPlatformKey()}. Configure it in Settings > CLI.`);
    }
    if (isCodexProvider) {
      if (!codexCliPath || (platformRuntime && !platformRuntime.cliPath)) {
        throw new Error(
          `Codex CLI is not available on ${currentPlatformKey()}. Install it with ` +
            `\`${CLI_INSTALL_INFO.codex.recommendedInstallCommand}\`, then refresh Settings > CLI.`,
        );
      }
      if (platformRuntime && platformRuntime.authPresent === false) {
        throw new Error(`Codex CLI is not logged in on ${currentPlatformKey()}. Run \`${CLI_INSTALL_INFO.codex.loginCommand}\` for this OS.`);
      }
    }
    // staleResume is set by the stderr watcher if the CLI reports a missing
    // resume target; the catch path clears that cached session id.
      console.log(
        `[sendMessage] persisted user msg seq=${userPersisted?.seq ?? "(suppressed)"}, ` +
          `dispatching to runtime cli=${claudeCliPath ?? codexCliPath ?? "(sdk)"}`,
      );
      // W16 Slice 1.6: dispatch via AgentRuntime abstraction instead of
      // directly calling the Claude SDK's query(). chooseRuntime falls back
      // to ClaudeAgentRuntime when no provider is bound (legacy default flow).
      const runtime = this.runtimeResolver(resolvedProvider?.kind ?? "anthropic-local");
      // W16 Slice 2.1: OpenAIAgentRuntime needs prior turns reconstructed
      // (no SDK-side resume concept). Read prior user/assistant messages from
      // db and hand them to the runtime — Claude side ignores `history`
      // (CLI session file is the source of truth there).
      const isCodexKind = resolvedProvider?.kind === "openai-codex";
      const runningEntry = this.running.get(sessionId);
      if (runningEntry?.runId === runId) {
        runningEntry.clearResumeOnAbort = isCodexKind;
      }
      const isOpenAIKind =
        resolvedProvider?.kind === "openai-compat" ||
        resolvedProvider?.kind === "openai-local" ||
        isCodexKind;
      // Read for EVERY runtime, once. The budget resolver has to size the same
      // transcript whether or not this runtime will be handed it: a resumed CLI
      // holds those turns in its own session file, and reporting an empty
      // history because "the CLI has it" is how the plan stopped being the
      // single source of truth. The strategy field says who holds it; the
      // counts and the budget are the same numbers either way.
      // The first seq that is NOT prior history: the current user message when
      // it was persisted, otherwise the seq it would have taken. One value, used
      // by the reader below AND by the pre-dispatch compact's upper bound — so
      // the rows the budget measured and the rows a compact may archive are the
      // same rows by construction.
      const priorCutSeq = userPersisted?.seq ?? seq;
      const priorRows = (
        await prisma.message.findMany({
          where: { agentId: sessionId },
          orderBy: { seq: "asc" },
        })
      )
        // The user message we just persisted IS `opts.prompt`, so keeping it
        // would state this turn's request twice.
        .filter((m) => m.seq < priorCutSeq);
      const priorTurns: RuntimeHistoryTurn[] = runtimeHistoryTurnsFromCompletedRows(priorRows);
      // The tool schemas sit in the window alongside the transcript. Named here
      // once, so the runtime's tool list and the budget's accounting cannot
      // describe two different tool sets.
      const runtimeToolNames = [
        "Read",
        "Edit",
        "Write",
        "Bash",
        "Grep",
        "Glob",
        "Task",
        "ExitPlanMode",
      ];
      // W21: precompute team context (async DB read) so the systemPrompt IIFE
      // below stays synchronous. Empty string when agent isn't in a team.
      const teamContextSync = await this.buildTeamContext(sessionId);

      // Build the merged systemPrompt up-front. Done BEFORE runtimeOpts so we
      // can hash it and detect drift since the resumed session started — if
      // we updated buildEnsemblePrimer / buildTeamContext / etc. between
      // turns, the resumed CLI session still has the OLD prompt locked in and
      // our new directives never reach the model. Hash + clear-on-drift forces
      // a fresh session whenever the composed prompt changes.
      const planNotice = planModeNotice(permissionMode);
      const primer = buildEnsemblePrimer();
      const base = agent.systemPrompt ?? "";
      const teamContext = teamContextSync;
      // Project instructions, ONCE, for runtimes whose adapter does not load
      // them while using Ensemble's custom system prompt. Codex reads project
      // rules from its cwd itself. OpenAI has no directory awareness, while
      // Claude's SDK stops CLAUDE.md walk-up when a string systemPrompt and
      // `settingSources: []` are used, so Ensemble must inject the same complete
      // block for both OpenAI and Claude. An unbound
      // agent (scratch) gets nothing: scratch is not the user's project.
      // The gate is the RUNTIME the plan resolved, not the provider's family:
      // `openai-codex` is an OpenAI-branded provider that runs the native Codex
      // CLI (spawned with cwd = the root, so it reads the files itself), while
      // `openai-local`/`openai-compat` run in-process over HTTP and have no
      // directory awareness of their own. Reading the plan's runtime keeps this
      // decision and the executor's on the same field.
      let projectInstructions: string | null = null;
      if (turnPlan.identity.runtime === "openai" || turnPlan.identity.runtime === "claude") {
        try {
          projectInstructions = renderProjectInstructionsBlock(
            loadProjectInstructions(projectRoot.source === "agent" ? projectRoot.value : null),
          );
        } catch (err) {
          // The project HAS rules we cannot read. Running the turn anyway would
          // give this runtime a different (empty) rule set than the native CLIs
          // read from the same directory, so the turn is refused with the code
          // the caller can show — the same treatment a bad project root gets.
          const code = isProjectInstructionsRejection(err)
            ? err.code
            : "PROJECT_INSTRUCTIONS_UNREADABLE";
          const message =
            err instanceof Error ? err.message : "the project instructions could not be loaded";
          this.hub.sendToSession(sessionId, { type: "error", sessionId, code, message });
          return null;
        }
      }
      // Stable hash of the assembled prompt (excluding the non-deterministic
      // skill set — skills are re-picked per turn based on user input, so
      // including them would invalidate resume every turn). What matters for
      // resume safety is: primer + plan + team-context + base. Skills are
      // additive and the model handles their churn gracefully. Computed here,
      // BEFORE the prompt parts are joined, because the resume decision below
      // has to be settled before we know where the skill section is injected.
      const promptHash = hashStableSystemPrompt({
        permissionMode,
        teamContext,
        baseSystemPrompt: base,
        projectInstructions,
      });
      const storedPromptHash = readMetaString(agent.metadata, "systemPromptHash");
      const codexReasoningEffort = readReasoningEffortOverride(agent.metadata);
      const codexSandboxMode = isCodexKind
        ? readSandboxOverride(agent.metadata) ?? readProviderDefaultSandbox(resolvedProvider?.metadata)
        : null;
      const codexResumeSignature = isCodexKind
        ? buildCodexResumeSignature({
            providerId: resolvedProvider?.id ?? null,
            model: agent.model,
            // The value the CLI actually receives, from the plan — not the stored
            // request. A request the plan refused never reached the CLI, so
            // hashing it here would drop a reusable session for a change that
            // did not happen.
            reasoningEffort: turnPlan.execution.reasoningEffort ?? null,
            sandboxMode: codexSandboxMode ?? CODEX_DEFAULT_SANDBOX,
            cwd: runtimeCwd,
            systemPromptHash: promptHash,
          })
        : null;
      const storedCodexResumeSignature = readMetaString(agent.metadata, CODEX_RESUME_SIGNATURE_KEY);
      // If the assembled prompt's identity changed since we last persisted it,
      // the cached session is running with stale instructions. Drop the
      // resume pointer so the next turn opens a fresh CLI session and the
      // updated prompt actually reaches the model.
      let resumeInvalidReason: string | null = null;
      if (lastSessionId !== null) {
        if (storedPromptHash === null) {
          resumeInvalidReason = "missingSystemPromptHash";
        } else if (storedPromptHash !== promptHash) {
          resumeInvalidReason = "systemPromptHash";
        }
      }
      if (
        resumeInvalidReason === null &&
        isCodexKind &&
        lastSessionId !== null &&
        storedCodexResumeSignature !== codexResumeSignature
      ) {
        resumeInvalidReason =
          storedCodexResumeSignature === null ? "missingCodexResumeSignature" : "codexResumeSignature";
      }
      resumeInvalidReasonForRun = resumeInvalidReason;
      const effectiveLastSessionId = resumeInvalidReason ? null : lastSessionId;
      capturedSessionId = effectiveLastSessionId;
      usedResumeSessionId = effectiveLastSessionId;
      if (effectiveLastSessionId === null && lastSessionId !== null) {
        console.log(
          `[sendMessage] resume invalidated agent=${sessionId.slice(0, 8)} reason=${resumeInvalidReason} ` +
            `stored=${storedPromptHash} current=${promptHash} — clearing resume pointer`,
        );
      }
      // ── the turn's skills decision ─────────────────────────────────────
      // Same readers SessionManager always used for the enabled/disabled state
      // (`readSkillForcelist` / `readSkillBlocklist`), and the same registry the
      // MCP `skill_invoke` tool reads, so there is exactly one answer to "what
      // is enabled" and one to "what is active this turn".
      const workspacesForSkills = skillWorkspace ? [skillWorkspace] : [];
      const allSkills = loadSkills(workspacesForSkills);
      const blocked = readSkillBlocklist(agent.metadata);
      const forced = readSkillForcelist(agent.metadata);
      const skillSelection = selectSkills({
        userInput,
        all: allSkills,
        blocked,
        forced,
        runtimeKind: runtimeKindForSkills,
        workspaces: workspacesForSkills,
        tokenBudget: skillsBudget,
        autoActivation: readSkillAutoActivation(agent.metadata),
        // Null (not 0) when the local tokenizer could not answer: selectSkills
        // then labels its numbers "estimated" and says why, instead of treating
        // an unmeasurable skill as free.
        measure: skillMeasure,
      });
      skillSelection.diagnostics.push(
        `skill budget ${skillsBudget ?? "none established"} ` +
          `(${SKILL_BUDGET_FRACTION} of the window after the output reserve); ` +
          "explicit skill_invoke is bounded by the same number (the mid-turn remainder is not knowable there), " +
          "so an over-budget body is refused with SKILL_BUDGET_EXCEEDED rather than injected whole",
      );
      const skillsSection = renderSkillSelection(skillSelection, runtimeKindForSkills);

      // Order: primer → plan → skills → project instructions → (team context OR
      // base). Team context already includes the agent's own systemPrompt
      // verbatim, so when it's present we drop `base` to avoid double role
      // declarations — and the role tail stays LAST so the agent's identity is
      // not buried under project rules.
      //
      // ONE injection point for the skill section. On a fresh session it rides
      // in the system prompt; on a native resume the CLI keeps the system prompt
      // it was started with, so the section goes in the prompt instead — and
      // must NOT also be left in `systemPrompt`, which is how the same skill
      // bodies used to be sent twice in one turn.
      const tailRole = teamContext || base;
      // Claude CLI keeps a session file for official OAuth and for third-party
      // Anthropic-compat (DeepSeek etc.). OpenAI HTTP mints a fresh UUID every
      // turn — that UUID is not a CLI session. Lumping compat in with OpenAI
      // forced a local-rebuild of the whole transcript into one new prompt;
      // CLI compact then failed (`too_few_groups`) and the API returned
      // "Prompt is too long".
      const nativeSessionRuntime =
        turnPlan.identity.runtime === "codex" ||
        (turnPlan.identity.runtime === "claude" &&
          (!resolvedProvider ||
            resolvedProvider.kind === "anthropic-local" ||
            resolvedProvider.kind === "anthropic"));
      const resumed = nativeSessionRuntime && effectiveLastSessionId !== null;
      const promptParts = [
        primer,
        planNotice,
        resumed ? null : skillsSection,
        projectInstructions,
        tailRole,
      ].filter((s) => s && s.length > 0);
      const mergedSystemPrompt = promptParts.join("\n\n---\n\n");
      const promptForRuntime = resumed && skillsSection
        ? `${skillsSection}\n\n---\n\n${userInput}`
        : userInput;

      // ── the turn's history budget ──────────────────────────────────────
      // One resolver, one answer. The strategy names WHO holds the context
      // (the CLI's own session / a server-side conversation / the transcript we
      // assembled), and every consumer reads it from the plan rather than
      // deciding for itself.
      // A server-side continuation is only reusable while everything that
      // shaped it is unchanged. The signature binds the id to the provider, the
      // model, the project root, the stable system-prompt hash and the transport
      // — and a mismatch DISCARDS the id instead of continuing a conversation
      // this agent is no longer in.
      const continuationSignature = serverConversationSignature({
        providerId: resolvedProvider?.id ?? null,
        model: agent.model,
        projectRoot: runtimeCwd,
        systemPromptHash: promptHash,
        transport: turnPlan.transport.resolved,
      });
      const serverConversation = resolveServerConversation({
        metadata: agent.metadata,
        signature: continuationSignature,
        supported: supportsServerConversationFor(turnPlan),
      });
      if (serverConversation.invalidated) {
        // Persisted now, not at the end of the turn: if the turn fails the stale
        // id is still gone, which is the point.
        await prisma.agent.update({
          where: { id: sessionId },
          data: { metadata: withoutServerConversation(agent.metadata) as never },
        });
      }
      // The id this turn hands the runtime, and the signature it was validated
      // against — kept here because the turn's END is what decides the stored
      // value: the new id when the server issued one, nothing when it did not.
      usedServerConversationId = serverConversation.id;
      const historyStrategy: RunPlanHistoryStrategy = resumed
        ? "runtime-session"
        : serverConversation.id
          ? "server-conversation"
          : "local-rebuild";
      // The reason is read from the same decision the strategy is. An invalidated
      // resume is the one case where "local-rebuild" is NOT the default: the
      // agent HAD a session and dropped it, and a report that cannot say which
      // of the two happened is a report nobody can act on.
      const historyStrategyReason =
        resumed || resumeInvalidReason !== null
          ? historyStrategyReasonFor({
              strategy: historyStrategy,
              resumeInvalidReason,
              isOpenAIKind,
            })
          : serverConversation.reason;
      const budgetRequest = {
        systemPrompt: mergedSystemPrompt || null,
        toolsText: toolSchemaOverheadText(runtimeToolNames),
        turnPrompt: promptForRuntime || null,
        context: turnPlan.context,
        strategy: historyStrategy,
        strategyReason: historyStrategyReason,
        measure: (text: string) => countTokens(agent.model, text) || null,
      };
      const historyOutcome = resolveHistoryBudget({
        ...budgetRequest,
        turns: priorTurns.map((entry) => entry.turn),
      });
      let effectiveHistory = historyOutcome;
      // What the local-rebuild strategy will actually hand over. Normally the
      // rows read at the top of the turn; after a pre-dispatch compact it is the
      // REREAD set, because the rows those turns came from no longer exist —
      // matching the new plan against the old objects would hand the runtime an
      // empty history and a summary nothing points at.
      let priorTurnsForDispatch = priorTurns;
      if (historyOutcome.history.overflow && historyStrategy === "local-rebuild") {
        // Over budget on content the runtime has to be handed locally, and no
        // summary covers it yet. Compacting FIRST is the only alternative to
        // dropping it — which is exactly what "never a silent break" means in
        // practice. The compact is itself reversible (see message-archive.ts),
        // so this does not trade one irreversible action for another.
        console.log(
          `[history] agent=${sessionId.slice(0, 8)} over budget by ` +
            `${historyOutcome.history.overflow.count} turn(s) (seq ${historyOutcome.history.overflow.fromSeq}–` +
            `${historyOutcome.history.overflow.toSeq}) — compacting before dispatch`,
        );
        // No extra notice row: the compact itself broadcasts
        // `agent_history_reset` (reason "compact") and `/status` prints the
        // budget, the overflow range and the diagnostics. A third channel
        // describing the same event is how the numbers start to differ.
        try {
          // The bound is the row BEFORE this turn's user message — the exact set
          // of rows `priorRows` measured a moment ago. Without it the compact
          // would read every active row, archive the request being dispatched
          // (deleting it) and then write its summary at a seq the runtime's own
          // events are about to want.
          await this.compactNow(agent, turnPlan, undefined, priorCutSeq - 1);
          const reread = await prisma.message.findMany({
            where: { agentId: sessionId },
            orderBy: { seq: "asc" },
          });
          const refreshed = runtimeHistoryTurnsFromCompletedRows(
            reread.filter((m) => m.seq < priorCutSeq),
          );
          effectiveHistory = resolveHistoryBudget({
            ...budgetRequest,
            turns: refreshed.map((entry) => entry.turn),
          });
          // The reread set replaces the pre-compact one for dispatch as well as
          // for accounting: its turns carry the summary row, and the plan's
          // `included` refers to THESE turn objects.
          priorTurnsForDispatch = refreshed;
          effectiveHistory.history.diagnostics.push(
            "this turn ran a ranged compact before dispatch because the transcript exceeded the history budget",
          );
        } catch (err) {
          effectiveHistory.history.diagnostics.push(
            `the pre-dispatch compact failed (${err instanceof Error ? err.message : String(err)}); ` +
              "the turn is running with the overflow reported rather than silently dropped",
          );
        }
      }
      // The budget is a limit, not a forecast. When the content that must be
      // sent is STILL over it — pinned continuity the budget may not evict, or a
      // summary that alone exceeds the window — the request is not dispatched:
      // sending it would either fail upstream or silently drop content, and both
      // are worse than a refusal that names the numbers. Runtimes that hold the
      // conversation themselves (runtime-session / server-conversation) do not
      // receive this transcript at all, so the figure is reported there without
      // blocking the turn.
      if (historyStrategy === "local-rebuild" && effectiveHistory.history.overBudget) {
        const h = effectiveHistory.history;
        const message =
          `this turn's history is ${h.actualIncludedTokens} tokens against a ${h.tokenBudget}-token budget ` +
          `(${h.actualIncludedTokens - (h.tokenBudget ?? 0)} over) after the pre-dispatch compact — ` +
          "the overage is pinned continuity (the newest summary and the latest interrupted turn), which the budget " +
          "is not allowed to evict. The turn was NOT dispatched: a request that cannot fit the window is not sent. " +
          "Run /compact or /clear, or raise the context budget, and retry.";
        this.hub.sendToSession(sessionId, { type: "error", sessionId, code: "HISTORY_OVER_BUDGET", message });
        console.error(`[history] agent=${sessionId.slice(0, 8)} refusing dispatch: ${message}`);
        return null;
      }
      const historyIncluded = new Set(effectiveHistory.included);
      const priorMessages: SdkMessage[] =
        historyStrategy === "local-rebuild"
          ? priorTurnsForDispatch
              .filter((entry) => historyIncluded.has(entry.turn))
              .map((entry) => entry.message)
          : [];
      turnPlan = attachPlanSkills(
        attachPlanHistory(turnPlan, effectiveHistory.history),
        planSkillsFromSelection(skillSelection, `selected for this turn against a ${skillSelection.counting} skill budget`),
      );
      this.runPlanByAgent.set(sessionId, turnPlan);
      // After the history and skill attachments, so what the UI is handed is the
      // plan the runtime is about to be dispatched with — not the one from
      // before the transcript was sized.
      this.broadcastRunPlan(sessionId, turnPlan);
      if (isCodexKind) {
        console.error(
          JSON.stringify({
            codexDispatch: true,
            agentId: sessionId,
            runId,
            model: agent.model,
            reasoningEffortRequested: codexReasoningEffort,
            reasoningEffortResolved: turnPlan.execution.reasoningEffort ?? null,
            sandboxMode: codexSandboxMode,
            cwd: runtimeCwd,
            hasLastSessionId: lastSessionId !== null,
            resumeSessionId: effectiveLastSessionId,
            storedCodexResumeSignature,
            codexResumeSignature,
            resumeInvalidReason,
          }),
        );
      }
      const runtimeOpts: RuntimeOptions = {
        sessionId,
        prompt: promptForRuntime,
        model: agent.model,
        permissionMode,
        // `tools` restricts what the model can request. `allowedTools` is auto-approval
        // (bypasses canUseTool) — leave empty for built-ins so every tool use round-trips
        // to the user. peer_send and ask_user are system-level safe operations so we
        // auto-approve them.
        tools: runtimeToolNames,
        allowedTools: [
          PEER_SEND_TOOL_NAME,
          PEER_QUERY_TOOL_NAME,
          CONVERSATION_SEARCH_TOOL_NAME,
          ASK_USER_TOOL_NAME,
          SUBAGENT_TOOL_NAME,
          ENSEMBLE_HELP_TOOL_NAME,
          SKILL_INVOKE_TOOL_NAME,
          SKILL_LIST_TOOL_NAME,
          // Reading a stored result is a read-only lookup of material this
          // agent's own turns produced. Nothing to approve.
          ARTIFACT_READ_TOOL_NAME,
          ARTIFACT_SEARCH_TOOL_NAME,
          // Reading a job's own status/log is likewise inert, and it must never
          // need a human: the case these tools exist for is precisely the one
          // where nobody is watching. `job_wait` is bounded by JOB_WAIT_MAX_MS,
          // the same ceiling the Bash tool already exposes.
          //
          // `job_start` and `job_cancel` are deliberately NOT here — they
          // execute and kill processes, which is the class of action the
          // permission prompt exists for. Auto-approving them would make this
          // module a way around the gate the Bash tool still has.
          JOB_STATUS_TOOL_NAME,
          JOB_WAIT_TOOL_NAME,
        ],
        // W20: codex has no per-call approval protocol — its safety gate is
        // the sandboxMode declared at thread start. canUseTool would just
        // silently hang because codex never emits an approval event. Short-
        // circuit to auto-allow; sandboxMode handles refusal of risky ops.
        canUseTool: isCodexKind
          ? async () => ({ behavior: "allow" as const, updatedInput: {} })
          : opts?.nonInteractive
            ? async () => ({
                behavior: "deny" as const,
                message:
                  "Denied: this is a non-interactive freshness reconciliation turn. " +
                  "Do not use permission-gated tools or ask the human; reconcile the queued peer input in text.",
              })
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
        // No `cwd` field: the working directory is read from
        // `runPlan.execution.projectRoot` by every runtime and every tool, so
        // there is exactly one value in play and no second channel that could
        // carry a different one.
        ...(resumed && effectiveLastSessionId ? { resume: effectiveLastSessionId } : {}),
        // The server-side conversation to CONTINUE, already validated against
        // this turn's signature (`serverConversation.id` is null unless the
        // stored id was issued for this exact provider/model/root/prompt/
        // transport). The runtime hands it to the Responses API as
        // `previous_response_id` and sends only this turn's input; a runtime
        // that does not speak that API never sees a value here.
        ...(serverConversation.id ? { serverConversationId: serverConversation.id } : {}),
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
        // Only the turns the budget actually included. A `runtime-session`
        // strategy hands `[]` on purpose: the CLI holds that transcript, and
        // re-sending a locally clipped copy of it is exactly the pretence the
        // plan's strategy field exists to forbid.
        history: priorMessages,
        // W20: codex runtime reads sandboxMode from this blob (per-agent
        // override). Other runtimes ignore it.
        agentMetadata: agent.metadata,
        // No separate `reasoningEffort` field: the runtime reads
        // `runPlan.execution.reasoningEffort`, which is the same object `/status`
        // reports and the same one the plan resolved. A parallel field would be a
        // second channel that could disagree with the plan it was copied from.
        runPlan: turnPlan,
        // Phase 4: what this runtime sees about its own run is reported to the
        // controller through here. A runtime that cannot see a process simply
        // never registers a probe, and its health checks answer `unknown`.
        liveness: this.makeLivenessReporter(runId, livenessHooks),
        // Where a tool result that does not fit the turn's tool-result budget
        // puts its COMPLETE bytes. Same run plan as everything else in this
        // object, so "over budget" has one answer per turn.
        toolOutput: this.toolOutputSink({
          agentId: sessionId,
          runId,
          turnSeq: this.running.get(sessionId)?.userMessageSeq ?? null,
          model: agent.model,
          context: turnPlan.context,
        }),
        onTransportFallback: (info) => {
          this.transportFallbackByAgent.set(sessionId, info);
          console.error(
            `[transport] session=${sessionId.slice(0, 8)} switched ${info.from} → ${info.to} ` +
              `(HTTP ${info.httpStatus ?? "n/a"}, code=${info.upstreamCode ?? "n/a"}): ${info.policyReason}`,
          );
        },
        // Slice 5.1: session-aware callbacks for OpenAIAgentRuntime to
        // register as NormalizedTools. Claude side ignores — same operations
        // already arrive via allMcpServers (peer + ask-user MCP). The closures
        // bind fromAgentId via the Slice 1.7 handler factories.
        peerSend: makePeerSendHandler(this, sessionId),
        peerQuery: makePeerQueryHandler(this, sessionId),
        conversationSearch: makeConversationSearchHandler(this, sessionId),
        askUser: makeAskUserHandler(this, sessionId),
        spawnTask: ({ description, prompt, background, projectRoot: childRoot }) =>
          this.spawnTaskSubagent(sessionId, description, prompt, {
            background,
            ...(childRoot === undefined ? {} : { projectRoot: childRoot }),
          }),
        ensembleHelp: async ({ topic }) => formatEnsembleHelp(topic),
        // Both read the SAME registry and the SAME read path the auto-activation
        // path uses (skills/index.js → skills/read.js), so "what a skill says"
        // has one answer. A failure comes back as a structured code, never as
        // text that reads like a successful body.
        skillList: async () => formatSkillListForTool(workspacesForSkills),
        skillInvoke: async ({ name }) =>
          skillInvokeToolResult(name, {
            runtimeKind: runtimeKindForSkills,
            workspaces: workspacesForSkills,
            measure: skillMeasure,
            // Same budget as the MCP tool and the auto-selection: an explicit
            // invoke is bounded by the plan's skill section, not by nothing.
            tokenBudget: skillsBudget,
          }),
        // Reading a stored artifact (peer source output, peer_query transcript,
        // conversation_search page, subagent final). Bound to the same store
        // the Claude-side MCP tool uses, so a page read on the OpenAI runtime
        // is byte-for-byte the page read on the Claude runtime.
        artifactRead: (args) => this.artifactRead(args),
        artifactSearch: (args) => this.artifactSearch(args),
        // Same process-wide manager and same turn-scoped cwd the Claude-side
        // MCP server got above, so a job started on either runtime is the same
        // job, addressable from the other.
        jobs: { jobs: this.jobs, agentId: sessionId, agentName: agent.name, defaultCwd: runtimeCwd },
      };
      const stream = takeUntilAbort(runtime.query(runtimeOpts), abort.signal);
      const providerKindForContext = resolvedProvider?.kind ?? "anthropic-local";
      await this.seedLiveContext(
        sessionId,
        agent.model,
        await this.contextWindowInput(
          agent.model,
          providerKindForContext,
          resolvedProvider?.id ?? null,
          this.contextUsageByAgent.get(sessionId)?.contextWindow ?? null,
        ),
        mergedSystemPrompt,
      );

      let firstMsg = true;
      // Slice 1 (method A): keep the turn alive after `result` until every
      // drain-blocking Claude background task reports terminal, instead of the
      // old unconditional `break` that silently killed background subagents.
      let sawResultForDrain = false;
      // The server-side response id this turn produced, from the runtime's own
      // result payload. SessionManager is the only writer of the stored
      // continuation: the runtime observes an id, this layer decides whether it
      // may be reused (it is bound to the turn's signature).
      let serverResponseIdFromResult: string | null = null;
      const liveBackgroundTasks = new Map<string, BackgroundTaskInfo>();
      // Ids the SDK currently reports as live background tasks, plus the subset
      // that is genuinely DETACHED. Claude Code emits `task_started` for a
      // long-running FOREGROUND Bash call too (measured: a 2s `git push` gets
      // one, with no `background_tasks_changed`), which is why the UI used to
      // label foreground commands as "background task started".
      let liveBackgroundTaskIds = new Set<string>();
      const detachedBackgroundTaskIds = new Set<string>();
      let lastEventLoopYieldAt = 0;
      let eventsSinceYield = 0;
      const yieldEventLoop = async (): Promise<void> => {
        eventsSinceYield++;
        const now = Date.now();
        if (eventsSinceYield < EVENT_LOOP_YIELD_EVERY_N && now - lastEventLoopYieldAt < EVENT_LOOP_YIELD_MIN_MS) {
          return;
        }
        eventsSinceYield = 0;
        lastEventLoopYieldAt = now;
        await flushVisibleState();
      };
      for await (const event of stream) {
        if (abort.signal.aborted || !this.isRunOwner(sessionId, runId)) break;
        // Every runtime event is proof of life on the model AND on the wire —
        // this is the signal that used to be an idle-timer reset, which had only
        // the power to POSTPONE a kill. It now has the power to END the
        // suspicion, which is the direction that matters.
        this.liveness.noteModelEvent(runId);
        if (event.type === "error") {
          // The runtime explains this ending itself, so it settles the run: a
          // stream that closed WITH a structured reason must not also be read as
          // one that closed abnormally.
          this.liveness.noteStreamClosed(runId, false);
          throw runtimeErrorFromEvent(event);
        }
        const msg = event.payload;
        if (firstMsg) {
          console.log(`[sendMessage] first SDK msg type=${msg.type}`);
          firstMsg = false;
        }

        // Capture SDK session_id from the first message that exposes one,
        // so the next sendMessage can resume the conversation context.
        const incomingSid = (msg as { session_id?: string }).session_id;
        if (incomingSid && incomingSid !== capturedSessionId) {
          capturedSessionId = incomingSid;
        }

        if (isInternalSystemMessage(msg)) {
          // thinking_tokens is the only live signal during redacted CoT
          // (the API streams pings, not thinking_delta). Broadcast it so
          // the pane can show "thinking…" instead of looking idle; do not
          // persist — it is a heartbeat, not resume context.
          this.streamWs.flush(sessionId);
          this.hub.sendToSession(sessionId, { type: "message", sessionId, seq: -1, msg: msg as never });
          await yieldEventLoop();
          continue;
        }

        this.recordLiveTranscript(sessionId, msg);

        if (msg.type === "stream_event") {
          this.noteLiveStreamOccupancy(sessionId, msg);
          this.streamWs.push(sessionId, msg);
          await yieldEventLoop();
          if (abort.signal.aborted || !this.isRunOwner(sessionId, runId)) break;
          continue;
        }

        // Slice 1 (method A): track Claude background-task lifecycle so the
        // turn can DRAIN past `result` and finalize only once background work
        // settles. `task_progress` is a broadcast-only heartbeat — surfaced to
        // the UI but NOT persisted, to keep resume context precise (mission:
        // 精准记忆). Unknown/other system subtypes fall through and are
        // persisted+broadcast as before (never silently dropped).
        const bgDelta = classifyBackgroundTaskMessage(msg);
        if (bgDelta) {
          // Phase 4: a background task reporting in IS the run being alive. The
          // gate is explicit about this — seven silent minutes with a live
          // native child must not end anything — and this is the signal that
          // makes that true even when the model itself has nothing to say.
          this.liveness.noteToolProgress(runId);
          if (bgDelta.kind === "prune") liveBackgroundTaskIds = bgDelta.liveIds;
          // Tag each message with the detach-ness of the task it belongs to so
          // the UI can word a foreground command as a command. The SDK emits
          // `background_tasks_changed` immediately BEFORE the matching
          // `task_started` (measured: seq 622→623 and 1318→1319), so the live
          // set as it stands right now is authoritative for this task.
          if (bgDelta.kind === "add") {
            const isDetached = liveBackgroundTaskIds.has(bgDelta.task.taskId);
            (msg as { detached?: boolean }).detached = isDetached;
            if (isDetached) detachedBackgroundTaskIds.add(bgDelta.task.taskId);
          } else {
            const taskId = (msg as { task_id?: unknown }).task_id;
            if (
              typeof taskId === "string" &&
              (detachedBackgroundTaskIds.has(taskId) || liveBackgroundTaskIds.has(taskId))
            ) {
              (msg as { detached?: boolean }).detached = true;
            }
          }
          const { broadcastOnly, lost } = applyBackgroundTaskDelta(liveBackgroundTasks, bgDelta);
          // A tracked task that leaves the live set without ever reporting
          // terminal must be surfaced NOW: pruned silently, a dead background
          // build reads as a clean DONE and its fate only shows up at the top
          // of the next turn (measured: seq 645 vs 647).
          if (lost.length > 0) {
            console.warn(
              `[sendMessage] background task(s) lost from live set agent=${sessionId.slice(0, 8)} tasks=[${lost.map((t) => t.taskId).join(",")}]`,
            );
            for (const task of lost) detachedBackgroundTaskIds.delete(task.taskId);
            seq =
              (await this.appendBackgroundTaskNotice(
                sessionId,
                backgroundTaskInterruptedMessage(lost, "live_set_dropped"),
              )) + 1;
          }
          if (broadcastOnly) {
            this.hub.sendToSession(sessionId, { type: "message", sessionId, seq: -1, msg: msg as never });
            continue;
          }
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

        let persisted: DbMessage;
        try {
          this.streamWs.flush(sessionId);
          persisted = await prisma.message.create({
            data: {
              agentId: sessionId,
              seq,
              type: msg.type,
              payload: msg as object,
            },
          });
        } catch (cause) {
          throw new MessagePersistenceError(msg.type, cause);
        }

        // W17.3: double-write usage events on every result message. Pure
        // helper; emits one row per model in the result's modelUsage map.
        // Pricing is resolved against pricing.json (Claude SDK's costUSD
        // is intentionally ignored — wrong for third-party anthropic-compat).
        if (msg.type === "result") {
          const activeRun = this.running.get(sessionId);
          if (activeRun?.runId === runId) activeRun.sawResult = true;
          this.liveness.noteResultSeen(runId);
          if (isPromptTooLongResult(msg)) promptTooLong = true;
          latestCodexUsageSnapshot = normalizeCodexUsageSnapshot(
            (msg as { _codexUsageSnapshot?: unknown })._codexUsageSnapshot,
          );
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

          // Refresh the live context-usage indicator from this result. Occupancy
          // is prompt + this call's output, so the bar does not drop when the
          // stream ends. Prefer per-call usage on assistant rows (Claude), else
          // the result payload's `contextUsage` (OpenAI / Codex). Live occupancy
          // wins when the provider number is smaller (Codex currently reports
          // outputTokens: 0). Fall back to a local count of the replayed history.
          const providerKind = resolvedProvider?.kind ?? "anthropic-local";
          const windowInput = await this.contextWindowInput(
            agent.model,
            providerKind,
            resolvedProvider?.id ?? null,
            reportedContextWindowFromResult(msg, agent.model) ?? null,
          );
          const live = this.liveContextByAgent.get(sessionId);
          if (live) {
            live.windowInput = windowInput;
            this.flushPendingStreamOccupancy(live);
          }
          const liveUsed = live
            ? liveOccupancy(live.promptTokens, live.streamedTokens)
            : 0;
          const providerTokens =
            (await this.latestOccupancyTokens(sessionId, userPersisted?.seq ?? 0)) ??
            occupancyTokensFromResultContextUsage(msg);
          const used =
            providerTokens !== null
              ? Math.max(providerTokens, liveUsed)
              : liveUsed > 0
                ? liveUsed
                : null;
          // Never tokenize the full transcript here: a long DeepSeek session
          // (thousands of rows) freezes the Node event loop, so every other
          // agent stops answering and settings HTTP never returns.
          if (used !== null) {
            this.setContextUsage(
              sessionId,
              contextUsageFromUsedTokens(agent.model, windowInput, used),
            );
          }
          this.clearLiveContext(sessionId);
        } else {
          await this.refreshLiveContextAfterPersist(
            sessionId,
            msg,
            userPersisted?.seq ?? 0,
          );
        }

        this.hub.sendToSession(sessionId, {
          type: "message",
          sessionId,
          seq: persisted.seq,
          msg: msg as never,
        });
        await yieldEventLoop();

        seq++;
        // A result message ends the *foreground* turn, but Claude background
        // subagents may still be running (method A). Finalize only once the
        // result is seen AND no drain-blocking background task remains. If the
        // SDK closes the stream first, the for-await simply ends and we
        // finalize gracefully. Phase 4 removed the sentence that used to follow
        // ("if a task goes silent past the idle watchdog, that watchdog aborts
        // the run"): a silent background task with a live child is exactly the
        // case the liveness rule protects, so the drain waits for an ACTUAL
        // terminal event rather than for a clock.
        if (msg.type === "result") {
          sawResultForDrain = true;
          const responseId = (msg as { serverResponseId?: unknown }).serverResponseId;
          if (typeof responseId === "string" && responseId.length > 0) {
            serverResponseIdFromResult = responseId;
          }
        }
        if (shouldFinalizeTurn(sawResultForDrain, liveBackgroundTasks)) break;
      }
      // Phase 4: the stream ended from the consumer's side. `noteStopRequested`
      // is what tells the controller that anything the runtime does from here on
      // is a consequence of us finishing, not evidence about the run — without
      // it, the runtime tearing down its child process would look like a
      // confirmed death.
      this.liveness.noteStopRequested(runId);
      this.liveness.noteStreamClosed(runId, false);

      // A background task can die/hang without ever emitting a terminal
      // task_notification, and the SDK can still close the stream. That must
      // never be silently swallowed into a `status:"DONE"` turn — surface a
      // visible, persisted error-toned notice (design §6: no silent drops, no
      // clean completion for an interrupted drain).
      const unresolvedAtClose = [...liveBackgroundTasks.values()];
      if (abort.signal.aborted && unresolvedAtClose.length > 0) {
        // The turn was cancelled (user stop / idle watchdog / peer interrupt)
        // while background work was live. The old `!abort.signal.aborted` guard
        // skipped the notice entirely here, so a cancelled turn orphaned those
        // shells in silence — surface them as detached-from-supervision.
        console.warn(
          `[sendMessage] turn aborted with live background task(s) agent=${sessionId.slice(0, 8)} tasks=[${unresolvedAtClose.map((t) => t.taskId).join(",")}]`,
        );
        await this.appendBackgroundTaskNotice(
          sessionId,
          backgroundTaskOrphanedMessage(unresolvedAtClose, "turn_aborted"),
        );
      } else if (sawResultForDrain && unresolvedAtClose.length > 0) {
        console.warn(
          `[sendMessage] background task(s) unresolved at stream close agent=${sessionId.slice(0, 8)} tasks=[${unresolvedAtClose.map((t) => t.taskId).join(",")}]`,
        );
        await this.appendBackgroundTaskNotice(
          sessionId,
          backgroundTaskInterruptedMessage(unresolvedAtClose, "stream_closed"),
        );
      }

      // Phase 4 gate 4: the stream closed with background work still
      // outstanding is NOT a completed turn. This used to persist `DONE`
      // regardless — the notice above was written into the transcript and then
      // contradicted by the very status written immediately after it, so a
      // turn whose shells were still (or no longer) running reported success.
      // `IDLE` is this codebase's word for interrupted, and it is what the run
      // gets here.
      const drainedCleanly = unresolvedAtClose.length === 0;
      const persistData: { status: "DONE" | "IDLE"; metadata?: object } = {
        status: drainedCleanly ? "DONE" : "IDLE",
      };
      subagentTerminalStatus = drainedCleanly ? "DONE" : "IDLE";
      if (!drainedCleanly) {
        this.liveness.end(runId, "RUNTIME_STREAM_CLOSED", "interrupted");
      } else {
        this.liveness.end(runId, "completed", "completed");
      }
      if (!opts?.suppressRuntimeMetadata) {
        const metaPatch: Record<string, unknown> = {};
        if (!promptTooLong && capturedSessionId && capturedSessionId !== effectiveLastSessionId) {
          metaPatch.lastSessionId = capturedSessionId;
        }
        // Always persist the current promptHash on success so the next turn can
        // detect drift correctly even if the hash didn't change this turn.
        if (storedPromptHash !== promptHash) {
          metaPatch.systemPromptHash = promptHash;
        }
        if (latestCodexUsageSnapshot) {
          metaPatch.codexUsageSnapshot = latestCodexUsageSnapshot;
        }
        if (codexResumeSignature && storedCodexResumeSignature !== codexResumeSignature) {
          metaPatch[CODEX_RESUME_SIGNATURE_KEY] = codexResumeSignature;
        }
        if (
          resumeInvalidReasonForRun !== null ||
          promptTooLong ||
          Object.keys(metaPatch).length > 0 ||
          serverResponseIdFromResult !== null
        ) {
          const baseMetadata =
            resumeInvalidReasonForRun !== null || promptTooLong
              ? removeMetadataKeys(agent.metadata, [...RESUME_METADATA_KEYS])
              : agent.metadata;
          let nextMetadata = mergeMetadata(baseMetadata, metaPatch);
          // Only a route that earned the continuation may store the id it
          // issued. On a route that did not, an id in hand would be an
          // invitation to name a continuation the endpoint never agreed to —
          // and `storedAt` is seconds, purely so a reader can see its age.
          if (serverResponseIdFromResult !== null && supportsServerConversationFor(turnPlan)) {
            nextMetadata = withServerConversation(
              nextMetadata,
              serverResponseIdFromResult,
              continuationSignature,
              Math.floor(Date.now() / 1000),
            );
          }
          persistData.metadata = nextMetadata;
        }
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
      // Phase 4: the run ends here, and WHICH ending it gets is decided by what
      // actually happened, not by the fact that an exception passed through. An
      // abort is the user's own decision (`user-cancelled`), anything else is a
      // run that stopped before it completed (`interrupted`) — neither is a
      // confirmed death, and neither may be reported as a completion.
      const persistenceFailure = err instanceof MessagePersistenceError;
      this.liveness.noteStopRequested(runId);
      if (abort.signal.aborted) {
        this.liveness.end(runId, "user-cancelled", "user-cancelled");
      } else if (persistenceFailure) {
        this.liveness.end(runId, "MESSAGE_PERSISTENCE_FAILED", "interrupted");
      } else {
        this.liveness.end(runId, "RUNTIME_STREAM_CLOSED", "interrupted");
      }
      const aborted = abort.signal.aborted;
      const rawMsg = err instanceof Error ? err.message : String(err);
      const runtimeDetails = (err && typeof err === "object" ? err : {}) as Partial<RuntimeErrorDetails>;
      console.log(
        `[sendMessage] caught err agent=${sessionId.slice(0, 8)} run=${runId.slice(0, 8)} ` +
          `aborted=${aborted} stale=${staleResume} runtimeCode=${runtimeDetails.runtimeCode ?? "(none)"} err=${rawMsg}`,
      );
      // Self-heal stale resume: clear the bad lastSessionId so the next send
      // starts a fresh CLI session instead of re-failing on the same lookup.
      const persistData: { status: "ERROR" | "IDLE"; metadata?: object } = {
        status: aborted ? "IDLE" : "ERROR",
      };
      const structuredResumeFailure = isRuntimeResumeRecoverySignal(
        runtimeDetails.runtimeCode,
        runtimeDetails.runtimeRecoverable,
        runtimeDetails.runtimeResumeScoped,
        usedResumeSessionId,
      );
      const legacyResumeFailure =
        !structuredResumeFailure &&
        runtimeDetails.runtimeCode === undefined &&
        isResumeScopedStreamFailure(rawMsg, usedResumeSessionId);
      const recoverableResumeFailure = structuredResumeFailure || legacyResumeFailure;
      const recoverableCodexEventStreamFailure = isRuntimeCodexEventStreamRecoverySignal(
        runtimeDetails.runtimeCode,
        runtimeDetails.runtimeRecoverable,
      );
      const recoverableThreadWriterConflict = isRuntimeCodexThreadWriterConflictSignal(
        runtimeDetails.runtimeCode,
        runtimeDetails.runtimeRecoverable,
      );
      if (
        resumeInvalidReasonForRun !== null ||
        staleResume ||
        recoverableResumeFailure ||
        recoverableCodexEventStreamFailure ||
        recoverableThreadWriterConflict
      ) {
        persistData.metadata = removeMetadataKeys(agent.metadata, [...RESUME_METADATA_KEYS]);
        console.warn(
          `[sendMessage] clearing resume metadata agent=${sessionId.slice(0, 8)} ` +
            `run=${runId.slice(0, 8)} stale=${staleResume} ` +
            `resumeInvalidReason=${resumeInvalidReasonForRun ?? "(none)"} ` +
            `structuredResumeFailure=${structuredResumeFailure} legacyResumeFailure=${legacyResumeFailure} ` +
            `codexEventStreamFailure=${recoverableCodexEventStreamFailure}`,
        );
      }
      // A continuation the endpoint REJECTED is a verdict about the route, not
      // an incident to retry. Recorded against the provider (24h, like every
      // other capability verdict) and the id is dropped with it, so the next
      // turn rebuilds the transcript locally instead of failing the same way.
      //
      // The test is STRUCTURED, never prose (see capability/transport-errors.ts):
      // a request-shaped status or an "unsupported" classification, on a turn
      // that actually carried a continuation id. A 400 from this endpoint for
      // some unrelated field therefore downgrades us too — the safe direction,
      // and the recorded status/code says what happened.
      if (!aborted && usedServerConversationId !== null) {
        const status = runtimeDetails.httpStatus ?? null;
        const requestShaped =
          runtimeDetails.transportClassification === "request" ||
          runtimeDetails.transportClassification === "unsupported" ||
          status === 400 ||
          status === 404 ||
          status === 422;
        if (requestShaped) {
          const rejectionBase =
            (persistData.metadata as Record<string, unknown> | undefined) ??
            (agent.metadata as Record<string, unknown>);
          persistData.metadata = withServerConversationRejection(
            rejectionBase,
            {
              reason: firstLine(rawMsg),
              httpStatus: status,
              upstreamCode: runtimeDetails.upstreamCode ?? null,
            },
            new Date(),
          );
          console.warn(
            `[sendMessage] server-side conversation rejected agent=${sessionId.slice(0, 8)} ` +
              `run=${runId.slice(0, 8)} status=${status ?? "(none)"} ` +
              `code=${runtimeDetails.upstreamCode ?? "(none)"} — dropping the continuation id`,
          );
        }
      }
      const shouldAutoRecoverCodexEventStream =
        !aborted &&
        recoverableCodexEventStreamFailure &&
        opts?.autoRecoveryAttempt !== "codex-event-stream-lagged";
      // Thread-store writer conflict: the cached thread id is now unusable
      // (a prior process held/holds its writer). Clear resume (done above) and
      // auto-continue on a fresh thread from local history — unattended, no
      // user resend. Guarded by the attempt tag so a repeat conflict can't loop.
      const shouldAutoRecoverThreadWriterConflict =
        !aborted &&
        recoverableThreadWriterConflict &&
        opts?.autoRecoveryAttempt !== "codex-thread-writer-conflict";
      if (shouldAutoRecoverCodexEventStream) {
        persistData.status = "IDLE";
        autoRecoverAfterRun = {
          userInput: "continue",
          opts: {
            ...(opts?.peerOrigin ? { peerOrigin: opts.peerOrigin } : {}),
            autoRecoveryAttempt: "codex-event-stream-lagged",
            suppressUserMessage: true,
          },
        };
      } else if (shouldAutoRecoverThreadWriterConflict) {
        persistData.status = "IDLE";
        autoRecoverAfterRun = {
          userInput: "continue",
          opts: {
            ...(opts?.peerOrigin ? { peerOrigin: opts.peerOrigin } : {}),
            autoRecoveryAttempt: "codex-thread-writer-conflict",
            suppressUserMessage: true,
          },
        };
      }
      // Auto-recovery keeps the run alive on a fresh thread/session, so it is
      // NOT a terminal state — the retry run settles the child instead.
      if (!shouldAutoRecoverCodexEventStream && !shouldAutoRecoverThreadWriterConflict) {
        // A cancelled child is reported as INTERRUPTED, not failed: the parent
        // must not treat a deliberate stop as a broken task.
        subagentTerminalStatus = aborted ? "IDLE" : persistData.status;
        subagentTerminalError = aborted ? "the run was cancelled before it completed" : rawMsg;
      }
      // Same guard as the success path. cancel() owns the canonical IDLE state
      // once it's removed this run from the map.
      if (this.running.get(sessionId)?.runId === runId) {
        const activeRun = this.running.get(sessionId);
        if (activeRun?.runId === runId && !activeRun.sawResult) {
          const reason = aborted
            ? "aborted"
            : persistenceFailure
              ? "MESSAGE_PERSISTENCE_FAILED"
              : String(runtimeDetails.runtimeCode ?? (staleResume ? "SESSION_LOST" : "QUERY_FAILED"));
          await this.persistInterruptedTurn(sessionId, activeRun, reason);
        }
        const updated = await prisma.agent.update({ where: { id: sessionId }, data: persistData });
        this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
        if (!aborted) {
          const friendly = staleResume
            ? "Previous conversation session was lost (the CLI's local session file is gone). " +
              "Cleared cached session id; please send your message again to start fresh."
            : shouldAutoRecoverCodexEventStream
              ? rawMsg + "\n\nThe local Codex event stream fell behind and dropped events. Ensemble saved the interrupted turn, cleared cached Codex resume state, and is automatically continuing from local history."
            : shouldAutoRecoverThreadWriterConflict
              ? rawMsg + "\n\nThe cached Codex thread was still locked by a previous process (thread-store writer conflict). Ensemble killed the stale process, cleared the cached thread id, and is automatically continuing on a fresh thread from local history."
            : recoverableResumeFailure
              ? rawMsg + "\n\nCleared cached session state for this agent. Please send your message again; Ensemble will start a fresh runtime session while preserving the local chat history."
            : rawMsg;
          this.hub.sendToSession(sessionId, {
            type: "error",
            sessionId,
            code: shouldAutoRecoverCodexEventStream
              ? "CODEX_EVENT_STREAM_RECOVERING"
              : shouldAutoRecoverThreadWriterConflict
                ? "CODEX_THREAD_WRITER_CONFLICT_RECOVERING"
                : persistenceFailure
                  ? "MESSAGE_PERSISTENCE_FAILED"
                  : staleResume ? "SESSION_LOST" : "QUERY_FAILED",
            message: friendly,
          });
        }
        this.hub.sendToSession(sessionId, {
          type: "status",
          sessionId,
          status:
            aborted || shouldAutoRecoverCodexEventStream || shouldAutoRecoverThreadWriterConflict
              ? "idle"
              : "error",
        });
      } else {
        console.log(`[sendMessage] run=${runId.slice(0, 8)} error post-cancel; skipping DB update`);
      }
    } finally {
      this.streamWs.flush(sessionId);
      // Only clear state if we're still the owner. After cancel() the entry
      // is gone; a brand-new sendMessage could already have set its own entry.
      // Without this guard a wedged old run's finally would corrupt the new run.
      if (this.running.get(sessionId)?.runId === runId) {
        const activeRun = this.running.get(sessionId)!;
        const freshnessDrainOpts = this.runEndDrainOptions(activeRun);
        // Phase 4: the run is over — whichever path got us here (success, error,
        // cancel, early return). The record keeps whatever reason was set; this
        // is the backstop for a path that never set one, and it keeps the
        // controller's live map from outliving the run it describes.
        this.liveness.noteStopRequested(runId);
        this.liveness.end(runId, "completed", "completed");
        this.clearLiveContext(sessionId);
        this.running.delete(sessionId);
        this.pending.delete(sessionId);
        const qb = this.pendingQuestions.get(sessionId);
        if (qb) {
          for (const [, q] of qb) q.resolve("[run ended before answer]");
          this.pendingQuestions.delete(sessionId);
        }
        if (autoRecoverAfterRun) {
          const recoveryDrainToken = this.beginDrain(sessionId);
          autoRecoveryPromise = this.runMessageNow(sessionId, autoRecoverAfterRun.userInput, autoRecoverAfterRun.opts)
            .catch((err) => {
              console.error(`[codex-event-stream-recovery] retry for ${sessionId} failed:`, err);
              return null;
            })
            .finally(() => {
              this.finishDrain(sessionId, recoveryDrainToken);
            });
        } else {
          this.drainQueuedTurns(sessionId, freshnessDrainOpts);
        }
      }

      // Deliberately OUTSIDE the owner guard: cancel() deletes the running
      // entry synchronously, so a cancelled run fails that guard — and a
      // cancelled background child is exactly the case where the parent used to
      // be left in the dark forever. settleBackgroundSubagent is idempotent and
      // writes its durable record before it queues anything, so a superseded run
      // racing the new owner can't double-notify.
      if (backgroundParentId && subagentTerminalStatus) {
        // Fire-and-forget: notifying the parent must never delay this run's
        // teardown or the queue drain.
        void this.settleBackgroundSubagent(sessionId, backgroundParentId, {
          status: subagentTerminalStatus,
          ...(subagentTerminalError ? { error: subagentTerminalError } : {}),
          ...(finalText.trim() ? { finalText } : {}),
        }).catch((err) => {
          console.error(
            `[subagent:bg] failed to notify parent ${backgroundParentId.slice(0, 8)} about ${sessionId.slice(0, 8)}:`,
            err,
          );
        });
      }
      // Job settlements that arrived during this run were shown live but not
      // inserted into Message: the turn's local sequence cursor owned that
      // namespace until its iterator fully unwound. Persist them now. If a new
      // run already won the race, flushSettledJobNotices sees it and defers.
      if (!this.running.has(sessionId)) this.flushSettledJobNotices(sessionId);
    }
    return autoRecoveryPromise ? await autoRecoveryPromise : null;
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

  /** Re-emit the authoritative current state to a freshly subscribed socket,
   * then replay any unanswered permission/user questions. This makes subscribe
   * a resync point for clients that missed recovery broadcasts while offline. */
  async replaySubscriptionStateFor(sessionId: string, socket: WebSocket): Promise<void> {
    const agent = await prisma.agent.findUnique({ where: { id: sessionId } });
    if (!agent) return;
    this.hub.sendTo(socket, { type: "agent_updated", agent: agentRowToSummary(agent) });
    this.hub.sendTo(socket, { type: "status", sessionId, status: dbToProto(agent.status) });
    // The context readout is server-owned state: the numerator is a runtime
    // observation and the limits come from the plan. A client that just opened
    // or reconnected holds neither, and MUST NOT infer one — so the last
    // reading is re-emitted here, and an absent one is sent as an explicit
    // null ("nothing has been observed"), not left for the UI to guess.
    this.hub.sendTo(socket, {
      type: "context_usage",
      sessionId,
      usage: this.contextUsageByAgent.get(sessionId) ?? null,
    });
    // The plan the last turn actually ran under — the other half of the same
    // resync. The client DROPS its copy when the connection goes (`clearRunPlan`:
    // a finished turn's limits must not read as the next turn's), so without
    // this the bar's plan half — effective window, output reserve, counting
    // quality, compaction state, degraded markers — stays empty until the next
    // turn, and everything derived from `planView` (including `/status`) has
    // nothing to read. Sent only when the server holds one: an agent that has
    // never been dispatched has no plan, and inventing an empty one would be a
    // prediction, not a record. */
    const lastPlan = this.runPlanByAgent.get(sessionId);
    if (lastPlan) {
      this.hub.sendTo(socket, {
        type: "run_plan",
        sessionId,
        plan: runPlanStatusView({ plan: lastPlan, source: "last-turn" }),
      });
    }
    this.replayPendingFor(sessionId, socket);
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
    const run = this.running.get(sessionId);
    if (run?.nonInteractive) {
      return "freshness-blocked: ask_user is disabled for this non-interactive freshness continuation. Reconcile the queued peer message(s) without human input.";
    }
    if (run) {
      const action: FreshnessBlockedAction = { tool: "ask_user" };
      const queued = this.findFreshnessBlockingPeerTurns(run, action);
      if (queued.length > 0) {
        run.blockedFreshnessAction = action;
        return this.formatFreshnessBlockedResult(action, queued);
      }
    }
    const reqId = randomUUID();
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

  // ── result artifacts ───────────────────────────────────────────────────────
  // A large result is stored WHOLE first and presented second. The presentation
  // (inline text, or a bounded preview plus the artifact's id/sha256/size) is
  // the only thing that reaches a model or a chat message; the bytes behind it
  // always exist and are always readable (artifact_read / artifact_search).
  //
  // Before this, the capped paths had no copy at all: peer source output,
  // peer_query transcripts and subagent final text were each cut before they
  // were stored (1 600 / 4 000 / 5 000 / 8 000 / 12 000 characters, depending
  // on the path), so a recipient reviewing "the source output" could be reading
  // a prefix while the sender believed it had sent everything.

  /** The model id whose tokenizer should measure a result for this agent. From
   *  the plan when the agent has one (the model the turn actually runs), else
   *  from its row. `""` means unmeasurable, which the caller turns into the
   *  conservative UTF-8 byte bound rather than a silent zero. */
  private async modelOfAgent(agentId: string): Promise<string> {
    const planModel = this.runPlanByAgent.get(agentId)?.identity.modelId;
    if (planModel) return planModel;
    const row = await prisma.agent.findUnique({ where: { id: agentId } });
    return row?.model ?? "";
  }

  /** artifact_read, in-process. Deliberately NOT bound to a calling agent: the
   *  id is the capability. A peer handoff stores the SOURCE's output and the
   *  RECIPIENT must be able to read it back, so an ownership check here would
   *  break the one flow artifacts exist for. */
  artifactRead(args: ArtifactReadArgs): ArtifactReadResult {
    return readArtifactPage(args.id, { cursor: args.cursor ?? null, pageBytes: args.pageBytes ?? null });
  }

  artifactSearch(args: ArtifactSearchArgs): ArtifactSearchResult {
    return searchArtifact(args.id, {
      query: args.query,
      caseSensitive: args.caseSensitive === true,
      maxHits: args.maxHits ?? null,
      snippetBytes: args.snippetBytes ?? null,
      cursor: args.cursor ?? null,
    });
  }

  /** The turn's tool-result capability, handed to the runtime and passed
   *  straight through to its tools (see `ToolOutputSink`).
   *
   *  It is built here, and only here, because the three facts behind an
   *  over-budget result all live at this layer: `budgetBytes` is the SAME
   *  `windowFractionBudget(context, ARTIFACT_INLINE_FRACTION)` the rest of the
   *  turn is measured against (a tool that invented its own ceiling would
   *  disagree with the plan `/status` reports), `present` writes through the one
   *  artifact store, and the agent / run / turn correlation is `presentResult`'s
   *  own — no second mechanism, and nothing clipped before the write.
   *
   *  A `null` budget means no window was established. It is NOT a zero budget:
   *  the caller passes it on as "no number", so the artifact is still written
   *  and nothing is dropped on a guess. */
  private toolOutputSink(args: {
    agentId: string;
    runId: string;
    turnSeq: number | null;
    model: string;
    context: RunPlanContext | null;
  }): ToolOutputSink {
    const decision = decideArtifactInline({ text: "", context: args.context, measure: () => null });
    const budgetBytes = decision.budgetTokens === null ? null : previewBytesFor(decision);
    return {
      budgetBytes,
      present: ({ source, headerLines }) => {
        const presented = this.presentSpooledResult({
          agentId: args.agentId,
          model: args.model,
          kind: "tool-output",
          source,
          budgetBytes,
          runId: args.runId,
          turnSeq: args.turnSeq,
          ...(headerLines ? { headerLines } : {}),
        });
        return {
          text: presented.text,
          handle: presented.handle,
          inlined: presented.inlined,
          reason: presented.reason,
        };
      },
    };
  }

  /** Store a SPOOLED result and render what the caller should carry — the
   *  over-budget path of `presentResult`, for a body that may be larger than
   *  memory.
   *
   *  It is a separate method rather than a branch inside `presentResult` because
   *  the two write different storage shapes: a string that fits is stored on the
   *  row, and a streamed body becomes chunk rows. The rendering is the same, and
   *  so is the rule it follows — the artifact is written first, and the preview
   *  is page one of the artifact rather than a copy of the text. */
  private presentSpooledResult(args: {
    agentId: string;
    model: string;
    kind: string;
    source: ArtifactBodySource;
    /** The turn's tool-result budget in bytes, or null when no window was
     *  established (the artifact is written either way). */
    budgetBytes: number | null;
    headerLines?: string[];
    runId?: string | null;
    turnSeq?: number | null;
  }): { text: string; handle: ArtifactHandle; inlined: boolean; reason: string } {
    const run = this.running.get(args.agentId);
    const row = createArtifactFromSpool({
      agentId: args.agentId,
      runId: args.runId ?? run?.runId ?? null,
      turnSeq: args.turnSeq ?? run?.userMessageSeq ?? null,
      kind: args.kind,
      source: args.source,
    });
    const handle = handleOf(row);
    const reason =
      args.budgetBytes === null
        ? "no context window was established for this route, so the result was stored whole rather than clipped on a guess"
        : `${args.source.byteSize} bytes is past this turn's ${args.budgetBytes}-byte tool-result budget`;
    const preview = artifactPreview(row, args.budgetBytes ?? ARTIFACT_DEFAULT_PAGE_BYTES);
    console.log(
      `[artifact] agent=${args.agentId.slice(0, 8)} kind=${args.kind} bytes=${row.byteSize} ` +
        `sha256=${row.sha256.slice(0, 12)} id=${row.id} chunks=${row.chunkCount} → preview ${preview.bytes} bytes (${reason})`,
    );
    const text = renderArtifactResult({
      handle,
      text: preview.text,
      inline: false,
      reason,
      previewCursor: preview.cursor,
      ...(args.headerLines ? { headerLines: args.headerLines } : {}),
    });
    return { text, handle, inlined: false, reason };
  }

  /** Store `body` as an artifact and render what the caller should carry.
   *
   *  The size decision comes from the SAME plan field the rest of the turn uses
   *  (`runPlanByAgent.get(agentId).context`), so "does this fit" is answered
   *  once, against the real window, instead of by a character constant. When no
   *  window was established the text travels whole and says so — the artifact
   *  is still written, so "unknown" never means "no durable copy". */
  private presentResult(args: {
    /** Who the artifact belongs to (the producer). */
    agentId: string;
    /** Whose window the text has to fit. Usually the same agent, but a peer
     *  handoff is PRODUCED by the sender and CONSUMED by the recipient: sizing
     *  it against the sender's window would put the wrong number on it. */
    budgetForAgentId?: string;
    model: string;
    kind: string;
    body: string;
    headerLines?: string[];
    runId?: string | null;
    turnSeq?: number | null;
  }): { text: string; handle: ArtifactHandle; inlined: boolean; reason: string } {
    const run = this.running.get(args.agentId);
    const row = createArtifact({
      agentId: args.agentId,
      runId: args.runId ?? run?.runId ?? null,
      turnSeq: args.turnSeq ?? run?.userMessageSeq ?? null,
      kind: args.kind,
      body: args.body,
    });
    const budgetAgentId = args.budgetForAgentId ?? args.agentId;
    const decision = decideArtifactInline({
      text: args.body,
      context: this.runPlanByAgent.get(budgetAgentId)?.context ?? null,
      measure: (text: string): number | null => countTokens(args.model, text) || null,
    });
    const handle = {
      id: row.id,
      kind: row.kind,
      mediaType: row.mediaType,
      byteSize: row.byteSize,
      sha256: row.sha256,
      createdAt: row.createdAt,
    };
    if (decision.inline) {
      console.log(
        `[artifact] agent=${args.agentId.slice(0, 8)} kind=${args.kind} bytes=${row.byteSize} ` +
          `sha256=${row.sha256.slice(0, 12)} id=${row.id} → inlined whole (${decision.reason})`,
      );
      const text = renderArtifactResult({
        handle,
        text: args.body,
        inline: true,
        reason: decision.reason,
        ...(args.headerLines ? { headerLines: args.headerLines } : {}),
      });
      return { text, handle, inlined: true, reason: decision.reason };
    }
    const preview = artifactPreview(row, previewBytesFor(decision));
    console.log(
      `[artifact] agent=${args.agentId.slice(0, 8)} kind=${args.kind} bytes=${row.byteSize} ` +
        `sha256=${row.sha256.slice(0, 12)} id=${row.id} → preview ${preview.bytes} bytes (${decision.reason})`,
    );
    const text = renderArtifactResult({
      handle,
      text: preview.text,
      inline: false,
      reason: decision.reason,
      previewCursor: preview.cursor,
      ...(args.headerLines ? { headerLines: args.headerLines } : {}),
    });
    return { text, handle, inlined: false, reason: decision.reason };
  }

  /** Resolve a peer-target string to an agent id. Tries id-equality first
   * (only when target looks like a UUID, since Prisma rejects malformed UUIDs
   * even on read), then exact name match, then case-insensitive name match.
   * Excludes self. Name lookup is confined to the sender's peer circle
   * (same team, or other ungrouped agents) so a same-named agent on another
   * team cannot win. UUID hits are still returned so the refusal can name
   * the outsider instead of pretending they do not exist. */
  async resolvePeerTarget(fromAgentId: string, target: string): Promise<string | null> {
    const trimmed = target.trim();
    if (!trimmed || trimmed === fromAgentId) return null;
    const from = await prisma.agent.findUnique({ where: { id: fromAgentId } });
    if (!from) return null;
    if (UUID_RE.test(trimmed)) {
      const byId = await prisma.agent.findUnique({ where: { id: trimmed } });
      if (byId && byId.id !== fromAgentId) return byId.id;
    }
    const circle = { teamId: from.teamId };
    const byName = await prisma.agent.findFirst({
      where: { name: trimmed, ...circle, NOT: { id: fromAgentId } },
      orderBy: { createdAt: "desc" },
    });
    if (byName) return byName.id;
    const ci = await prisma.agent.findFirst({
      where: {
        name: { equals: trimmed, mode: "insensitive" },
        ...circle,
        NOT: { id: fromAgentId },
      },
      orderBy: { createdAt: "desc" },
    });
    return ci?.id ?? null;
  }

  /** Who is allowed to contact whom, where subagents are concerned.
   *
   *  The rule itself lives in `@agentorch/shared` (`peerContactAllowed`) so the
   *  UI cannot drift from what is enforced here — this method is the boundary
   *  and only turns the shared verdict into the message an agent reads. In
   *  short: a subagent is private to the agent that spawned it, and a subagent
   *  may contact that one parent and nobody else (not siblings, not its own
   *  children — a nested task's result travels up through the existing
   *  completion notice, not through a peer channel).
   *
   *  Returns the refusal to hand back to the caller, or null when allowed. The
   *  refusal names the parent and says who to talk to instead, because the
   *  useful correction is "ask the parent", not "target not found".
   *
   *  Scope: agents spawned BY an agent (`spawnedAsTaskFor`, i.e. the
   *  subagentKind the sidebar badges). An ordinary agent the user created —
   *  top-level or nested — is not affected: a human deciding to parent an agent
   *  does not make it private to someone else. */
  private async peerContactRefusal(fromAgentId: string, target: DbAgent): Promise<string | null> {
    const from = await prisma.agent.findUnique({ where: { id: fromAgentId } });
    const fromSpawner = from ? readMetaString(from.metadata, "spawnedAsTaskFor") : null;
    const targetSpawner = readMetaString(target.metadata, "spawnedAsTaskFor");
    const identity = (id: string, spawnedBy: string | null, teamId: string | null): PeerContactIdentity => ({
      id,
      spawnedBy,
      teamId,
    });
    const fromId = identity(fromAgentId, fromSpawner, from?.teamId ?? null);
    const targetId = identity(target.id, targetSpawner, target.teamId);
    if (!samePeerCircle(fromId, targetId)) {
      if (from?.teamId) {
        return (
          `error: "${target.name}" is not on your team. peer_send / peer_query only reach teammates ` +
          `listed in TEAM CONTEXT. An agent with the same name on another team is a different agent.`
        );
      }
      return (
        `error: "${target.name}" belongs to a team. Ungrouped agents can only message other ungrouped agents.`
      );
    }
    const allowed = peerContactAllowed(fromId, targetId);
    if (allowed) return null;
    // A subagent reaching outside its one link (checked in the same order as the
    // rule itself, so the message names the side that actually decided it).
    if (fromSpawner !== null) {
      return (
        `error: you are a subagent, and a subagent may only contact the agent that spawned you. ` +
        `"${target.name}" is not your parent — report back to your parent and let it decide.`
      );
    }
    // Otherwise the target is someone else's worker: name its parent as the
    // recipient rather than saying "not found".
    const parent = targetSpawner ? await prisma.agent.findUnique({ where: { id: targetSpawner } }) : null;
    const parentLabel = parent ? `"${parent.name}"` : "its parent";
    return (
      `error: "${target.name}" is a subagent of ${parentLabel} and can only be contacted by the agent that ` +
      `spawned it. Send your message to ${parentLabel} instead — it owns that work.`
    );
  }

  /** Pull the source agent's most recent assistant text — the artifact the
   * recipient should review. Walks Message rows newest-first, stopping when
   * we hit a `user` row (i.e., previous turn boundary). Joins text blocks
   * across the contiguous assistant run; drops tool_use noise.
   *
   *  Nothing is clipped any more. The old 8 000 / 5 000 / 3 600 / 1 200 char
   *  caps each cut a different part of the same handoff, so a recipient could
   *  review a truncated artifact while the source agent believed it had sent
   *  the whole thing. The window those caps were protecting is the RECIPIENT
   *  turn's window: its budget enforces that, and /status says what it did.
   */
  private async fetchPeerSourceSnapshot(agentId: string): Promise<PeerSourceSnapshot> {
    const running = this.running.get(agentId);
    const liveText = this.liveAssistantText(agentId);
    if (running) {
      const output = [
        `Source state: running`,
        `Current user request: ${running.userInput}`,
        "",
        liveText ? "Live assistant output so far:" : "Live assistant output so far: (none yet)",
        liveText ?? "",
      ].join("\n");
      return {
        sourceRunState: "running",
        ...(liveText ? { liveText } : {}),
        sourceUserRequest: running.userInput,
        sourceOutput: output,
      };
    }
    // Newest 400 rows, restored to ascending order. `orderBy: seq asc` took the
    // OLDEST 400 of a long history, so "the source's latest output" could be a
    // turn from hundreds of messages ago — an artifact that is a faithful copy
    // of the wrong thing is still the wrong thing to hand a reviewer.
    const newestFirst = await prisma.message.findMany({
      where: { agentId },
      orderBy: { seq: "desc" },
      take: 400,
    });
    const sourceRows = [...newestFirst].reverse();
    const latestResultIndex = sourceRows.map((row) => row.type).lastIndexOf("result");
    const latestUnresolvedInterruptedIndex = findLatestInterruptedTurnIndex(sourceRows, latestResultIndex + 1);
    const interrupted = latestUnresolvedInterruptedIndex >= 0
      ? parseInterruptedTurnPayload(sourceRows[latestUnresolvedInterruptedIndex]!.payload)
      : null;
    if (interrupted) {
      const output = [
        `Source state: interrupted`,
        `Interrupted user request: ${interrupted.userRequest}`,
        "",
        "Partial assistant output before interruption:",
        interrupted.partialAssistantText ?? "(no assistant output before interruption)",
      ].join("\n");
      return {
        sourceRunState: "interrupted",
        latestInterruptedContext: interrupted,
        sourceUserRequest: interrupted.userRequest,
        sourceOutput: output,
      };
    }
    // Walk back from the newest row to the `user` row that opened the last
    // turn. There is no row-count window any more: the old `slice(-80)` cut a
    // tool-heavy turn short, the walk then never reached its `user` row, and
    // the handoff carried the tail of an answer as if it were the answer.
    const rows = [...sourceRows].reverse();
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
    if (texts.length === 0) return { sourceRunState: "empty" };
    const lastCompletedAssistantText = texts.join("\n\n");
    return {
      sourceRunState: "completed",
      lastCompletedAssistantText,
      sourceOutput: lastCompletedAssistantText,
    };
  }

  /** Called by the peer_query MCP tool. Read-only fetch of another agent's
   *  recent text turns, so the calling agent can pull more context on demand
   *  (e.g., a handoff recipient feels the embedded source-output is too short
   *  and wants more of the source's prior trajectory). Does NOT cause the
   *  target agent to run — pure DB read.
   *
   *  Walks user+assistant rows newest-first, stops once we've accumulated
   *  `limit` user-message boundaries (default 20, max 50). Drops tool_use
   *  noise — only text content is returned.
   *
   *  Nothing is clipped here any more. The old 12 000-character head+tail cut
   *  removed the middle of the transcript and then told the model it could read
   *  the rest — but the middle had never been stored anywhere, so there was
   *  nothing to read. The whole text is now written as an artifact first, and
   *  the tool result carries it inline when it fits this turn's budget or a
   *  bounded preview plus the artifact id/sha256/size when it does not. */
  async fetchPeerHistory(
    fromAgentId: string,
    target: string,
    limit: number = 20,
  ): Promise<string> {
    const MAX_TURNS = 50;
    const sanitized = Math.max(1, Math.min(MAX_TURNS, Math.floor(limit) || 20));

    const targetId = await this.resolvePeerTarget(fromAgentId, target);
    if (!targetId) return `error: no peer agent matches "${target}" (excluding self)`;
    const targetAgent = await prisma.agent.findUnique({ where: { id: targetId } });
    if (!targetAgent) return `error: peer agent ${targetId} not found`;
    const refusal = await this.peerContactRefusal(fromAgentId, targetAgent);
    if (refusal) return refusal;

    // No `in` operator on our DB shim, so rows are fetched newest-first in
    // batches and JS-filtered to user|assistant. The scan pages until it has
    // walked back over `sanitized` user-turn boundaries or run out of history:
    // a single 400-row batch used to end the walk early on a long, tool-heavy
    // turn, and the caller then received a transcript that stopped mid-topic
    // with nothing saying so. Now only the caller's own `limit` bounds it, and
    // that bound is printed in the header.
    const SCAN_ROWS = 400;
    const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
    const seen = new Set<number>();
    let userBoundaries = 0;
    let scanned = 0;
    while (userBoundaries < sanitized) {
      const batch = await prisma.message.findMany({
        where: { agentId: targetId },
        orderBy: { seq: "desc" },
        take: SCAN_ROWS,
        skip: scanned,
      });
      if (batch.length === 0) break;
      scanned += batch.length;
      for (const row of batch) {
        // Offset paging against a live table can re-show a row when the agent
        // appends while we scan; a duplicate turn is worse than a short one.
        const seq = Number(row.seq);
        if (seen.has(seq)) continue;
        seen.add(seq);
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
    }

    const live = this.formatLiveTranscript(targetId);
    if (turns.length === 0 && !live) {
      return `peer "${targetAgent.name}" (id=${targetId.slice(0, 8)}) has no text history yet.`;
    }
    const header = `peer agent: ${targetAgent.name} (id=${targetId.slice(0, 8)}) - last ${turns.length} text turns (oldest to newest):\n\n`;
    const body = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
    const full = [turns.length > 0 ? header + body : "", live].filter((s) => s && s.trim()).join("\n\n---\n\n");
    // Stored whole, then presented within this turn's budget. The result is the
    // same text as before for anything that fits; what changed is that a result
    // which does NOT fit is now a preview with a verifiable handle instead of a
    // head+tail cut whose middle existed nowhere.
    return this.presentResult({
      agentId: fromAgentId,
      model: await this.modelOfAgent(fromAgentId),
      kind: "peer-history",
      body: full,
    }).text;
  }

  async conversationSearch(fromAgentId: string, args: ConversationSearchArgs): Promise<string> {
    const outcome = await conversationSearchOutcome(fromAgentId, args);
    // A search that could not run (no such target, no source agent) is already
    // an `error:` sentence and is returned as itself: dressing a failure in an
    // artifact handle would make it look like a result.
    if (!outcome.ok) return outcome.message;
    return this.presentResult({
      agentId: fromAgentId,
      model: await this.modelOfAgent(fromAgentId),
      kind: "conversation-search",
      body: outcome.text,
    }).text;
  }

  /** Called by the peer_send MCP tool. Validates and forwards a peer message.
   * Fire-and-forget: returns once the message has been queued, does NOT await
   * the recipient's reply (that would block the parent's stream). */
  async sendPeerMessage(
    fromAgentId: string,
    target: string,
    body: string,
    mode: PeerMode = "raw",
    opts: PeerSendOptions = {},
  ): Promise<string> {
    const interrupt = opts.interrupt === true;
    const interruptReason = opts.interruptReason?.trim() ?? "";
    if (interrupt && !interruptReason) {
      return "error: interruptReason is required when interrupt=true";
    }
    const fromAgent = await prisma.agent.findUnique({ where: { id: fromAgentId } });
    if (!fromAgent) return `error: source agent ${fromAgentId} not found`;

    const targetId = await this.resolvePeerTarget(fromAgentId, target);
    if (!targetId) return `error: no peer agent matches "${target}" (excluding self)`;
    const targetAgent = await prisma.agent.findUnique({ where: { id: targetId } });
    if (!targetAgent) return `error: peer agent ${targetId} not found`;
    const refusal = await this.peerContactRefusal(fromAgentId, targetAgent);
    if (refusal) return refusal;
    if (readMetaBool(targetAgent.metadata, "closed")) {
      return `error: peer agent "${targetAgent.name}" is closed; user must restart it before it can receive messages`;
    }

    const sourceRun = this.running.get(fromAgent.id);
    const sourceRunId = sourceRun?.runId;
    const action: FreshnessBlockedAction = {
      tool: "peer_send",
      targetAgentId: targetAgent.id,
      targetAgentName: targetAgent.name,
      peerSendDraft: { body, mode },
      ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
      ...(opts.replyToCorrelationId ? { replyToCorrelationId: opts.replyToCorrelationId } : {}),
    };
    if (sourceRun && !interrupt) {
      const queued = this.findFreshnessBlockingPeerTurns(sourceRun, action);
      if (queued.length > 0) {
        sourceRun.blockedFreshnessAction = action;
        return this.formatFreshnessBlockedResult(action, queued);
      }
    }
    const includeSource =
      opts.includeSource === true ||
      ((opts.includeSource === undefined || opts.includeSource === "auto") && mode !== "raw");
    const sourceSnapshot = await this.fetchPeerSourceSnapshot(fromAgent.id);
    // The source's output is stored whole and the handoff carries what fits the
    // RECIPIENT's window. It used to be cut to 8 000/5 000/3 600/1 200
    // characters depending on the mode, with nothing anywhere holding the rest:
    // a reviewer could be auditing a prefix while the sender believed the whole
    // answer had been sent.
    // Only store/present the source snapshot when the handoff will actually
    // carry it: a raw send drops it, and writing an artifact nobody is told
    // about would just be a row per message.
    const sourceOutput = includeSource && sourceSnapshot.sourceOutput
      ? this.presentResult({
          agentId: fromAgent.id,
          budgetForAgentId: targetAgent.id,
          model: targetAgent.model,
          kind: "peer-source",
          body: sourceSnapshot.sourceOutput,
          runId: sourceRunId ?? null,
        }).text
      : undefined;
    const formatted = formatPeerHandoff({
      fromName: fromAgent.name,
      fromId: fromAgent.id,
      receiverMetadata: targetAgent.metadata,
      mode,
      body,
      sourceLastOutput: sourceOutput,
      sourceState: sourceSnapshot.sourceRunState,
      includeSource: opts.includeSource ?? "auto",
      ...(interrupt ? { interruptReason } : {}),
    });
    const targetWasBusy = this.running.has(targetId) || this.drainingQueues.has(targetId);
    const peerOrigin = {
      fromAgentId: fromAgent.id,
      fromAgentName: fromAgent.name,
      mode,
      messageId: opts.messageId?.trim() || randomUUID(),
      ...(opts.correlationId?.trim() ? { correlationId: opts.correlationId.trim() } : {}),
      ...(opts.correlationKind ? { correlationKind: opts.correlationKind } : {}),
      ...(opts.replyToCorrelationId?.trim() ? { replyToCorrelationId: opts.replyToCorrelationId.trim() } : {}),
      ...(sourceRunId ? { sourceRunId } : {}),
      ...(opts.causalRunId?.trim() ? { causalRunId: opts.causalRunId.trim() } : sourceRunId ? { causalRunId: sourceRunId } : {}),
      ...(sourceRunId && includeSource ? { coalescibleSourceOutput: true } : {}),
    };
    const willReplaceQueuedPeerHandoff = targetWasBusy && this.findQueuedPeerHandoff(targetId, peerOrigin) !== null;
    const duplicateCorrelation = targetWasBusy ? this.findQueuedPeerCorrelationDuplicate(targetId, peerOrigin) : null;
    if (interrupt) {
      await this.interruptForPeerSend(targetId, interruptReason);
      void this.sendMessage(targetId, formatted, { peerOrigin }).catch((err) => {
        console.error(`[peer_send] sendMessage to ${targetId} failed:`, err);
      });
      return `interrupted and delivered to "${targetAgent.name}" (id=${targetId.slice(0, 8)}, mode=${mode}, reason=${interruptReason})`;
    }
    if (duplicateCorrelation) {
      return `suppressed duplicate peer_send for "${targetAgent.name}" (id=${targetId.slice(0, 8)}, mode=${mode}, queuedTurn=${duplicateCorrelation.id}); queued correlation/message already covers this request`;
    }
    void this.sendMessage(targetId, formatted, { peerOrigin }).catch((err) => {
      console.error(`[peer_send] sendMessage to ${targetId} failed:`, err);
    });
    const delivery = willReplaceQueuedPeerHandoff ? "replaced stale queued peer handoff for" : targetWasBusy ? "queued for" : "delivered to";
    return `${delivery} "${targetAgent.name}" (id=${targetId.slice(0, 8)}, mode=${mode})`;
  }

  private async interruptForPeerSend(
    targetId: string,
    reason: string,
  ): Promise<void> {
    if (
      this.running.has(targetId) ||
      this.drainingQueues.has(targetId) ||
      this.pending.has(targetId) ||
      this.pendingQuestions.has(targetId)
    ) {
      await this.forceStopRun(targetId, {
        dbStatus: "IDLE",
        protoStatus: "idle",
        logPrefix: "peer-send-interrupt",
        error: {
          code: "PEER_SEND_INTERRUPT",
          message: `Interrupted by urgent peer_send: ${reason}`,
        },
        drainQueued: false,
        interruptedReason: `peer_send interrupt: ${reason}`,
      });
    }
  }

  private async forceStopRun(sessionId: string, opts: ForceStopOptions): Promise<boolean> {
    const r = this.running.get(sessionId);
    if (opts.expectedRunId && (!r || r.runId !== opts.expectedRunId)) {
      return false;
    }

    const liveText = r ? this.liveAssistantText(sessionId) : null;
    if (r) {
      console.log(`[${opts.logPrefix}] abort agent=${sessionId.slice(0, 8)} run=${r.runId.slice(0, 8)}`);
      this.liveness.noteStopRequested(r.runId);
      try { r.abort.abort(); } catch { /* signal already aborted */ }
    } else {
      console.log(`[${opts.logPrefix}] no live run for agent=${sessionId.slice(0, 8)}; cleaning stale state`);
    }

    this.running.delete(sessionId);
    this.drainingQueues.delete(sessionId);
    this.pendingDrainOptions.delete(sessionId);
    this.liveTranscripts.delete(sessionId);
    this.clearLiveContext(sessionId);
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

    if (r) {
      try {
        await this.persistInterruptedTurn(
          sessionId,
          r,
          opts.interruptedReason ?? opts.error?.code ?? opts.logPrefix,
          liveText,
        );
      } catch (err) {
        console.warn(
          `[${opts.logPrefix}] interrupted_turn persist for agent=${sessionId.slice(0, 8)} failed: ${(err as Error).message}`,
        );
      }
    }

    try {
      let nextMetadata: object | undefined;
      if (r?.clearResumeOnAbort) {
        const agent = await prisma.agent.findUnique({ where: { id: sessionId } });
        if (agent) {
          nextMetadata = removeMetadataKeys(agent.metadata, [...RESUME_METADATA_KEYS]);
        }
      }
      const updated = await prisma.agent.update({
        where: { id: sessionId },
        data: { status: opts.dbStatus, ...(nextMetadata ? { metadata: nextMetadata } : {}) },
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
      if (opts.drainQueued !== false) this.drainQueuedTurns(sessionId);
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
    const owner = this.running.get(sessionId);
    if (!owner) return;
    const runId = owner.runId;
    const updated = await prisma.agent.update({
      where: { id: sessionId },
      data: { status: dbStatus },
    });
    if (this.running.get(sessionId)?.runId !== runId) return;
    this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
    this.hub.sendToSession(sessionId, { type: "status", sessionId, status: protoStatus });
    // Phase 4: the agent status IS the session's own statement about what this
    // run is doing, so it is what tells the controller to SUSPEND stall
    // judgement. A run blocked on a human — a permission dialog, an ask_user
    // question — is not quiet, it is waiting, and the old pause/resume pair of a
    // per-session timer could not say that: it could only stop counting silence
    // without recording why.
    if (dbStatus === "AWAITING_PERMISSION") {
      this.liveness.notePermissionWait(runId, Date.now());
    } else if (dbStatus === "AWAITING_USER_INPUT") {
      this.liveness.noteUserInputWait(runId, Date.now());
    } else if (dbStatus === "RUNNING") {
      this.liveness.notePermissionWait(runId, null);
      this.liveness.noteUserInputWait(runId, null);
    }
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
    const liveText = r ? this.liveAssistantText(sessionId) : null;
    if (r) {
      console.log(`[cancel] abort agent=${sessionId.slice(0, 8)} run=${r.runId.slice(0, 8)}`);
      // Abort and drop the owner synchronously. persistInterruptedTurn used to
      // run first, and a UNIQUE(agentId, seq) collision — the live turn writing
      // the same seq — threw out of cancel() so the signal never fired and the
      // UI stayed RUNNING. Stopping the run is the contract; the interrupted_turn
      // row is best-effort context for /continue.
      this.liveness.noteStopRequested(r.runId);
      this.liveness.end(r.runId, "user-cancelled", "user-cancelled");
      try { r.abort.abort(); } catch { /* signal already aborted */ }
    } else {
      // No in-memory run — but the DB might still say RUNNING because a
      // previous core process crashed mid-turn or a runtime hang outlived its
      // sendMessage call. Continue to the DB reset below; better to leave
      // the agent IDLE than stuck.
      console.log(`[cancel] no live run for agent=${sessionId.slice(0, 8)}; cleaning stale state`);
    }
    this.liveTranscripts.delete(sessionId);
    this.clearLiveContext(sessionId);

    // Drop in-memory state synchronously so sendMessage's runId guard fires
    // and a fresh send_message can be accepted without races.
    this.running.delete(sessionId);
    this.drainingQueues.delete(sessionId);
    this.pendingDrainOptions.delete(sessionId);
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

    if (r) {
      try {
        await this.persistInterruptedTurn(sessionId, r, "cancelled", liveText);
      } catch (err) {
        console.warn(
          `[cancel] interrupted_turn persist for agent=${sessionId.slice(0, 8)} failed: ${(err as Error).message}`,
        );
      }
    }

    // Authoritative DB reset. We deliberately do NOT touch metadata — only the
    // status flips back to IDLE. lastSessionId / sandboxMode / etc. survive.
    try {
      const metadata = r?.clearResumeOnAbort
        ? removeMetadataKeys((await prisma.agent.findUnique({ where: { id: sessionId } }))?.metadata, [...RESUME_METADATA_KEYS])
        : undefined;
      const updated = await prisma.agent.update({
        where: { id: sessionId },
        data: { status: "IDLE", ...(metadata ? { metadata } : {}) },
      });
      this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
      this.hub.sendToSession(sessionId, { type: "status", sessionId, status: "idle" });
      this.drainQueuedTurns(sessionId);
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
      if (stuck.length > 0) {
        console.warn(
          `[recover] resetting ${stuck.length} stale agent(s) to IDLE: ${stuck
            .map((a) => `${a.name}(${a.id.slice(0, 8)}/${a.status})`)
            .join(", ")}`,
        );
        for (const a of stuck) {
          // Phase 4: the agent going back to IDLE is NOT the same as the run
          // having completed, and this is the place where those two used to be
          // silently conflated. Being RUNNING (or awaiting a human) when the
          // process came up means the previous process died mid-run: the run is
          // recorded as interrupted/recovered, with the signals it had. Only a
          // run that ALREADY has a terminal record is left alone — recovering it
          // again would overwrite the real ending with a guess.
          const orphan = this.liveness.lastPersistedForAgent(a.id);
          if (!orphan || orphan.endedAt === null) {
            await this.recordRecoveredRun(a.id, a.status);
          }
          const updated = await prisma.agent.update({
            where: { id: a.id },
            data: { status: "IDLE" },
          });
          this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
          this.hub.sendToSession(a.id, { type: "status", sessionId: a.id, status: "idle" });
        }
      }
      this.drainPersistedQueues();
    } catch (err) {
      console.error(`[recover] failed: ${(err as Error).message}`);
    }
  }

  /** Write the "this run did not finish" record for an agent the previous
   *  process left RUNNING (or waiting on a human).
   *
   *  A run with no row at all — an agent mid-turn when the process was upgraded
   *  to phase 4, or one whose row write failed — still gets one, because
   *  otherwise `/status` would show nothing and "no record" reads as "no
   *  problem". The DB status alone could not say this: IDLE is true and useless.
   */
  private async recordRecoveredRun(
    agentId: string,
    staleStatus: string,
  ): Promise<void> {
    try {
      const row = sqliteDb
        .prepare("SELECT * FROM RunLiveness WHERE agentId = ? ORDER BY updatedAt DESC LIMIT 1")
        .get(agentId) as Record<string, unknown> | undefined;
      const now = Date.now();
      if (row) {
        // The row exists: close it honestly, keeping every signal it had.
        sqliteDb
          .prepare(
            "UPDATE RunLiveness SET state = ?, terminalReason = ?, endedAt = ?, updatedAt = ?, signals = ? WHERE runId = ?",
          )
          .run(
            "interrupted",
            "RECOVERED_AFTER_RESTART",
            now,
            now,
            JSON.stringify({
              ...(JSON.parse(String(row.signals ?? "{}")) as Record<string, unknown>),
              recoveredAt: now,
              recoveryReason:
                `the core process restarted while this run was open (agent status was ${staleStatus}); ` +
                "the run did not finish, and the signals kept here are the last ones recorded",
            }),
            String(row.runId),
          );
        return;
      }
      const runId = `recovered-${randomUUID()}`;
      const signals = newLivenessSignals(now);
      sqliteDb
        .prepare(
          `INSERT INTO RunLiveness (runId, agentId, state, policy, signals, startedAt, updatedAt, endedAt, terminalReason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          agentId,
          "interrupted",
          JSON.stringify(
            resolveLivenessPolicy({ runtime: "unknown", hardDeadlineMs: null }),
          ),
          JSON.stringify({
            ...signals,
            recoveredAt: now,
            recoveryReason:
              `the core process restarted with this agent still marked ${staleStatus}, but no run record was ` +
              "kept for it; the run did not finish normally. No signals survive, which is itself the record",
          }),
          now,
          now,
          now,
          "RECOVERED_AFTER_RESTART",
        );
      console.warn(
        `[recover] agent=${agentId.slice(0, 8)} was ${staleStatus} with no liveness record; ` +
          "recorded as interrupted/recovered",
      );
    } catch (err) {
      console.error(`[recover] could not record the recovered run for ${agentId.slice(0, 8)}: ${(err as Error).message}`);
    }
  }

  private drainPersistedQueues(): void {
    const rows = prisma.pendingTurn.findMany({ orderBy: { id: "asc" } });
    const sessionIds = new Set(rows.map((row) => row.agentId));
    for (const sessionId of sessionIds) this.drainQueuedTurns(sessionId);
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
