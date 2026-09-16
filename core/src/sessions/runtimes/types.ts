// W16 Slice 1.5: AgentRuntime abstraction.
//
// Two-layer event model (per multi-sdk-integration.md §3.3):
//   • RuntimeEvent — internal, runtime-emitted, never crosses the WS protocol boundary
//   • ServerMsg    — the WS protocol payload (in shared/protocol.ts), produced
//                    by SessionManager from RuntimeEvent + agent lifecycle state
//
// SessionManager is the only translator. Runtimes never produce ServerMsg; the
// adapter loop is in SessionManager.sendMessage.
//
// canUseTool stays a callback (rather than an event-style request/response
// over the iterator) because it's the simpler, lower-latency contract that
// already works for Claude side. OpenAI runtime (Slice 4) will translate its
// interrupt-resume semantics into the same callback shape.

import type {
  CanUseTool,
  McpServerConfig,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  LivenessProbeKind,
  PeerCorrelationKind,
  PeerIncludeSource,
  ResolvedRunPlan,
  RunPlanTransport,
  SdkMessage,
} from "@agentorch/shared";
import type { ConversationSearchArgs } from "../../conversation-search.js";
import type { ArtifactReadArgs, ArtifactSearchArgs } from "../../artifact-mcp.js";
import type { JobToolContext } from "../../jobs.js";
import type { ArtifactReadResult, ArtifactSearchResult } from "../../artifacts.js";
import type { ToolOutputSink } from "../tools/types.js";
import type { TransportErrorClass } from "../../capability/transport-errors.js";

import type { Provider } from "../../db.js";

/** Phase 4: what a runtime can OBSERVE about its own run.
 *
 *  This is deliberately a reporting surface, not a decision one. A runtime says
 *  "I spawned pid 4711", "it exited with code 1", "my stream closed" — facts,
 *  each of which the LivenessController records against the run. It is the
 *  controller, and only the controller, that decides whether a fact is evidence
 *  of death. A runtime that calls nothing here is not broken: it means the route
 *  exposes no process or stream handle, so its probe answers `unknown`, and
 *  `unknown` never ends a run.
 *
 *  Why the runtimes and not SessionManager: SessionManager sees the events a
 *  runtime chose to emit, and the whole failure this replaces was that "no
 *  events" was read as "dead". The process handle only exists inside the
 *  runtime, so the observation has to originate there. */
export interface RuntimeLivenessReporter {
  /** A child process now exists for this run. */
  childProcessStarted: (info: { pid: number | null }) => void;
  /** The child process is gone. Recorded as an OBSERVATION; whether it is
   *  evidence is the controller's call (an exit we asked for is not). */
  childProcessExited: (info: {
    pid: number | null;
    exitCode: number | null;
    signal: string | null;
  }) => void;
  /** The runtime's event stream ended. `abnormal` means it closed WITHOUT the
   *  terminal result the turn was waiting for. */
  streamClosed: (abnormal: boolean) => void;
  /** The model produced its terminal result for this turn: the run finished its
   *  work, so a later child exit is expected rather than evidence. */
  resultSeen: () => void;
  /** Progress that is not a model token — a tool call, a background task's
   *  `task_progress`, a long build reporting in. Proof of life on its own. */
  toolProgress: () => void;
  /** Registers the ONE question this runtime can answer about its own run:
   *  "is the child process still alive?"
   *
   *  Called by the runtime at spawn time, from inside the run — the handle only
   *  exists there. The controller calls the registered function later, during a
   *  health check, which is why this is a registration rather than a return
   *  value: the answer does not exist yet when the runtime starts.
   *
   *  The registered function MUST answer `unknown` rather than guess: a probe
   *  that cannot tell has no answer, and the controller reads `unknown` as
   *  "carry on, warned". A runtime that never registers one is the same as one
   *  that always answers `unknown` — a supported state, not a gap. */
  registerProbe?: (probe: () => LivenessProbeKind | Promise<LivenessProbeKind>) => void;
}

export interface RuntimeOptions {
  /** Stable agent identifier — used for logging only. */
  sessionId: string;
  /** User input for this turn. */
  prompt: string;
  /** Effective model id. */
  model: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Tools the model is allowed to request. */
  tools: string[];
  /** Tools auto-approved (skip canUseTool). */
  allowedTools: string[];
  /** Permission mode. */
  permissionMode: PermissionMode;
  /** Per-tool gate. SessionManager wires the actual UI flow. Signature matches
   *  the Claude SDK's `CanUseTool` so ClaudeAgentRuntime can pass it straight
   *  through; OpenAI runtime translates its interrupt-resume to the same shape. */
  canUseTool: CanUseTool;
  /** Cancellation. SDK / native fetch listen on .signal. */
  abortController: AbortController;
  /** MCP servers — keyed by name. SessionManager constructs peer-mcp /
   *  ask-user-mcp here with fromAgentId closures bound to sessionId.
   *  The runtime must NOT alter the keys or rebuild these — the closure
   *  binding is the only thing keeping fromAgentId from cross-talking. */
  mcpServers: Record<string, McpServerConfig>;
  /** Per-call env overrides — runtime forwards to the underlying CLI / SDK. */
  env: Record<string, string>;
  /** Optional resume token. Claude SDK uses for ~/.claude session resume.
   *  OpenAI runtime ignores (it self-maintains history via `history`). */
  resume?: string;
  /** Native claude binary path. ClaudeAgentRuntime needs this in SEA mode
   *  where `import.meta.url` is undefined and the SDK's default cli.js
   *  derivation fails. OpenAI runtime ignores. */
  claudeCliPath?: string | null;
  /** Native codex binary path. CodexCliRuntime needs a real executable in
   *  packaged mode because npm shims are not spawnable with shell:false. */
  codexCliPath?: string | null;
  // There is deliberately NO `cwd` field. The turn's working directory is
  // `runPlan.execution.projectRoot.value`, read by the runtime from the same
  // snapshot `/status` reports and the tools resolve against. A second channel
  // would let a runtime run in a directory the rest of the turn does not know
  // about — which is exactly what happened while `cwd` was pinned to the home
  // directory or the data dir for kinds that had no workspace.
  /** Stderr forwarder + stale-resume detector hook. ClaudeAgentRuntime calls
   *  per stderr line; OpenAI runtime never. */
  onStderr?: (line: string) => void;
  /** The provider record. Runtimes branch on `kind` for provider-specific
   *  behavior; OpenAI runtime needs baseUrl + apiKey to construct its client. */
  provider: Provider;
  /** The turn's immutable capability snapshot, resolved ONCE before dispatch.
   *
   *  REQUIRED, so a call site cannot even compile a turn that has no plan: every
   *  caller resolves one and threads it through. A runtime that re-derives a
   *  capability (the transport, above all) has reinstated the bug the plan
   *  removes — `/status` would describe one route while the SDK called another.
   *  The native CLI runtimes ignore it (they are spoken to by launching them);
   *  the HTTP runtime refuses to guess without it, and keeps that refusal at
   *  runtime because a JS caller can bypass the type. */
  runPlan: ResolvedRunPlan;
  /** Mints the id this turn's messages report. Injected only so the "one id per
   *  turn" contract can be pinned without a network round trip; production uses
   *  a UUID. The runtime never mints a second id per attempt. */
  newSessionId?: () => string;
  /** Reports an automatic transport switch as it happens. The plan says whether
   *  a switch is permitted; this says one occurred, so `/status` can show the
   *  user a route change they did not ask for. */
  onTransportFallback?: (info: TransportFallbackInfo) => void;
  /** Persisted prior messages — feed for runtimes that maintain conversation
   *  state outside the SDK (OpenAI). Claude side ignores; the CLI's
   *  ~/.claude session file holds Claude's history. */
  history: SdkMessage[];
  /** Opaque agent metadata blob (Agent.metadata) — runtimes that care about
   *  per-agent settings (e.g. CodexCliRuntime reading sandboxMode override)
   *  read from here. Most runtimes ignore. */
  agentMetadata?: unknown;
  /** Reasoning is NOT a runtime option. The runtime reads the level off
   *  `runPlan.execution.reasoningEffort` — the same field `/status` reports and
   *  the same value the SDK is handed, so there is no second channel that could
   *  disagree with the plan. */
  /** Forward partial assistant token deltas. Default true. */
  includePartialMessages?: boolean;

  /** Phase 4: how this runtime reports what it can see about its own run (see
   *  `RuntimeLivenessReporter`). Optional so a runtime that observes nothing —
   *  and a test that does not care — does not have to fake it; the absence is
   *  read as "no probe capability", which the policy already models. */
  liveness?: RuntimeLivenessReporter;

  /** Where a tool whose result does not fit the turn's tool-result budget puts
   *  the COMPLETE bytes (see `ToolOutputSink`).
   *
   *  It arrives here because this is the last hop that still knows the run: the
   *  session layer owns the run plan (the budget), the artifact store and the
   *  agent / run / turn the result belongs to, and the runtime passes it
   *  straight through to the tool adapter. A runtime that hands it to no tool
   *  is not broken — its tools then refuse an oversized result structurally
   *  instead of storing it, which is the same answer as a caller with no
   *  session. */
  toolOutput?: ToolOutputSink;

  /** Session-aware callbacks for the OpenAI runtime to register as
   *  NormalizedTools (per docs/plans/openai-mcp-integration.md). Claude side
   *  ignores — peer_send / ask_user already arrive via mcpServers map, and
   *  Task is handled inside the claude CLI's scheme A.
   *
   *  Arg-object signatures match the Slice 1.7 makePeerSendHandler /
   *  makeAskUserHandler factories, which SessionManager re-uses verbatim. */
  peerSend?: (args: {
    target: string;
    message: string;
    mode?: "continue" | "review" | "fork" | "raw";
    includeSource?: PeerIncludeSource;
    interrupt?: boolean;
    interruptReason?: string;
    messageId?: string;
    correlationId?: string;
    correlationKind?: PeerCorrelationKind;
    replyToCorrelationId?: string;
    causalRunId?: string;
  }) => Promise<string>;
  peerQuery?: (args: { target: string; limit?: number }) => Promise<string>;
  conversationSearch?: (args: ConversationSearchArgs) => Promise<string>;
  askUser?: (args: { question: string; options: string[] }) => Promise<string>;
  spawnTask?: (args: { description: string; prompt: string; background?: boolean; projectRoot?: string | null }) => Promise<{ finalText: string; subagentId: string; background?: boolean }>;
  ensembleHelp?: (args: { topic?: string }) => Promise<string>;
  skillList?: () => Promise<string>;
  /** A string is returned verbatim; any other object is JSON-serialized by the
   *  tool adapter. `object` rather than `Record<string, unknown>` so the
   *  structured skill read failure ({ok:false, code, message, available}) can be
   *  handed back as itself — formatting it into a sentence is how a failure
   *  starts to look like a successful skill body. */
  skillInvoke?: (args: { name: string }) => Promise<string | object>;
  /** Reading a stored result artifact. Synchronous — it is a SQLite read with
   *  the hash verification done in-process, so there is nothing to await. */
  artifactRead?: (args: ArtifactReadArgs) => ArtifactReadResult;
  artifactSearch?: (args: ArtifactSearchArgs) => ArtifactSearchResult;
  /** The job primitive's binding for THIS turn (which agent, which project
   *  root, which process-wide manager). One object rather than four callbacks
   *  on purpose: the four job tools must agree about the default cwd and the
   *  owning agent, and four independent fields is how they would drift apart.
   *  The Claude runtime reaches the same operations through the
   *  `agentorch-jobs` MCP server instead. */
  jobs?: JobToolContext;
}

export type RuntimeErrorCode =
  | "RESUME_TURN_INTERRUPTED"
  | "CODEX_EVENT_STREAM_LAGGED"
  | "CODEX_THREAD_WRITER_CONFLICT"
  // Provider-request failures, one code per classification. A failed model call
  // used to reach the persisted turn as a bare QUERY_FAILED, which threw away
  // the one thing a user needs to act on it ("the endpoint has no /responses"
  // is a different problem from "your key was rejected"). None of these are
  // recoverable flags — recovery stays with the RESUME_TURN_INTERRUPTED /
  // CODEX_* signals above.
  | "TRANSPORT_UNSUPPORTED"
  // The plan carries a reasoning level this runtime cannot express. Kept
  // separate from TRANSPORT_UNSUPPORTED because the fix is different (pick
  // another level, versus move to another route) and because the alternative —
  // dropping the setting and sending the request anyway — is exactly the silent
  // clear the plan forbids.
  | "REASONING_EFFORT_UNSUPPORTED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_NETWORK_FAILED"
  | "PROVIDER_SERVER_ERROR"
  | "PROVIDER_REQUEST_REJECTED"
  | "PROVIDER_REQUEST_FAILED"
  // The plan resolved no working directory for this turn: the agent is bound to
  // a project root that is no longer usable, or to nothing at all and its
  // scratch dir could not be created. The turn is REFUSED rather than run in
  // whatever directory the process happens to be in.
  | "PROJECT_ROOT_NOT_FOUND"
  | "SCRATCH_UNWRITABLE";

/** One automatic transport switch, as reported by the runtime that made it. */
export interface TransportFallbackInfo {
  from: RunPlanTransport;
  to: RunPlanTransport;
  /** Why the switch was permitted at all (from the plan). */
  policyReason: string;
  /** What the failing attempt actually said — the structured reason, never a
   *  paraphrase of the message. */
  httpStatus: number | null;
  upstreamCode: string | null;
  upstreamType: string | null;
  classification: TransportErrorClass;
  at: string;
}

/** Structured detail for `REASONING_EFFORT_UNSUPPORTED`. Carried as data rather
 *  than prose because the caller has to render it: which level the plan asked
 *  for, on which model, which levels that runtime CAN express, and where that
 *  list came from. An empty `supportedLevels` is an honest answer ("this runtime
 *  has no ladder at all"), not a missing one. */
export interface ReasoningUnsupportedDetail {
  requested: string;
  runtime: string;
  model: string;
  supportedLevels: string[];
  source: string;
}

export interface RuntimeErrorEvent {
  type: "error";
  message: string;
  code?: RuntimeErrorCode;
  recoverable?: boolean;
  resumeScoped?: boolean;
  /** Structured classification of a failed provider request. Kept on the error
   *  object so a caller cannot degrade "the endpoint has no /responses" into a
   *  bare string and lose the status/code that decided it. */
  classification?: TransportErrorClass;
  httpStatus?: number | null;
  upstreamCode?: string | null;
  upstreamType?: string | null;
  transport?: RunPlanTransport;
  /** Present on REASONING_EFFORT_UNSUPPORTED. */
  reasoning?: ReasoningUnsupportedDetail;
}

export type RuntimeEvent =
  | { type: "sdk_message"; payload: SdkMessage }
  | RuntimeErrorEvent;

export interface AgentRuntime {
  /** Yields RuntimeEvents for one turn of conversation. Caller iterates via
   *  for-await; abort by toggling opts.abortController.signal. */
  query(opts: RuntimeOptions): AsyncIterable<RuntimeEvent>;
}
