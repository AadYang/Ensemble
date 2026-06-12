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
import type { ReasoningEffort, SdkMessage } from "@agentorch/shared";

import type { Provider } from "../../db.js";

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
  /** Pinned cwd for ClaudeAgentRuntime CLI session storage. */
  cwd: string;
  /** Stderr forwarder + stale-resume detector hook. ClaudeAgentRuntime calls
   *  per stderr line; OpenAI runtime never. */
  onStderr?: (line: string) => void;
  /** The provider record. Runtimes branch on `kind` for provider-specific
   *  behavior; OpenAI runtime needs baseUrl + apiKey to construct its client. */
  provider: Provider;
  /** Persisted prior messages — feed for runtimes that maintain conversation
   *  state outside the SDK (OpenAI). Claude side ignores; the CLI's
   *  ~/.claude session file holds Claude's history. */
  history: SdkMessage[];
  /** Opaque agent metadata blob (Agent.metadata) — runtimes that care about
   *  per-agent settings (e.g. CodexCliRuntime reading sandboxMode override)
   *  read from here. Most runtimes ignore. */
  agentMetadata?: unknown;
  /** Per-agent reasoning/thinking override. Claude Code maps this to a
   *  thinking-token budget; Codex forwards the effort enum directly. */
  reasoningEffort?: ReasoningEffort | null;
  /** Forward partial assistant token deltas. Default true. */
  includePartialMessages?: boolean;

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
  }) => Promise<string>;
  peerQuery?: (args: { target: string; limit?: number }) => Promise<string>;
  askUser?: (args: { question: string; options: string[] }) => Promise<string>;
  spawnTask?: (args: { description: string; prompt: string }) => Promise<{ finalText: string; subagentId: string }>;
  ensembleHelp?: (args: { topic?: string }) => Promise<string>;
  skillList?: () => Promise<string>;
  skillInvoke?: (args: { name: string }) => Promise<string>;
}

export type RuntimeErrorCode = "RESUME_TURN_INTERRUPTED" | "CODEX_EVENT_STREAM_LAGGED";

export interface RuntimeErrorEvent {
  type: "error";
  message: string;
  code?: RuntimeErrorCode;
  recoverable?: boolean;
  resumeScoped?: boolean;
}

export type RuntimeEvent =
  | { type: "sdk_message"; payload: SdkMessage }
  | RuntimeErrorEvent;

export interface AgentRuntime {
  /** Yields RuntimeEvents for one turn of conversation. Caller iterates via
   *  for-await; abort by toggling opts.abortController.signal. */
  query(opts: RuntimeOptions): AsyncIterable<RuntimeEvent>;
}
