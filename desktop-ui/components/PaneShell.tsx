"use client";

import { useState } from "react";
import { selectActiveWindow, useStore } from "@/store/agents";
import { useT } from "@/i18n/useT";
import { ChatPane } from "./ChatPane";
import { AgentSettings } from "./AgentSettings";

export function PaneShell({ paneId, agentId }: { paneId: string; agentId: string | null }) {
  const isActive = useStore((s) => selectActiveWindow(s)?.activePaneId === paneId);
  const setActivePane = useStore((s) => s.setActivePane);
  const splitActive = useStore((s) => s.splitActive);
  const closeActive = useStore((s) => s.closeActive);
  const setActive = useStore((s) => s.setActive);
  const attachAgentToPane = useStore((s) => s.attachAgentToPane);
  const agent = useStore((s) => (agentId ? s.agents[agentId] : null));
  const agents = useStore((s) => s.agents);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const t = useT();

  // Background tasks this agent spawned (detached subagents). Derived live from
  // the store so their status updates in place — no chat-text parsing.
  const backgroundTasks = agentId
    ? Object.values(agents).filter(
        (x) => x.summary.parentId === agentId && x.summary.subagentKind === "background",
      )
    : [];

  const summary = agent?.summary ?? null;
  const turnCount = agent?.turns.length ?? 0;
  const toolCount = agent?.turns.filter((t) => t.kind === "tool_use").length ?? 0;
  const isPlan = summary?.permissionMode === "plan";

  return (
    <div
      onMouseDownCapture={() => {
        if (!isActive) setActivePane(paneId);
      }}
      className={`group flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-pane)] ${
        isActive
          ? "pane-active"
          : "border border-[var(--border)] ascii-corners"
      }`}
    >
      <div className="shrink-0 flex items-stretch border-b border-[var(--border)]">
        <div className={`pane-stripe ${summary?.status ?? "idle"}`} />
        <div className="flex-1 flex items-center gap-2 px-2 py-1 text-[11px] min-w-0">
          {summary ? (
            <>
              <span className="font-bold text-[var(--text)] truncate">{summary.name}</span>
              <span className="text-[var(--text-dim)] truncate">{summary.model}</span>
              <span className="text-[var(--text-dim)]">·</span>
              <span className={statusColor(summary.status)}>{summary.status}</span>
              {isPlan && (
                <>
                  <span className="text-[var(--text-dim)]">·</span>
                  <span className="text-[var(--warn)] tracking-wider">{t("pane.label.plan")}</span>
                </>
              )}
              <span className="text-[var(--text-dim)]">·</span>
              <span className="text-[var(--text-dim)]">{t("pane.label.msg", { n: turnCount })}</span>
              {toolCount > 0 && (
                <>
                  <span className="text-[var(--text-dim)]">·</span>
                  <span className="text-[var(--warn)]">{t("pane.label.tool", { n: toolCount })}</span>
                </>
              )}
            </>
          ) : (
            <span className="text-[var(--text-faint)] italic">{t("pane.empty")}</span>
          )}
          <span className="flex-1" />
          <span className="text-[var(--text-faint)]">{paneId.slice(0, 8)}</span>
          <div
            className={`flex items-center gap-1 transition-opacity ${
              isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            {agentId && (
              <PaneBtn
                title={t("pane.btn.settings")}
                onClick={() => {
                  setActivePane(paneId);
                  setSettingsOpen(true);
                }}
              >
                ⚙
              </PaneBtn>
            )}
            <PaneBtn
              title={t("pane.btn.splitH")}
              onClick={() => {
                setActivePane(paneId);
                splitActive("h");
              }}
            >
              ⇿
            </PaneBtn>
            <PaneBtn
              title={t("pane.btn.splitV")}
              onClick={() => {
                setActivePane(paneId);
                splitActive("v");
              }}
            >
              ⇕
            </PaneBtn>
            <PaneBtn
              title={t("pane.btn.close")}
              danger
              onClick={() => {
                setActivePane(paneId);
                closeActive();
              }}
            >
              ×
            </PaneBtn>
          </div>
        </div>
      </div>

      {agentId && backgroundTasks.length > 0 && (
        <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto border-b border-[var(--border)] px-2 py-1 text-[10px]">
          <span className="shrink-0 text-[var(--warn)] tracking-wider">
            {t("pane.bgtasks.label", { n: backgroundTasks.length })}
          </span>
          {backgroundTasks.map((bt) => (
            <button
              key={bt.summary.id}
              title={t("pane.bgtasks.open")}
              onClick={(e) => {
                e.stopPropagation();
                setActivePane(paneId);
                setActive(bt.summary.id);
                attachAgentToPane(paneId, bt.summary.id);
              }}
              className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 border border-[var(--border)] hover:border-[var(--accent)] transition-colors"
            >
              <span className={`status-dot ${bt.summary.status}`} />
              <span className="truncate max-w-[10rem] text-[var(--text)]">{bt.summary.name}</span>
              <span className={statusColor(bt.summary.status)}>{bt.summary.status}</span>
            </button>
          ))}
        </div>
      )}

      {agentId ? (
        <ChatPane agentId={agentId} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-faint)] text-xs gap-2 px-4 text-center">
          <div className="text-[var(--text-dim)]">{t("pane.empty")}</div>
          <div>{t("pane.bind.hint1")}</div>
          <div>{t("pane.bind.hint2")}</div>
        </div>
      )}
      {agentId && settingsOpen && (
        <AgentSettings
          agentId={agentId}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function PaneBtn({
  children,
  title,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  danger?: boolean;
}) {
  const color = danger ? "var(--err)" : "var(--accent)";
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className="px-1.5 py-0.5 border border-[var(--border)] hover:text-[var(--accent)] transition-colors"
      style={{ borderColor: undefined }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = color)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "")}
    >
      {children}
    </button>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "running": return "text-[var(--accent)]";
    case "done": return "text-[var(--ok)]";
    case "error": return "text-[var(--err)]";
    case "awaiting_permission": return "text-[var(--warn)]";
    default: return "text-[var(--text-dim)]";
  }
}
