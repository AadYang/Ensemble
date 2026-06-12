"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus, CloudRealtimeServerMsg, SdkMessage } from "@agentorch/shared";
import { CloudRealtimeClient } from "@/lib/cloud-realtime";
import { type CloudAgent, type CloudMessage, type CloudSnapshot } from "@/lib/cloud-api";
import { useStore } from "@/store/agents";

export function CloudWorkspaceView({
  activeAgentId,
  onPickAgent,
}: {
  activeAgentId: string | null;
  onPickAgent: (id: string | null) => void;
}) {
  const cloudSession = useStore((s) => s.cloudSession);
  const cloudCurrentWorkspaceId = useStore((s) => s.cloudCurrentWorkspaceId);
  const cloudSnapshot = useStore((s) => s.cloudSnapshot);
  const setCloudSnapshot = useStore((s) => s.setCloudSnapshot);
  const setCloudRevision = useStore((s) => s.setCloudRevision);
  const setCloudMessageCursors = useStore((s) => s.setCloudMessageCursors);
  const [desktopOnline, setDesktopOnline] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [busyAgents, setBusyAgents] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "idle"; text: string } | null>(null);
  const [input, setInput] = useState("");
  const clientRef = useRef<CloudRealtimeClient | null>(null);

  const activeAgent = useMemo(
    () => cloudSnapshot?.agents.find((agent) => agent.id === activeAgentId) ?? null,
    [activeAgentId, cloudSnapshot],
  );
  const messages = useMemo(
    () =>
      (cloudSnapshot?.messages ?? [])
        .filter((message) => message.agentId === activeAgentId)
        .sort((a, b) => a.seq - b.seq),
    [activeAgentId, cloudSnapshot],
  );

  useEffect(() => {
    if (!cloudSnapshot) {
      onPickAgent(null);
      return;
    }
    if (!activeAgentId || !cloudSnapshot.agents.some((agent) => agent.id === activeAgentId)) {
      onPickAgent(cloudSnapshot.agents[0]?.id ?? null);
    }
  }, [activeAgentId, cloudSnapshot, onPickAgent]);

  useEffect(() => {
    if (!cloudSession) return;
    const client = new CloudRealtimeClient(cloudSession, "web");
    clientRef.current = client;
    const unsubscribe = client.subscribe((msg) => {
      handleRealtimeMessage(msg, {
        currentWorkspaceId: cloudCurrentWorkspaceId,
        setDesktopOnline,
        setStatuses,
        setBusyAgents,
        setNotice,
        setCloudSnapshot,
        setCloudRevision,
        setCloudMessageCursors,
      });
    });
    client.connect();
    return () => {
      unsubscribe();
      client.close();
      if (clientRef.current === client) clientRef.current = null;
      setDesktopOnline(false);
    };
  }, [cloudCurrentWorkspaceId, cloudSession, setCloudMessageCursors, setCloudRevision, setCloudSnapshot]);

  if (!cloudSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] text-xs">
        Sign in from the workspace add menu to open cloud workspaces.
      </div>
    );
  }

  if (!cloudSnapshot) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] text-xs">
        Select or create a cloud workspace.
      </div>
    );
  }

  const status = activeAgentId ? statuses[activeAgentId] ?? "idle" : "idle";
  const busy = !!(activeAgentId && busyAgents[remoteAgentKey(cloudCurrentWorkspaceId, activeAgentId)]);
  const canSend = !!(cloudCurrentWorkspaceId && activeAgent && desktopOnline && !busy && input.trim());

  const sendRemote = () => {
    if (!cloudCurrentWorkspaceId || !activeAgent || !input.trim()) return;
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setBusyAgents((prev) => ({ ...prev, [remoteAgentKey(cloudCurrentWorkspaceId, activeAgent.id)]: true }));
    setStatuses((prev) => ({ ...prev, [activeAgent.id]: "running" }));
    clientRef.current?.send({
      type: "remote_send",
      requestId,
      workspaceId: cloudCurrentWorkspaceId,
      agentId: activeAgent.id,
      text: input.trim(),
    });
    setInput("");
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[var(--bg-pane)]">
      <div className="shrink-0 flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-xs">
        <span className="text-[var(--accent)] tracking-wider">cloud</span>
        <span className="font-bold text-[var(--text)] truncate">{cloudSnapshot.workspace.name}</span>
        <span className="text-[var(--text-dim)]">rev {cloudSnapshot.workspace.revision}</span>
        <span className="flex-1" />
        <span className={`status-dot ${desktopOnline ? "done" : "error"}`} />
        <span className={desktopOnline ? "text-[var(--ok)]" : "text-[var(--err)]"}>
          {desktopOnline ? "desktop online" : "desktop offline"}
        </span>
        <span className="text-[var(--text-dim)]">/</span>
        <span className={statusColor(status)}>{busy ? "remote busy" : status}</span>
      </div>

      {notice && (
        <div className={`mx-3 mt-3 border px-2 py-1 text-xs ${
          notice.tone === "error"
            ? "border-[var(--err)] text-[var(--err)]"
            : notice.tone === "ok"
              ? "border-[var(--ok)] text-[var(--ok)]"
              : "border-[var(--border)] text-[var(--text-dim)]"
        }`}>
          {notice.text}
        </div>
      )}

      {activeAgent ? (
        <>
          <div className="shrink-0 border-b border-[var(--border)] px-3 py-2 text-xs flex items-center gap-2">
            <span className="font-bold text-[var(--text)] truncate">{activeAgent.name}</span>
            <span className="text-[var(--text-dim)] truncate">{activeAgent.model ?? "model unset"}</span>
            <span className="text-[var(--text-faint)] truncate">{activeAgent.codexWorkspace ?? ""}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2">
            {messages.length === 0 ? (
              <div className="border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--text-faint)]">
                No synced messages for this cloud agent yet.
              </div>
            ) : (
              messages.map((message) => <CloudMessageRow key={`${message.agentId}:${message.seq}`} message={message} />)
            )}
          </div>
          <div className="shrink-0 border-t border-[var(--border)] p-3 flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!activeAgent}
              placeholder={
                desktopOnline
                  ? "Send a remote message through the online desktop."
                  : "Desktop cloud bridge is offline."
              }
              className="min-h-20 flex-1 resize-none bg-[var(--bg)] border border-[var(--border)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)] disabled:opacity-50"
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendRemote();
              }}
            />
            <button
              onClick={sendRemote}
              disabled={!canSend}
              className="w-24 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors text-xs"
            >
              send
            </button>
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] text-xs">
          Select a cloud agent.
        </div>
      )}
    </div>
  );
}

interface RealtimeHandlers {
  currentWorkspaceId: string | null;
  setDesktopOnline: (online: boolean) => void;
  setStatuses: React.Dispatch<React.SetStateAction<Record<string, AgentStatus>>>;
  setBusyAgents: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setNotice: React.Dispatch<React.SetStateAction<{ tone: "ok" | "error" | "idle"; text: string } | null>>;
  setCloudSnapshot: (snapshot: CloudSnapshot | null) => void;
  setCloudRevision: (workspaceId: string, revision: number) => void;
  setCloudMessageCursors: (workspaceId: string, cursors: Record<string, number>) => void;
}

function handleRealtimeMessage(msg: CloudRealtimeServerMsg, handlers: RealtimeHandlers): void {
  if (msg.type === "hello" || msg.type === "online_status") {
    handlers.setDesktopOnline(!!msg.desktopOnline);
    return;
  }
  if (msg.type === "remote_ack") {
    handlers.setNotice({ tone: "ok", text: "Desktop accepted the remote message." });
    return;
  }
  if (msg.type === "remote_error") {
    if (msg.workspaceId && msg.agentId) {
      const key = remoteAgentKey(msg.workspaceId, msg.agentId);
      handlers.setBusyAgents((prev) => ({ ...prev, [key]: false }));
    }
    handlers.setNotice({ tone: "error", text: `${msg.code}: ${msg.message}` });
    return;
  }
  if (msg.type === "agent_status") {
    handlers.setStatuses((prev) => ({ ...prev, [msg.agentId]: msg.status }));
    if (msg.status === "done" || msg.status === "error" || msg.status === "idle") {
      const key = remoteAgentKey(msg.workspaceId, msg.agentId);
      handlers.setBusyAgents((prev) => ({ ...prev, [key]: false }));
    }
    return;
  }
  if (msg.type === "agent_message") {
    appendCloudMessage(msg, handlers);
    return;
  }
  if (msg.type === "sync_result") {
    handlers.setCloudRevision(msg.workspaceId, msg.revision);
    const cursors: Record<string, number> = {};
    for (const cursor of msg.messageCursors) cursors[cursor.agentId] = cursor.maxSeq;
    handlers.setCloudMessageCursors(msg.workspaceId, cursors);
  }
}

function appendCloudMessage(
  msg: Extract<CloudRealtimeServerMsg, { type: "agent_message" }>,
  handlers: RealtimeHandlers,
): void {
  if (msg.workspaceId !== handlers.currentWorkspaceId) return;
  const state = useStore.getState();
  const snapshot = state.cloudSnapshot;
  if (!snapshot || state.cloudCurrentWorkspaceId !== msg.workspaceId) return;
  const nextMessage: CloudMessage = {
    agentId: msg.agentId,
    seq: msg.seq,
    type: messageType(msg.msg),
    payload: msg.msg,
    createdAt: new Date().toISOString(),
  };
  const messages = snapshot.messages.slice();
  const index = messages.findIndex((message) => message.agentId === msg.agentId && message.seq === msg.seq);
  if (index >= 0) messages[index] = nextMessage;
  else messages.push(nextMessage);
  messages.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.seq - b.seq);
  handlers.setCloudSnapshot({ ...snapshot, messages });
}

function CloudMessageRow({ message }: { message: CloudMessage }) {
  const kind = message.type === "assistant" ? "assistant" : message.type === "user" ? "user" : message.type === "result" ? "result" : "system";
  return (
    <article className="border border-[var(--border)] bg-[var(--bg)]/70 p-3 text-xs">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
        {kind} / seq {message.seq}
      </div>
      <div className="whitespace-pre-wrap break-words text-[var(--text)]">{messageText(message.payload)}</div>
    </article>
  );
}

function messageType(msg: SdkMessage): string {
  return msg && typeof msg === "object" && "type" in msg && typeof msg.type === "string" ? msg.type : "system";
}

function messageText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  const value = payload as Record<string, unknown>;
  if (value.type === "user") {
    const content = (value.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join("\n");
  }
  if (value.type === "assistant") {
    const blocks = (value.message as { content?: unknown[] } | undefined)?.content ?? [];
    return blocks.map(blockText).filter(Boolean).join("\n");
  }
  if (value.type === "stream_event") {
    const delta = ((value.event as { delta?: unknown } | undefined)?.delta ?? {}) as { type?: string; text?: string };
    if (delta.type === "text_delta") return delta.text ?? "";
  }
  if (value.type === "result") return String(value.subtype ?? "result");
  if (value.subtype === "interrupted_turn") return "Interrupted turn context saved.";
  return JSON.stringify(payload, null, 2);
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const value = block as { type?: string; text?: string; name?: string };
  if (value.type === "text") return value.text ?? "";
  if (value.type === "tool_use") return `[tool: ${value.name ?? "tool"}]`;
  return "";
}

function remoteAgentKey(workspaceId: string | null, agentId: string | null): string {
  return `${workspaceId ?? ""}\u0000${agentId ?? ""}`;
}

function statusColor(status: AgentStatus): string {
  switch (status) {
    case "running": return "text-[var(--accent)]";
    case "done": return "text-[var(--ok)]";
    case "error": return "text-[var(--err)]";
    case "awaiting_permission": return "text-[var(--warn)]";
    default: return "text-[var(--text-dim)]";
  }
}
