"use client";

import type { LoopView } from "@agentorch/shared";
import { useT } from "@/i18n/useT";
import { putLoopTasks } from "@/lib/loop-api";

export function LoopBoard({ agentId, loop }: { agentId: string; loop: LoopView }) {
  const t = useT();
  const last = loop.lastVerifyOk;
  return (
    <aside className="hidden @[560px]:flex flex-col w-[min(15rem,38%)] shrink-0 min-w-0 min-h-0 border-l border-[var(--border)] bg-[var(--bg)] p-3 text-[11px] overflow-y-auto">
      <div className="text-[var(--accent)] tracking-wider uppercase mb-2">{t("loop.board.title")}</div>
      <div className={last === false ? "text-[var(--warn)] mb-3" : last ? "text-[var(--ok)] mb-3" : "text-[var(--text-dim)] mb-3"}>
        {loop.config.verifier?.spec ?? t("loop.board.doneMarker")}
        {last == null ? "" : last ? " · pass" : " · fail"}
      </div>
      <div className="text-[var(--text-faint)] tracking-wider uppercase mb-1">{t("loop.board.tasks")}</div>
      {loop.tasks.length === 0 && <div className="text-[var(--text-dim)] mb-2">{t("loop.board.empty")}</div>}
      {loop.tasks.map((task, idx) => (
        <label key={`${task.text}-${idx}`} className="flex gap-2 items-start mb-1 text-[var(--text-dim)]">
          <input
            type="checkbox"
            checked={task.done}
            onChange={() => {
              const next = loop.tasks.map((row, i) => (i === idx ? { ...row, done: !row.done } : row));
              void putLoopTasks(agentId, next);
            }}
          />
          <span className={task.done ? "line-through opacity-70" : ""}>{task.text}</span>
        </label>
      ))}
      <div className="text-[var(--text-faint)] tracking-wider uppercase mt-3 mb-1">{t("loop.board.iters")}</div>
      {loop.iterations.map((it) => (
        <div key={it.n} className="flex justify-between border-b border-dashed border-[var(--border)] py-0.5 text-[var(--text-dim)]">
          <span>#{it.n}</span>
          <span className={it.result === "fail" ? "text-[var(--err)]" : "text-[var(--ok)]"}>
            {it.snapshot ? it.snapshot.slice(0, 7) : it.result}
          </span>
        </div>
      ))}
    </aside>
  );
}
