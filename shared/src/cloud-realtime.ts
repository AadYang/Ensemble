import type { AgentStatus, SdkMessage } from "./protocol";

export type CloudRealtimeRole = "desktop" | "web";

export type CloudRealtimeServerMsg =
  | { type: "hello"; role: CloudRealtimeRole; desktopOnline: boolean; serverTime: string }
  | { type: "online_status"; desktopOnline: boolean }
  | { type: "remote_send"; requestId: string; workspaceId: string; agentId: string; text: string }
  | { type: "remote_ack"; requestId: string; workspaceId: string; agentId: string }
  | { type: "remote_error"; requestId?: string; code: string; message: string; workspaceId?: string; agentId?: string }
  | { type: "sync_result"; workspaceId: string; revision: number; messageCursors: Array<{ agentId: string; maxSeq: number }> }
  | { type: "agent_status"; workspaceId: string; agentId: string; status: AgentStatus }
  | { type: "agent_message"; workspaceId: string; agentId: string; seq: number; msg: SdkMessage };

export type CloudRealtimeClientMsg =
  | { type: "ping" }
  | { type: "remote_send"; requestId: string; workspaceId: string; agentId: string; text: string }
  | { type: "remote_ack"; requestId: string; workspaceId: string; agentId: string }
  | { type: "remote_error"; requestId?: string; code: string; message: string; workspaceId?: string; agentId?: string }
  | { type: "agent_status"; workspaceId: string; agentId: string; status: AgentStatus }
  | { type: "agent_message"; workspaceId: string; agentId: string; seq: number; msg: SdkMessage };
