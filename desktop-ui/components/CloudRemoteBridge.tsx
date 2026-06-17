"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  forwardLocalEventForCloudRemoteRequest,
  type AgentSummary,
  type CloudAgentConfigPatch,
  type ServerMsg,
} from "@agentorch/shared";
import { closeAgent, patchAgent, restartAgent } from "@/lib/agent-api";
import { CloudRealtimeClient } from "@/lib/cloud-realtime";
import { cloudConfigSignature, type CloudAgent, type CloudSnapshot } from "@/lib/cloud-api";
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
      if (msg.type === "config_request") {
        void (async () => {
          const state = useStore.getState();
          if (!cloudAgentLoaded(state, msg.workspaceId, msg.agentId)) {
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
          try {
            const updated = await applyRemoteConfig(msg.agentId, msg.patch);
            applyCloudAgentSummary(msg.workspaceId, updated);
            client.send({
              type: "config_ack",
              requestId: msg.requestId,
              workspaceId: msg.workspaceId,
              agentId: msg.agentId,
              agent: updated,
            });
          } catch (err) {
            client.send({
              type: "remote_error",
              requestId: msg.requestId,
              workspaceId: msg.workspaceId,
              agentId: msg.agentId,
              code: "CONFIG_APPLY_FAILED",
              message: err instanceof Error ? err.message : "Remote settings change failed.",
            });
          }
        })();
        return;
      }
      if (msg.type !== "remote_send") return;
      void (async () => {
        const state = useStore.getState();
        if (!cloudAgentLoaded(state, msg.workspaceId, msg.agentId)) {
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
      const sessionId = "sessionId" in msg ? msg.sessionId : undefined;
      if (!sessionId) return;
      const request = activeRequestsRef.current.get(sessionId);
      if (!request) return;
      const result = forwardLocalEventForCloudRemoteRequest(request, msg);
      for (const outbound of result.messages) client.send(outbound);
      if (result.releaseRequest) activeRequestsRef.current.delete(sessionId);
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

type StoreState = ReturnType<typeof useStore.getState>;

function cloudAgentLoaded(state: StoreState, workspaceId: string, agentId: string): boolean {
  return !!(
    state.cloudCurrentWorkspaceId &&
    state.cloudCurrentWorkspaceId === workspaceId &&
    state.cloudSnapshot?.agents.some((agent) => agent.id === agentId)
  );
}

async function applyRemoteConfig(agentId: string, patch: CloudAgentConfigPatch): Promise<AgentSummary> {
  const { closed, agentPatch } = splitRemoteConfigPatch(patch);
  let updated: AgentSummary | null = null;
  if (Object.keys(agentPatch).length > 0) updated = await patchAgent(agentId, agentPatch);
  if (closed === true) updated = await closeAgent(agentId);
  if (closed === false) updated = await restartAgent(agentId);
  if (!updated) {
    const current = useStore.getState().agents[agentId]?.summary;
    if (!current) throw new Error("The corresponding local agent is not available on this desktop.");
    updated = current;
  }
  return updated;
}

function splitRemoteConfigPatch(patch: CloudAgentConfigPatch): {
  closed: boolean | undefined;
  agentPatch: CloudAgentConfigPatch;
} {
  const { closed, ...agentPatch } = patch;
  return { closed, agentPatch };
}

function applyCloudAgentSummary(workspaceId: string, summary: AgentSummary): void {
  const state = useStore.getState();
  const snapshot = state.cloudSnapshot;
  if (!snapshot || state.cloudCurrentWorkspaceId !== workspaceId) return;
  const next = replaceCloudAgent(snapshot, summary);
  state.setCloudSnapshot(next);
  state.setCloudConfigSignature(workspaceId, cloudConfigSignature(next));
}

function replaceCloudAgent(snapshot: CloudSnapshot, summary: AgentSummary): CloudSnapshot {
  return {
    ...snapshot,
    agents: snapshot.agents.map((agent) => (agent.id === summary.id ? cloudAgentFromSummary(agent, summary) : agent)),
  };
}

function cloudAgentFromSummary(existing: CloudAgent, summary: AgentSummary): CloudAgent {
  return {
    ...existing,
    parentId: summary.parentId,
    teamId: summary.teamId,
    name: summary.name,
    systemPrompt: summary.systemPrompt,
    model: summary.model,
    providerId: summary.providerId,
    permissionMode: summary.permissionMode,
    sandboxMode: summary.sandboxMode,
    reasoningEffort: summary.reasoningEffort,
    codexWorkspace: summary.codexWorkspace,
    metadata: {
      ...existing.metadata,
      forcedSkills: summary.forcedSkills,
      disabledSkills: summary.disabledSkills,
      closed: summary.closed,
    },
  };
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
