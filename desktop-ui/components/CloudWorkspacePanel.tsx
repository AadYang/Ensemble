"use client";

import { useMemo, useState } from "react";
import type { AgentState } from "@/store/agents";
import { useStore } from "@/store/agents";
import {
  buildCloudSnapshotFromLocal,
  cloudConfigSignature,
  createCloudWorkspace,
  fetchCloudMe,
  fetchCloudSnapshot,
  listCloudWorkspaces,
  logoutCloud,
  syncCloudBatch,
  upsertCloudSnapshot,
} from "@/lib/cloud-api";
import { listMessages, type PersistedMessage } from "@/lib/agent-api";
import type { WorkspaceSummaryDTO } from "@/lib/layout-api";
import { getDialog } from "@/lib/dialog";

interface CloudWorkspacePanelProps {
  localWorkspaces: WorkspaceSummaryDTO[];
  currentLocalWorkspaceId: string | null;
}

export function CloudWorkspacePanel({
  localWorkspaces,
  currentLocalWorkspaceId,
}: CloudWorkspacePanelProps) {
  const cloudSession = useStore((s) => s.cloudSession);
  const cloudWorkspaces = useStore((s) => s.cloudWorkspaces);
  const cloudCurrentWorkspaceId = useStore((s) => s.cloudCurrentWorkspaceId);
  const cloudSnapshot = useStore((s) => s.cloudSnapshot);
  const setCloudSession = useStore((s) => s.setCloudSession);
  const setCloudAccount = useStore((s) => s.setCloudAccount);
  const setCloudWorkspaces = useStore((s) => s.setCloudWorkspaces);
  const setCloudCurrentWorkspace = useStore((s) => s.setCloudCurrentWorkspace);
  const setCloudSnapshot = useStore((s) => s.setCloudSnapshot);
  const cloudRevisions = useStore((s) => s.cloudRevisions);
  const cloudMessageCursors = useStore((s) => s.cloudMessageCursors);
  const cloudConfigSignatures = useStore((s) => s.cloudConfigSignatures);
  const setCloudRevision = useStore((s) => s.setCloudRevision);
  const setCloudMessageCursors = useStore((s) => s.setCloudMessageCursors);
  const setCloudConfigSignature = useStore((s) => s.setCloudConfigSignature);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const localWorkspaceName = useMemo(
    () => localWorkspaces.find((w) => w.id === currentLocalWorkspaceId)?.name ?? "local",
    [localWorkspaces, currentLocalWorkspaceId],
  );

  const refreshCloud = async (
    session = cloudSession,
    opts: { silent?: boolean } = {},
  ) => {
    if (!session) return;
    if (!opts.silent) {
      setBusy(true);
      setError(null);
    }
    try {
      const [account, workspaces] = await Promise.all([
        fetchCloudMe(session),
        listCloudWorkspaces(session),
      ]);
      setCloudAccount(account);
      setCloudWorkspaces(workspaces);
      const target =
        workspaces.find((w) => w.id === cloudCurrentWorkspaceId) ??
        workspaces[0] ??
        null;
      setCloudCurrentWorkspace(target?.id ?? null);
      if (target) {
        const snapshot = await fetchCloudSnapshot(session, target.id);
        setCloudSnapshot(snapshot);
        setCloudRevision(target.id, snapshot.workspace.revision);
        setCloudMessageCursors(target.id, cursorsFromSnapshot(snapshot));
        setCloudConfigSignature(target.id, cloudConfigSignature(snapshot));
      } else {
        setCloudSnapshot(null);
      }
      if (!opts.silent) setStatus("cloud workspace refreshed");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (!opts.silent) setBusy(false);
    }
  };

  const selectCloudWorkspace = async (id: string) => {
    if (!cloudSession) return;
    setBusy(true);
    setError(null);
    try {
      const snapshot = await fetchCloudSnapshot(cloudSession, id);
      setCloudCurrentWorkspace(id);
      setCloudSnapshot(snapshot);
      setCloudRevision(id, snapshot.workspace.revision);
      setCloudMessageCursors(id, cursorsFromSnapshot(snapshot));
      setCloudConfigSignature(id, cloudConfigSignature(snapshot));
      setStatus("cloud workspace loaded");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onCreateCloudWorkspace = async () => {
    if (!cloudSession) return;
    const name = await getDialog().prompt({
      title: "Cloud workspace name",
      defaultValue: `${localWorkspaceName} cloud`,
    });
    if (!name?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createCloudWorkspace(cloudSession, name.trim());
      const list = await listCloudWorkspaces(cloudSession);
      setCloudWorkspaces(list);
      setCloudCurrentWorkspace(created.id);
      const snapshot = await fetchCloudSnapshot(cloudSession, created.id);
      setCloudSnapshot(snapshot);
      setCloudRevision(created.id, snapshot.workspace.revision);
      setCloudMessageCursors(created.id, cursorsFromSnapshot(snapshot));
      setCloudConfigSignature(created.id, cloudConfigSignature(snapshot));
      setStatus("cloud workspace created");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onCopyLocalToCloud = async () => {
    if (!cloudSession || !cloudCurrentWorkspaceId) return;
    const ok = await getDialog().confirm({
      title: "Copy local workspace to cloud",
      message:
        "This uploads the current local agents, teams, and conversation history to the selected account workspace. Secrets and local resume/auth state are filtered before upload.",
      okLabel: "upload",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const snapshot = await buildLocalSnapshot(agents, teams);
      const uploaded = await upsertCloudSnapshot(cloudSession, cloudCurrentWorkspaceId, snapshot);
      setCloudSnapshot(uploaded.snapshot);
      setCloudRevision(cloudCurrentWorkspaceId, uploaded.snapshot.workspace.revision);
      setCloudMessageCursors(cloudCurrentWorkspaceId, cursorsFromList(uploaded.messageCursors));
      setCloudConfigSignature(cloudCurrentWorkspaceId, cloudConfigSignature(snapshot));
      const list = await listCloudWorkspaces(cloudSession);
      setCloudWorkspaces(list);
      setStatus(`uploaded ${snapshot.agents.length} agents and ${snapshot.messages.length} messages`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSyncChanges = async () => {
    if (!cloudSession || !cloudCurrentWorkspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const cursor = cloudMessageCursors[cloudCurrentWorkspaceId] ?? {};
      const batch = await buildIncrementalBatch(
        agents,
        teams,
        cursor,
        cloudConfigSignatures[cloudCurrentWorkspaceId] ?? null,
      );
      if (batch.messages.length === 0 && !batch.teams && !batch.agents) {
        setStatus("no new cloud changes to sync");
        return;
      }
      const expectedRevision = cloudRevisions[cloudCurrentWorkspaceId] ?? cloudSnapshot?.workspace.revision;
      const result = await syncCloudBatch(cloudSession, cloudCurrentWorkspaceId, {
        expectedRevision,
        ...batch,
      });
      setCloudRevision(cloudCurrentWorkspaceId, result.workspace.revision);
      setCloudMessageCursors(cloudCurrentWorkspaceId, cursorsFromList(result.messageCursors));
      if (batch.configSignature) setCloudConfigSignature(cloudCurrentWorkspaceId, batch.configSignature);
      const snapshot = await fetchCloudSnapshot(cloudSession, cloudCurrentWorkspaceId);
      setCloudSnapshot(snapshot);
      const list = await listCloudWorkspaces(cloudSession);
      setCloudWorkspaces(list);
      setStatus(`synced ${result.applied.messages} new messages`);
    } catch (err) {
      if ((err as Error).message.includes("revision_conflict")) {
        setError("cloud workspace changed elsewhere; refresh and retry");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const onLogout = async () => {
    if (!cloudSession) return;
    setBusy(true);
    setError(null);
    try {
      await logoutCloud(cloudSession);
      setCloudSession(null);
      setCloudWorkspaces([]);
      setCloudCurrentWorkspace(null);
      setCloudSnapshot(null);
      setStatus("signed out");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!cloudSession) {
    return (
      <section className="border-b border-[var(--border)] px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-faint)]">cloud</span>
          <span className="text-[var(--text-dim)] truncate">not signed in</span>
        </div>
        <div className="mt-1 text-[10px] text-[var(--text-faint)] leading-tight">
          Local workspaces stay private until manually copied.
        </div>
      </section>
    );
  }

  const selected = cloudWorkspaces.find((w) => w.id === cloudCurrentWorkspaceId) ?? null;
  return (
    <section className="border-b border-[var(--border)] px-3 py-2 text-xs flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[var(--text-faint)]">cloud</span>
        <span className="text-[var(--text)] truncate" title={cloudSession.account.email}>
          {cloudSession.account.displayName || cloudSession.account.email}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => void refreshCloud()}
          disabled={busy}
          className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)] disabled:opacity-30"
          title="Refresh cloud workspace list"
        >
          refresh
        </button>
      </div>

      <div className="flex items-center gap-1">
        <select
          className="min-w-0 flex-1 bg-[var(--bg-pane)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] text-[var(--text)]"
          value={cloudCurrentWorkspaceId ?? ""}
          onChange={(e) => {
            if (e.target.value) void selectCloudWorkspace(e.target.value);
          }}
          disabled={busy || cloudWorkspaces.length === 0}
        >
          {cloudWorkspaces.length === 0 && <option value="">no cloud workspace</option>}
          {cloudWorkspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => void onCreateCloudWorkspace()}
          disabled={busy}
          className="px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-30"
          title="Create account workspace"
        >
          +
        </button>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => void onCopyLocalToCloud()}
          disabled={busy || !selected}
          className="flex-1 px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
          title="Upload a sanitized copy of this local workspace to the account workspace"
        >
          copy local
        </button>
        <button
          onClick={() => void onSyncChanges()}
          disabled={busy || !selected}
          className="flex-1 px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-30"
          title="Upload only messages after the stored per-agent cursor"
        >
          sync changes
        </button>
        <button
          onClick={() => void onLogout()}
          disabled={busy}
          className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30"
        >
          sign out
        </button>
      </div>

      <div className="text-[10px] text-[var(--text-faint)] leading-tight">
        {cloudSnapshot
          ? `${cloudSnapshot.agents.length} agents / ${cloudSnapshot.messages.length} messages synced`
          : "Create a cloud workspace, then copy local data manually."}
        {" "}Initial copy uploads at most the latest 500 messages per agent in this beta; sync changes sends changed config plus the next 500 messages after each stored seq cursor.
      </div>
      {status && <div className="text-[10px] text-[var(--ok)] leading-tight">{status}</div>}
      {error && <div className="text-[10px] text-[var(--err)] leading-tight break-words">{error}</div>}
      {cloudSnapshot && cloudSnapshot.agents.length > 0 && (
        <div className="max-h-28 overflow-y-auto border border-[var(--border)]">
          {cloudSnapshot.agents.slice(0, 12).map((agent) => (
            <div key={agent.id} className="px-2 py-1 border-b border-[var(--border)] last:border-b-0 flex gap-2">
              <span className="text-[var(--text)] truncate">{agent.name}</span>
              <span className="text-[var(--text-faint)] truncate">{agent.model ?? ""}</span>
            </div>
          ))}
          {cloudSnapshot.agents.length > 12 && (
            <div className="px-2 py-1 text-[var(--text-faint)]">+{cloudSnapshot.agents.length - 12} more</div>
          )}
        </div>
      )}
    </section>
  );
}

async function buildLocalSnapshot(
  agents: Record<string, AgentState>,
  teams: ReturnType<typeof useStore.getState>["teams"],
) {
  const agentList = Object.values(agents).map((a) => a.summary);
  const teamList = Object.values(teams);
  const messagesByAgent: Record<string, PersistedMessage[]> = {};
  await Promise.all(
    agentList.map(async (agent) => {
      messagesByAgent[agent.id] = await listMessages(agent.id, 500);
    }),
  );
  return buildCloudSnapshotFromLocal({
    agents: agentList,
    teams: teamList,
    messagesByAgent,
  });
}

async function buildIncrementalBatch(
  agents: Record<string, AgentState>,
  teams: ReturnType<typeof useStore.getState>["teams"],
  cursor: Record<string, number>,
  previousSignature: string | null,
) {
  const agentList = Object.values(agents).map((a) => a.summary);
  const teamList = Object.values(teams);
  const messagesByAgent: Record<string, PersistedMessage[]> = {};
  await Promise.all(
    agentList.map(async (agent) => {
      messagesByAgent[agent.id] = await listMessages(agent.id, 500, cursor[agent.id] ?? -1);
    }),
  );
  const snapshot = buildCloudSnapshotFromLocal({
    agents: agentList,
    teams: teamList,
    messagesByAgent,
  });
  const signature = cloudConfigSignature(snapshot);
  const messages = snapshot.messages;
  const configChanged = signature !== previousSignature;
  return {
    ...(configChanged ? { teams: snapshot.teams, agents: snapshot.agents } : {}),
    messages,
    configSignature: signature,
  };
}

function cursorsFromSnapshot(snapshot: { messages: Array<{ agentId: string; seq: number }> }): Record<string, number> {
  const cursors: Record<string, number> = {};
  for (const message of snapshot.messages) {
    cursors[message.agentId] = Math.max(cursors[message.agentId] ?? -1, message.seq);
  }
  return cursors;
}

function cursorsFromList(list: Array<{ agentId: string; maxSeq: number }>): Record<string, number> {
  const cursors: Record<string, number> = {};
  for (const cursor of list) cursors[cursor.agentId] = cursor.maxSeq;
  return cursors;
}
