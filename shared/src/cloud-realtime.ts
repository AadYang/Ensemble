import type { AgentStatus, AgentSummary, PermissionMode, ReasoningEffort, SandboxMode, SdkMessage } from "./protocol";

export type CloudRealtimeRole = "desktop" | "web";

export interface CloudAgentConfigPatch {
  name?: string;
  systemPrompt?: string | null;
  model?: string;
  providerId?: string | null;
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode | null;
  reasoningEffort?: ReasoningEffort | null;
  codexWorkspace?: string | null;
  teamId?: string | null;
  closed?: boolean;
}

export type CloudRealtimeServerMsg =
  | { type: "hello"; role: CloudRealtimeRole; desktopOnline: boolean; serverTime: string }
  | { type: "online_status"; desktopOnline: boolean }
  | { type: "remote_send"; requestId: string; workspaceId: string; agentId: string; text: string }
  | { type: "config_request"; requestId: string; workspaceId: string; agentId: string; patch: CloudAgentConfigPatch }
  | { type: "remote_ack"; requestId: string; workspaceId: string; agentId: string }
  | { type: "remote_error"; requestId?: string; code: string; message: string; workspaceId?: string; agentId?: string }
  | { type: "sync_result"; workspaceId: string; revision: number; messageCursors: Array<{ agentId: string; maxSeq: number }> }
  | { type: "config_updated"; requestId: string; workspaceId: string; agentId: string; agent: AgentSummary; revision: number }
  | { type: "agent_status"; workspaceId: string; agentId: string; status: AgentStatus }
  | { type: "agent_message"; workspaceId: string; agentId: string; seq: number; msg: SdkMessage };

export type CloudRealtimeClientMsg =
  | { type: "ping" }
  | { type: "remote_send"; requestId: string; workspaceId: string; agentId: string; text: string }
  | { type: "config_request"; requestId: string; workspaceId: string; agentId: string; patch: CloudAgentConfigPatch }
  | { type: "config_ack"; requestId: string; workspaceId: string; agentId: string; agent: AgentSummary }
  | { type: "remote_ack"; requestId: string; workspaceId: string; agentId: string }
  | { type: "remote_error"; requestId?: string; code: string; message: string; workspaceId?: string; agentId?: string }
  | { type: "agent_status"; workspaceId: string; agentId: string; status: AgentStatus }
  | { type: "agent_message"; workspaceId: string; agentId: string; seq: number; msg: SdkMessage };
