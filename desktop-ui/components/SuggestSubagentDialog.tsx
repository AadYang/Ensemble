"use client";

import { useEffect, useState } from "react";
import { getWS } from "@/lib/ws";
import { suggestSubagents, type SubagentSuggestion } from "@/lib/agent-api";
import { useT } from "@/i18n/useT";

// W14 v2: subagent suggestion dialog.
// - 4-card layout: 3 model-driven recommendations + 1 always-on "create from
//   scratch" anchor (per design §6 "永驻第 4 位").
// - 15s client-side timeout (matches server abort); on timeout / network
//   error we silently fall back to whatever the user can do via the static
//   "create from scratch" card. No error toast.
// - Click a recommendation card → prompt for a name (defaulting to the
//   display name) → fire create_agent with parentId + the inflated
//   systemPrompt. The user can rename, but for v1 we don't expose an inline
//   systemPrompt editor here — the model gave us a workable one and the
//   user can edit in AgentSettings after creation.

const TIMEOUT_MS = 15_000;

type Card =
  | { kind: "skeleton" }
  | { kind: "suggestion"; suggestion: SubagentSuggestion }
  | { kind: "scratch" };

interface Props {
  parentId: string;
  parentName: string;
  onClose: () => void;
}

export function SuggestSubagentDialog({ parentId, parentName, onClose }: Props) {
  const t = useT();
  const ws = getWS();
  const [cards, setCards] = useState<Card[]>([
    { kind: "skeleton" },
    { kind: "skeleton" },
    { kind: "skeleton" },
    { kind: "scratch" },
  ]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    (async () => {
      try {
        const suggestions = await suggestSubagents(parentId, controller.signal);
        const filled: Card[] = [];
        for (let i = 0; i < 3; i++) {
          if (suggestions[i]) filled.push({ kind: "suggestion", suggestion: suggestions[i] });
          else filled.push({ kind: "skeleton" });
        }
        filled.push({ kind: "scratch" });
        setCards(filled);
      } catch (err) {
        // Per design §1 "失败兜底": silently swap skeletons for static
        // catalog hints from the catalog fetch, no error toast. We surface a
        // tiny note inside the dialog instead.
        console.warn("suggestSubagents failed", err);
        setError(t("suggest.fellBack"));
        // Replace skeletons with a single "create from scratch" prompt — the
        // user can always proceed via the scratch card; we don't need to
        // synthesize fake recommendations.
        setCards([{ kind: "scratch" }, { kind: "scratch" }, { kind: "scratch" }, { kind: "scratch" }]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [parentId, t]);

  const onPick = (card: Card) => {
    if (card.kind === "skeleton") return;
    if (card.kind === "scratch") {
      // Fall through to the original "+ child" prompt-and-send flow via WS.
      const name = window.prompt(t("suggest.namePrompt"), t("settings.spawnChild.default"));
      if (!name?.trim()) return;
      ws.send({ type: "create_agent", name: name.trim(), parentId });
      onClose();
      return;
    }
    const defaultName = card.suggestion.displayName.toLowerCase().replace(/\s+/g, "-");
    const name = window.prompt(
      t("suggest.namePromptForRole", { role: card.suggestion.displayName }),
      defaultName,
    );
    if (!name?.trim()) return;
    ws.send({
      type: "create_agent",
      name: name.trim(),
      parentId,
      systemPrompt: card.suggestion.systemPrompt,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6">
      <div className="tool-card w-full max-w-3xl bg-[var(--bg-elevated)]">
        <div className="flex items-center gap-2 mb-3 text-xs">
          <span className="text-[var(--accent)] tracking-wider">{t("suggest.title")}</span>
          <span className="text-[var(--text-faint)]">
            {t("suggest.parentLabel")}{" "}
            <span className="text-[var(--text)]">{parentName}</span>
          </span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            className="px-1.5 py-0.5 text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)] border border-[var(--border)] transition-colors"
          >
            ✕
          </button>
        </div>
        {error && (
          <div className="text-[10px] text-[var(--warn)] leading-snug mb-2 px-1">{error}</div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {cards.map((card, i) => (
            <CardView key={i} card={card} onPick={() => onPick(card)} t={t} />
          ))}
        </div>
      </div>
    </div>
  );
}

function CardView({
  card,
  onPick,
  t,
}: {
  card: Card;
  onPick: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  if (card.kind === "skeleton") {
    return (
      <div className="border border-[var(--border)] bg-[var(--bg-pane)] p-3 min-h-[88px] flex flex-col gap-2">
        <div className="h-3 bg-[var(--border)] animate-pulse w-1/3" />
        <div className="h-2 bg-[var(--border)] animate-pulse w-full" />
        <div className="h-2 bg-[var(--border)] animate-pulse w-4/5" />
      </div>
    );
  }
  if (card.kind === "scratch") {
    return (
      <button
        onClick={onPick}
        className="text-left border border-dashed border-[var(--border)] bg-[var(--bg-pane)] p-3 min-h-[88px] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
      >
        <div className="text-xs tracking-wider mb-1">+ {t("suggest.scratchTitle")}</div>
        <div className="text-[10px] text-[var(--text-faint)] leading-tight">{t("suggest.scratchHint")}</div>
      </button>
    );
  }
  const { suggestion } = card;
  // Show the first ~120 chars of the inflated systemPrompt as a preview so
  // the user knows what they'll get; full prompt is in the agent post-create.
  const preview = suggestion.systemPrompt.length > 120
    ? suggestion.systemPrompt.slice(0, 120) + "…"
    : suggestion.systemPrompt;
  return (
    <button
      onClick={onPick}
      className="text-left border border-[var(--border)] bg-[var(--bg-pane)] p-3 min-h-[88px] hover:border-[var(--accent)] transition-colors"
    >
      <div className="text-xs text-[var(--accent)] tracking-wider mb-1">{suggestion.displayName}</div>
      <div className="text-[10px] text-[var(--text-dim)] leading-snug">{preview}</div>
    </button>
  );
}
