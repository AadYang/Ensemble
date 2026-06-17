import { describe, expect, it } from "vitest";
import {
  CODEX_EVENT_STREAM_RECOVERING,
  forwardLocalEventForCloudRemoteRequest,
  type CloudRemoteActiveRequest,
} from "./cloud-remote-bridge";
import type { CloudRealtimeClientMsg, ServerMsg } from "./index";

describe("cloud remote bridge forwarding", () => {
  it("keeps active remote request through the initial subscribe idle snapshot", () => {
    const request: CloudRemoteActiveRequest = { workspaceId: "workspace-1", agentId: "agent-1" };
    const active = new Map([[request.agentId, request]]);
    const forwarded: CloudRealtimeClientMsg[] = [];

    const apply = (msg: ServerMsg) => {
      const sessionId = "sessionId" in msg ? msg.sessionId : undefined;
      if (!sessionId) return;
      const activeRequest = active.get(sessionId);
      if (!activeRequest) return;
      const result = forwardLocalEventForCloudRemoteRequest(activeRequest, msg);
      forwarded.push(...result.messages);
      if (result.releaseRequest) active.delete(sessionId);
    };

    apply({ type: "status", sessionId: request.agentId, status: "idle" });
    expect(active.has(request.agentId)).toBe(true);

    apply({ type: "status", sessionId: request.agentId, status: "running" });
    apply({
      type: "message",
      sessionId: request.agentId,
      seq: 3,
      msg: {
        type: "assistant",
        message: { content: [{ type: "text", text: "started" }] },
      },
    });
    apply({ type: "status", sessionId: request.agentId, status: "done" });

    expect(forwarded).toEqual([
      {
        type: "agent_status",
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        status: "idle",
      },
      {
        type: "agent_status",
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        status: "running",
      },
      {
        type: "agent_message",
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        seq: 3,
        msg: {
          type: "assistant",
          message: { content: [{ type: "text", text: "started" }] },
        },
      },
      {
        type: "agent_status",
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        status: "done",
      },
    ]);
    expect(active.has(request.agentId)).toBe(false);
  });

  it("keeps active remote request through Codex event-stream recovery and forwards continuation", () => {
    const request: CloudRemoteActiveRequest = { workspaceId: "workspace-1", agentId: "agent-1" };
    const active = new Map([[request.agentId, request]]);
    const forwarded: CloudRealtimeClientMsg[] = [];

    const apply = (msg: ServerMsg) => {
      const sessionId = "sessionId" in msg ? msg.sessionId : undefined;
      if (!sessionId) return;
      const activeRequest = active.get(sessionId);
      if (!activeRequest) return;
      const result = forwardLocalEventForCloudRemoteRequest(activeRequest, msg);
      forwarded.push(...result.messages);
      if (result.releaseRequest) active.delete(sessionId);
    };

    apply({
      type: "error",
      sessionId: request.agentId,
      code: CODEX_EVENT_STREAM_RECOVERING,
      message: "local event stream lagged; recovery is continuing",
    });
    apply({ type: "status", sessionId: request.agentId, status: "idle" });
    apply({
      type: "message",
      sessionId: request.agentId,
      seq: 7,
      msg: {
        type: "assistant",
        message: { content: [{ type: "text", text: "continued from recovered history" }] },
      },
    });
    apply({ type: "status", sessionId: request.agentId, status: "done" });

    expect(forwarded).toEqual([
      {
        type: "agent_message",
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        seq: 7,
        msg: {
          type: "assistant",
          message: { content: [{ type: "text", text: "continued from recovered history" }] },
        },
      },
      {
        type: "agent_status",
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        status: "done",
      },
    ]);
    expect(forwarded.some((msg) => msg.type === "remote_error")).toBe(false);
    expect(active.has(request.agentId)).toBe(false);
  });

  it("releases ordinary idle only after run activity and not during recovery", () => {
    const request: CloudRemoteActiveRequest = { workspaceId: "workspace-1", agentId: "agent-1" };

    expect(
      forwardLocalEventForCloudRemoteRequest(request, {
        type: "status",
        sessionId: request.agentId,
        status: "idle",
      }).releaseRequest,
    ).toBe(false);
    expect(
      forwardLocalEventForCloudRemoteRequest(request, {
        type: "status",
        sessionId: request.agentId,
        status: "running",
      }).releaseRequest,
    ).toBe(false);
    expect(
      forwardLocalEventForCloudRemoteRequest(request, {
        type: "status",
        sessionId: request.agentId,
        status: "idle",
      }).releaseRequest,
    ).toBe(true);

    const recoveringRequest: CloudRemoteActiveRequest = { workspaceId: "workspace-1", agentId: "agent-1" };
    expect(
      forwardLocalEventForCloudRemoteRequest(recoveringRequest, {
        type: "status",
        sessionId: recoveringRequest.agentId,
        status: "running",
      }).releaseRequest,
    ).toBe(false);
    recoveringRequest.recovering = true;
    expect(
      forwardLocalEventForCloudRemoteRequest(recoveringRequest, {
        type: "status",
        sessionId: recoveringRequest.agentId,
        status: "idle",
      }),
    ).toEqual({ messages: [], releaseRequest: false });
    expect(
      forwardLocalEventForCloudRemoteRequest(recoveringRequest, {
        type: "status",
        sessionId: recoveringRequest.agentId,
        status: "done",
      }).releaseRequest,
    ).toBe(true);
    expect(
      forwardLocalEventForCloudRemoteRequest(recoveringRequest, {
        type: "status",
        sessionId: recoveringRequest.agentId,
        status: "error",
      }).releaseRequest,
    ).toBe(true);
  });
});
