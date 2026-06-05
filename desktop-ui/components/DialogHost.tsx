"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getDialog, type DialogRequest } from "@/lib/dialog";
import { useT } from "@/i18n/useT";

export function DialogHost() {
  const t = useT();
  const dialog = getDialog();
  const [req, setReq] = useState<DialogRequest | null>(null);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("");
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => dialog.subscribe(setReq), [dialog]);

  // Re-init position + input value each time the head request changes.
  useEffect(() => {
    if (!req) return;
    setPos(null);
    if (req.kind === "prompt") {
      setText(req.opts.defaultValue ?? "");
    }
  }, [req?.id]);

  // Center after mount; defer until ref is wired.
  useEffect(() => {
    if (!mounted || !req || pos !== null) return;
    const el = dialogRef.current;
    const w = el?.offsetWidth ?? 380;
    const h = el?.offsetHeight ?? 180;
    setPos({
      x: Math.max(8, Math.floor((window.innerWidth - w) / 2)),
      y: Math.max(8, Math.floor((window.innerHeight - h) / 2)),
    });
  }, [mounted, req, pos]);

  // Auto-focus prompt input.
  useEffect(() => {
    if (req?.kind === "prompt" && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [req?.id]);

  // Capture-phase drag listeners (consistent with other modals in the project).
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

  if (!mounted || !req) return null;

  const onSubmit = () => {
    if (req.kind === "prompt") {
      const trimmed = text.trim();
      if (!trimmed) {
        dialog.cancelCurrent();
        return;
      }
      dialog.resolveCurrent(trimmed);
    } else {
      dialog.resolveCurrent(true);
    }
  };

  const onCancel = () => dialog.cancelCurrent();

  const onHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = dialogRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.preventDefault();
    e.stopPropagation();
  };

  const isConfirm = req.kind === "confirm";
  const danger = isConfirm && req.opts.danger === true;
  const okLabel = isConfirm
    ? (req.opts.okLabel ?? (danger ? t("dialog.delete") : t("dialog.ok")))
    : t("dialog.ok");
  const okClasses = danger
    ? "border border-[var(--err)] text-[var(--err)] hover:bg-[var(--err)] hover:text-black"
    : "border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black";

  const content = (
    <div
      ref={dialogRef}
      className="tool-card bg-[var(--bg-elevated)] w-[420px] max-w-full text-xs shadow-2xl shadow-black/50"
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      style={{
        position: "fixed",
        zIndex: 9999,
        left: pos?.x ?? "50%",
        top: pos?.y ?? "30vh",
        transform: pos ? undefined : "translateX(-50%)",
      }}
    >
      <div
        onMouseDown={onHeaderMouseDown}
        className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2 cursor-move select-none"
        title={t("settings.dragHint")}
      >
        <span className="text-[var(--text-faint)]">⋮⋮</span>
        <span className="text-[var(--text-dim)] tracking-wider">{req.opts.title}</span>
        <span className="flex-1" />
        <button
          onClick={onCancel}
          title={t("settings.closeDialog")}
          className="px-1.5 text-[var(--text-faint)] hover:text-[var(--err)]"
        >
          ✕
        </button>
      </div>
      <div className="p-3 flex flex-col gap-3">
        {req.kind === "prompt" ? (
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={req.opts.placeholder}
            className="bg-[var(--bg-pane)] border border-[var(--border)] px-2 py-1 outline-none focus:border-[var(--accent)]"
          />
        ) : (
          req.opts.message && (
            <div className="text-[var(--text)] whitespace-pre-wrap break-words leading-relaxed">
              {req.opts.message}
            </div>
          )
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] tracking-wider"
          >
            {t("dialog.cancel")}
          </button>
          <button
            onClick={onSubmit}
            className={`px-3 py-1.5 transition-colors tracking-wider ${okClasses}`}
          >
            {okLabel}
          </button>
        </div>
        <div className="text-[10px] text-[var(--text-faint)] leading-tight">
          {t("dialog.hint")}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
