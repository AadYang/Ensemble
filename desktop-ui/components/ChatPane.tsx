"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getWS } from "@/lib/ws";
import {
  clearAgentContext,
  closeAgent,
  compactAgent,
  getAgentStatusReport,
  patchAgent,
  restartAgent,
} from "@/lib/agent-api";
import { listSkills, toggleAgentSkill } from "@/lib/skill-api";
import { listProviders, type ProviderDTO } from "@/lib/provider-api";
import { useStore, type ChatTurn } from "@/store/agents";
import { useT, type TranslateFn } from "@/i18n/useT";
import { ToolCard } from "./ToolCard";
import { PeerSendPopover } from "./PeerSendPopover";

// /model and /provider open a picker when invoked with no args (CLI-parity).
// Typed args bypass the picker (kept for muscle memory / scripting).
type PickerState =
  | { kind: "model"; items: string[]; cursor: number }
  | { kind: "provider"; items: ProviderDTO[]; cursor: number };

// Module-level stable empty array. Zustand selectors compare by reference;
// returning `[]` inline on every call creates a new ref → infinite re-render
// loop → React error #185 → whole app crashes to the Next.js "couldn't load"
// fallback. Same pattern would apply to any other "default to empty array"
// selector — always use a module-level constant.
const EMPTY_HISTORY: readonly string[] = Object.freeze([]);
const CHAT_INPUT_MAX_ROWS = 6;

const PEER_INCOMING_RE = /^\[(?:from|来自) ([^\]]+)\]\s*([\s\S]*)$/;
const PEER_OUTGOING_RE = /^→\s*(?:to|发往)\s+([^:]+):\s*([\s\S]*)$/;

// CLI-style ghost-text autocompletion for slash commands. Ordered to bias
// shorter / more common forms first when multiple match the typed prefix.
const SLASH_COMMAND_HINTS: readonly string[] = Object.freeze([
  "/help",
  "/clear",
  "/compact",
  "/cost",
  "/status",
  "/mcp",
  "/skills",
  "/skill enable ",
  "/skill disable ",
  "/skill auto ",
  "/model",
  "/model ",
  "/provider",
  "/provider ",
  "/close",
  "/restart",
  "/exit",
  "/quit",
]);

function pickSlashCompletion(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const lower = input.toLowerCase();
  for (const cmd of SLASH_COMMAND_HINTS) {
    if (cmd.toLowerCase().startsWith(lower) && cmd !== input) {
      return cmd.slice(input.length);
    }
  }
  return null;
}

/** Heuristic: pluck a "next step / question" sentence out of the agent's
 *  last assistant text so we can offer it as a ghost-text prefill when the
 *  user goes to type. Conservative — return null when nothing clearly
 *  invites a response. Cap at ~120 chars to stay reasonable as a one-line
 *  hint. */
function extractNextStepHint(text: string): string | null {
  if (!text) return null;
  // Sentence-ish split that respects both Latin and CJK terminators.
  const parts = text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 200);
  if (parts.length === 0) return null;

  const truncate = (s: string) => (s.length <= 120 ? s : s.slice(0, 119) + "…");
  // Prefer the last interrogative line.
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (/[?？]\s*$/.test(p)) return truncate(p);
  }
  // Else look for action-suggesting phrasing.
  const ACTION_KEYS = [
    "要不要", "下一步", "建议", "推荐", "可以", "需要我",
    "should i", "want me to", "shall i", "do you want",
    "want to ", "next step", "i can ", "try ", "next:",
  ];
  for (let i = parts.length - 1; i >= 0; i--) {
    const lower = parts[i]!.toLowerCase();
    if (ACTION_KEYS.some((k) => lower.includes(k))) return truncate(parts[i]!);
  }
  return null;
}

export function ChatPane({ agentId }: { agentId: string }) {
  const ws = getWS();
  const agent = useStore((s) => s.agents[agentId]);
  const totalAgents = useStore((s) => Object.keys(s.agents).length);
  const appendUserTurn = useStore((s) => s.appendUserTurn);
  const appendNotice = useStore((s) => s.appendNotice);
  const inputHistory = useStore((s) => s.inputHistory[agentId] ?? EMPTY_HISTORY);
  const pushInputHistory = useStore((s) => s.pushInputHistory);
  const input = useStore((s) => s.inputDrafts[agentId] ?? "");
  const inputSelection = useStore((s) => s.inputSelections[agentId] ?? null);
  const setInputDraft = useStore((s) => s.setInputDraft);
  const clearInputDraft = useStore((s) => s.clearInputDraft);
  const setInputSelection = useStore((s) => s.setInputSelection);
  const setUsageOpen = useStore((s) => s.setUsageOpen);
  const [peerOpen, setPeerOpen] = useState(false);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [providers, setProviders] = useState<ProviderDTO[]>([]);
  // CLI-style input history navigation.
  // historyIndex === null  →  not browsing; input is the live draft.
  // historyIndex 0..len-1  →  showing inputHistory[index]; draftRef holds
  //                            the text we left when entering history mode.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Next-step ghost hint: when a turn ends, scan the last assistant text for
  // a question / action-suggesting sentence. Show as ghost text in an empty
  // input box. Tab / RightArrow accepts. Cleared on send / type / dismiss /
  // agent switch.
  const [nextStepHint, setNextStepHint] = useState<string | null>(null);
  const lastSeenResultSeqRef = useRef<number>(-Infinity);
  const t = useT();
  const updateInput = useCallback((text: string) => setInputDraft(agentId, text), [agentId, setInputDraft]);

  // Reset history pointer + next-step hint when switching agents.
  useEffect(() => {
    setHistoryIndex(null);
    draftRef.current = "";
    setNextStepHint(null);
    lastSeenResultSeqRef.current = -Infinity;
  }, [agentId]);

  // Reader-speed auto-scroll. The old "jump to bottom on every update" felt
  // jarring on long streamed turns — you'd see a wall of text appear all at
  // once. Instead, animate scrollTop toward the bottom at roughly human
  // reading speed (~200 px/s baseline, adaptive up to 600 px/s when content
  // arrives faster than the eye can follow).
  //
  // Pause auto-follow if the user scrolls upward (they're reading something
  // earlier). Resume when they come back near the bottom.
  const followBottomRef = useRef(true);
  const rafIdRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const expectedTopRef = useRef(0);

  const kickScrollAnim = useCallback(() => {
    if (rafIdRef.current != null) return;
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      rafIdRef.current = null;
      const el = scrollRef.current;
      if (!el || !followBottomRef.current) return;
      const target = el.scrollHeight - el.clientHeight;
      const distance = target - el.scrollTop;
      if (distance <= 0.5) return;
      const dt = Math.min(0.1, (now - lastTickRef.current) / 1000);
      lastTickRef.current = now;
      // Catch up over ~2 seconds, bounded between 200 and 600 px/s.
      const speed = Math.min(600, Math.max(200, distance / 2));
      const step = Math.max(1, speed * dt);
      const nextTop = Math.min(target, el.scrollTop + step);
      el.scrollTop = nextTop;
      expectedTopRef.current = nextTop;
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  // Jump (no animation) to the bottom when switching agents. Animating
  // through 200 historical turns would be silly.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    expectedTopRef.current = el.scrollTop;
    followBottomRef.current = true;
  }, [agentId]);

  // Kick animation on turn count changes (new turn appended) — covers
  // tool_use rows, user turns, system rows, etc.
  useEffect(() => {
    if (followBottomRef.current) kickScrollAnim();
  }, [agent?.turns.length, kickScrollAnim]);

  // Watch the inner content for size changes so streaming deltas (which
  // extend the last turn in place and don't change turns.length) also
  // re-trigger the animation.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (followBottomRef.current) kickScrollAnim();
    });
    for (const child of Array.from(el.children)) ro.observe(child);
    ro.observe(el);
    return () => ro.disconnect();
  }, [agentId, kickScrollAnim]);

  // Distinguish user-initiated scroll from our own animated scroll. If the
  // observed scrollTop differs meaningfully from what the animation just
  // wrote, treat it as user input and toggle follow-mode.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const actual = el.scrollTop;
      if (Math.abs(actual - expectedTopRef.current) < 2) {
        expectedTopRef.current = actual;
        return;
      }
      expectedTopRef.current = actual;
      const distance = el.scrollHeight - el.clientHeight - actual;
      if (distance > 64) {
        followBottomRef.current = false;
      } else if (distance <= 8) {
        followBottomRef.current = true;
        kickScrollAnim();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [agentId, kickScrollAnim]);

  // Watch turns for a fresh `result` (turn-end marker). When we see one, walk
  // back to the most recent assistant_text and try to extract a next-step
  // hint. Track lastSeenResultSeq via a ref so we only fire once per result
  // even if React re-renders.
  useEffect(() => {
    const ts = agent?.turns;
    if (!ts || ts.length === 0) return;
    let latestResultIdx = -1;
    let latestResultSeq = lastSeenResultSeqRef.current;
    for (let i = ts.length - 1; i >= 0; i--) {
      if (ts[i]!.kind === "result" && ts[i]!.seq > latestResultSeq) {
        latestResultIdx = i;
        latestResultSeq = ts[i]!.seq;
        break;
      }
    }
    if (latestResultIdx < 0) return;
    lastSeenResultSeqRef.current = latestResultSeq;
    for (let j = latestResultIdx - 1; j >= 0; j--) {
      if (ts[j]!.kind === "assistant_text") {
        const hint = extractNextStepHint(ts[j]!.text);
        if (hint) setNextStepHint(hint);
        return;
      }
    }
  }, [agent?.turns]);

  useEffect(() => {
    void listProviders()
      .then(setProviders)
      .catch((err) => console.warn("listProviders failed", err));
  }, []);

  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    const verticalChrome = el.offsetHeight - el.clientHeight;
    const maxHeight = lineHeight * CHAT_INPUT_MAX_ROWS + verticalChrome;
    const nextHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeInput();
  }, [input, resizeInput]);

  const recordInputSelection = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    setInputSelection(agentId, {
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
    });
  }, [agentId, setInputSelection]);

  const restoreInputSelection = useCallback(() => {
    const el = inputRef.current;
    if (!el || !inputSelection) return;
    const start = Math.min(inputSelection.start, el.value.length);
    const end = Math.min(inputSelection.end, el.value.length);
    requestAnimationFrame(() => {
      if (document.activeElement === el) el.setSelectionRange(start, end);
    });
  }, [inputSelection]);

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] text-xs">
        {t("chat.notLoaded", { id: agentId.slice(0, 8) })}
      </div>
    );
  }

  const { summary, turns } = agent;

  const handleSlash = async (raw: string): Promise<void> => {
    // raw includes leading "/"
    const body = raw.slice(1);
    const spaceIdx = body.indexOf(" ");
    const cmd = (spaceIdx < 0 ? body : body.slice(0, spaceIdx)).toLowerCase();
    const arg = spaceIdx < 0 ? "" : body.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case "help": {
        appendNotice(agentId, t("slash.help"));
        return;
      }
      case "model": {
        const cur = providers.find((p) => p.id === summary.providerId);
        const available = cur?.models ?? [];
        if (!arg) {
          // CLI-parity: open picker. Caller closes the input field's blur loop.
          if (available.length === 0) {
            appendNotice(agentId, t("slash.model.noModels"));
            return;
          }
          const cursor = Math.max(0, available.indexOf(summary.model));
          setPicker({ kind: "model", items: available, cursor });
          return;
        }
        if (available.length > 0 && !available.includes(arg)) {
          appendNotice(
            agentId,
            t("slash.model.notFound", {
              name: arg,
              provider: cur?.name ?? "?",
              available: available.join(", "),
            }),
          );
          return;
        }
        try {
          await patchAgent(agentId, { model: arg });
          appendNotice(agentId, t("slash.model.applied", { name: arg }));
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      case "provider": {
        if (!arg) {
          if (providers.length === 0) {
            appendNotice(agentId, t("slash.provider.empty"));
            return;
          }
          const cursor = Math.max(
            0,
            providers.findIndex((p) => p.id === summary.providerId),
          );
          setPicker({ kind: "provider", items: providers, cursor });
          return;
        }
        const target =
          providers.find((p) => p.name === arg) ??
          providers.find((p) => p.name.toLowerCase() === arg.toLowerCase());
        if (!target) {
          appendNotice(
            agentId,
            t("slash.provider.notFound", {
              name: arg,
              available: providers.map((p) => p.name).join(", "),
            }),
          );
          return;
        }
        try {
          const nextModel = target.models[0] ?? summary.model;
          await patchAgent(agentId, { providerId: target.id, model: nextModel });
          appendNotice(agentId, t("slash.provider.applied", { name: target.name }));
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      case "close":
      case "exit":
      case "quit": {
        try {
          await closeAgent(agentId);
          appendNotice(agentId, t("slash.close.applied"));
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      case "restart": {
        try {
          await restartAgent(agentId);
          appendNotice(agentId, t("slash.restart.applied"));
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      case "clear": {
        try {
          await clearAgentContext(agentId);
          // The agent_history_reset broadcast already drops a "[context cleared]"
          // turn — don't double-notice.
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      case "compact": {
        appendNotice(agentId, t("slash.compact.starting"));
        try {
          await compactAgent(agentId);
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      case "cost":
      case "usage": {
        setUsageOpen(true);
        return;
      }
      case "status": {
        try {
          const s = await getAgentStatusReport(agentId);
          const lines = [
            `name=${s.name}`,
            `provider=${s.providerName ?? "(default)"} (${s.providerKind ?? "?"})`,
            `model=${s.model}`,
            `permissionMode=${s.permissionMode}`,
            s.providerKind === "openai-codex"
              ? `sandbox=${s.sandboxMode ?? "(inherit)"}`
              : null,
            s.codexWorkspace ? `codexWorkspace=${s.codexWorkspace}` : null,
            `messages=${s.messages}`,
            `enabledMcpServers=${s.enabledMcpServers}`,
            `resumeInfo=${s.hasResumeInfo ? "yes" : "no"}`,
            s.closed ? "closed=true" : null,
          ].filter(Boolean);
          appendNotice(agentId, lines.join("\n"));
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      case "skills": {
        try {
          const list = await listSkills();
          if (list.length === 0) {
            appendNotice(agentId, t("slash.skills.empty"));
            return;
          }
          const forced = new Set(summary.forcedSkills ?? []);
          const disabled = new Set(summary.disabledSkills ?? []);
          const lines = list.map((s) => {
            const status = forced.has(s.name)
              ? "forced"
              : disabled.has(s.name)
                ? "disabled"
                : "auto";
            return `${s.name} [${s.source}] (${status}) — ${s.description}`;
          });
          appendNotice(agentId, `skills (${list.length}):\n${lines.join("\n")}`);
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      case "skill": {
        const parts = arg.split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "").toLowerCase();
        const name = parts[1] ?? "";
        if (!["enable", "disable", "auto"].includes(sub) || !name) {
          appendNotice(agentId, t("slash.skill.usage"));
          return;
        }
        try {
          await toggleAgentSkill(agentId, name, sub as "enable" | "disable" | "auto");
          appendNotice(agentId, t("slash.skill.applied", { name, action: sub }));
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      case "mcp": {
        try {
          const res = await fetch("/api/mcp-servers");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const rows = (await res.json()) as Array<{
            id: string;
            name: string;
            transport: string;
            enabled: boolean;
            agentId: string | null;
          }>;
          const enabled = rows.filter((r) => r.enabled);
          if (enabled.length === 0) {
            appendNotice(agentId, t("slash.mcp.empty"));
            return;
          }
          const lines = enabled.map(
            (r) =>
              `${r.name} · ${r.transport}${r.agentId ? ` · agent=${r.agentId.slice(0, 8)}` : " · global"}`,
          );
          appendNotice(agentId, `enabled MCP servers (${enabled.length}):\n${lines.join("\n")}`);
        } catch (err) {
          appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
        }
        return;
      }
      default:
        appendNotice(agentId, t("slash.unknown", { cmd }));
        return;
    }
  };

  const onSend = (text: string) => {
    pushInputHistory(agentId, text);
    setHistoryIndex(null);
    draftRef.current = "";
    setNextStepHint(null);
    if (text.startsWith("/")) {
      void handleSlash(text);
      return;
    }
    if (summary.status !== "running") appendUserTurn(agentId, text);
    ws.send({ type: "send_message", sessionId: agentId, text });
  };
  const onCancel = () => ws.send({ type: "cancel", sessionId: agentId });

  const applyPickerSelection = async () => {
    if (!picker) return;
    try {
      if (picker.kind === "model") {
        const name = picker.items[picker.cursor];
        if (!name) return;
        await patchAgent(agentId, { model: name });
        appendNotice(agentId, t("slash.model.applied", { name }));
      } else {
        const target = picker.items[picker.cursor];
        if (!target) return;
        const nextModel = target.models[0] ?? summary.model;
        await patchAgent(agentId, { providerId: target.id, model: nextModel });
        appendNotice(agentId, t("slash.provider.applied", { name: target.name }));
      }
    } catch (err) {
      appendNotice(agentId, t("slash.error", { err: (err as Error).message }));
    } finally {
      setPicker(null);
      clearInputDraft(agentId);
    }
  };

  // Ghost-text completion candidate. Two sources, slash takes priority:
  //   1. /<prefix> → matched slash command suffix
  //   2. empty input → agent's last-turn next-step hint (full text)
  // For slash, we offer the SUFFIX (chars after the prefix); for next-step,
  // we offer the FULL text (replaces input on accept).
  const slashSuffix = pickSlashCompletion(input);
  const showNextStep = input === "" && nextStepHint !== null;
  const ghostSuffix: string | null = slashSuffix ?? (showNextStep ? nextStepHint! : null);

  const acceptGhost = () => {
    if (!ghostSuffix) return false;
    if (slashSuffix) {
      updateInput(input + slashSuffix);
    } else if (showNextStep && nextStepHint) {
      updateInput(nextStepHint);
      setNextStepHint(null);
    }
    // Defer focus + cursor-to-end so React's controlled-update commit lands first.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
    return true;
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab / RightArrow-at-end → accept ghost text (CLI-style).
    // Tab is unconditional (anywhere in the input). RightArrow only when the
    // cursor sits at the end of current input — otherwise users navigating
    // text would get hijacked.
    if (ghostSuffix && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      acceptGhost();
      return;
    }
    if (
      ghostSuffix &&
      e.key === "ArrowRight" &&
      e.currentTarget.selectionStart === input.length &&
      e.currentTarget.selectionEnd === input.length
    ) {
      e.preventDefault();
      acceptGhost();
      return;
    }
    if (ghostSuffix && e.key === "Escape" && (slashSuffix || showNextStep)) {
      // Esc dismisses the next-step hint specifically; slash suffix
      // disappears naturally when input no longer matches.
      e.preventDefault();
      setNextStepHint(null);
      return;
    }

    // Picker captures arrow nav + enter/escape.
    if (picker) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPicker({ ...picker, cursor: (picker.cursor - 1 + picker.items.length) % picker.items.length });
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPicker({ ...picker, cursor: (picker.cursor + 1) % picker.items.length });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        void applyPickerSelection();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPicker(null);
        return;
      }
      // Other keys fall through (typing closes picker via onChange below).
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (picker) return;
      const text = input.trim();
      if (!text) return;
      if (summary.closed && !text.startsWith("/")) return;
      onSend(text);
      clearInputDraft(agentId);
      return;
    }

    if (e.key === "ArrowUp") {
      if (inputHistory.length === 0) return;
      e.preventDefault();
      if (historyIndex === null) {
        draftRef.current = input;
        const idx = inputHistory.length - 1;
        setHistoryIndex(idx);
        updateInput(inputHistory[idx]!);
      } else if (historyIndex > 0) {
        const idx = historyIndex - 1;
        setHistoryIndex(idx);
        updateInput(inputHistory[idx]!);
      }
    } else if (e.key === "ArrowDown") {
      if (historyIndex === null) return;
      e.preventDefault();
      if (historyIndex < inputHistory.length - 1) {
        const idx = historyIndex + 1;
        setHistoryIndex(idx);
        updateInput(inputHistory[idx]!);
      } else {
        setHistoryIndex(null);
        updateInput(draftRef.current);
      }
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 py-1.5 border-b border-[var(--border)] flex items-center gap-2 text-xs">
        <span className={`status-dot ${summary.status}`} />
        <span className="font-bold">{summary.name}</span>
        <span className="text-[var(--text-dim)]">{summary.model}</span>
        <span className="text-[var(--text-dim)]">· {summary.status}</span>
        {summary.closed && (
          <span className="px-1.5 py-0.5 border border-[var(--warn)] text-[var(--warn)] text-[10px] tracking-wider">
            {t("chat.badge.closed")}
          </span>
        )}
        {summary.permissionMode === "plan" && (
          <span className="px-1.5 py-0.5 border border-[var(--warn)] text-[var(--warn)] text-[10px] tracking-wider">
            {t("chat.badge.plan")}
          </span>
        )}
        <span className="flex-1" />
        {totalAgents > 1 && (
          <button
            title={t("peer.btn.title")}
            onClick={() => setPeerOpen(true)}
            className="px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
          >
            @→
          </button>
        )}
        {summary.status === "running" && (
          <button
            className="px-2 py-0.5 border border-[var(--err)] text-[var(--err)] hover:bg-[var(--err)] hover:text-black transition-colors"
            onClick={onCancel}
          >
            {t("chat.cancel")}
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-0">
        {turns.length === 0 && (
          <div className="text-[var(--text-dim)] text-xs">{t("chat.empty")}</div>
        )}
        {turns.map((turn, i) => (
          <Turn key={i} t={turn} tr={t} />
        ))}
        {summary.status === "running" && <div className="stream-cursor h-4" />}
      </div>

      {picker && (
        <div className="border-t border-[var(--border)] bg-[var(--bg-elevated)] max-h-56 overflow-y-auto text-xs">
          <div className="px-2 py-1 text-[10px] tracking-wider text-[var(--text-faint)] border-b border-[var(--border)] flex items-center gap-2">
            <span>{picker.kind === "model" ? t("slash.picker.model") : t("slash.picker.provider")}</span>
            <span className="text-[var(--text-faint)]">{t("slash.picker.hint")}</span>
          </div>
          {picker.items.map((item, idx) => {
            const label = picker.kind === "model" ? (item as string) : `${(item as ProviderDTO).name} · ${(item as ProviderDTO).kind}`;
            const isCur = idx === picker.cursor;
            return (
              <div
                key={picker.kind === "model" ? (item as string) : (item as ProviderDTO).id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setPicker({ ...picker, cursor: idx });
                  void applyPickerSelection();
                }}
                className={`px-2 py-1 cursor-pointer ${isCur ? "bg-[var(--accent)] text-black" : "hover:bg-[var(--bg-pane)]"}`}
              >
                {label}
              </div>
            );
          })}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (picker) {
            // Enter while picker is open is handled by onInputKeyDown; the
            // form-submit path should be inert.
            return;
          }
          const text = input.trim();
          if (!text) return;
          onSend(text);
          clearInputDraft(agentId);
        }}
        className="border-t border-[var(--border)] p-2 flex items-end gap-2"
      >
        <div className="relative flex-1">
          {/* Ghost layer renders behind the textarea. Uses font-mono explicitly
              and matches input padding/border so the user-typed-text width
              measured by the invisible <span> aligns exactly with the visible
              text inside the textarea. Without `font-mono` on both, glyph
              widths drift slightly and the gray suffix appears misaligned. */}
          {ghostSuffix && (
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-[var(--bg-pane)] border border-[var(--border)] px-2 py-1 pointer-events-none whitespace-pre-wrap break-words overflow-hidden text-sm font-mono leading-[1.25rem]"
            >
              <span style={{ visibility: "hidden" }}>{input}</span>
              <span className="text-[var(--text-faint)] opacity-60">{ghostSuffix}</span>
            </div>
          )}
          <textarea
            ref={inputRef}
            className={`relative w-full ${
              ghostSuffix ? "bg-transparent" : "bg-[var(--bg-pane)]"
            } border border-[var(--border)] px-2 py-1 outline-none focus:border-[var(--accent)] text-sm font-mono leading-[1.25rem] resize-none min-h-[2rem] overflow-hidden align-bottom`}
            value={input}
            onChange={(e) => {
              updateInput(e.target.value);
              // Typing dismisses any active next-step hint — it was a
              // one-time offer. Slash suffix recomputes naturally from input.
              if (nextStepHint !== null && e.target.value !== "") setNextStepHint(null);
              // Typing exits picker AND history-browse mode (any letter key invalidates them).
              if (picker) setPicker(null);
              if (historyIndex !== null) {
                setHistoryIndex(null);
                draftRef.current = "";
              }
            }}
            onKeyDown={onInputKeyDown}
            onSelect={recordInputSelection}
            onClick={recordInputSelection}
            onKeyUp={recordInputSelection}
            onBlur={recordInputSelection}
            onFocus={restoreInputSelection}
            placeholder={ghostSuffix ? "" : picker ? t("slash.picker.placeholder") : t("chat.placeholder")}
            rows={1}
          />
        </div>
        <button
          type="submit"
          className="shrink-0 px-3 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
          disabled={
            !input.trim() ||
            (summary.closed && !input.trim().startsWith("/"))
          }
        >
          {t("chat.send")}
        </button>
      </form>

      {peerOpen && (
        <PeerSendPopover
          fromAgentId={agentId}
          onClose={() => setPeerOpen(false)}
        />
      )}
    </div>
  );
}

function Turn({ t, tr }: { t: ChatTurn; tr: TranslateFn }) {
  if (t.kind === "tool_use") {
    return <ToolCard name={t.toolName ?? "tool"} input={t.toolInput} />;
  }

  const tagColor =
    t.kind === "user" ? "text-[var(--accent)]" :
    t.kind === "assistant_text" ? "text-[var(--text)]" :
    t.kind === "result" ? "text-[var(--ok)]" :
    "text-[var(--text-dim)]";
  const prefix =
    t.kind === "user" ? "> " :
    t.kind === "assistant_text" ? "" :
    t.kind === "result" ? "✓ " :
    "· ";

  // Peer-relayed user messages: structured (modes) win over legacy regex (raw).
  let body = t.text;
  let marker: string | null = null;
  let modeColor = "text-[var(--warn)]";
  if (t.kind === "user") {
    if (t.peerOrigin) {
      const { direction, fromName, mode } = t.peerOrigin;
      const namePart = direction === "in"
        ? tr("peer.fromMarker", { name: fromName })
        : tr("peer.toMarker", { name: fromName });
      const modeIcon = mode === "review" ? "🔍" : mode === "continue" ? "↪" : mode === "fork" ? "⑂" : "←";
      const modeLabel = mode === "raw" ? "" : ` · ${tr(`peer.mode.${mode}`)}`;
      marker = `${modeIcon} ${namePart}${modeLabel}`;
      modeColor =
        mode === "review" ? "text-purple-400" :
        mode === "continue" ? "text-blue-400" :
        mode === "fork" ? "text-orange-400" :
        "text-[var(--warn)]";
    } else {
      const inc = PEER_INCOMING_RE.exec(t.text);
      const out = inc ? null : PEER_OUTGOING_RE.exec(t.text);
      if (inc) {
        marker = tr("peer.fromMarker", { name: inc[1] ?? "" });
        body = inc[2] ?? "";
      } else if (out) {
        marker = tr("peer.toMarker", { name: out[1]?.trim() ?? "" });
        body = out[2] ?? "";
      }
    }
  }

  return (
    <div className={`whitespace-pre-wrap break-words ${tagColor}`}>
      {marker && (
        <span className={`text-[10px] tracking-wider ${modeColor} mr-2`}>{marker}</span>
      )}
      {prefix}{body}
    </div>
  );
}
