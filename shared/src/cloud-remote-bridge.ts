import type { CloudRealtimeClientMsg } from "./cloud-realtime";
import type { AgentStatus, ServerMsg } from "./protocol";

export const CODEX_EVENT_STREAM_RECOVERING = "CODEX_EVENT_STREAM_RECOVERING";

export interface CloudRemoteActiveRequest {
  workspaceId: string;
  agentId: string;
  hasForwardedRunActivity?: boolean;
  recovering?: boolean;
}

export interface CloudRemoteForwardResult {
  messages: CloudRealtimeClientMsg[];
  releaseRequest: boolean;
}

export function isRecoveringLocalError(code: string): boolean {
  return code === CODEX_EVENT_STREAM_RECOVERING;
}

export function shouldReleaseCloudRemoteRequest(status: AgentStatus): boolean {
  return status === "done" || status === "error" || status === "idle";
}

export function forwardLocalEventForCloudRemoteRequest(
  request: CloudRemoteActiveRequest,
  msg: ServerMsg,
): CloudRemoteForwardResult {
  if (msg.type === "message") {
    request.hasForwardedRunActivity = true;
    return {
      messages: [
        {
          type: "agent_message",
          workspaceId: request.workspaceId,
          agentId: msg.sessionId,
          seq: msg.seq,
          msg: msg.msg,
        },
      ],
      releaseRequest: false,
    };
  }

  if (msg.type === "status") {
    if (request.recovering && msg.status === "idle") {
      return { messages: [], releaseRequest: false };
    }
    const isRunActivity = msg.status !== "idle" && msg.status !== "done" && msg.status !== "error";
    if (isRunActivity) {
      request.hasForwardedRunActivity = true;
    }
    const isInitialIdleSnapshot = msg.status === "idle" && !request.hasForwardedRunActivity;
    return {
      messages: [
        {
          type: "agent_status",
          workspaceId: request.workspaceId,
          agentId: msg.sessionId,
          status: msg.status,
        },
      ],
      releaseRequest: !isInitialIdleSnapshot && shouldReleaseCloudRemoteRequest(msg.status),
    };
  }

  if (msg.type === "error" && msg.sessionId) {
    if (isRecoveringLocalError(msg.code)) {
      request.recovering = true;
      return { messages: [], releaseRequest: false };
    }
    return {
      messages: [
        {
          type: "remote_error",
          workspaceId: request.workspaceId,
          agentId: msg.sessionId,
          code: msg.code,
          message: msg.message,
        },
      ],
      releaseRequest: false,
    };
  }

  return { messages: [], releaseRequest: false };
}
