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

/** Claude Code/Codex reasoning effort. null = inherit from the runtime default. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  codexWorkspace: string | null;
  permissionMode: PermissionMode;
  /** Codex per-agent override. null = inherit from provider.defaultSandbox. */
  sandboxMode: SandboxMode | null;
  /** Claude Code/Codex per-agent reasoning effort override. null = inherit from runtime. */
  reasoningEffort: ReasoningEffort | null;
  /** W21: which team this agent belongs to (null = ungrouped). */
  teamId: string | null;
  /** Skills this agent has flipped to force-on (always inject regardless of score). */
  forcedSkills: string[];
  /** Skills this agent has explicitly disabled (never auto-activate). */
  disabledSkills: string[];
  closed: boolean;
  hasResumeInfo: boolean;
  createdAt: string;
}

// ---- permission ----

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: unknown; message?: string }
  | { behavior: "deny"; message?: string };

// ---- client → server ----

export type PeerMode = "continue" | "review" | "fork" | "raw";
export type PeerIncludeSource = boolean | "auto";

export type ClientMsg =
  | {
      type: "create_agent";
      name: string;
      systemPrompt?: string;
      model?: string;
      parentId?: string;
      providerId?: string;
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
      reason: "clear" | "compact";
      /** When reason="compact", the summary text inserted as a system notice. */
      summary?: string;
    }
  | { type: "team_created"; team: TeamSummary }
  | { type: "team_updated"; team: TeamSummary }
  | { type: "team_deleted"; teamId: string }
  | { type: "status"; sessionId: string; status: AgentStatus }
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
