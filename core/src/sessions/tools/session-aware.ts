// Slice 5: session-aware NormalizedTools — peer_send / ask_user / Task.
//
// These three tools need a closure over SessionManager (or specific methods
// on it). They mirror the Claude side's peer-mcp / ask-user-mcp / Task with
// the same fromAgentId-binding pattern: SessionManager.sendMessage builds a
// fresh tool per call via these factories. Each factory takes a callback
// (not a SessionManager reference) so the abstraction stays clean — the
// callbacks are the Slice 1.7 makePeerSendHandler / makeAskUserHandler /
// (new) spawnTaskSubagent closures.
//
// Per docs/plans/openai-mcp-integration.md §2 these are plain function
// tools, not MCP — the OpenAI Agents SDK's MCP API is client-only, so an
// in-process MCP server would be 4-hop where 0-hop works.
//
// Per docs/plans/cross-runtime-peer-send.md §6.1 OpenAI names: short
// `peer_send` / `ask_user` / `Task`. Frontend normalizes vs Claude's
// `mcp__agentorch-peer__peer_send` long names in Slice 5.5.

import { z } from "zod";
import type { PeerCorrelationKind, PeerIncludeSource } from "@agentorch/shared";
import { backgroundSubagentStartedText } from "../subagentFinish.js";
import { CONVERSATION_SEARCH_SCOPES, type ConversationSearchArgs } from "../../conversation-search.js";
import {
  ARTIFACT_MAX_PAGE_BYTES,
  ARTIFACT_READ_DESCRIPTION,
  ARTIFACT_SEARCH_DESCRIPTION,
  renderArtifactRead,
  renderArtifactSearch,
  type ArtifactReadResult,
  type ArtifactSearchResult,
} from "../../artifacts.js";
import {
  JOB_WAIT_MAX_MS,
  jobCancelToolText,
  jobStartToolText,
  jobStatusToolText,
  jobWaitToolText,
  type JobToolContext,
} from "../../jobs.js";
import type { AnyNormalizedTool, NormalizedTool } from "./types.js";

const PEER_MODES = ["continue", "review", "fork", "raw"] as const;
const PEER_CORRELATION_KINDS = ["decision", "request"] as const;

type PeerSendCallback = (args: {
  target: string;
  message: string;
  mode?: typeof PEER_MODES[number];
  includeSource?: PeerIncludeSource;
  interrupt?: boolean;
  interruptReason?: string;
  messageId?: string;
  correlationId?: string;
  correlationKind?: PeerCorrelationKind;
  replyToCorrelationId?: string;
  causalRunId?: string;
}) => Promise<string>;

type PeerQueryCallback = (args: { target: string; limit?: number }) => Promise<string>;
type ConversationSearchCallback = (args: ConversationSearchArgs) => Promise<string>;

type AskUserCallback = (args: { question: string; options: string[] }) => Promise<string>;

type SpawnTaskCallback = (args: {
  description: string;
  prompt: string;
  background?: boolean;
  projectRoot?: string | null;
}) => Promise<{ finalText: string; subagentId: string; background?: boolean }>;

type ArtifactReadCallback = (args: {
  id: string;
  cursor?: string;
  pageBytes?: number;
}) => ArtifactReadResult;
type ArtifactSearchCallback = (args: {
  id: string;
  query: string;
  cursor?: string;
  caseSensitive?: boolean;
  maxHits?: number;
  snippetBytes?: number;
}) => ArtifactSearchResult;

type EnsembleHelpCallback = (args: { topic?: string }) => Promise<string>;
type SkillListCallback = () => Promise<string>;
// May resolve to the structured read result ({ok:false,...}) — NormalizedTool.execute
// already accepts string-or-object and the OpenAI adapter JSON-stringifies a
// non-string, so the failure shape survives to the model instead of being
// flattened into a success-shaped sentence.
type SkillInvokeCallback = (args: { name: string }) => Promise<string | object>;

const PEER_SEND_SCHEMA = z.object({
  target: z.string().min(1).describe("Name (preferred) or UUID of the recipient agent."),
  message: z.string().min(1).describe("Body of the message to send."),
  mode: z
    .enum(PEER_MODES)
    .optional()
    .describe("Handoff semantics: continue|review|fork|raw. Default 'raw'."),
  includeSource: z
    .union([z.boolean(), z.literal("auto")])
    .optional()
    .describe("Whether to include source-output. Default 'auto': raw=false, continue/review/fork=true."),
  interrupt: z
    .boolean()
    .optional()
    .describe("Emergency only. Interrupt the target's current run so this message is delivered immediately."),
  interruptReason: z
    .string()
    .optional()
    .describe("Required when interrupt=true. Explain why delayed delivery would be harmful or stale."),
  messageId: z.string().optional().describe("Optional sender-generated id for this peer message."),
  correlationId: z.string().optional().describe("Optional id tying related peer request/decision messages together."),
  correlationKind: z
    .enum(PEER_CORRELATION_KINDS)
    .optional()
    .describe("Optional correlation semantic: decision or request."),
  replyToCorrelationId: z.string().optional().describe("Optional correlationId this message answers."),
  causalRunId: z.string().optional().describe("Optional sender-side run id or causal clock for this message."),
});

/** peer_send NormalizedTool factory. Mirror of Claude side peer-mcp.ts.
 *  fromAgentId is bound inside the callback (see Slice 1.7), not here. */
export function makePeerSendTool(send: PeerSendCallback): NormalizedTool<typeof PEER_SEND_SCHEMA> {
  return {
    name: "peer_send",
    description: [
      "Send a chat message to another agent in this workspace. Bidirectional: anyone can",
      "send to anyone. If you received a peer-handoff and need more info, you can peer_send",
      "back to the source agent (their reply arrives as a new turn).",
      "",
      "Modes (cxsm-style handoff semantics):",
      "  - continue: hand off your work-in-progress; recipient continues from your trajectory.",
      "  - review:   ask recipient for a second-opinion audit of your work; quote verbatim.",
      "  - fork:     same task, different approach; recipient should NOT replicate your path.",
      "  - raw:      plain message forwarding (default).",
      "",
      "Source context defaults to includeSource='auto': raw sends only your message;",
      "continue/review/fork include a <<<source-output>>> block with your current or most",
      "recent key output — verbatim when it fits the recipient's window, otherwise its first",
      "page plus an artifact handle the recipient reads in full with artifact_read.",
      "",
      "interrupt=true is emergency-only: use it only when delayed delivery would make",
      "the message stale or cause the target to continue incorrectly. You must provide",
      "interruptReason. Ordinary notifications, questions, and handoffs must not interrupt.",
      "",
      "Use the target agent's name (preferred) or its UUID.",
      "Subagents are PRIVATE to their spawner: an agent spawned by another agent (Task /",
      "spawn_subagent) can only be messaged by the agent that spawned it, and a subagent can",
      "message ONLY that one parent — not other agents, not sibling subagents, not subagents of",
      "its own. Anything else is refused; send the work to the parent agent instead.",
      "Returns delivery status; does NOT wait for the recipient to reply.",
      "For read-only context pulls without running anyone, prefer peer_query.",
    ].join("\n"),
    parameters: PEER_SEND_SCHEMA,
    async execute(args) {
      return send(args);
    },
  };
}

const PEER_QUERY_SCHEMA = z.object({
  target: z.string().min(1).describe("Name (preferred) or UUID of the peer agent."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max user-turn boundaries to walk back (default 20, max 50)."),
});

/** peer_query NormalizedTool factory. Read-only DB-only fetch of a peer
 *  agent's recent text turns. Use this when a handoff feels short on context. */
export function makePeerQueryTool(query: PeerQueryCallback): NormalizedTool<typeof PEER_QUERY_SCHEMA> {
  return {
    name: "peer_query",
    description: [
      "Pull another agent's recent text turns (read-only, synchronous). Use when",
      "you need more context than what arrived in a handoff, or to inspect a peer's",
      "state before sending them work.",
      "",
      "A subagent is private to the agent that spawned it: another agent's subagent cannot be",
      "queried — ask its parent instead.",
      "",
      "Does NOT cause the target agent to run; pure DB read. Returns oldest-first",
      "text turns prefixed with [user] / [assistant], tool-use noise stripped.",
      "",
      "The transcript is stored whole as an artifact and returned verbatim when it fits",
      "this turn's budget; otherwise you get its first page plus an <<<artifact id=…",
      "sha256=…>>> handle to continue with artifact_read(id, cursor).",
    ].join("\n"),
    parameters: PEER_QUERY_SCHEMA,
    async execute(args) {
      return query(args);
    },
  };
}

const CONVERSATION_SEARCH_SCHEMA = z.object({
  query: z.string().min(1).describe("Keyword or short phrase to search for in prior user/assistant text."),
  scope: z
    .enum(CONVERSATION_SEARCH_SCOPES)
    .optional()
    .describe("Search scope. Default team; if this agent has no team, team falls back to self."),
  target: z
    .string()
    .optional()
    .describe("Agent name or UUID. Required when scope='agent'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Maximum matches to return (default 8, max 25)."),
});

export function makeConversationSearchTool(
  search: ConversationSearchCallback,
): NormalizedTool<typeof CONVERSATION_SEARCH_SCHEMA> {
  return {
    name: "conversation_search",
    description: [
      "Search prior Ensemble conversation text by keyword (read-only DB lookup).",
      "Does NOT run any target agent and does not modify memory, resume, model,",
      "provider, permissionMode, or sandbox settings.",
      "",
      "Default scope is team. If this agent has no team, team falls back to self.",
      "Use scope='self' for this agent only or scope='agent' with target name/UUID.",
      "",
      "Returns bounded matches with agent, seq, role, createdAt, and snippet.",
      "Tool-use/tool-result/raw event noise is filtered out.",
    ].join("\n"),
    parameters: CONVERSATION_SEARCH_SCHEMA,
    async execute(args) {
      return search(args);
    },
  };
}

const ASK_USER_SCHEMA = z.object({
  question: z.string().min(1).describe("Question text shown to the user."),
  options: z
    .array(z.string().min(1))
    .min(1)
    .describe("List of choice labels the user can pick from. At least one."),
});

/** ask_user NormalizedTool factory. Mirror of Claude side ask-user-mcp.ts. */
export function makeAskUserTool(ask: AskUserCallback): NormalizedTool<typeof ASK_USER_SCHEMA> {
  return {
    name: "ask_user",
    description:
      "Ask the human user a question and wait for their answer. Pass a list of options " +
      "(button labels). The tool returns the option string the user picked. Use this when " +
      "you need a decision before proceeding (clarification / branching / approval beyond " +
      "simple yes-no).",
    parameters: ASK_USER_SCHEMA,
    async execute(args) {
      return ask(args);
    },
  };
}

const TASK_SCHEMA = z.object({
  description: z.string().min(1).describe("Short task summary (3-5 words)."),
  prompt: z.string().min(1).describe("Full task description for the subagent."),
  background: z
    .boolean()
    .optional()
    .describe(
      "If true, run the subagent as a detached BACKGROUND TASK: this tool returns " +
        "its id immediately and you keep working while it runs. If false/omitted, " +
        "wait for the subagent and return its final response. Either way the " +
        "subagent appears in the sidebar tree under you.",
    ),
  projectRoot: z
    .string()
    .optional()
    .describe(
      "Optional override for the subagent's project root (absolute path to an " +
        "existing directory). Omit it and the subagent inherits YOUR project root " +
        "verbatim — that is almost always what you want, since a subtask is part of " +
        "your project.",
    ),
});

const ENSEMBLE_HELP_SCHEMA = z.object({
  topic: z
    .string()
    .optional()
    .describe(
      "Topic name. One of: overview, add_mcp_server, switch_provider, switch_model, create_agent, permissions, sandbox, peer_messaging, slash_commands, subagents, data_dir.",
    ),
});

/** ensemble_help NormalizedTool factory. Stateless — no closure needed —
 *  but kept on the factory pattern for consistency with peer_send / ask_user. */
export function makeEnsembleHelpTool(
  help: EnsembleHelpCallback,
): NormalizedTool<typeof ENSEMBLE_HELP_SCHEMA> {
  return {
    name: "ensemble_help",
    description: [
      "Ensemble runtime guidance. Call this BEFORE attempting Ensemble-specific",
      "tasks — Ensemble's source code is NOT on this machine; don't try to Grep",
      "for it. Returns UI paths + HTTP API hints for each topic.",
      "",
      "Topics: overview, add_mcp_server, switch_provider, switch_model,",
      "create_agent, permissions, sandbox, peer_messaging, slash_commands, subagents, data_dir.",
      "Call with no topic for the index.",
    ].join("\n"),
    parameters: ENSEMBLE_HELP_SCHEMA,
    async execute(args) {
      return help(args);
    },
  };
}

const SKILL_LIST_SCHEMA = z.object({});
const SKILL_INVOKE_SCHEMA = z.object({
  name: z.string().min(1).describe("Skill name (slug from SKILL.md frontmatter)."),
});

export function makeSkillListTool(list: SkillListCallback): NormalizedTool<typeof SKILL_LIST_SCHEMA> {
  return {
    name: "skill_list",
    description: [
      "List skills currently available to this agent. Each entry: name,",
      "description (when-to-use), source, optional tool restrictions.",
      "",
      "Skills may auto-activate based on the user's message — check your system",
      "prompt for ACTIVE SKILLS before invoking explicitly.",
    ].join("\n"),
    parameters: SKILL_LIST_SCHEMA,
    async execute() {
      return list();
    },
  };
}

export function makeSkillInvokeTool(
  invoke: SkillInvokeCallback,
): NormalizedTool<typeof SKILL_INVOKE_SCHEMA> {
  return {
    name: "skill_invoke",
    description: [
      "Load a specific skill's instructions by name. Use when auto-activation",
      "missed the skill you need, or when the user invokes by name.",
      "",
      "Returns the full skill body — treat its instructions as system-prompt",
      "guidance for the rest of this turn.",
    ].join("\n"),
    parameters: SKILL_INVOKE_SCHEMA,
    async execute(args) {
      return invoke(args);
    },
  };
}

/** Task NormalizedTool factory. Per docs/plans/openai-task-handoff.md §3 the
 *  callback round-trips through SessionManager.spawnTaskSubagent so the
 *  child agent is a real DB row, can be canceled with the parent, and its
 *  messages broadcast normally. */
export function makeTaskTool(spawn: SpawnTaskCallback): NormalizedTool<typeof TASK_SCHEMA> {
  return {
    name: "Task",
    description:
      "Delegate a subtask to a subagent. The subagent is a REAL Ensemble agent: it " +
      "inherits your model + provider, runs in an isolated context, and appears nested " +
      "under you in the sidebar tree so the user can watch it. " +
      "Use it for self-contained work that benefits from a clean slate (research, " +
      "exploration, multi-step decomposition). Set background=true to spawn it as a " +
      "detached background task (returns its id immediately; you keep working while it " +
      "runs, and you are sent a `subagent-finished` message when it ends — never poll). " +
      "The subagent works in YOUR project root unless you pass projectRoot to place it " +
      "elsewhere (that directory must exist). " +
      "Subagent depth is capped at 3 levels.",
    parameters: TASK_SCHEMA,
    async execute(args) {
      const result = await spawn(args);
      if (result.background) {
        return backgroundSubagentStartedText(result.subagentId);
      }
      return result.finalText;
    },
  };
}

const ARTIFACT_READ_SCHEMA = z.object({
  id: z.string().min(1).describe("Artifact id, as printed in the result that stored it."),
  cursor: z
    .string()
    .optional()
    .describe("Opaque byte cursor from a previous artifact_read/artifact_search for the SAME artifact."),
  pageBytes: z
    .number()
    .int()
    .optional()
    .describe(`Bytes to return (default 16384, max ${ARTIFACT_MAX_PAGE_BYTES}). Snapped to a UTF-8 boundary.`),
});

const ARTIFACT_SEARCH_SCHEMA = z.object({
  id: z.string().min(1).describe("Artifact id, as printed in the result that stored it."),
  query: z.string().min(1).describe("Literal string to find (not a regex)."),
  cursor: z.string().optional().describe("Resume the scan from a previous artifact_search's nextCursor."),
  caseSensitive: z.boolean().optional().describe("Default false."),
  maxHits: z.number().int().optional().describe("Maximum hits per call (default 20, max 200)."),
  snippetBytes: z.number().int().optional().describe("Bytes of context around each hit (default 160)."),
});

/** artifact_read NormalizedTool. The OpenAI runtime's surface for the same
 *  paged read the Claude MCP server and the Codex bridge expose; all three
 *  render through `artifacts.ts` so the contract cannot drift per runtime.
 *
 *  Resolves to the rendered page STRING on success (the model reads the text
 *  directly) and to the structured error OBJECT on failure, which the OpenAI
 *  adapter serializes — so a failure is a code, never a success-shaped
 *  sentence. */
export function makeArtifactReadTool(read: ArtifactReadCallback): NormalizedTool<typeof ARTIFACT_READ_SCHEMA> {
  return {
    name: "artifact_read",
    description: ARTIFACT_READ_DESCRIPTION,
    parameters: ARTIFACT_READ_SCHEMA,
    async execute(args) {
      const result = read(args);
      return result.ok ? renderArtifactRead(result) : result;
    },
  };
}

// ── jobs: long work whose owner is core, not this turn ────────────────────
//
// The OpenAI runtime's surface for the same primitive the Claude runtime
// reaches through the `agentorch-jobs` MCP server. Both call the SAME
// `jobs.ts` operations, so "what does job_wait return" has one answer.
//
// Unlike the other factories in this file, these four share one context
// object rather than four callbacks: the context IS the binding (which agent,
// which project root, which manager) and splitting it would let the four
// tools disagree about, say, the default cwd. Per the plan's §2 reasoning the
// OpenAI SDK's MCP support is client-only, so an in-process MCP server here
// would be 4-hop where 0-hop works.

const JOB_START_SCHEMA = z.object({
  command: z.string().min(1).describe("Shell command to run. Windows runs PowerShell; macOS/Linux runs sh."),
  cwd: z.string().optional().describe("Working directory; defaults to the agent's project root."),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional hard ceiling. Omit for work whose length is unknown — a job has no default timeout."),
});

const JOB_STATUS_SCHEMA = z.object({
  job_id: z.string().optional().describe("Job id from job_start. Omit to list this agent's jobs."),
});

const JOB_WAIT_SCHEMA = z.object({
  job_id: z.string().min(1).describe("Job id from job_start."),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(JOB_WAIT_MAX_MS)
    .optional()
    .describe(`How long to wait before reporting the job as still running (max ${JOB_WAIT_MAX_MS}).`),
});

const JOB_CANCEL_SCHEMA = z.object({
  job_id: z.string().min(1).describe("Job id from job_start."),
});

const JOB_START_DESCRIPTION =
  "Start a long-running command whose OWNER IS ENSEMBLE'S SERVER, not this agent process, and return immediately with a job id. " +
  "Use this — not a background shell — for anything that may outlive the current turn: builds, installers, test suites, long downloads. " +
  "A background shell is a child of this agent process, so it is killed when the session is recycled (for example when the context window fills) " +
  "and its exit is never recorded; a job survives that, keeps writing to a log file, and always ends with a recorded status. " +
  "Poll with job_status, or block with job_wait. Output is streamed to a log file you can read in full.";

const JOB_STATUS_DESCRIPTION =
  "Report one job's status (running / exited / failed / cancelled / lost), its exit code, and the last lines of its log. " +
  "With no job id, list this agent's jobs. `lost` means the process is gone without a recorded exit — the honest answer after a crash — " +
  "and it is never reported as success.";

const JOB_WAIT_DESCRIPTION =
  "Block until a job reaches a terminal status or the timeout elapses, then report it the same way job_status does. " +
  "Prefer this to polling when you have nothing else to do; the timeout is capped so a turn can never hang here forever.";

const JOB_CANCEL_DESCRIPTION =
  "Kill a running job and its descendants. The job is recorded as `cancelled`, with whatever it printed kept in its log.";

/** The four job NormalizedTools for one agent's context.
 *
 *  Each is annotated with its OWN schema rather than the erased
 *  `AnyNormalizedTool` — otherwise `execute` would take `Record<string,
 *  unknown>` and every call below would need a cast that could hide a renamed
 *  parameter. */
export function makeJobTools(ctx: JobToolContext): AnyNormalizedTool[] {
  const start: NormalizedTool<typeof JOB_START_SCHEMA> = {
    name: "job_start",
    description: JOB_START_DESCRIPTION,
    parameters: JOB_START_SCHEMA,
    async execute(args) {
      return jobStartToolText(ctx, args);
    },
  };
  const status: NormalizedTool<typeof JOB_STATUS_SCHEMA> = {
    name: "job_status",
    description: JOB_STATUS_DESCRIPTION,
    parameters: JOB_STATUS_SCHEMA,
    async execute(args) {
      const r = jobStatusToolText(ctx, args);
      if (r.isError) throw new Error(r.text);
      return r.text;
    },
  };
  const wait: NormalizedTool<typeof JOB_WAIT_SCHEMA> = {
    name: "job_wait",
    description: JOB_WAIT_DESCRIPTION,
    parameters: JOB_WAIT_SCHEMA,
    async execute(args) {
      const r = await jobWaitToolText(ctx, args);
      if (r.isError) throw new Error(r.text);
      return r.text;
    },
  };
  const cancel: NormalizedTool<typeof JOB_CANCEL_SCHEMA> = {
    name: "job_cancel",
    description: JOB_CANCEL_DESCRIPTION,
    parameters: JOB_CANCEL_SCHEMA,
    async execute(args) {
      const r = jobCancelToolText(ctx, args);
      if (r.isError) throw new Error(r.text);
      return r.text;
    },
  };
  return [start, status, wait, cancel];
}

/** artifact_search NormalizedTool — same shape of contract as artifact_read. */
export function makeArtifactSearchTool(search: ArtifactSearchCallback): NormalizedTool<typeof ARTIFACT_SEARCH_SCHEMA> {
  return {
    name: "artifact_search",
    description: ARTIFACT_SEARCH_DESCRIPTION,
    parameters: ARTIFACT_SEARCH_SCHEMA,
    async execute(args) {
      const result = search(args);
      return result.ok ? renderArtifactSearch(result) : result;
    },
  };
}
