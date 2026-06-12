"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PeerMode } from "@agentorch/shared";
import { getWS } from "@/lib/ws";
import { useStore } from "@/store/agents";
import { useT } from "@/i18n/useT";

const PEER_MODE_OPTIONS: PeerMode[] = ["raw", "continue", "review", "fork"];

export function PeerSendPopover({
  fromAgentId,
  onClose,
}: {
  fromAgentId: string;
  onClose: () => void;
}) {
  const t = useT();
  const agents = useStore((s) => s.agents);
  const appendUserTurn = useStore((s) => s.appendUserTurn);
  const fromAgent = agents[fromAgentId];

  const peers = useMemo(
    () =>
      Object.values(agents)
        .filter((a) => a.summary.id !== fromAgentId && !a.summary.closed)
        .sort((x, y) => x.summary.name.localeCompare(y.summary.name)),
    [agents, fromAgentId],
  );

  const [targetId, setTargetId] = useState<string>(peers[0]?.summary.id ?? "");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<PeerMode>("raw");
  const [interrupt, setInterrupt] = useState(false);
  const [interruptReason, setInterruptReason] = useState("");
  const [busy, setBusy] = useState(false);

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Center after the dialog actually mounts.
  useEffect(() => {
    if (!mounted || pos !== null) return;
    const el = dialogRef.current;
    const w = el?.offsetWidth ?? 360;
    const h = el?.offsetHeight ?? 360;
    setPos({
      x: Math.max(8, Math.floor((window.innerWidth - w) / 2)),
      y: Math.max(8, Math.floor((window.innerHeight - h) / 2)),
    });
  }, [mounted, pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onMove = (e: MouseEvent) => {
      const off = dragOffsetRef.current;
      if (!off) return;
      e.preventDefault();
      e.stopPropagation();
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 60, e.clientX - off.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 30, e.clientY - off.dy)),
      });
    };
    const onUp = () => {
      dragOffsetRef.current = null;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousemove", onMove, { capture: true });
    document.addEventListener("mouseup", onUp, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousemove", onMove, { capture: true });
      document.removeEventListener("mouseup", onUp, { capture: true });
    };
  }, [onClose]);

  if (!fromAgent || !mounted) return null;

  const onHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = dialogRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.preventDefault();
    e.stopPropagation();
  };

  const onSend = () => {
    const trimmed = text.trim();
    const reason = interruptReason.trim();
    if (!trimmed || !targetId || (interrupt && !reason)) return;
    setBusy(true);
    const targetAgent = agents[targetId];
    const targetName = targetAgent?.summary.name ?? targetId.slice(0, 8);
    getWS().send({
      type: "peer_send",
      fromSessionId: fromAgentId,
      targetSessionId: targetId,
      text: trimmed,
      mode,
      interrupt,
      ...(interrupt ? { interruptReason: reason } : {}),
    });
    // Outgoing log on the sender side so they see what they sent.
    appendUserTurn(
      fromAgentId,
      interrupt ? `${trimmed}\n\n[urgent interrupt: ${reason}]` : trimmed,
      { direction: "out", fromName: targetName, mode },
    );
    onClose();
  };

  const dialog = (
    <div
      ref={dialogRef}
      className="tool-card bg-[var(--bg-elevated)] w-[420px] max-w-full text-xs shadow-2xl shadow-black/50"
      style={{
        position: "fixed",
        zIndex: 9999,
        left: pos?.x ?? "50%",
        top: pos?.y ?? "15vh",
        transform: pos ? undefined : "translateX(-50%)",
      }}
    >
      <div
        onMouseDown={onHeaderMouseDown}
        className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2 cursor-move select-none"
        title={t("settings.dragHint")}
      >
        <span className="text-[var(--text-faint)]">⋮⋮</span>
        <span className="text-[var(--text-dim)] tracking-wider">{t("peer.popover.title")}</span>
        <span className="flex-1" />
        <span className="text-[var(--text-faint)] truncate max-w-[40%]">
          {fromAgent.summary.name} →
        </span>
        <button
          onClick={onClose}
          title={t("settings.closeDialog")}
          className="px-1.5 py-0.5 text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)] border border-[var(--border)] transition-colors cursor-pointer"
        >
          ✕
        </button>
      </div>
      <div className="p-3 flex flex-col gap-3">
        {peers.length === 0 ? (
          <div className="text-[var(--text-faint)]">{t("peer.popover.empty")}</div>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
                {t("peer.popover.toLabel")}
              </span>
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
              >
                {peers.map((p) => (
                  <option key={p.summary.id} value={p.summary.id}>
                    {p.summary.name} · {p.summary.status}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
                {t("peer.popover.modeLabel")}
              </span>
              <div className="flex flex-wrap gap-2">
                {PEER_MODE_OPTIONS.map((m) => (
                  <label
                    key={m}
                    className={`px-2 py-0.5 border cursor-pointer transition-colors ${
                      mode === m
                        ? "border-[var(--accent)] text-[var(--accent)]"
                        : "border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="peer-mode"
                      value={m}
                      checked={mode === m}
                      onChange={() => setMode(m)}
                      className="hidden"
                    />
                    {t(`peer.mode.${m}`)}
                  </label>
                ))}
              </div>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("peer.popover.placeholder")}
              rows={4}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  onSend();
                }
              }}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] resize-y font-mono"
            />
            <div className="border border-[var(--border)] bg-[var(--bg-pane)]/40 p-2 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[var(--text-dim)]">
                <input
                  type="checkbox"
                  checked={interrupt}
                  onChange={(e) => setInterrupt(e.target.checked)}
                />
                <span className={interrupt ? "text-[var(--warn)]" : ""}>
                  {t("peer.popover.interruptLabel")}
                </span>
              </label>
              {interrupt && (
                <input
                  value={interruptReason}
                  onChange={(e) => setInterruptReason(e.target.value)}
                  placeholder={t("peer.popover.interruptReasonPlaceholder")}
                  className="bg-[var(--bg-pane)] border border-[var(--warn)] px-1.5 py-1 outline-none focus:border-[var(--accent)] text-[11px]"
                />
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onSend}
                disabled={!text.trim() || !targetId || busy || (interrupt && !interruptReason.trim())}
                className="flex-1 px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
              >
                {t("peer.popover.send")}
              </button>
              <button
                onClick={onClose}
                className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
              >
                {t("peer.popover.cancel")}
              </button>
            </div>
            <div className="text-[10px] text-[var(--text-faint)] leading-tight">
              {t("peer.popover.hint")}
            </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
