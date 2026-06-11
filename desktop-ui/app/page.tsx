"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getWS } from "@/lib/ws";
import { listAgents, listMessages } from "@/lib/agent-api";
import { listTeams } from "@/lib/team-api";
import { getDialog } from "@/lib/dialog";
import type { SdkMessage } from "@agentorch/shared";
import {
  createWorkspace,
  fetchWorkspace,
  listWorkspaces,
  putWorkspaceLayout,
  renameWorkspace,
  type WorkspaceSummaryDTO,
} from "@/lib/layout-api";
import type { LayoutNode } from "@agentorch/shared";
import { hydrateLocaleFromStorage, selectActiveWindow, useStore } from "@/store/agents";
import { LayoutRenderer } from "@/components/LayoutRenderer";
import { PermissionDialog } from "@/components/PermissionDialog";
import { AskUserDialog } from "@/components/AskUserDialog";
import { DialogHost } from "@/components/DialogHost";
import { AgentTree } from "@/components/AgentTree";
import { CloudBootstrap } from "@/components/CloudBootstrap";
import { CloudRemoteBridge } from "@/components/CloudRemoteBridge";
import { CloudWorkspacePanel } from "@/components/CloudWorkspacePanel";
import { McpServerPanel } from "@/components/McpServerPanel";
import { SkillPanel } from "@/components/SkillPanel";
import { ProviderPanel } from "@/components/ProviderPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { GlobalSettings } from "@/components/GlobalSettings";
import { UsageStatsDialog } from "@/components/UsageStatsDialog";
import { TutorialDialog } from "@/components/TutorialDialog";
import { PricingSettingsDialog } from "@/components/PricingSettingsDialog";
import { KeyHelpDialog } from "@/components/KeyHelpDialog";
import { WindowControls } from "@/components/WindowControls";
import { NewAgentDialog } from "@/components/NewAgentDialog";
import { NewTeamDialog } from "@/components/NewTeamDialog";
import { UpdateDialog } from "@/components/UpdateDialog";
import { useTmuxKeys } from "@/hooks/useTmuxKeys";
import { useT } from "@/i18n/useT";
import { checkForUpdates, type UpdateState } from "@/lib/update-check";

const LAST_WORKSPACE_KEY = "ensemble:last-workspace";
const SIDEBAR_WIDTH_KEY = "ensemble:sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "ensemble:sidebar-collapsed";
const SIDEBAR_MIN_WIDTH = 224; // = w-56, current default — never narrower
const SIDEBAR_MAX_WIDTH = 600;

export default function Page() {
  const ws = getWS();
  const connected = useStore((s) => s.connected);
  const setConnected = useStore((s) => s.setConnected);
  const upsertAgent = useStore((s) => s.upsertAgent);
  const setStatus = useStore((s) => s.setStatus);
  const ingestSdkMessage = useStore((s) => s.ingestSdkMessage);
  const appendError = useStore((s) => s.appendError);
  const agents = useStore((s) => s.agents);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);

  const windows = useStore((s) => s.windows);
  const activeWindowId = useStore((s) => s.activeWindowId);
  const setActiveWindow = useStore((s) => s.setActiveWindow);
  const renameWindow = useStore((s) => s.renameWindow);
  const closeWindow = useStore((s) => s.closeWindow);
  const createWindow = useStore((s) => s.createWindow);
  const attachAgentToPane = useStore((s) => s.attachAgentToPane);
  const setLayout = useStore((s) => s.setLayout);
  const addPermissionRequest = useStore((s) => s.addPermissionRequest);
  const addUserQuestion = useStore((s) => s.addUserQuestion);

  const workspaces = useStore((s) => s.workspaces);
  const setWorkspaces = useStore((s) => s.setWorkspaces);
  const currentWorkspaceId = useStore((s) => s.currentWorkspaceId);
  const setCurrentWorkspace = useStore((s) => s.setCurrentWorkspace);

  const aw = useStore(selectActiveWindow);
  const activePaneId = aw?.activePaneId ?? "";

  const t = useT();
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  // W17: usage stats dialog visibility. Lives in the store so slash commands
  // (/cost) and the toolbar button can flip it from anywhere.
  const usageOpen = useStore((s) => s.usageOpen);
  const setUsageOpen = useStore((s) => s.setUsageOpen);
  const tutorialOpen = useStore((s) => s.tutorialOpen);
  const setTutorialOpen = useStore((s) => s.setTutorialOpen);
  const [pricingModel, setPricingModel] = useState<string | null>(null);
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  // Update-checker. Launch-time auto-check populates this; the dialog only
  // surfaces when a newer version exists. Manual checks from the Preferences
  // dialog also drive it.
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const { prefixed } = useTmuxKeys();

  // Auto-check on launch — silent if up-to-date or if the manifest endpoint
  // is unreachable. Mandatory updates show a dialog the user can't dismiss.
  // We also suppress the prompt when the release has no asset for this
  // client's platform (e.g. a Windows-only release showing on a Mac), unless
  // the release is mandatory — in that case the user MUST be told something
  // is wrong, but the dialog's clipboard fallback can still surface whatever
  // legacy URL exists for manual handling.
  useEffect(() => {
    let alive = true;
    void checkForUpdates().then((s) => {
      if (!alive) return;
      if (!s || !s.hasNewer) return;
      if (s.asset === null && !s.mustUpgrade) return;
      setUpdateState(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Sidebar width: persisted, clamped to [MIN, MAX]. SSR-safe via lazy init.
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR_MIN_WIDTH);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const sidebarDraggingRef = useRef(false);
  useEffect(() => {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, n)));
      }
    }
    setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
  }, []);
  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sidebarDraggingRef.current) return;
      const next = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, e.clientX));
      setSidebarWidth(next);
    };
    const onUp = () => {
      if (!sidebarDraggingRef.current) return;
      sidebarDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Persist on release rather than every mousemove tick.
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
      } catch {
        /* quota / private mode — ignore */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [sidebarWidth]);

  // Restore persisted locale after first paint to avoid SSR/CSR hydration mismatch.
  useEffect(() => {
    hydrateLocaleFromStorage();
  }, []);

  // Hydrate known agents on mount so post-refresh permission_request / user_question
  // events route to a populated store. WS hello handler also re-subscribes from store,
  // so this only needs to populate before hello fires; if hello races ahead, the loop
  // in the WS handler will see the hydrated store on a subsequent reconnect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, teams] = await Promise.all([listAgents(), listTeams()]);
        if (cancelled) return;
        useStore.getState().setTeams(teams);
        for (const a of list) {
          upsertAgent(a);
          if (ws.isOpen()) ws.send({ type: "subscribe", sessionId: a.id });
        }
        await Promise.all(
          list.map(async (a) => {
            try {
              const msgs = await listMessages(a.id);
              if (cancelled) return;
              for (const m of msgs) ingestSdkMessage(a.id, m.seq, m.msg as SdkMessage);
            } catch (err) {
              console.warn("history hydrate failed", a.id, err);
            }
          }),
        );
      } catch (err) {
        console.warn("agents hydrate failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadedRef = useRef(false);
  const lastSavedRef = useRef<string>("");

  // Boot: list workspaces, pick last-used or first, then fetch its layout.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listWorkspaces();
        if (cancelled) return;
        setWorkspaces(list);
        if (list.length === 0) return;
        const lastUsed =
          typeof window !== "undefined" ? window.localStorage.getItem(LAST_WORKSPACE_KEY) : null;
        const target = list.find((w) => w.id === lastUsed) ?? list[0]!;
        await selectWorkspace(target.id);
      } catch (err) {
        console.warn("workspaces boot failed", err);
      } finally {
        loadedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectWorkspace = async (id: string) => {
    const dto = await fetchWorkspace(id);
    setCurrentWorkspace(id);
    setLayout(dto.layout);
    if (typeof window !== "undefined") window.localStorage.setItem(LAST_WORKSPACE_KEY, id);
    lastSavedRef.current = JSON.stringify({ windows: dto.layout.windows, activeWindowId: dto.layout.activeWindowId });
  };

  // Debounce-save active workspace's layout whenever the windows tree changes.
  useEffect(() => {
    if (!loadedRef.current || !currentWorkspaceId) return;
    const payload = JSON.stringify({ windows, activeWindowId });
    if (payload === lastSavedRef.current) return;
    const t = window.setTimeout(() => {
      void putWorkspaceLayout(currentWorkspaceId, { windows, activeWindowId })
        .then(() => {
          lastSavedRef.current = payload;
        })
        .catch((err) => console.warn("layout save failed", err));
    }, 500);
    return () => window.clearTimeout(t);
  }, [windows, activeWindowId, currentWorkspaceId]);

  useEffect(() => {
    ws.connect();
    const unsub = ws.subscribe((msg) => {
      switch (msg.type) {
        case "hello":
          setConnected(true);
          // Re-subscribe to all known agents so events route after a reconnect.
          for (const id of Object.keys(useStore.getState().agents)) {
            ws.send({ type: "subscribe", sessionId: id });
          }
          break;
        case "agent_created":
          upsertAgent(msg.agent);
          ws.send({ type: "subscribe", sessionId: msg.agent.id });
          break;
        case "agent_updated":
          upsertAgent(msg.agent);
          break;
        case "agent_deleted":
          useStore.getState().removeAgent(msg.sessionId);
          break;
        case "agent_history_reset":
          useStore.getState().resetAgentHistory(msg.sessionId, msg.reason, msg.summary);
          break;
        case "team_created":
        case "team_updated":
          useStore.getState().upsertTeam(msg.team);
          break;
        case "team_deleted":
          useStore.getState().removeTeam(msg.teamId);
          break;
        case "status":
          setStatus(msg.sessionId, msg.status);
          break;
        case "message":
          ingestSdkMessage(msg.sessionId, msg.seq, msg.msg);
          break;
        case "permission_request":
          addPermissionRequest({
            sessionId: msg.sessionId,
            reqId: msg.reqId,
            toolName: msg.toolName,
            input: msg.input,
            receivedAt: Date.now(),
          });
          break;
        case "user_question":
          addUserQuestion({
            sessionId: msg.sessionId,
            reqId: msg.reqId,
            question: msg.question,
            options: msg.options,
            receivedAt: Date.now(),
          });
          break;
        case "error":
          appendError(msg.sessionId ?? null, msg.code, msg.message);
          break;
      }
    });
    const interval = setInterval(() => setConnected(ws.isOpen()), 1000);
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [
    ws,
    setConnected,
    upsertAgent,
    setStatus,
    ingestSdkMessage,
    addPermissionRequest,
    addUserQuestion,
    appendError,
  ]);

  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const nextDefaultName = useMemo(() => {
    const used = new Set(Object.values(agents).map((a) => a.summary.name));
    let i = 1;
    while (used.has(`agent-${i}`)) i++;
    return `agent-${i}`;
  }, [agents]);

  const onCreateWorkspace = async () => {
    const wsName = await getDialog().prompt({ title: t("ws.new.prompt") });
    if (!wsName?.trim()) return;
    try {
      const created = await createWorkspace(wsName.trim());
      const list = await listWorkspaces();
      setWorkspaces(list);
      await selectWorkspace(created.id);
    } catch (err) {
      console.warn("create workspace failed", err);
    }
  };

  const onRenameWorkspace = async () => {
    if (!currentWorkspaceId) return;
    const cur = workspaces.find((w) => w.id === currentWorkspaceId);
    const next = await getDialog().prompt({ title: t("ws.rename.prompt"), defaultValue: cur?.name });
    if (!next?.trim()) return;
    try {
      await renameWorkspace(currentWorkspaceId, next.trim());
      const list = await listWorkspaces();
      setWorkspaces(list);
    } catch (err) {
      console.warn("rename workspace failed", err);
    }
  };

  const agentList = Object.values(agents);
  const activeCount = agentList.filter(
    (a) => a.summary.status === "running" || a.summary.status === "awaiting_permission",
  ).length;
  const idleCount = agentList.length - activeCount;

  const activeAgentId = useMemo(() => {
    if (!aw) return null;
    const find = (n: LayoutNode): string | null =>
      n.kind === "pane"
        ? n.id === aw.activePaneId
          ? n.agentId
          : null
        : find(n.a) ?? find(n.b);
    return find(aw.root);
  }, [aw]);
  const activeAgent = activeAgentId ? agents[activeAgentId] : null;
  const uptime = useUptime();

  const boundAgentIds = useMemo(() => {
    const set = new Set<string>();
    const visit = (n: LayoutNode): void => {
      if (n.kind === "pane") {
        if (n.agentId) set.add(n.agentId);
      } else {
        visit(n.a);
        visit(n.b);
      }
    };
    for (const w of windows) visit(w.root);
    return set;
  }, [windows]);

  // Per-window "has running activity" indicator (`+` in tmux).
  const windowHasActivity = (winRoot: LayoutNode): boolean => {
    if (winRoot.kind === "pane") {
      if (!winRoot.agentId) return false;
      const ag = agents[winRoot.agentId];
      return ag?.summary.status === "running" || ag?.summary.status === "awaiting_permission";
    }
    return windowHasActivity(winRoot.a) || windowHasActivity(winRoot.b);
  };

  return (
    <div className="flex h-dvh max-h-dvh min-h-0 min-w-0 flex-col overflow-hidden">
      <CloudBootstrap />
      <CloudRemoteBridge />
      <header
        data-tauri-drag-region
        className="shrink-0 flex items-center justify-between pl-4 pr-0 py-2 border-b border-[var(--border)] bg-[var(--bg-pane)]/40 select-none"
      >
        <div className="flex items-center gap-2">
          <span className="text-[var(--accent)]">▎</span>
          <span className="font-bold tracking-[0.18em]">{t("header.brand")}</span>
          <span className="text-[var(--text-faint)] text-[10px] tracking-wider ml-1">{t("header.version")}</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1">
            <span className="text-[var(--accent)]">◉</span>
            <span className="text-[var(--text)]">{activeCount}</span>
            <span className="text-[var(--text-dim)]">{t("header.active")}</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[var(--text-faint)]">◯</span>
            <span className="text-[var(--text)]">{idleCount}</span>
            <span className="text-[var(--text-dim)]">{t("header.idle")}</span>
          </span>
          {prefixed && (
            <span className="prefix-active px-1.5 py-0.5 border border-[var(--accent)] text-[var(--accent)] tracking-wider">
              {t("header.prefix")}
            </span>
          )}
          <span className="text-[var(--text-dim)] tabular-nums">{uptime}</span>
          <span className="flex items-center gap-1 text-[var(--text-dim)]">
            <span className={`status-dot ${connected ? "running" : "error"}`} />
            {connected ? t("header.ws.connected") : t("header.ws.disconnected")}
          </span>
          <button
            title={sidebarCollapsed ? t("header.sidebar.show") : t("header.sidebar.hide")}
            onClick={toggleSidebar}
            className="px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
          >
            {sidebarCollapsed ? "▶" : "◀"}
          </button>
          <button
            title={t("header.usage.title")}
            onClick={() => setUsageOpen(true)}
            className="px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
          >
            ◔
          </button>
          <button
            title={t("header.tutorial.title")}
            onClick={() => setTutorialOpen(true)}
            className="px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
          >
            ⓘ
          </button>
          <button
            title={t("header.settings.title")}
            onClick={() => setGlobalSettingsOpen(true)}
            className="px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
          >
            ⚙
          </button>
          <WindowControls />
        </div>
      </header>

      <div className="flex flex-1 min-h-0 min-w-0">
        {!sidebarCollapsed && (
        <aside
          style={{ width: sidebarWidth, minWidth: SIDEBAR_MIN_WIDTH, maxWidth: SIDEBAR_MAX_WIDTH }}
          className="shrink-0 border-r border-[var(--border)] flex flex-col min-h-0 bg-[var(--bg-pane)]/30 relative"
        >
          <WorkspaceSelector
            workspaces={workspaces}
            currentId={currentWorkspaceId}
            onSelect={selectWorkspace}
            onCreate={onCreateWorkspace}
            onRename={onRenameWorkspace}
          />
          <CloudWorkspacePanel
            localWorkspaces={workspaces}
            currentLocalWorkspaceId={currentWorkspaceId}
          />
          <div className="p-3 border-b border-[var(--border)] flex flex-col gap-2">
            <div className="flex gap-1">
              <button
                className="flex-1 px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
                onClick={() => setNewAgentOpen(true)}
                disabled={!connected}
              >
                {t("agent.create")}
              </button>
              <button
                className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-30 transition-colors"
                onClick={() => setNewTeamOpen(true)}
                disabled={!connected}
                title={t("team.create.title")}
              >
                {t("team.create")}
              </button>
            </div>
            <div className="text-[10px] text-[var(--text-dim)] leading-tight">
              {t("agent.attachHint", { paneId: activePaneId.slice(0, 6) })}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <AgentTree
              activeId={activeId}
              boundAgentIds={boundAgentIds}
              onPick={(a) => {
                setActive(a.id);
                attachAgentToPane(activePaneId, a.id);
              }}
            />
          </div>
          <ProviderPanel />
          <McpServerPanel />
          <SkillPanel />
          <div
            onMouseDown={(e) => {
              sidebarDraggingRef.current = true;
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
              e.preventDefault();
            }}
            onDoubleClick={() => {
              setSidebarWidth(SIDEBAR_MIN_WIDTH);
              try {
                window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_MIN_WIDTH));
              } catch { /* ignore */ }
            }}
            title={t("sidebar.resizeHint")}
            className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-[var(--accent)] active:bg-[var(--accent)] transition-colors z-10"
          />
        </aside>
        )}

        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          {aw ? (
            <LayoutRenderer node={aw.root} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[var(--text-dim)]">
              {t("main.loading")}
            </div>
          )}
        </main>
      </div>

      <footer className="shrink-0 px-3 py-1 border-t border-[var(--border)] bg-[var(--bg-pane)]/60 flex items-center gap-2 text-[10px] tracking-wider overflow-x-auto overflow-y-hidden whitespace-nowrap">
        {windows.map((w, i) => {
          const isActive = w.id === activeWindowId;
          const active = windowHasActivity(w.root);
          return (
            <button
              key={w.id}
              onClick={() => setActiveWindow(w.id)}
              onContextMenu={async (e) => {
                e.preventDefault();
                const next = await getDialog().prompt({
                  title: t("win.rename.prompt"),
                  defaultValue: w.name,
                });
                if (next?.trim()) renameWindow(w.id, next.trim());
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && windows.length > 1) closeWindow(w.id);
              }}
              className={`px-2 py-0.5 transition-colors ${
                isActive
                  ? "border border-[var(--accent)] text-[var(--accent)]"
                  : "border border-transparent text-[var(--text-dim)] hover:text-[var(--text)]"
              }`}
              title={t("win.tab.title")}
            >
              [{i + 1}:{w.name}{isActive ? "*" : active ? "+" : ""}]
            </button>
          );
        })}
        <button
          onClick={() => createWindow()}
          className="px-1 text-[var(--text-faint)] hover:text-[var(--accent)]"
          title={t("win.new.title")}
        >
          +
        </button>
        <span className="flex-1" />
        <span className="text-[var(--text-dim)]">{t("footer.pane", { id: activePaneId.slice(0, 6) })}</span>
        {activeAgent ? (
          <span className="flex items-center gap-1">
            <span className={`status-dot ${activeAgent.summary.status}`} />
            <span className="text-[var(--text)]">{activeAgent.summary.name}</span>
            <span className="text-[var(--text-dim)]">· {activeAgent.summary.status}</span>
          </span>
        ) : (
          <span className="text-[var(--text-faint)]">{t("footer.noAgent")}</span>
        )}
        <span className="text-[var(--text-dim)]">{t("footer.help")}</span>
      </footer>

      <PermissionDialog />
      <AskUserDialog />
      <DialogHost />
      <CommandPalette />
      <KeyHelpDialog />
      {tutorialOpen && <TutorialDialog onClose={() => setTutorialOpen(false)} />}
      {newTeamOpen && <NewTeamDialog onClose={() => setNewTeamOpen(false)} />}
      {globalSettingsOpen && (
        <GlobalSettings
          onClose={() => setGlobalSettingsOpen(false)}
          onShowUpdate={setUpdateState}
        />
      )}
      {updateState && (
        <UpdateDialog state={updateState} onClose={() => setUpdateState(null)} />
      )}
      {usageOpen && (
        <UsageStatsDialog
          onClose={() => setUsageOpen(false)}
          onOpenPricing={(model) => setPricingModel(model ?? "")}
          refreshKey={usageRefreshKey}
          onNavigateAgent={(id) => {
            setUsageOpen(false);
            if (activePaneId) attachAgentToPane(activePaneId, id);
          }}
        />
      )}
      {pricingModel !== null && (
        <PricingSettingsDialog
          initialModel={pricingModel || null}
          onClose={() => setPricingModel(null)}
          onSaved={() => setUsageRefreshKey((n) => n + 1)}
        />
      )}
      {newAgentOpen && (
        <NewAgentDialog
          defaultName={nextDefaultName}
          onClose={() => setNewAgentOpen(false)}
          onSubmit={({ name, providerId, model, codexWorkspace }) => {
            ws.send({
              type: "create_agent",
              name,
              ...(providerId ? { providerId } : {}),
              ...(model ? { model } : {}),
              ...(codexWorkspace ? { codexWorkspace } : {}),
            });
          }}
        />
      )}
    </div>
  );
}

function WorkspaceSelector({
  workspaces,
  currentId,
  onSelect,
  onCreate,
  onRename,
}: {
  workspaces: WorkspaceSummaryDTO[];
  currentId: string | null;
  onSelect: (id: string) => Promise<void>;
  onCreate: () => Promise<void>;
  onRename: () => Promise<void>;
}) {
  const t = useT();
  const cur = workspaces.find((w) => w.id === currentId);
  return (
    <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2 text-xs">
      <span className="text-[var(--text-faint)]">{t("ws.label")}</span>
      <select
        className="flex-1 bg-[var(--bg-pane)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] text-[var(--text)]"
        value={currentId ?? ""}
        onChange={(e) => {
          if (e.target.value) void onSelect(e.target.value);
        }}
      >
        {!cur && <option value="">{t("ws.placeholder")}</option>}
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <button
        title={t("ws.rename.title")}
        onClick={() => void onRename()}
        className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)]"
      >
        ✎
      </button>
      <button
        title={t("ws.new.title")}
        onClick={() => void onCreate()}
        className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)]"
      >
        +
      </button>
    </div>
  );
}

function useUptime(): string {
  // Stays "00:00:00" through SSR + first client paint; the interval kicks in
  // after mount, so server HTML and first client HTML match exactly.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    }, 1000);
    return () => window.clearInterval(t);
  }, []);
  const h = Math.floor(elapsed / 3600).toString().padStart(2, "0");
  const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, "0");
  const s = (elapsed % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}
