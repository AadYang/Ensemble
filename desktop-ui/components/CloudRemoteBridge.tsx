"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ServerMsg } from "@agentorch/shared";
import { CloudRealtimeClient } from "@/lib/cloud-realtime";
import { getWS } from "@/lib/ws";
import { useStore } from "@/store/agents";

interface RemoteRequest {
  workspaceId: string;
  agentId: string;
}

export function CloudRemoteBridge() {
  const cloudSession = useStore((s) => s.cloudSession);
  const cloudCurrentWorkspaceId = useStore((s) => s.cloudCurrentWorkspaceId);
  const cloudSnapshot = useStore((s) => s.cloudSnapshot);
  const localAgents = useStore((s) => s.agents);
  const localWs = getWS();

  const cloudAgentIds = useMemo(
    () => new Set((cloudSnapshot?.agents ?? []).map((agent) => agent.id)),
    [cloudSnapshot],
  );
  const activeRequestsRef = useRef(new Map<string, RemoteRequest>());

  useEffect(() => {
    if (!cloudSession) return;
    const client = new CloudRealtimeClient(cloudSession, "desktop");
    const unsubscribeCloud = client.subscribe((msg) => {
      if (msg.type !== "remote_send") return;
      void (async () => {
        const state = useStore.getState();
        const workspaceId = state.cloudCurrentWorkspaceId;
        const snapshot = state.cloudSnapshot;
        if (!workspaceId || workspaceId !== msg.workspaceId || !snapshot?.agents.some((agent) => agent.id === msg.agentId)) {
          client.send({
            type: "remote_error",
            requestId: msg.requestId,
            workspaceId: msg.workspaceId,
            agentId: msg.agentId,
            code: "AGENT_NOT_AVAILABLE",
            message: "This desktop does not have the requested cloud workspace agent loaded.",
          });
          return;
        }
        if (!state.agents[msg.agentId]) {
          client.send({
            type: "remote_error",
            requestId: msg.requestId,
            workspaceId: msg.workspaceId,
            agentId: msg.agentId,
            code: "LOCAL_AGENT_NOT_FOUND",
            message: "The corresponding local agent is not available on this desktop.",
          });
          return;
        }
        if (!(await ensureLocalWsOpen(localWs))) {
          client.send({
            type: "remote_error",
            requestId: msg.requestId,
            workspaceId: msg.workspaceId,
            agentId: msg.agentId,
            code: "LOCAL_EXECUTOR_OFFLINE",
            message: "The desktop execution channel is not connected.",
          });
          return;
        }
        activeRequestsRef.current.set(msg.agentId, { workspaceId: msg.workspaceId, agentId: msg.agentId });
        localWs.send({ type: "subscribe", sessionId: msg.agentId });
        localWs.send({ type: "send_message", sessionId: msg.agentId, text: msg.text });
        client.send({ type: "remote_ack", requestId: msg.requestId, workspaceId: msg.workspaceId, agentId: msg.agentId });
      })();
    });
    const unsubscribeCloudState = client.subscribe((msg) => {
      if (msg.type !== "sync_result") return;
      const state = useStore.getState();
      state.setCloudRevision(msg.workspaceId, msg.revision);
      const cursors: Record<string, number> = {};
      for (const cursor of msg.messageCursors) cursors[cursor.agentId] = cursor.maxSeq;
      state.setCloudMessageCursors(msg.workspaceId, cursors);
    });

    const unsubscribeLocal = localWs.subscribe((msg: ServerMsg) => {
      if (msg.type === "message") {
        const request = activeRequestsRef.current.get(msg.sessionId);
        if (!request) return;
        client.send({
          type: "agent_message",
          workspaceId: request.workspaceId,
          agentId: msg.sessionId,
          seq: msg.seq,
          msg: msg.msg,
        });
        return;
      }
      if (msg.type === "status") {
        const request = activeRequestsRef.current.get(msg.sessionId);
        if (!request) return;
        client.send({
          type: "agent_status",
          workspaceId: request.workspaceId,
          agentId: msg.sessionId,
          status: msg.status,
        });
        if (msg.status === "done" || msg.status === "error" || msg.status === "idle") {
          activeRequestsRef.current.delete(msg.sessionId);
        }
        return;
      }
      if (msg.type === "error" && msg.sessionId) {
        const request = activeRequestsRef.current.get(msg.sessionId);
        if (!request) return;
        client.send({
          type: "remote_error",
          workspaceId: request.workspaceId,
          agentId: msg.sessionId,
          code: msg.code,
          message: msg.message,
        });
      }
    });

    client.connect();
    return () => {
      unsubscribeCloud();
      unsubscribeCloudState();
      unsubscribeLocal();
      client.close();
    };
  }, [cloudSession, localWs]);

  useEffect(() => {
    if (!cloudCurrentWorkspaceId) return;
    for (const agentId of cloudAgentIds) {
      if (localAgents[agentId]) localWs.send({ type: "subscribe", sessionId: agentId });
    }
  }, [cloudAgentIds, cloudCurrentWorkspaceId, localAgents, localWs]);

  return null;
}

async function ensureLocalWsOpen(localWs: ReturnType<typeof getWS>, timeoutMs = 3000): Promise<boolean> {
  if (localWs.isOpen()) return true;
  localWs.connect();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    if (localWs.isOpen()) return true;
  }
  return false;
}
