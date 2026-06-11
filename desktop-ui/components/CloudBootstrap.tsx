"use client";

import { useEffect } from "react";
import {
  fetchCloudMe,
  fetchCloudSnapshot,
  listCloudWorkspaces,
  loadCloudSession,
} from "@/lib/cloud-api";
import { useStore } from "@/store/agents";

export function CloudBootstrap() {
  const setCloudSession = useStore((s) => s.setCloudSession);
  const setCloudAccount = useStore((s) => s.setCloudAccount);
  const setCloudWorkspaces = useStore((s) => s.setCloudWorkspaces);
  const setCloudCurrentWorkspace = useStore((s) => s.setCloudCurrentWorkspace);
  const setCloudSnapshot = useStore((s) => s.setCloudSnapshot);
  const setCloudRevision = useStore((s) => s.setCloudRevision);
  const setCloudMessageCursors = useStore((s) => s.setCloudMessageCursors);
  const setCloudConfigSignature = useStore((s) => s.setCloudConfigSignature);

  useEffect(() => {
    let cancelled = false;
    const session = loadCloudSession();
    if (!session) return;
    setCloudSession(session);
    void (async () => {
      try {
        const [account, workspaces] = await Promise.all([
          fetchCloudMe(session),
          listCloudWorkspaces(session),
        ]);
        if (cancelled) return;
        setCloudAccount(account);
        setCloudWorkspaces(workspaces);
        const target = workspaces[0] ?? null;
        setCloudCurrentWorkspace(target?.id ?? null);
        if (!target) {
          setCloudSnapshot(null);
          return;
        }
        const snapshot = await fetchCloudSnapshot(session, target.id);
        if (cancelled) return;
        setCloudSnapshot(snapshot);
        setCloudRevision(target.id, snapshot.workspace.revision);
        setCloudMessageCursors(target.id, cursorsFromSnapshot(snapshot));
        setCloudConfigSignature(target.id, configSignature(snapshot));
      } catch (err) {
        console.warn("cloud bootstrap failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    setCloudAccount,
    setCloudCurrentWorkspace,
    setCloudMessageCursors,
    setCloudRevision,
    setCloudSession,
    setCloudSnapshot,
    setCloudWorkspaces,
    setCloudConfigSignature,
  ]);

  return null;
}

function cursorsFromSnapshot(snapshot: {
  messages: Array<{ agentId: string; seq: number }>;
}): Record<string, number> {
  const cursors: Record<string, number> = {};
  for (const message of snapshot.messages) {
    cursors[message.agentId] = Math.max(cursors[message.agentId] ?? -1, message.seq);
  }
  return cursors;
}

function configSignature(snapshot: { teams: unknown[]; agents: unknown[] }): string {
  return JSON.stringify({ teams: snapshot.teams, agents: snapshot.agents });
}
