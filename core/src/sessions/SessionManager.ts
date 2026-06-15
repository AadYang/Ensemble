import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { CanUseTool, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMessage } from "@agentorch/shared";
import { extractUsageEvents, buildMetaUsageEvent } from "../usage-extract.js";
import { chooseRuntime } from "./runtimes/index.js";
import type { AgentRuntime, RuntimeErrorCode, RuntimeErrorEvent, RuntimeOptions } from "./runtimes/types.js";
import {
  normalizeCodexUsageSnapshot,
  type CodexUsageSnapshot,
} from "./runtimes/codex-usage.js";
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
  PeerIncludeSource,
  PeerMode,
  PermissionDecision,
  PermissionMode,
  ReasoningEffort,
  SandboxMode,
} from "@agentorch/shared";
import { formatPeerHandoff } from "./peerHandoff.js";
import type { Agent as DbAgent, PendingTurn as DbPendingTurn } from "../db.js";
import { prisma, sqliteDb } from "../db.js";
import type { WebSocket } from "@fastify/websocket";
import type { WSHub } from "../ws/hub.js";
import { CLI_INSTALL_INFO, getClaudeCliPath, getCodexCliPath } from "../cli-config.js";
import { ensureDataDir } from "../paths.js";
import { currentPlatformKey } from "../platform-key.js";

/** Stable cwd for the spawned claude CLI. The CLI scopes session files by
 * `~/.claude/projects/<encoded-cwd>/`, so if we let the CLI inherit our
 * sidecar's cwd, sessions become unfindable across reinstalls / launches
 * (Tauri's sidecar cwd may differ between runs). Pinning cwd to homedir
 * keeps sessions reachable for resume regardless of where the EXE lives. */
const STABLE_CWD = homedir();
const CODEX_DEFAULT_CWD = ensureDataDir();
const CODEX_DEFAULT_SANDBOX: SandboxMode = "danger-full-access";
const CODEX_RESUME_SIGNATURE_KEY = "codexResumeSignature";
const CODEX_RESUME_SIGNATURE_VERSION = 1;
const RESUME_METADATA_KEYS = ["lastSessionId", "codexUsageSnapshot", CODEX_RESUME_SIGNATURE_KEY] as const;
const RUNTIME_HISTORY_MAX_MESSAGES = 28;
const RUNTIME_HISTORY_MAX_CHARS = 18_000;
const RUNTIME_HISTORY_SINGLE_MESSAGE_MAX_CHARS = 6_000;
const RUNTIME_HISTORY_INTERRUPTED_MAX_CHARS = 12_000;
const INTERRUPTED_USER_REQUEST_MAX_CHARS = 8_000;
const INTERRUPTED_PARTIAL_MAX_CHARS = 6_000;
const PEER_SOURCE_OUTPUT_MAX_CHARS = 5_000;
const PEER_SOURCE_REQUEST_MAX_CHARS = 1_200;
const PEER_SOURCE_PARTIAL_MAX_CHARS = 3_600;
const AUTO_COMPACT_MIN_MESSAGES = 40;
const AUTO_COMPACT_TRIGGER_CHARS = 28_000;
const AUTO_COMPACT_KEEP_MESSAGES = 16;
const AUTO_COMPACT_SUMMARY_MAX_CHARS = 40_000;
const COMPACT_START_TEXT = "Compacting conversation context...";
const COMPACT_FAILURE_PREFIX = "Context compact failed:";
const RUNTIME_IDLE_TIMEOUT_DEFAULT_MS = 20 * 60 * 1000;

const flushVisibleState = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function readRuntimeIdleTimeoutMs(): number {
  const raw = process.env.ENSEMBLE_RUNTIME_IDLE_TIMEOUT_MS;
  if (!raw) return RUNTIME_IDLE_TIMEOUT_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : RUNTIME_IDLE_TIMEOUT_DEFAULT_MS;
}

function formatRuntimeIdleTimeout(timeoutMs: number): string {
  if (timeoutMs >= 60_000) {
    const minutes = Math.round(timeoutMs / 60_000);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function runtimeIdleTimeoutMessage(timeoutMs: number): string {
  return (
    `No events have been received from the upstream runtime or network connection for ${formatRuntimeIdleTimeout(timeoutMs)}. ` +
    "Ensemble has automatically stopped this turn so the agent is not left running forever. " +
    "This turn's interrupted context was saved; send \"continue\" to resume from the interruption. " +
    "The agent's model, thinking mode, sandbox, provider, and other settings were not modified."
  );
}

function truncateMiddle(text: string, maxChars: number, label = "chars"): string {
  if (text.length <= maxChars) return text;
  const half = Math.max(1, Math.floor(maxChars / 2) - 60);
  return `${text.slice(0, half)}\n\n[... truncated ${text.length - half * 2} ${label} ...]\n\n${text.slice(-half)}`;
}

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
  sawResult?: boolean;
  interruptedPersisted?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleWatchdogPaused?: boolean;
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
    sourceRunId?: string;
    coalescibleSourceOutput?: boolean;
  };
  autoRecoveryAttempt?: "codex-event-stream-lagged";
  suppressUserMessage?: boolean;
};

type PeerSendOptions = {
  includeSource?: PeerIncludeSource;
  interrupt?: boolean;
  interruptReason?: string;
};

function normalizeQueuedTurnOpts(raw: unknown): SendMessageOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: SendMessageOptions = {};
  const autoRecoveryAttempt = (raw as { autoRecoveryAttempt?: unknown }).autoRecoveryAttempt;
  if (autoRecoveryAttempt === "codex-event-stream-lagged") {
    out.autoRecoveryAttempt = autoRecoveryAttempt;
  }
  if ((raw as { suppressUserMessage?: unknown }).suppressUserMessage === true) {
    out.suppressUserMessage = true;
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
        ...(typeof p.sourceRunId === "string" ? { sourceRunId: p.sourceRunId } : {}),
        ...(p.coalescibleSourceOutput === true ? { coalescibleSourceOutput: true } : {}),
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  "max",
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

const readProviderDefaultSandbox = (metadata: unknown): SandboxMode => {
  if (metadata && typeof metadata === "object" && "defaultSandbox" in metadata) {
    const m = (metadata as { defaultSandbox: unknown }).defaultSandbox;
    if (typeof m === "string" && VALID_SANDBOX_MODES.has(m as SandboxMode)) {
      return m as SandboxMode;
    }
  }
  return CODEX_DEFAULT_SANDBOX;
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
};

const runtimeErrorFromEvent = (event: RuntimeErrorEvent): Error & RuntimeErrorDetails => {
  const err = new Error(event.message) as Error & RuntimeErrorDetails;
  if (event.code !== undefined) err.runtimeCode = event.code;
  if (event.recoverable !== undefined) err.runtimeRecoverable = event.recoverable;
  if (event.resumeScoped !== undefined) err.runtimeResumeScoped = event.resumeScoped;
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

export const runtimeHistoryFromCompletedTurns = (
  rows: Array<{ type: string; payload: unknown; seq?: number }>,
): SdkMessage[] => {
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
  return trimRuntimeHistory(
    completedRows
      .map(rowToRuntimeHistoryMessage)
      .filter((m): m is SdkMessage => m !== null),
  );
};

export const buildRuntimeHistoryForTurn = (
  rows: Array<{ type: string; payload: unknown; seq?: number }>,
): SdkMessage[] => runtimeHistoryFromCompletedTurns(rows);

function rowToRuntimeHistoryMessage(row: { type: string; payload: unknown }): SdkMessage | null {
  if (row.type === "user" || row.type === "assistant") return row.payload as SdkMessage;
  if (row.type !== "system") return null;
  const payload = row.payload as { type?: unknown; subtype?: unknown; text?: unknown } | null;
  if (payload?.type !== "system") {
    return null;
  }
  if (payload.subtype === "compact" && typeof payload.text === "string") {
    return {
      type: "user",
      message: {
        role: "user",
        content: truncateMiddle(
          `Conversation summary from Ensemble auto-compact:\n${payload.text}`,
          RUNTIME_HISTORY_SINGLE_MESSAGE_MAX_CHARS,
        ),
      },
      _compactSummary: true,
    } as SdkMessage;
  }
  const interrupted = parseInterruptedTurnPayload(payload);
  if (!interrupted) return null;
  const parts = [
    "Previous Ensemble turn was interrupted before completion.",
    "",
    "Original user request:",
    truncateMiddle(interrupted.userRequest, INTERRUPTED_USER_REQUEST_MAX_CHARS),
  ];
  if (interrupted.partialAssistantText?.trim()) {
    parts.push(
      "",
      "Partial assistant output before interruption:",
      truncateMiddle(interrupted.partialAssistantText.trim(), INTERRUPTED_PARTIAL_MAX_CHARS),
    );
  }
  parts.push(
    "",
    `Interruption reason: ${interrupted.reason}.`,
    'If the current user asks to continue/resume, continue that interrupted request instead of starting unrelated work.',
  );
  return {
    type: "user",
    message: {
      role: "user",
      content: truncateMiddle(parts.join("\n"), RUNTIME_HISTORY_INTERRUPTED_MAX_CHARS),
    },
    _interruptedTurn: true,
  } as SdkMessage;
}

function runtimeHistoryMessageText(msg: SdkMessage): string {
  if (msg.type === "user") {
    const content = (msg as { message?: { content?: unknown } }).message?.content;
    return typeof content === "string" ? content : "";
  }
  if (msg.type === "assistant") {
    return assistantTextFromMessage(msg);
  }
  return "";
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

function truncateTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;
  const half = Math.floor(maxChars / 2) - 80;
  return `${transcript.slice(0, half)}\n\n[... truncated ${transcript.length - half * 2} chars ...]\n\n${transcript.slice(-half)}`;
}

function compactPromptFromTranscript(transcript: string): string {
  return [
    "Summarize the following conversation transcript in 5-12 sentences.",
    "Focus on: what the user asked for, key decisions, what's been done, what's still pending.",
    "Output plain text only - no markdown headers, no bullet markup.",
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

export function trimRuntimeHistory(messages: SdkMessage[]): SdkMessage[] {
  const normalized = messages.map(clampRuntimeHistoryMessage);
  if (normalized.length <= RUNTIME_HISTORY_MAX_MESSAGES) {
    const total = normalized.reduce((sum, msg) => sum + runtimeHistoryMessageText(msg).length, 0);
    if (total <= RUNTIME_HISTORY_MAX_CHARS) return normalized;
  }
  const summaryMessages = normalized.filter((msg) => (msg as { _compactSummary?: unknown })._compactSummary === true);
  const interruptedMessages = normalized.filter((msg) => (msg as { _interruptedTurn?: unknown })._interruptedTurn === true);
  const latestSummary = summaryMessages.at(-1);
  const latestInterrupted = interruptedMessages.at(-1);
  const preserved = [latestSummary, latestInterrupted].filter((m): m is SdkMessage => Boolean(m));
  const preservedChars = preserved.reduce((sum, msg) => sum + runtimeHistoryMessageText(msg).length, 0);
  const remainingChars = Math.max(0, RUNTIME_HISTORY_MAX_CHARS - preservedChars);
  const remainingMessages = Math.max(0, RUNTIME_HISTORY_MAX_MESSAGES - preserved.length);
  const kept: SdkMessage[] = [];
  let chars = 0;
  for (let i = normalized.length - 1; i >= 0; i--) {
    const msg = normalized[i]!;
    if ((msg as { _compactSummary?: unknown })._compactSummary === true) continue;
    if ((msg as { _interruptedTurn?: unknown })._interruptedTurn === true) continue;
    const textLen = Math.min(
      runtimeHistoryMessageText(msg).length,
      RUNTIME_HISTORY_SINGLE_MESSAGE_MAX_CHARS,
    );
    if (kept.length >= remainingMessages || chars + textLen > remainingChars) break;
    kept.unshift(clampRuntimeHistoryMessage(msg));
    chars += textLen;
  }
  return [...preserved, ...kept];
}

function clampRuntimeHistoryMessage(msg: SdkMessage): SdkMessage {
  const maxChars = (msg as { _interruptedTurn?: unknown })._interruptedTurn === true
    ? RUNTIME_HISTORY_INTERRUPTED_MAX_CHARS
    : RUNTIME_HISTORY_SINGLE_MESSAGE_MAX_CHARS;
  if (msg.type === "user") {
    const original = (msg as { message?: { role?: string; content?: unknown } }).message?.content;
    if (typeof original !== "string" || original.length <= maxChars) return msg;
    return {
      ...msg,
      message: {
        ...((msg as { message?: object }).message ?? {}),
        role: (msg as { message?: { role?: string } }).message?.role ?? "user",
        content: truncateMiddle(original, maxChars),
      },
    } as SdkMessage;
  }
  if (msg.type === "assistant") {
    const blocks = (msg as { message?: { content?: Array<{ type?: unknown; text?: unknown }> } }).message?.content;
    if (!Array.isArray(blocks)) return msg;
    let remaining = maxChars;
    let changed = false;
    const nextBlocks = blocks.map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      if (remaining <= 0) {
        changed = true;
        return { ...block, text: "" };
      }
      if (block.text.length <= remaining) {
        remaining -= block.text.length;
        return block;
      }
      changed = true;
      const text = truncateMiddle(block.text, remaining);
      remaining = 0;
      return { ...block, text };
    });
    if (!changed) return msg;
    return {
      ...msg,
      message: {
        ...((msg as { message?: object }).message ?? {}),
        content: nextBlocks,
      },
    } as SdkMessage;
  }
  return msg;
}

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
  private queuedTurns = new Map<string, Map<number, (result: { finalText: string } | null) => void>>();
  private drainingQueues = new Map<string, string>();
  private liveTranscripts = new Map<string, LiveTranscript>();
  private pending = new Map<string, Map<string, PendingPermission>>();
  private pendingQuestions = new Map<string, Map<string, PendingUserQuestion>>();

  constructor(
    private hub: WSHub,
    private runtimeResolver: (kind: string) => AgentRuntime = chooseRuntime,
  ) {}

  private getRuntimeIdleTimeoutMs(): number {
    return readRuntimeIdleTimeoutMs();
  }

  private clearRuntimeIdleWatchdog(sessionId: string, expectedRunId?: string): void {
    const running = this.running.get(sessionId);
    if (!running || (expectedRunId && running.runId !== expectedRunId)) return;
    if (running.idleTimer) {
      clearTimeout(running.idleTimer);
      running.idleTimer = undefined;
    }
  }

  private armRuntimeIdleWatchdog(sessionId: string, expectedRunId: string): void {
    const running = this.running.get(sessionId);
    if (!running || running.runId !== expectedRunId || running.idleWatchdogPaused) return;
    this.clearRuntimeIdleWatchdog(sessionId, expectedRunId);
    const timeoutMs = this.getRuntimeIdleTimeoutMs();
    const timer = setTimeout(() => {
      void this.handleRuntimeIdleTimeout(sessionId, expectedRunId, timeoutMs);
    }, timeoutMs);
    const maybeNodeTimer = timer as { unref?: () => void };
    if (typeof maybeNodeTimer.unref === "function") maybeNodeTimer.unref();
    running.idleTimer = timer;
  }

  private resetRuntimeIdleWatchdog(sessionId: string, expectedRunId: string): void {
    const running = this.running.get(sessionId);
    if (!running || running.runId !== expectedRunId) return;
    running.idleWatchdogPaused = false;
    this.armRuntimeIdleWatchdog(sessionId, expectedRunId);
  }

  private pauseRuntimeIdleWatchdog(sessionId: string, expectedRunId?: string): void {
    const running = this.running.get(sessionId);
    if (!running || (expectedRunId && running.runId !== expectedRunId)) return;
    running.idleWatchdogPaused = true;
    this.clearRuntimeIdleWatchdog(sessionId, expectedRunId);
  }

  private resumeRuntimeIdleWatchdog(sessionId: string, expectedRunId?: string): void {
    const running = this.running.get(sessionId);
    if (!running || (expectedRunId && running.runId !== expectedRunId)) return;
    running.idleWatchdogPaused = false;
    this.armRuntimeIdleWatchdog(sessionId, running.runId);
  }

  private async handleRuntimeIdleTimeout(
    sessionId: string,
    expectedRunId: string,
    timeoutMs = this.getRuntimeIdleTimeoutMs(),
  ): Promise<boolean> {
    const running = this.running.get(sessionId);
    if (!running || running.runId !== expectedRunId || running.idleWatchdogPaused) return false;
    this.clearRuntimeIdleWatchdog(sessionId, expectedRunId);
    return this.forceStopRun(sessionId, {
      expectedRunId,
      dbStatus: "ERROR",
      protoStatus: "error",
      logPrefix: "runtime-idle-timeout",
      error: {
        code: "RUNTIME_IDLE_TIMEOUT",
        message: runtimeIdleTimeoutMessage(timeoutMs),
      },
    });
  }

  private beginDrain(sessionId: string): string {
    const token = randomUUID();
    this.drainingQueues.set(sessionId, token);
    return token;
  }

  private finishDrain(sessionId: string, token: string): void {
    if (this.drainingQueues.get(sessionId) === token) {
      this.drainingQueues.delete(sessionId);
      this.drainQueuedTurns(sessionId);
    }
  }

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
        model: opts.model ?? "claude-opus-4-8",
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
    if (patch.codexWorkspace !== undefined) {
      const codexWorkspace = normalizeCodexWorkspace(patch.codexWorkspace);
      if (codexWorkspace && targetProvider?.kind !== "openai-codex") {
        throw new Error("codexWorkspace is only valid for openai-codex agents");
      }
      data.codexWorkspace = codexWorkspace;
      if (codexWorkspace !== cur.codexWorkspace) {
        clearResumeMetadata();
      }
    } else if (patch.providerId !== undefined && targetProvider?.kind !== "openai-codex" && cur.codexWorkspace) {
      data.codexWorkspace = null;
      clearResumeMetadata();
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
    } else if (patch.providerId !== undefined && targetProvider?.kind !== "openai-codex" && readSandboxOverride(cur.metadata) !== null) {
      removeNextMetadataKeys(["sandboxMode"]);
    }
    if (patch.reasoningEffort !== undefined) {
      if (patch.reasoningEffort !== null && !providerSupportsReasoningEffort(targetProvider?.kind)) {
        throw new Error("reasoningEffort override is only valid for Claude Code or Codex agents");
      }
      const previousReasoningEffort = readReasoningEffortOverride(cur.metadata);
      if (patch.reasoningEffort === null) {
        removeNextMetadataKeys(["reasoningEffort"]);
      } else {
        mergeNextMetadata({ reasoningEffort: patch.reasoningEffort });
      }
      if (patch.reasoningEffort !== previousReasoningEffort) {
        clearResumeMetadata();
      }
    } else if (
      patch.providerId !== undefined &&
      !providerSupportsReasoningEffort(targetProvider?.kind) &&
      readReasoningEffortOverride(cur.metadata) !== null
    ) {
      removeNextMetadataKeys(["reasoningEffort"]);
    }
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

  async deleteAgent(id: string): Promise<boolean> {
    const cur = await prisma.agent.findUnique({ where: { id } });
    if (!cur) return false;
    this.clearQueuedTurns(id);
    await this.cancel(id);
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
    this.clearQueuedTurns(id);
    await this.cancel(id);
    await prisma.message.delete({ where: { agentId: id } });
    await prisma.agent.update({
      where: { id },
      data: { metadata: removeMetadataKeys(cur.metadata, [...RESUME_METADATA_KEYS]) },
    });
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
      autoAllowedTools: new Set<string>(),
    });
    try {
      await this.appendCompactStatusMessage(id, COMPACT_START_TEXT);
      await this.updateAgentStatus(id, "RUNNING", "running");
      await flushVisibleState();
      if (!this.isRunOwner(id, runId)) {
        return { summary: "(compact cancelled)" };
      }
      const out = await this.compactAgentHistory(cur, () => this.isRunOwner(id, runId));
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
        this.clearRuntimeIdleWatchdog(id, runId);
        this.running.delete(id);
        this.drainQueuedTurns(id);
      }
    }
  }

  private async compactAgentHistory(cur: DbAgent, shouldContinue?: () => boolean): Promise<{ summary: string }> {
    const id = cur.id;
    const messages = await prisma.message.findMany({
      where: { agentId: id },
      orderBy: { seq: "asc" },
    });
    const lines = transcriptLinesFromRows(messages);
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
    if (shouldContinue && !shouldContinue()) {
      return { summary };
    }

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
    await prisma.agent.update({
      where: { id },
      data: { metadata: removeMetadataKeys(cur.metadata, [...RESUME_METADATA_KEYS]) },
    });
    this.hub.broadcast({
      type: "agent_history_reset",
      sessionId: id,
      reason: "compact",
      summary,
    });
    return { summary };
  }

  /** /status — runtime-agnostic snapshot of an agent's current state. */
  private async maybeAutoCompactBeforeTurn(
    agent: DbAgent,
    shouldContinue?: () => boolean,
  ): Promise<"skipped" | "compacted" | "failed" | "cancelled"> {
    const rows = await prisma.message.findMany({
      where: { agentId: agent.id },
      orderBy: { seq: "asc" },
    });
    if (rows.length < AUTO_COMPACT_MIN_MESSAGES) return "skipped";

    const totalChars = rows.reduce((sum, row) => sum + messageRowText(row).length, 0);
    if (totalChars < AUTO_COMPACT_TRIGGER_CHARS) return "skipped";

    const keepStart = Math.max(0, rows.length - AUTO_COMPACT_KEEP_MESSAGES);
    const rowsToSummarize = rows.slice(0, keepStart);
    const rowsToKeep = rows.slice(keepStart);
    const lines = transcriptLinesFromRows(rowsToSummarize);
    if (lines.length === 0) return "skipped";

    await this.appendCompactStatusMessage(agent.id, COMPACT_START_TEXT);
    await this.updateAgentStatus(agent.id, "RUNNING", "running");
    await flushVisibleState();
    if (shouldContinue && !shouldContinue()) {
      return "cancelled";
    }

    const transcript = truncateTranscript(lines.join("\n\n"), AUTO_COMPACT_SUMMARY_MAX_CHARS);
    let summary = "";
    try {
      summary = (await this.quickQuery(agent.id, compactPromptFromTranscript(transcript), 45_000)).trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendCompactStatusMessage(agent.id, `${COMPACT_FAILURE_PREFIX} ${message}`);
      return "failed";
    }
    if (!summary) {
      await this.appendCompactStatusMessage(agent.id, `${COMPACT_FAILURE_PREFIX} model returned empty summary`);
      return "failed";
    }
    if (shouldContinue && !shouldContinue()) {
      return "cancelled";
    }

    this.replaceMessageHistory(agent.id, summary, rowsToKeep);
    await prisma.agent.update({
      where: { id: agent.id },
      data: { metadata: removeMetadataKeys(agent.metadata, [...RESUME_METADATA_KEYS]) },
    });
    this.hub.sendToSession(agent.id, {
      type: "message",
      sessionId: agent.id,
      seq: 0,
      msg: { type: "system", subtype: "compact", text: summary } as never,
    });
    return "compacted";
  }

  private replaceMessageHistory(
    agentId: string,
    summary: string,
    rowsToKeep: Array<{ type: string; payload: unknown }>,
  ): void {
    sqliteDb.exec("BEGIN IMMEDIATE");
    try {
      sqliteDb.prepare("DELETE FROM Message WHERE agentId = ?").run(agentId);
      const insert = sqliteDb.prepare("INSERT INTO Message (agentId, seq, type, payload) VALUES (?, ?, ?, ?)");
      insert.run(agentId, 0, "system", JSON.stringify({ type: "system", subtype: "compact", text: summary }));
      let seq = 1;
      for (const row of rowsToKeep) {
        insert.run(agentId, seq, row.type, JSON.stringify(row.payload));
        seq++;
      }
      sqliteDb.exec("COMMIT");
    } catch (err) {
      try { sqliteDb.exec("ROLLBACK"); } catch { /* ignore rollback failure */ }
      throw err;
    }
  }

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

    const runtime = this.runtimeResolver(resolvedProvider?.kind ?? "anthropic-local");
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

  private enqueueTurn(
    sessionId: string,
    userInput: string,
    opts?: SendMessageOptions,
  ): Promise<{ finalText: string } | null> {
    return new Promise((resolve) => {
      const peerOrigin = opts?.peerOrigin;
      let row: { id: number };
      if (peerOrigin) {
        const existing = this.findQueuedPeerHandoff(sessionId, peerOrigin);
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

  private drainQueuedTurns(sessionId: string): void {
    if (this.running.has(sessionId) || this.drainingQueues.has(sessionId)) return;
    const rows = prisma.pendingTurn.findMany({
      where: { agentId: sessionId },
      orderBy: { id: "asc" },
    });
    if (rows.length === 0) {
      this.queuedTurns.delete(sessionId);
      return;
    }
    const nextRows = this.takeNextQueuedTurnSegment(rows);
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
    const userInput = this.formatQueuedTurnSegment(nextRows);
    const opts = nextRows.length === 1 ? normalizeQueuedTurnOpts(nextRows[0]!.opts) : undefined;
    const drainToken = this.beginDrain(sessionId);
    void this.runMessageNow(sessionId, userInput, opts)
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

  private takeNextQueuedTurnSegment(rows: DbPendingTurn[]): DbPendingTurn[] {
    const first = rows[0];
    if (!first) return [];
    if (!normalizeQueuedTurnOpts(first.opts)?.peerOrigin) return [first];
    const segment: DbPendingTurn[] = [];
    for (const row of rows) {
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
      if (origin?.sourceRunId) lines.push(`Source run: ${origin.sourceRunId.slice(0, 8)}`);
      lines.push("", row.userInput.trim(), "");
    });
    lines.push("</peer-batch>");
    return lines.join("\n");
  }

  private clearQueuedTurns(sessionId: string): void {
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
    const MAX_LIVE_CHARS = 6000;
    const clipped =
      text.length <= MAX_LIVE_CHARS
        ? text
        : `${text.slice(0, 2800)}\n\n[... ${text.length - 5600} live chars truncated ...]\n\n${text.slice(-2800)}`;
    return [
      `target is currently running; live assistant output visible so far:`,
      "",
      "[assistant/live]",
      clipped,
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
  ): Promise<InterruptedTurnPayload | null> {
    if (run.interruptedPersisted || run.sawResult || run.userMessageSeq === undefined) return null;
    if (this.interruptedTurnAlreadyPersisted(sessionId, run)) {
      run.interruptedPersisted = true;
      return null;
    }
    const userRequest = truncateMiddle(run.userInput.trim(), INTERRUPTED_USER_REQUEST_MAX_CHARS);
    if (!userRequest) return null;
    const liveText = this.liveAssistantText(sessionId);
    const payload: InterruptedTurnPayload = {
      type: "system",
      subtype: "interrupted_turn",
      reason,
      runId: run.runId,
      userSeq: run.userMessageSeq,
      userRequest,
      ...(liveText ? { partialAssistantText: truncateMiddle(liveText, INTERRUPTED_PARTIAL_MAX_CHARS) } : {}),
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

    const lastMsg = await prisma.message.findFirst({
      where: { agentId: sessionId },
      orderBy: { seq: "desc" },
    });
    let seq = (lastMsg?.seq ?? -1) + 1;

    const abort = new AbortController();
    const runId = randomUUID();
    let staleResume = false;
    let usedResumeSessionId: string | null = null;
    let resumeInvalidReasonForRun: string | null = null;
    let autoRecoverAfterRun: { userInput: string; opts: SendMessageOptions } | null = null;
    let autoRecoveryPromise: Promise<{ finalText: string } | null> | null = null;
    this.running.set(sessionId, {
      id: sessionId,
      runId,
      abort,
      seq,
      userInput,
      startedSeq: seq,
      peerOrigin: opts?.peerOrigin,
      startedAt: new Date().toISOString(),
      autoAllowedTools: new Set<string>(),
    });

    try {
    console.log(`[sendMessage] start agent=${sessionId.slice(0, 8)} run=${runId.slice(0, 8)} text="${userInput.slice(0, 40)}"`);

    try {
      const compactResult = await this.maybeAutoCompactBeforeTurn(agent, () => this.isRunOwner(sessionId, runId));
      if (compactResult === "cancelled" || !this.isRunOwner(sessionId, runId)) {
        return null;
      }
      const refreshedAgent = await prisma.agent.findUnique({ where: { id: sessionId } });
      if (!refreshedAgent) {
        this.hub.sendToSession(sessionId, { type: "error", sessionId, code: "NOT_FOUND", message: "agent not found" });
        return null;
      }
      agent = refreshedAgent;
      const refreshedLastMsg = await prisma.message.findFirst({
        where: { agentId: sessionId },
        orderBy: { seq: "desc" },
      });
      seq = (refreshedLastMsg?.seq ?? -1) + 1;
      const activeRunAfterCompact = this.running.get(sessionId);
      if (activeRunAfterCompact?.runId === runId) {
        activeRunAfterCompact.seq = seq;
        activeRunAfterCompact.startedSeq = seq;
      }
    } catch (err) {
      console.warn(`[auto-compact] skipped agent=${sessionId.slice(0, 8)}: ${(err as Error).message}`);
    }
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
    const userPersisted = userMsgPayload
      ? await prisma.message.create({
          data: {
            agentId: sessionId,
            seq,
            type: "user",
            payload: userMsgPayload,
          },
        })
      : null;
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
    const helpMcp = makeHelpMcpServer();
    const permissionMode = readPermissionMode(agent.metadata);
    const lastSessionId = readMetaString(agent.metadata, "lastSessionId");
    let capturedSessionId: string | null = lastSessionId;
    let latestCodexUsageSnapshot: CodexUsageSnapshot | null = null;
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
      const priorRows = isOpenAIKind
        ? (await prisma.message.findMany({
            where: { agentId: sessionId },
            orderBy: { seq: "asc" },
          }))
              // Drop the user message we just persisted (it's opts.prompt) and
              // the system/init / stream_event / result rows — those don't
              // round-trip into the OpenAI Agents input items.
              .filter((m) => m.seq < (userPersisted?.seq ?? seq))
          : [];
      const priorMessages: SdkMessage[] =
        isOpenAIKind ? buildRuntimeHistoryForTurn(priorRows) : [];
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
      const codexReasoningEffort = readReasoningEffortOverride(agent.metadata);
      const codexSandboxMode = isCodexKind
        ? readSandboxOverride(agent.metadata) ?? readProviderDefaultSandbox(resolvedProvider?.metadata)
        : null;
      const codexResumeSignature = isCodexKind
        ? buildCodexResumeSignature({
            providerId: resolvedProvider?.id ?? null,
            model: agent.model,
            reasoningEffort: codexReasoningEffort,
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
      const promptForRuntime =
        effectiveLastSessionId && skillsSection
          ? `${skillsSection}\n\n---\n\n${userInput}`
          : userInput;
      if (isCodexKind) {
        console.error(
          JSON.stringify({
            codexDispatch: true,
            agentId: sessionId,
            runId,
            model: agent.model,
            reasoningEffort: codexReasoningEffort,
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
        reasoningEffort: codexReasoningEffort,
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

      let firstMsg = true;
      for await (const event of stream) {
        this.resetRuntimeIdleWatchdog(sessionId, runId);
        if (event.type === "error") {
          throw runtimeErrorFromEvent(event);
        }
        const msg = event.payload;
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

        this.recordLiveTranscript(sessionId, msg);

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
          const activeRun = this.running.get(sessionId);
          if (activeRun?.runId === runId) activeRun.sawResult = true;
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
        }

        this.hub.sendToSession(sessionId, {
          type: "message",
          sessionId,
          seq: persisted.seq,
          msg: msg as never,
        });

        seq++;
        // A result message is terminal for this turn. Exit only after the
        // result has been persisted, usage-accounted, and broadcast so queued
        // work can drain even if the runtime stream never closes naturally.
        if (msg.type === "result") break;
      }
      this.clearRuntimeIdleWatchdog(sessionId, runId);

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
      if (latestCodexUsageSnapshot) {
        metaPatch.codexUsageSnapshot = latestCodexUsageSnapshot;
      }
      if (codexResumeSignature && storedCodexResumeSignature !== codexResumeSignature) {
        metaPatch[CODEX_RESUME_SIGNATURE_KEY] = codexResumeSignature;
      }
      if (resumeInvalidReasonForRun !== null || Object.keys(metaPatch).length > 0) {
        const baseMetadata =
          resumeInvalidReasonForRun !== null
            ? removeMetadataKeys(agent.metadata, [...RESUME_METADATA_KEYS])
            : agent.metadata;
        persistData.metadata = mergeMetadata(baseMetadata, metaPatch);
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
      this.clearRuntimeIdleWatchdog(sessionId, runId);
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
      if (resumeInvalidReasonForRun !== null || staleResume || recoverableResumeFailure || recoverableCodexEventStreamFailure) {
        persistData.metadata = removeMetadataKeys(agent.metadata, [...RESUME_METADATA_KEYS]);
        console.warn(
          `[sendMessage] clearing resume metadata agent=${sessionId.slice(0, 8)} ` +
            `run=${runId.slice(0, 8)} stale=${staleResume} ` +
            `resumeInvalidReason=${resumeInvalidReasonForRun ?? "(none)"} ` +
            `structuredResumeFailure=${structuredResumeFailure} legacyResumeFailure=${legacyResumeFailure} ` +
            `codexEventStreamFailure=${recoverableCodexEventStreamFailure}`,
        );
      }
      const shouldAutoRecoverCodexEventStream =
        !aborted &&
        recoverableCodexEventStreamFailure &&
        opts?.autoRecoveryAttempt !== "codex-event-stream-lagged";
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
      }
      // Same guard as the success path. cancel() owns the canonical IDLE state
      // once it's removed this run from the map.
      if (this.running.get(sessionId)?.runId === runId) {
        const activeRun = this.running.get(sessionId);
        if (activeRun?.runId === runId && !activeRun.sawResult) {
          const reason = aborted
            ? "aborted"
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
            : recoverableResumeFailure
              ? rawMsg + "\n\nCleared cached session state for this agent. Please send your message again; Ensemble will start a fresh runtime session while preserving the local chat history."
            : rawMsg;
          this.hub.sendToSession(sessionId, {
            type: "error",
            sessionId,
            code: shouldAutoRecoverCodexEventStream
              ? "CODEX_EVENT_STREAM_RECOVERING"
              : staleResume ? "SESSION_LOST" : "QUERY_FAILED",
            message: friendly,
          });
        }
        this.hub.sendToSession(sessionId, {
          type: "status",
          sessionId,
          status: aborted || shouldAutoRecoverCodexEventStream ? "idle" : "error",
        });
      } else {
        console.log(`[sendMessage] run=${runId.slice(0, 8)} error post-cancel; skipping DB update`);
      }
    } finally {
      // Only clear state if we're still the owner. After cancel() the entry
      // is gone; a brand-new sendMessage could already have set its own entry.
      // Without this guard a wedged old run's finally would corrupt the new run.
      if (this.running.get(sessionId)?.runId === runId) {
        this.clearRuntimeIdleWatchdog(sessionId, runId);
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
          this.drainQueuedTurns(sessionId);
        }
      }
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
  private async fetchPeerSourceSnapshot(agentId: string): Promise<PeerSourceSnapshot> {
    const MAX_REVIEW_CHARS = 8000;
    const running = this.running.get(agentId);
    const liveText = this.liveAssistantText(agentId);
    if (running) {
      const output = [
        `Source state: running`,
        `Current user request: ${truncateMiddle(running.userInput, PEER_SOURCE_REQUEST_MAX_CHARS)}`,
        "",
        liveText ? "Live assistant output so far:" : "Live assistant output so far: (none yet)",
        liveText ? truncateMiddle(liveText, PEER_SOURCE_PARTIAL_MAX_CHARS) : "",
      ].join("\n");
      return {
        sourceRunState: "running",
        ...(liveText ? { liveText: truncateMiddle(liveText, PEER_SOURCE_PARTIAL_MAX_CHARS) } : {}),
        sourceUserRequest: truncateMiddle(running.userInput, PEER_SOURCE_REQUEST_MAX_CHARS),
        sourceOutput: truncateMiddle(output, PEER_SOURCE_OUTPUT_MAX_CHARS),
      };
    }
    const sourceRows = await prisma.message.findMany({
      where: { agentId },
      orderBy: { seq: "asc" },
      take: 400,
    });
    const latestResultIndex = sourceRows.map((row) => row.type).lastIndexOf("result");
    const latestUnresolvedInterruptedIndex = findLatestInterruptedTurnIndex(sourceRows, latestResultIndex + 1);
    const interrupted = latestUnresolvedInterruptedIndex >= 0
      ? parseInterruptedTurnPayload(sourceRows[latestUnresolvedInterruptedIndex]!.payload)
      : null;
    if (interrupted) {
      const output = [
        `Source state: interrupted`,
        `Interrupted user request: ${truncateMiddle(interrupted.userRequest, PEER_SOURCE_REQUEST_MAX_CHARS)}`,
        "",
        "Partial assistant output before interruption:",
        truncateMiddle(interrupted.partialAssistantText ?? "(no assistant output before interruption)", PEER_SOURCE_PARTIAL_MAX_CHARS),
      ].join("\n");
      return {
        sourceRunState: "interrupted",
        latestInterruptedContext: interrupted,
        sourceUserRequest: truncateMiddle(interrupted.userRequest, PEER_SOURCE_REQUEST_MAX_CHARS),
        sourceOutput: truncateMiddle(output, PEER_SOURCE_OUTPUT_MAX_CHARS),
      };
    }
    // Pull newest rows from the already-loaded source snapshot; any sensible
    // last turn fits in the last 80 rows.
    const rows = sourceRows.slice(-80).reverse();
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
    const joined = texts.join("\n\n");
    const lastCompletedAssistantText =
      joined.length <= MAX_REVIEW_CHARS ? joined : truncateMiddle(joined, MAX_REVIEW_CHARS);
    return {
      sourceRunState: "completed",
      lastCompletedAssistantText,
      sourceOutput: truncateMiddle(lastCompletedAssistantText, PEER_SOURCE_OUTPUT_MAX_CHARS),
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

    const live = this.formatLiveTranscript(targetId);
    if (turns.length === 0 && !live) {
      return `peer "${targetAgent.name}" (id=${targetId.slice(0, 8)}) has no text history yet.`;
    }
    const header = `peer agent: ${targetAgent.name} (id=${targetId.slice(0, 8)}) - last ${turns.length} text turns (oldest to newest):\n\n`;
    const body = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
    const full = [turns.length > 0 ? header + body : "", live].filter((s) => s && s.trim()).join("\n\n---\n\n");
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
    if (readMetaBool(targetAgent.metadata, "closed")) {
      return `error: peer agent "${targetAgent.name}" is closed; user must restart it before it can receive messages`;
    }

    const sourceRunId = this.running.get(fromAgent.id)?.runId;
    const includeSource =
      opts.includeSource === true ||
      ((opts.includeSource === undefined || opts.includeSource === "auto") && mode !== "raw");
    const sourceSnapshot = await this.fetchPeerSourceSnapshot(fromAgent.id);
    const formatted = formatPeerHandoff({
      fromName: fromAgent.name,
      fromId: fromAgent.id,
      receiverMetadata: targetAgent.metadata,
      mode,
      body,
      sourceLastOutput: sourceSnapshot.sourceOutput,
      sourceState: sourceSnapshot.sourceRunState,
      includeSource: opts.includeSource ?? "auto",
      ...(interrupt ? { interruptReason } : {}),
    });
    const targetWasBusy = this.running.has(targetId) || this.drainingQueues.has(targetId);
    const peerOrigin = {
      fromAgentId: fromAgent.id,
      fromAgentName: fromAgent.name,
      mode,
      ...(sourceRunId ? { sourceRunId } : {}),
      ...(sourceRunId && includeSource ? { coalescibleSourceOutput: true } : {}),
    };
    const willReplaceQueuedPeerHandoff = targetWasBusy && this.findQueuedPeerHandoff(targetId, peerOrigin) !== null;
    if (interrupt) {
      await this.interruptForPeerSend(targetId, interruptReason);
      void this.sendMessage(targetId, formatted, { peerOrigin }).catch((err) => {
        console.error(`[peer_send] sendMessage to ${targetId} failed:`, err);
      });
      return `interrupted and delivered to "${targetAgent.name}" (id=${targetId.slice(0, 8)}, mode=${mode}, reason=${interruptReason})`;
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

    if (r) {
      console.log(`[${opts.logPrefix}] abort agent=${sessionId.slice(0, 8)} run=${r.runId.slice(0, 8)}`);
      await this.persistInterruptedTurn(sessionId, r, opts.interruptedReason ?? opts.error?.code ?? opts.logPrefix);
      try { r.abort.abort(); } catch { /* signal already aborted */ }
      this.clearRuntimeIdleWatchdog(sessionId, r.runId);
    } else {
      console.log(`[${opts.logPrefix}] no live run for agent=${sessionId.slice(0, 8)}; cleaning stale state`);
    }

    this.running.delete(sessionId);
    this.drainingQueues.delete(sessionId);
    this.liveTranscripts.delete(sessionId);
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
    const updated = await prisma.agent.update({
      where: { id: sessionId },
      data: { status: dbStatus },
    });
    this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
    this.hub.sendToSession(sessionId, { type: "status", sessionId, status: protoStatus });
    if (dbStatus === "RUNNING") {
      this.resumeRuntimeIdleWatchdog(sessionId);
    } else if (dbStatus === "AWAITING_PERMISSION" || dbStatus === "AWAITING_USER_INPUT") {
      this.pauseRuntimeIdleWatchdog(sessionId);
    } else {
      this.clearRuntimeIdleWatchdog(sessionId);
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
    if (r) {
      console.log(`[cancel] abort agent=${sessionId.slice(0, 8)} run=${r.runId.slice(0, 8)}`);
      await this.persistInterruptedTurn(sessionId, r, "cancelled");
      try { r.abort.abort(); } catch { /* signal already aborted */ }
      this.clearRuntimeIdleWatchdog(sessionId, r.runId);
    } else {
      // No in-memory run — but the DB might still say RUNNING because a
      // previous core process crashed mid-turn or a runtime hang outlived its
      // sendMessage call. Continue to the DB reset below; better to leave
      // the agent IDLE than stuck.
      console.log(`[cancel] no live run for agent=${sessionId.slice(0, 8)}; cleaning stale state`);
    }
    this.liveTranscripts.delete(sessionId);

    // Drop in-memory state synchronously so sendMessage's runId guard fires
    // and a fresh send_message can be accepted without races.
    this.running.delete(sessionId);
    this.drainingQueues.delete(sessionId);
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
          const updated = await prisma.agent.update({
            where: { id: a.id },
            data: { status: "IDLE" },
          });
          this.hub.broadcast({ type: "agent_updated", agent: agentRowToSummary(updated) });
        }
      }
      this.drainPersistedQueues();
    } catch (err) {
      console.error(`[recover] failed: ${(err as Error).message}`);
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
