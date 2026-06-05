"use client";

import { create } from "zustand";
import {
  clearAgentFromTree,
  closePane,
  listLeaves,
  resize,
  resizeSplit,
  setPaneAgent,
  splitPane,
  type AgentStatus,
  type AgentSummary,
  type FocusDirection,
  type LayoutNode,
  type LayoutWindow,
  type LayoutWorkspace,
  type PeerMode,
  type SdkMessage,
  type SplitDir,
  type TeamSummary,
} from "@agentorch/shared";
import type { Locale } from "@/i18n/dict";

const LOCALE_KEY = "ensemble:locale";

export interface PeerOrigin {
  direction: "in" | "out";
  fromName: string;
  mode: PeerMode;
}

export interface ChatTurn {
  seq: number;
  kind: "user" | "assistant_text" | "tool_use" | "system" | "result" | "raw";
  text: string;
  toolName?: string;
  toolInput?: unknown;
  streaming?: boolean;
  peerOrigin?: PeerOrigin;
}

export interface AgentState {
  summary: AgentSummary;
  turns: ChatTurn[];
}

export interface PendingPermission {
  sessionId: string;
  reqId: string;
  toolName: string;
  input: unknown;
  receivedAt: number;
}

export interface PendingUserQuestion {
  sessionId: string;
  reqId: string;
  question: string;
  options: string[];
  receivedAt: number;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: string;
}

interface Store {
  connected: boolean;
  setConnected: (b: boolean) => void;

  agents: Record<string, AgentState>;
  activeId: string | null;
  setActive: (id: string | null) => void;

  workspaces: WorkspaceSummary[];
  currentWorkspaceId: string | null;
  setWorkspaces: (list: WorkspaceSummary[]) => void;
  setCurrentWorkspace: (id: string | null) => void;

  windows: LayoutWindow[];
  activeWindowId: string;

  setLayout: (layout: LayoutWorkspace) => void;

  setActivePane: (paneId: string) => void;
  splitActive: (dir: SplitDir) => void;
  closeActive: () => void;
  resizeSplitTo: (splitId: string, ratio: number) => void;
  resizeActivePane: (dir: FocusDirection, delta: number) => void;
  attachAgentToPane: (paneId: string, agentId: string | null) => void;

  createWindow: (name?: string) => void;
  closeWindow: (id: string) => void;
  setActiveWindow: (id: string) => void;
  cycleWindow: (direction: "next" | "prev") => void;
  renameWindow: (id: string, name: string) => void;

  upsertAgent: (a: AgentSummary) => void;
  removeAgent: (id: string) => void;
  setStatus: (id: string, status: AgentStatus) => void;
  appendUserTurn: (id: string, text: string, peerOrigin?: PeerOrigin) => void;
  appendNotice: (id: string, text: string) => void;
  ingestSdkMessage: (id: string, seq: number, msg: SdkMessage) => void;
  appendError: (id: string | null, code: string, message: string) => void;

  /** Per-agent buffer of user-typed inputs (only what was sent via the
   *  ChatPane input field — NOT peer-handoff incoming or system notices).
   *  Used for CLI-style Up/Down history walking. In-memory only; resets on
   *  page reload. */
  inputHistory: Record<string, string[]>;
  pushInputHistory: (agentId: string, text: string) => void;

  pendingPermissions: PendingPermission[];
  addPermissionRequest: (p: PendingPermission) => void;
  clearPermissionRequest: (reqId: string) => void;

  pendingUserQuestions: PendingUserQuestion[];
  addUserQuestion: (q: PendingUserQuestion) => void;
  clearUserQuestion: (reqId: string) => void;

  paletteOpen: boolean;
  setPaletteOpen: (b: boolean) => void;

  /** /cost slash + toolbar both flip this. */
  usageOpen: boolean;
  setUsageOpen: (b: boolean) => void;

  /** Tutorial dialog visibility (toolbar ⓘ button). */
  tutorialOpen: boolean;
  setTutorialOpen: (b: boolean) => void;

  /** Server broadcast on /clear or /compact — wipe local turns and (compact
   *  only) drop a notice carrying the summary so the user sees what survived. */
  resetAgentHistory: (id: string, reason: "clear" | "compact", summary?: string) => void;

  /** W21: team registry keyed by team id. Refreshed via listTeams() on
   *  connect and patched by team_created / team_updated / team_deleted WS
   *  messages. */
  teams: Record<string, TeamSummary>;
  setTeams: (list: TeamSummary[]) => void;
  upsertTeam: (t: TeamSummary) => void;
  removeTeam: (id: string) => void;

  helpOpen: boolean;
  setHelpOpen: (b: boolean) => void;

  locale: Locale;
  setLocale: (l: Locale) => void;
}

const newId = (prefix: string): string =>
  `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;

const findFirstLeafId = (n: LayoutNode): string =>
  n.kind === "pane" ? n.id : findFirstLeafId(n.a);

const initialWindow: LayoutWindow = {
  id: "w-default",
  name: "main",
  root: { kind: "pane", id: "p-root", agentId: null },
  activePaneId: "p-root",
};

const PEER_HANDOFF_RE =
  /^<peer-handoff[^>]*>\n[\s\S]*?\n---\n([\s\S]*?)\n---\n<\/peer-handoff>(?:\n\n([\s\S]*))?$/;

function stripPeerHandoff(text: string): string | null {
  const m = PEER_HANDOFF_RE.exec(text);
  return m ? (m[1] ?? null) : null;
}

const sdkMessageToTurn = (seq: number, msg: SdkMessage): ChatTurn | null => {
  switch (msg.type) {
    case "assistant": {
      const blocks = (msg as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } }).message?.content ?? [];
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("");
      const toolUse = blocks.find((b) => b.type === "tool_use");
      if (text) return { seq, kind: "assistant_text", text };
      if (toolUse) {
        return {
          seq,
          kind: "tool_use",
          text: `${toolUse.name ?? "tool"}(...)`,
          toolName: toolUse.name as string | undefined,
          toolInput: toolUse.input,
        };
      }
      return { seq, kind: "raw", text: `[assistant]` };
    }
    case "result": {
      const subtype = (msg as { subtype?: string }).subtype ?? "";
      return { seq, kind: "result", text: `result · ${subtype}` };
    }
    case "system":
      return { seq, kind: "system", text: `system · ${(msg as { subtype?: string }).subtype ?? ""}` };
    case "stream_event":
    case "rate_limit_event":
    case "user":
      return null;
    default:
      return { seq, kind: "raw", text: `[${(msg as { type: string }).type}]` };
  }
};

const updateActiveWindow = (
  s: { windows: LayoutWindow[]; activeWindowId: string },
  mutator: (w: LayoutWindow) => LayoutWindow,
): { windows: LayoutWindow[] } | null => {
  const idx = s.windows.findIndex((w) => w.id === s.activeWindowId);
  if (idx < 0) return null;
  const cur = s.windows[idx]!;
  const next = mutator(cur);
  if (next === cur) return null;
  const newWindows = s.windows.slice();
  newWindows[idx] = next;
  return { windows: newWindows };
};

export const useStore = create<Store>((set) => ({
  connected: false,
  setConnected: (b) => set({ connected: b }),

  agents: {},
  activeId: null,
  setActive: (id) => set({ activeId: id }),

  workspaces: [],
  currentWorkspaceId: null,
  setWorkspaces: (list) => set({ workspaces: list }),
  setCurrentWorkspace: (id) => set({ currentWorkspaceId: id }),

  windows: [initialWindow],
  activeWindowId: initialWindow.id,

  setLayout: (layout) =>
    set(() => ({
      windows: layout.windows,
      activeWindowId: layout.activeWindowId,
    })),

  setActivePane: (paneId) =>
    set((s) => {
      const result = updateActiveWindow(s, (w) =>
        w.activePaneId === paneId ? w : { ...w, activePaneId: paneId },
      );
      return result ?? s;
    }),

  splitActive: (dir) =>
    set((s) => {
      const newPaneId = newId("p");
      const splitId = newId("s");
      const result = updateActiveWindow(s, (w) => {
        const nextRoot = splitPane(w.root, w.activePaneId, dir, { newPaneId, splitId });
        if (nextRoot === w.root) return w;
        return { ...w, root: nextRoot, activePaneId: newPaneId };
      });
      return result ?? s;
    }),

  closeActive: () =>
    set((s) => {
      const result = updateActiveWindow(s, (w) => {
        const nextRoot = closePane(w.root, w.activePaneId);
        if (nextRoot === null) return w; // refuse to close last pane in window
        if (nextRoot === w.root) return w;
        const remaining = listLeaves(nextRoot);
        const firstId = remaining[0]?.id ?? w.activePaneId;
        return { ...w, root: nextRoot, activePaneId: firstId };
      });
      return result ?? s;
    }),

  resizeSplitTo: (splitId, ratio) =>
    set((s) => {
      const result = updateActiveWindow(s, (w) => {
        const nextRoot = resizeSplit(w.root, splitId, ratio);
        return nextRoot === w.root ? w : { ...w, root: nextRoot };
      });
      return result ?? s;
    }),

  resizeActivePane: (dir, delta) =>
    set((s) => {
      const result = updateActiveWindow(s, (w) => {
        const nextRoot = resize(w.root, w.activePaneId, dir, delta);
        return nextRoot === w.root ? w : { ...w, root: nextRoot };
      });
      return result ?? s;
    }),

  attachAgentToPane: (paneId, agentId) =>
    set((s) => {
      // Detach is a single-window edit (agentId === null only clears the named pane).
      if (agentId === null) {
        const result = updateActiveWindow(s, (w) => {
          const nextRoot = setPaneAgent(w.root, paneId, null);
          return nextRoot === w.root ? w : { ...w, root: nextRoot };
        });
        return result ?? s;
      }
      // Attach: enforce single binding by clearing this agentId from EVERY window first,
      // then setting it on the target pane in the active window.
      const cleared = s.windows.map((w) => {
        const nextRoot = clearAgentFromTree(w.root, agentId);
        return nextRoot === w.root ? w : { ...w, root: nextRoot };
      });
      const idx = cleared.findIndex((w) => w.id === s.activeWindowId);
      if (idx < 0) return cleared === s.windows ? s : { windows: cleared };
      const cur = cleared[idx]!;
      const newRoot = setPaneAgent(cur.root, paneId, agentId);
      const nextWindows = cleared.slice();
      nextWindows[idx] = newRoot === cur.root ? cur : { ...cur, root: newRoot };
      return { windows: nextWindows };
    }),

  createWindow: (name) =>
    set((s) => {
      const wid = newId("w");
      const pid = newId("p");
      const win: LayoutWindow = {
        id: wid,
        name: name?.trim() || `window-${s.windows.length + 1}`,
        root: { kind: "pane", id: pid, agentId: null },
        activePaneId: pid,
      };
      return { windows: [...s.windows, win], activeWindowId: wid };
    }),

  closeWindow: (id) =>
    set((s) => {
      if (s.windows.length <= 1) return s; // refuse to close last window
      const idx = s.windows.findIndex((w) => w.id === id);
      if (idx < 0) return s;
      const newWindows = s.windows.filter((w) => w.id !== id);
      const activeWindowId =
        s.activeWindowId === id
          ? (newWindows[Math.max(0, idx - 1)]?.id ?? newWindows[0]!.id)
          : s.activeWindowId;
      return { windows: newWindows, activeWindowId };
    }),

  setActiveWindow: (id) =>
    set((s) => (s.activeWindowId === id ? s : { activeWindowId: id })),

  cycleWindow: (direction) =>
    set((s) => {
      if (s.windows.length <= 1) return s;
      const idx = s.windows.findIndex((w) => w.id === s.activeWindowId);
      if (idx < 0) return s;
      const step = direction === "next" ? 1 : -1;
      const next = s.windows[(idx + step + s.windows.length) % s.windows.length]!;
      return { activeWindowId: next.id };
    }),

  renameWindow: (id, name) =>
    set((s) => {
      const idx = s.windows.findIndex((w) => w.id === id);
      if (idx < 0) return s;
      const cur = s.windows[idx]!;
      if (cur.name === name) return s;
      const newWindows = s.windows.slice();
      newWindows[idx] = { ...cur, name };
      return { windows: newWindows };
    }),

  upsertAgent: (a) =>
    set((s) => {
      const existing = s.agents[a.id];
      const turns = existing?.turns ?? [];
      // Auto-attach to active pane if it's empty.
      const result = updateActiveWindow(s, (w) => {
        const leaves = listLeaves(w.root);
        const activeEmpty = leaves.find((l) => l.id === w.activePaneId)?.agentId == null;
        if (!activeEmpty) return w;
        const nextRoot = setPaneAgent(w.root, w.activePaneId, a.id);
        return nextRoot === w.root ? w : { ...w, root: nextRoot };
      });
      return {
        agents: { ...s.agents, [a.id]: { summary: a, turns } },
        activeId: s.activeId ?? a.id,
        ...(result ?? {}),
      };
    }),

  removeAgent: (id) =>
    set((s) => {
      if (!s.agents[id]) return s;
      const { [id]: _, ...rest } = s.agents;
      // Detach from every pane in every window.
      const windows = s.windows.map((w) => {
        const nextRoot = clearAgentFromTree(w.root, id);
        return nextRoot === w.root ? w : { ...w, root: nextRoot };
      });
      return {
        agents: rest,
        windows,
        activeId: s.activeId === id ? null : s.activeId,
      };
    }),

  setStatus: (id, status) =>
    set((s) => {
      const ag = s.agents[id];
      if (!ag) return s;
      return { agents: { ...s.agents, [id]: { ...ag, summary: { ...ag.summary, status } } } };
    }),

  appendUserTurn: (id, text, peerOrigin) =>
    set((s) => {
      const ag = s.agents[id];
      if (!ag) return s;
      const seq = ag.turns.length > 0 ? ag.turns[ag.turns.length - 1]!.seq + 0.5 : -1;
      const turn: ChatTurn = peerOrigin
        ? { seq, kind: "user", text, peerOrigin }
        : { seq, kind: "user", text };
      return { agents: { ...s.agents, [id]: { ...ag, turns: [...ag.turns, turn] } } };
    }),

  appendNotice: (id, text) =>
    set((s) => {
      const ag = s.agents[id];
      if (!ag) return s;
      const seq = ag.turns.length > 0 ? ag.turns[ag.turns.length - 1]!.seq + 0.5 : -1;
      const turn: ChatTurn = { seq, kind: "raw", text };
      return { agents: { ...s.agents, [id]: { ...ag, turns: [...ag.turns, turn] } } };
    }),

  inputHistory: {},
  pushInputHistory: (agentId, text) =>
    set((s) => {
      const HISTORY_CAP = 200;
      const prev = s.inputHistory[agentId] ?? [];
      // Skip consecutive duplicates (bash HISTCONTROL=ignoredups semantic).
      if (prev.length > 0 && prev[prev.length - 1] === text) return s;
      const next = [...prev, text];
      const trimmed = next.length > HISTORY_CAP ? next.slice(-HISTORY_CAP) : next;
      return { inputHistory: { ...s.inputHistory, [agentId]: trimmed } };
    }),

  ingestSdkMessage: (id, seq, msg) =>
    set((s) => {
      const ag = s.agents[id];
      if (!ag) return s;

      if (msg.type === "stream_event") {
        const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
        if (
          ev?.type === "content_block_delta" &&
          ev.delta?.type === "text_delta" &&
          typeof ev.delta.text === "string"
        ) {
          const turns = ag.turns.slice();
          const last = turns[turns.length - 1];
          if (last && last.kind === "assistant_text" && last.streaming) {
            turns[turns.length - 1] = { ...last, text: last.text + ev.delta.text };
          } else {
            turns.push({ seq, kind: "assistant_text", text: ev.delta.text, streaming: true });
          }
          return { agents: { ...s.agents, [id]: { ...ag, turns } } };
        }
        return s;
      }

      if (msg.type === "assistant") {
        const blocks =
          (msg as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } })
            .message?.content ?? [];
        const text = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text!)
          .join("");
        if (text) {
          const turns = ag.turns.slice();
          const last = turns[turns.length - 1];
          const finalized: ChatTurn = { seq, kind: "assistant_text", text };
          if (last && last.kind === "assistant_text" && last.streaming) {
            turns[turns.length - 1] = finalized;
          } else {
            turns.push(finalized);
          }
          return { agents: { ...s.agents, [id]: { ...ag, turns } } };
        }
      }

      if (msg.type === "user") {
        // SDK echoes user input (and sometimes tool_result wrapping). Surface text-only
        // payloads so peer-relayed messages and history replay become visible. Dedupe
        // against the optimistic appendUserTurn that the local sender already pushed.
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .map((b) =>
              typeof b === "string"
                ? b
                : b && typeof b === "object" && "type" in b && (b as { type: string }).type === "text"
                  ? ((b as { text?: string }).text ?? "")
                  : "",
            )
            .join("");
        }
        if (!text) return s;

        // Peer handoff: server attaches `_peerOrigin` for non-raw modes; raw mode
        // stays on the legacy `[from X] body` text format (parsed in ChatPane).
        let peerOrigin: PeerOrigin | undefined;
        const peerMeta = (msg as { _peerOrigin?: { fromAgentName: string; mode: PeerMode } })._peerOrigin;
        if (peerMeta && typeof peerMeta === "object") {
          peerOrigin = { direction: "in", fromName: peerMeta.fromAgentName, mode: peerMeta.mode };
          const stripped = stripPeerHandoff(text);
          if (stripped) text = stripped;
        }

        const last = ag.turns[ag.turns.length - 1];
        if (last && last.kind === "user" && last.text === text) return s;
        const turn: ChatTurn = peerOrigin
          ? { seq, kind: "user", text, peerOrigin }
          : { seq, kind: "user", text };
        return { agents: { ...s.agents, [id]: { ...ag, turns: [...ag.turns, turn] } } };
      }

      const turn = sdkMessageToTurn(seq, msg);
      if (!turn) return s;
      return { agents: { ...s.agents, [id]: { ...ag, turns: [...ag.turns, turn] } } };
    }),

  appendError: (id, code, message) =>
    set((s) => {
      if (!id) return s;
      const ag = s.agents[id];
      if (!ag) return s;
      const seq = ag.turns.length > 0 ? ag.turns[ag.turns.length - 1]!.seq + 0.5 : -1;
      const turn: ChatTurn = { seq, kind: "raw", text: `error · ${code} · ${message}` };
      return { agents: { ...s.agents, [id]: { ...ag, turns: [...ag.turns, turn] } } };
    }),

  pendingPermissions: [],
  addPermissionRequest: (p) =>
    set((s) =>
      s.pendingPermissions.some((x) => x.reqId === p.reqId)
        ? s
        : { pendingPermissions: [...s.pendingPermissions, p] },
    ),
  clearPermissionRequest: (reqId) =>
    set((s) => {
      const next = s.pendingPermissions.filter((x) => x.reqId !== reqId);
      if (next.length === s.pendingPermissions.length) return s;
      return { pendingPermissions: next };
    }),

  pendingUserQuestions: [],
  addUserQuestion: (q) =>
    set((s) =>
      s.pendingUserQuestions.some((x) => x.reqId === q.reqId)
        ? s
        : { pendingUserQuestions: [...s.pendingUserQuestions, q] },
    ),
  clearUserQuestion: (reqId) =>
    set((s) => {
      const next = s.pendingUserQuestions.filter((x) => x.reqId !== reqId);
      if (next.length === s.pendingUserQuestions.length) return s;
      return { pendingUserQuestions: next };
    }),

  paletteOpen: false,
  setPaletteOpen: (b) => set({ paletteOpen: b }),

  usageOpen: false,
  setUsageOpen: (b) => set({ usageOpen: b }),

  tutorialOpen: false,
  setTutorialOpen: (b) => set({ tutorialOpen: b }),

  teams: {},
  setTeams: (list) =>
    set(() => {
      const teams: Record<string, TeamSummary> = {};
      for (const t of list) teams[t.id] = t;
      return { teams };
    }),
  upsertTeam: (t) => set((s) => ({ teams: { ...s.teams, [t.id]: t } })),
  removeTeam: (id) =>
    set((s) => {
      const { [id]: _drop, ...rest } = s.teams;
      void _drop;
      return { teams: rest };
    }),

  resetAgentHistory: (id, reason, summary) =>
    set((s) => {
      const ag = s.agents[id];
      if (!ag) return s;
      const turns: ChatTurn[] = [];
      if (reason === "compact" && summary) {
        turns.push({ seq: 0, kind: "raw", text: `[context compacted] ${summary}` });
      } else {
        turns.push({ seq: 0, kind: "raw", text: reason === "compact" ? "[context compacted]" : "[context cleared]" });
      }
      const summaryStatus = reason === "clear" ? "idle" : ag.summary.status;
      return {
        agents: {
          ...s.agents,
          [id]: {
            ...ag,
            turns,
            summary: { ...ag.summary, status: summaryStatus, hasResumeInfo: false },
          },
        },
        inputHistory: { ...s.inputHistory, [id]: [] },
      };
    }),

  helpOpen: false,
  setHelpOpen: (b) => set({ helpOpen: b }),

  // Initial value MUST match what SSR rendered (always "zh") to avoid hydration
  // mismatch. The real persisted choice (if any) is restored client-side via
  // hydrateLocale(); upgrades preserve it because localStorage lives in the
  // Tauri webview data dir, not the installer-managed program files.
  locale: "zh",
  setLocale: (l) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCALE_KEY, l);
    }
    set({ locale: l });
  },
}));

export const selectActiveWindow = (s: Store): LayoutWindow | undefined =>
  s.windows.find((w) => w.id === s.activeWindowId);

/** Read the persisted locale from localStorage and apply it. Call ONCE on mount
 * from a top-level client component — never during render or SSR. */
export const hydrateLocaleFromStorage = (): void => {
  if (typeof window === "undefined") return;
  const stored = window.localStorage.getItem(LOCALE_KEY);
  if (stored === "zh" || stored === "en") {
    useStore.getState().setLocale(stored);
  }
};
