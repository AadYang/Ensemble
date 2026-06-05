"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getWS } from "@/lib/ws";
import { useStore, type PendingUserQuestion } from "@/store/agents";
import { useT } from "@/i18n/useT";

export function AskUserDialog() {
  const ws = getWS();
  const queue = useStore((s) => s.pendingUserQuestions);
  const agents = useStore((s) => s.agents);
  const clearUserQuestion = useStore((s) => s.clearUserQuestion);
  const t = useT();

  const head: PendingUserQuestion | undefined = queue[0];

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Re-center each time a new question becomes head (head id changes).
  useEffect(() => {
    if (!mounted || !head) return;
    setPos(null);
  }, [mounted, head?.reqId]);

  useEffect(() => {
    if (!mounted || pos !== null || !head) return;
    const el = dialogRef.current;
    const w = el?.offsetWidth ?? 480;
    const h = el?.offsetHeight ?? 320;
    setPos({
      x: Math.max(8, Math.floor((window.innerWidth - w) / 2)),
      y: Math.max(8, Math.floor((window.innerHeight - h) / 2)),
    });
  }, [mounted, pos, head]);

  useEffect(() => {
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
    document.addEventListener("mousemove", onMove, { capture: true });
    document.addEventListener("mouseup", onUp, { capture: true });
    return () => {
      document.removeEventListener("mousemove", onMove, { capture: true });
      document.removeEventListener("mouseup", onUp, { capture: true });
    };
  }, []);

  if (!mounted || !head) return null;

  const agent = agents[head.sessionId];
  const agentName = agent?.summary.name ?? head.sessionId.slice(0, 8);

  const onPick = (choice: string) => {
    ws.send({
      type: "user_answer",
      sessionId: head.sessionId,
      reqId: head.reqId,
      choice,
    });
    clearUserQuestion(head.reqId);
  };

  const onHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = dialogRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.preventDefault();
    e.stopPropagation();
  };

  const dialog = (
    <div
      ref={dialogRef}
      className="tool-card bg-[var(--bg-elevated)] w-[480px] max-w-full text-xs shadow-2xl shadow-black/50"
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
        <span className="status-dot awaiting_user_input" />
        <span className="text-[var(--accent)] tracking-wider">{t("ask.title")}</span>
        <span className="flex-1" />
        {queue.length > 1 && (
          <span className="text-[var(--text-dim)]">{t("ask.pending", { n: queue.length - 1 })}</span>
        )}
      </div>
      <div className="p-4 flex flex-col gap-3">
        <div className="text-[10px] tracking-wider text-[var(--text-faint)]">
          {t("ask.fromAgent", { name: agentName })}
        </div>
        <div className="text-sm whitespace-pre-wrap break-words text-[var(--text)]">
          {head.question}
        </div>
        <div className="flex flex-col gap-1.5 mt-1">
          {head.options.map((opt, i) => (
            <button
              key={`${head.reqId}-${i}`}
              onClick={() => onPick(opt)}
              className="px-3 py-1.5 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors text-left text-xs"
            >
              <span className="text-[var(--text-faint)] mr-2">{i + 1}.</span>
              {opt}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-[var(--text-faint)] leading-tight">
          {t("ask.note")}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
