"use client";

import { useEffect, useState } from "react";
import { type LoopView } from "@agentorch/shared";
import { useT } from "@/i18n/useT";
import { patchLoop, putLoopTasks } from "@/lib/loop-api";

export function LoopBoard({ agentId, loop }: { agentId: string; loop: LoopView }) {
  const t = useT();
  const last = loop.lastVerifyOk;
  const done = loop.tasks.filter((task) => task.done).length;
  const [capDraft, setCapDraft] = useState(String(loop.maxIterations));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setCapDraft(String(loop.maxIterations));
  }, [loop.maxIterations]);

  const run = (body: { maxIterations?: number; resetAttempts?: boolean }) => {
    setBusy(true);
    setError("");
    void patchLoop(agentId, body)
      .catch((err) => setError((err as Error).message))
      .finally(() => setBusy(false));
  };
  // An exhausted budget (iter >= max) pauses on the next stop-gate. Both
  // controls re-arm it — `set` raises the cap, `reset` clears the counter.
  const spent = loop.status === "paused" && loop.iter >= loop.maxIterations;
  const draft = Number(capDraft);
  const draftValid = Number.isFinite(draft) && draft >= 1 && draft <= 200 && Math.floor(draft) === draft;
  return (
    <aside className="hidden @[560px]:flex flex-col w-[min(17rem,42%)] shrink-0 min-w-0 min-h-0 border-l border-[var(--border)] bg-[var(--bg)] p-3 text-[11px] overflow-y-auto">
      <div className="text-[var(--accent)] tracking-wider uppercase mb-2">{t("loop.board.title")}</div>
      <div className={loop.config.verifier && last === false ? "text-[var(--warn)] mb-3" : loop.config.verifier && last ? "text-[var(--ok)] mb-3" : "text-[var(--text-dim)] mb-3"}>
        {loop.config.verifier
          ? `${loop.config.verifier.spec}${last == null ? "" : last ? " · pass" : " · fail"}`
          : `${t("loop.board.noVerifier")} · ${loop.config.doneWhen.spec || t("loop.board.doneMarker")}`}
      </div>
      <div className="flex flex-wrap items-center gap-1 mb-2 text-[var(--text-dim)]">
        <span className="text-[var(--text-faint)] tracking-wider uppercase">{t("loop.board.attempts")}</span>
        <span className={spent ? "tabular-nums text-[var(--warn)]" : "tabular-nums"}>
          {loop.iter}/{loop.maxIterations}
        </span>
        <input
          type="number"
          min={1}
          max={200}
          value={capDraft}
          onChange={(e) => setCapDraft(e.target.value)}
          aria-label={t("loop.board.maxAttempts")}
          title={t("loop.board.maxAttempts")}
          className="w-12 bg-[var(--bg-pane)] border border-[var(--border)] px-1 tabular-nums text-[var(--text)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
        />
        <button
          type="button"
          disabled={busy || !draftValid}
          className="px-1 border border-[var(--border)] hover:text-[var(--accent)] disabled:opacity-40"
          onClick={() => run({ maxIterations: Math.floor(draft) })}
        >
          {t("loop.board.setCap")}
        </button>
        <button
          type="button"
          disabled={busy || loop.iter === 1}
          className="px-1 border border-[var(--border)] hover:text-[var(--accent)] disabled:opacity-40"
          onClick={() => run({ resetAttempts: true })}
        >
          {t("loop.board.resetAttempts")}
        </button>
        {spent && <span className="text-[var(--warn)] w-full">{t("loop.board.spent")}</span>}
        {error && <span className="text-[var(--err)] w-full break-words">{error}</span>}
      </div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[var(--text-faint)] tracking-wider uppercase">{t("loop.board.tasks")}</span>
        {loop.tasks.length > 0 && (
          <span className="text-[var(--text-dim)] tabular-nums">{done}/{loop.tasks.length}</span>
        )}
      </div>
      {loop.tasks.length === 0 && <div className="text-[var(--text-dim)] mb-2">{t("loop.board.empty")}</div>}
      {loop.tasks.map((task, idx) => (
        <label
          key={`${task.text}-${idx}`}
          className="flex gap-2 items-start mb-1 cursor-pointer hover:bg-[var(--bg-pane)]"
          title={task.text}
        >
          <input
            type="checkbox"
            checked={task.done}
            className="mt-0.5 accent-[var(--accent)]"
            onChange={() => {
              const next = loop.tasks.map((row, i) => (i === idx ? { ...row, done: !row.done } : row));
              void putLoopTasks(agentId, next);
            }}
          />
          <span className={task.done ? "line-through text-[var(--text-faint)]" : "text-[var(--text)]"}>
            {task.text}
          </span>
        </label>
      ))}
      <div className="text-[var(--text-faint)] tracking-wider uppercase mt-3 mb-1">{t("loop.board.iters")}</div>
      {loop.iterations.map((it, idx) => (
        // `n` restarts after a manual reset, so it is not unique.
        <details key={`${idx}-${it.n}`} className="border-b border-dashed border-[var(--border)] py-0.5">
          <summary className="flex justify-between gap-2 cursor-pointer text-[var(--text-dim)] hover:text-[var(--text)]">
            <span>#{it.n}</span>
            <span
              className={
                it.result === "fail"
                  ? "text-[var(--err)]"
                  : it.result === "progress"
                    ? "text-[var(--accent)]"
                    : it.result === "skip"
                      ? "text-[var(--text-dim)]"
                      : "text-[var(--ok)]"
              }
            >
              {it.result}
              {it.snapshot ? ` · ${it.snapshot.slice(0, 7)}` : ""}
            </span>
          </summary>
          <div className="pl-3 pr-1 pb-1 text-[var(--text-dim)] whitespace-pre-wrap break-words">
            {it.summary || "—"}
          </div>
        </details>
      ))}
    </aside>
  );
}
