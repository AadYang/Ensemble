"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  cloudConfigSignature,
  defaultCloudOrigin,
  fetchCloudSnapshot,
  listCloudWorkspaces,
  loginCloud,
} from "@/lib/cloud-api";
import { useStore } from "@/store/agents";

interface CloudLoginDialogProps {
  onClose: () => void;
  onSignedIn: (firstWorkspaceId: string | null) => void;
}

export function CloudLoginDialog({ onClose, onSignedIn }: CloudLoginDialogProps) {
  const setCloudSession = useStore((s) => s.setCloudSession);
  const setCloudWorkspaces = useStore((s) => s.setCloudWorkspaces);
  const setCloudCurrentWorkspace = useStore((s) => s.setCloudCurrentWorkspace);
  const setCloudSnapshot = useStore((s) => s.setCloudSnapshot);
  const setCloudRevision = useStore((s) => s.setCloudRevision);
  const setCloudMessageCursors = useStore((s) => s.setCloudMessageCursors);
  const setCloudConfigSignature = useStore((s) => s.setCloudConfigSignature);

  const [origin, setOrigin] = useState(defaultCloudOrigin());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await loginCloud({
        origin,
        email: email.trim(),
        password,
        inviteCode,
      });
      setCloudSession(session);
      const workspaces = await listCloudWorkspaces(session);
      setCloudWorkspaces(workspaces);
      const target = workspaces[0] ?? null;
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
      onSignedIn(target?.id ?? null);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9998] bg-black/50 flex items-center justify-center p-4">
      <div className="tool-card bg-[var(--bg-elevated)] w-[420px] max-w-full text-xs shadow-2xl shadow-black/50">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[var(--text-dim)] tracking-wider">Cloud workspace login</span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            className="px-1.5 text-[var(--text-faint)] hover:text-[var(--err)]"
            title="Close"
          >
            x
          </button>
        </div>
        <div className="p-3 flex flex-col gap-2">
          <input
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder={defaultCloudOrigin()}
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] font-mono text-[11px]"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email"
            autoComplete="username"
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            type="password"
            autoComplete="current-password"
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
          />
          <input
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="invite code (only needed for first login)"
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={() => void submit()}
            disabled={busy || !email.trim() || !password}
            className="px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
          >
            {busy ? "signing in..." : "sign in"}
          </button>
          {error && <div className="text-[10px] text-[var(--err)] break-words">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function cursorsFromSnapshot(snapshot: { messages: Array<{ agentId: string; seq: number }> }): Record<string, number> {
  const cursors: Record<string, number> = {};
  for (const message of snapshot.messages) {
    cursors[message.agentId] = Math.max(cursors[message.agentId] ?? -1, message.seq);
  }
  return cursors;
}
