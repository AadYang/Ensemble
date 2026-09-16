/**
 * WebSocket protocol contract between web (client) and server.
 * W1 subset: only events actually exercised by the minimal chat path.
 * Extend this file (alongside agent-orchestrator-plan.md §4.2) when widening scope.
 */

export type AgentStatus =
  | "idle"
  | "running"
  | "awaiting_permission"
  | "awaiting_user_input"
  | "error"
  | "done";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

/** Codex sandbox modes (mirrors `@openai/codex-sdk` SandboxMode). */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

// `ReasoningEffort` is the OPEN token from reasoning.ts — not a union declared
// here. The value is a model capability, so membership is resolved per model by
// the capability registry, never by a literal list: see shared/src/reasoning.ts.
// null (or the literal "inherit") = send nothing, use the runtime default.
import type { ReasoningEffort } from "./reasoning";
// Phase 4 liveness: the state vocabulary and its wire projection are declared
// with the rest of the capability contract (AGENTS.md §2.3), so the core that
// builds the projection and the UI that receives it cannot drift apart.
import type { LivenessUpdate } from "./capability";
import type { RunPlanStatusView } from "./run-plan-view";

export interface TeamSummary {
  id: string;
  name: string;
  description: string | null;
  /** Member agent ids in creation order. Empty if all members deleted but
   *  the team row itself survived. */
  memberIds: string[];
  createdAt: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  parentId: string | null;
  status: AgentStatus;
  model: string;
  /** Role / persona prompt set at creation (or patched later). Null when the
   *  agent never had one. Exposed in the summary so the settings dialog can
   *  render it for editing without an extra fetch. */
  systemPrompt: string | null;
  providerId: string | null;
  /** The canonical project root every runtime, tool and status report uses.
   *  `null` = unbound: the agent has no project and works in its own scratch
   *  directory. */
  projectRoot: string | null;
  /** Legacy alias of `projectRoot`, still emitted so an older client has
   *  something to show. It is the SAME value (never the retired column), which
   *  is what makes it a compatibility echo rather than a second source. */
  codexWorkspace: string | null;
  permissionMode: PermissionMode;
  /** Codex per-agent override. null = inherit from provider.defaultSandbox. */
  sandboxMode: SandboxMode | null;
  /** Claude Code/Codex per-agent reasoning effort override. null = inherit from runtime. */
  reasoningEffort: ReasoningEffort | null;
  /** The user's wall-clock ceiling on ONE run, in milliseconds. `null` = no
   *  ceiling, which is the default and the only state in which a clock may never
   *  end a run. Stored on the agent; the same name and the same meaning on the
   *  cloud DTO, because a setting that is only synced under a different name is
   *  a setting the synced copy does not have. */
  maxRunDurationMs: number | null;
  /** W21: which team this agent belongs to (null = ungrouped). */
  teamId: string | null;
  /** How this agent was spawned by another agent, if at all. Lets the UI badge
   *  and group it distinctly from a user-created agent:
   *    - "background": detached background task (Task/spawn_subagent background=true)
   *    - "task":       blocking subagent delegation
   *    - null:         a normal user-created agent (or a team member) */
  subagentKind: "background" | "task" | null;
  /** Skills this agent has flipped to force-on (always inject regardless of score). */
  forcedSkills: string[];
  /** Skills this agent has explicitly disabled (never auto-activate). */
  disabledSkills: string[];
  closed: boolean;
  hasResumeInfo: boolean;
  createdAt: string;
}

/** How much a context-window figure can be trusted. Mirrors the resolution
 *  layers in `core/src/context-window.ts`; only `confirmed` may ever be
 *  declared to a runtime. `legacy` is a value migrated out of the pre-scope
 *  override file — the user's own number, never verified by us. */
export type ContextWindowConfidence =
  | "confirmed"
  | "family-analogy"
  | "unverified"
  | "legacy";

/** Live per-agent context usage for the ChatPane header indicator.
 *  `usedTokens` is the total tokens currently occupying the model context
 *  window (regular input + cache read/write + output); `contextWindow` is the
 *  RUNTIME's effective window for this session; `percent` is the rounded ratio
 *  (may exceed 100). */
export interface ContextUsage {
  usedTokens: number;
  /** The bar's denominator: the runtime's EFFECTIVE window for this session,
   *  never the model's advertised capacity.
   *
   *  ABSENT when we have a token count but no trustworthy live ceiling. That is
   *  a real state and must be rendered as "有效上限未知" — the advertised
   *  capacity is never substituted here, because an unenforced model limit is
   *  not available headroom. */
  contextWindow?: number;
  /** Absent exactly when `contextWindow` is. */
  percent?: number;
  /** The model's OFFICIAL CONTEXT WINDOW, shown BESIDE the bar ("Codex 可用
   *  828.4K · 模型官方上限 1.05M"). Display only — never a denominator. This is
   *  the vendor's context-window figure, NOT "max input tokens" (max input,
   *  total context and max output are three different published quantities). */
  advertisedContextWindow?: number;
  /** How well the advertised figure is established. Present whenever
   *  `advertisedContextWindow` is, so the UI can label an unverified or
   *  legacy-migrated number instead of presenting it as settled fact. */
  advertisedWindowConfidence?: ContextWindowConfidence;
  /** Where the advertised figure came from (doc URL, snapshot, or the legacy
   *  override file). Surfaced in the tooltip as the migration hint. */
  advertisedWindowSource?: string;
  /** Where `contextWindow` came from, so the UI can label it honestly. */
  windowOrigin?: "session-observed" | "runtime-profile";
  /** ISO date the runtime profile was measured (only for `runtime-profile`). */
  windowObservedAt?: string;
  /** True when the runtime clamped our requested value — the window shown is
   *  smaller than what the model/provider documents. */
  windowClamped?: boolean;
}

// ---- permission ----

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: unknown; message?: string }
  | { behavior: "deny"; message?: string };

// ---- client → server ----

export type PeerMode = "continue" | "review" | "fork" | "raw";
export type PeerIncludeSource = boolean | "auto";
export type PeerCorrelationKind = "decision" | "request";

export interface PeerCorrelationMetadata {
  messageId?: string;
  correlationId?: string;
  correlationKind?: PeerCorrelationKind;
  replyToCorrelationId?: string;
  causalRunId?: string;
}

export type ClientMsg =
  | {
      type: "create_agent";
      name: string;
      systemPrompt?: string;
      model?: string;
      parentId?: string;
      providerId?: string;
      projectRoot?: string;
      /** Legacy alias: when it is the only field sent it means `projectRoot`.
       *  Sending both with different values is refused, not merged. */
      codexWorkspace?: string;
      teamId?: string | null;
    }
  | { type: "send_message"; sessionId: string; text: string }
  | {
      type: "peer_send";
      fromSessionId: string;
      targetSessionId: string;
      text: string;
      mode: PeerMode;
      includeSource?: PeerIncludeSource;
      interrupt?: boolean;
      interruptReason?: string;
      messageId?: string;
      correlationId?: string;
      correlationKind?: PeerCorrelationKind;
      replyToCorrelationId?: string;
      causalRunId?: string;
    }
  | { type: "cancel"; sessionId: string }
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "permission_response"; sessionId: string; reqId: string; decision: PermissionDecision }
  | { type: "user_answer"; sessionId: string; reqId: string; choice: string };

// ---- server → client ----

export type ServerMsg =
  | { type: "hello"; serverTime: string }
  | { type: "agent_created"; agent: AgentSummary }
  | { type: "agent_updated"; agent: AgentSummary }
  | { type: "agent_deleted"; sessionId: string }
  | {
      type: "agent_history_reset";
      sessionId: string;
      /** `restore` is the inverse of `compact`: archived originals were
       *  appended back onto the live history. The UI has to be able to tell it
       *  apart from a compaction, which REMOVES messages. */
      reason: "clear" | "compact" | "restore";
      /** When reason="compact", the summary text inserted as a system notice. */
      summary?: string;
    }
  | { type: "team_created"; team: TeamSummary }
  | { type: "team_updated"; team: TeamSummary }
  | { type: "team_deleted"; teamId: string }
  | { type: "status"; sessionId: string; status: AgentStatus }
  | { type: "context_usage"; sessionId: string; usage: ContextUsage | null }
  /** Phase 4: the run's liveness changed — suspected stall, health check, back
   *  to running, a waiting state, a terminal state. `liveness` is the server's
   *  own projection (`livenessUpdateOf`), not the raw signals, and the client
   *  must NOT recompute any of it: the clock that can see the run is the
   *  server's, and a client-side derivation is how a stale verdict appears. */
  | { type: "liveness_update"; sessionId: string; liveness: LivenessUpdate }
  /** The plan a turn is about to run under, as the ONE view-model
   *  (`runPlanStatusView`). Sent when a turn resolves its plan, so the settings
   *  page and the context bar render the SAME snapshot the runtime was handed
   *  instead of resolving anything of their own. `plan.source` is always
   *  "last-turn" here: this is a turn's own plan, not a status read's guess. */
  | { type: "run_plan"; sessionId: string; plan: RunPlanStatusView }
  | { type: "message"; sessionId: string; seq: number; msg: SdkMessage }
  | { type: "permission_request"; sessionId: string; reqId: string; toolName: string; input: unknown }
  | {
      type: "user_question";
      sessionId: string;
      reqId: string;
      question: string;
      options: string[];
    }
  | { type: "error"; sessionId?: string; code: string; message: string };

/**
 * Mirror of the @anthropic-ai/claude-agent-sdk message envelope, narrowed to fields we care about.
 * SDK's exported types are not always re-exported in stable form, so we pin a structural view here.
 */
export type SdkMessage =
  | { type: "system"; subtype?: string; [k: string]: unknown }
  // Claude Code emits this as a TOP-LEVEL type (NOT a `system` subtype): one
  // heartbeat every 30s for a long-running tool call. Core broadcasts it
  // without persisting it (no context bloat) — see sessions/backgroundTasks.ts.
  | {
      type: "tool_progress";
      tool_use_id?: string;
      tool_name?: string;
      parent_tool_use_id?: string;
      elapsed_time_seconds?: number;
      heartbeat?: boolean;
      [k: string]: unknown;
    }
  | { type: "rate_limit_event"; [k: string]: unknown }
  | { type: "stream_event"; [k: string]: unknown }
  | {
      type: "assistant";
      message: {
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
          | { type: string; [k: string]: unknown }
        >;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    }
  | { type: "user"; message: unknown; [k: string]: unknown }
  | {
      type: "result";
      subtype: string;
      usage?: unknown;
      [k: string]: unknown;
    };
