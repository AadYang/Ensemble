"use client";

import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import type { PermissionDecision } from "@agentorch/shared";
import { getWS } from "@/lib/ws";
import { patchAgent } from "@/lib/agent-api";
import { useStore, type PendingPermission } from "@/store/agents";
import { useT } from "@/i18n/useT";
import { displayToolName } from "@/lib/tool-display";

export function PermissionDialog() {
  const ws = getWS();
  const queue = useStore((s) => s.pendingPermissions);
  const agents = useStore((s) => s.agents);
  const clearPermissionRequest = useStore((s) => s.clearPermissionRequest);
  const t = useT();

  const head: PendingPermission | undefined = queue[0];

  useEffect(() => {
    if (!head) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        allowAndAuto(head);
      } else if (e.key === "Enter") {
        e.preventDefault();
        respond(head, { behavior: "allow" });
      } else if (e.key === "Escape") {
        e.preventDefault();
        respond(head, { behavior: "deny", message: t("perm.deniedReason") });
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [head, t]);

  if (!head) return null;

  const agent = agents[head.sessionId];
  const agentName = agent?.summary.name ?? head.sessionId.slice(0, 8);
  const displayedToolName = displayToolName(head.toolName);
  // W16 Slice 5.5: ExitPlanMode is special — its `plan` arg is markdown the
  // user must approve before code is written. Render it rich rather than as
  // raw JSON so headings / lists / code blocks come through readably.
  const isExitPlanMode = head.toolName === "ExitPlanMode";
  const planText =
    isExitPlanMode && head.input && typeof head.input === "object" && "plan" in head.input
      ? String((head.input as { plan: unknown }).plan ?? "")
      : "";

  const respond = (entry: PendingPermission, decision: PermissionDecision) => {
    ws.send({
      type: "permission_response",
      sessionId: entry.sessionId,
      reqId: entry.reqId,
      decision,
    });
    clearPermissionRequest(entry.reqId);
  };

  const allowAndAuto = (entry: PendingPermission) => {
    respond(entry, { behavior: "allow" });
    void patchAgent(entry.sessionId, { permissionMode: "acceptEdits" }).catch((err) =>
      console.warn("patchAgent acceptEdits failed", err),
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6">
      <div className="tool-card max-w-2xl w-full bg-[var(--bg-elevated)]">
        <div className="flex items-center gap-2 mb-2 text-xs">
          <span className="status-dot awaiting_permission" />
          <span className="text-[var(--warn)] tracking-wider">{t("perm.title")}</span>
          <span className="flex-1" />
          {queue.length > 1 && (
            <span className="text-[var(--text-dim)]">{t("perm.pending", { n: queue.length - 1 })}</span>
          )}
        </div>

        <div className="text-sm mb-3">
          <span className="text-[var(--text-dim)]">{t("perm.subtitle.agent")}</span>{" "}
          <span className="text-[var(--text)] font-bold">{agentName}</span>{" "}
          <span className="text-[var(--text-dim)]">{t("perm.subtitle.wants")}</span>{" "}
          <span className="text-[var(--accent)] font-bold">{displayedToolName}</span>
        </div>

        {isExitPlanMode ? (
          <div className="markdown-plan text-xs text-[var(--text)] bg-[var(--bg-pane)] border border-[var(--border)] p-3 max-h-96 overflow-auto leading-relaxed">
            <ReactMarkdown>{planText}</ReactMarkdown>
          </div>
        ) : (
          <pre className="text-xs text-[var(--text-dim)] bg-[var(--bg-pane)] border border-[var(--border)] p-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(head.input, null, 2)}
          </pre>
        )}

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <button
            autoFocus
            onClick={() => respond(head, { behavior: "allow" })}
            className="px-3 py-1.5 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors text-xs tracking-wider"
          >
            {t("perm.allow")}
          </button>
          <button
            onClick={() => allowAndAuto(head)}
            className="px-3 py-1.5 border border-[var(--ok)] text-[var(--ok)] hover:bg-[var(--ok)] hover:text-black transition-colors text-xs tracking-wider"
          >
            {t("perm.allowAndAuto")}
          </button>
          <button
            onClick={() => respond(head, { behavior: "deny", message: t("perm.deniedReason") })}
            className="px-3 py-1.5 border border-[var(--err)] text-[var(--err)] hover:bg-[var(--err)] hover:text-black transition-colors text-xs tracking-wider"
          >
            {t("perm.deny")}
          </button>
          <span className="flex-1" />
          <span className="text-[10px] text-[var(--text-faint)]">
            {t("perm.note")}
          </span>
        </div>
      </div>
    </div>
  );
}
