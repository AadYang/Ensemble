"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getCliSettings, type CliHealth } from "@/lib/settings-api";

type ReminderItem =
  | { kind: "missing"; health: CliHealth }
  | { kind: "upgrade"; health: CliHealth };

function collectReminderItems(rows: CliHealth[]): ReminderItem[] {
  const items: ReminderItem[] = [];
  for (const health of rows) {
    if (!health.found) items.push({ kind: "missing", health });
    else if (health.versionTooOld) items.push({ kind: "upgrade", health });
  }
  return items;
}

export function CliInstallReminder() {
  const [mounted, setMounted] = useState(false);
  const [items, setItems] = useState<ReminderItem[]>([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    void getCliSettings()
      .then((health) => {
        if (cancelled) return;
        const next = collectReminderItems([health.claude, health.codex]);
        setItems(next);
        setOpen(next.length > 0);
      })
      .catch((err) => {
        console.warn("CLI install reminder check failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [mounted]);

  const primaryItem = items[0] ?? null;
  const primaryCommand = useMemo(() => {
    if (!primaryItem) return "";
    if (primaryItem.kind === "upgrade") {
      return primaryItem.health.recommendedUpgradeCommand ?? primaryItem.health.recommendedInstallCommand;
    }
    return primaryItem.health.recommendedInstallCommand;
  }, [primaryItem]);

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
    } catch {
      setCopied("clipboard unavailable");
    }
  };

  if (!mounted || !open || items.length === 0) return null;

  const dialog = (
    <div className="fixed inset-0 z-[9998] pointer-events-none flex items-start justify-center p-4 pt-16">
      <div className="tool-card pointer-events-auto w-[520px] max-w-full bg-[var(--bg-elevated)] shadow-2xl shadow-black/50 text-xs">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[var(--warn)]">!</span>
          <span className="text-[var(--text-dim)] tracking-wider">CLI setup needed</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-1.5 text-[var(--text-faint)] hover:text-[var(--text)]"
            title="Remind me later"
          >
            x
          </button>
        </div>
        <div className="p-3 flex flex-col gap-3">
          <div className="text-[var(--text-dim)] leading-snug">
            Ensemble uses the official local CLIs. Missing CLIs are not installed automatically.
          </div>
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <CliReminderRow
                key={item.health.kind}
                item={item}
                copied={copied}
                onCopy={copyCommand}
              />
            ))}
          </div>
          {primaryCommand && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void copyCommand(primaryCommand)}
                className="flex-1 px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors"
              >
                copy install command
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
              >
                remind later
              </button>
            </div>
          )}
          {copied && (
            <div className={copied === "clipboard unavailable" ? "text-[var(--err)]" : "text-[var(--ok)]"}>
              {copied === "clipboard unavailable" ? copied : "copied"}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

function CliReminderRow({
  item,
  copied,
  onCopy,
}: {
  item: ReminderItem;
  copied: string | null;
  onCopy: (command: string) => Promise<void>;
}) {
  const { health } = item;
  const command =
    item.kind === "upgrade"
      ? health.recommendedUpgradeCommand ?? health.recommendedInstallCommand
      : health.recommendedInstallCommand;
  const title =
    item.kind === "upgrade"
      ? `${health.displayName} ${health.version ?? "(unknown)"} is below ${health.minSupportedVersion ?? "the minimum supported version"}`
      : `${health.displayName} was not found`;
  return (
    <div className="border border-[var(--border)] bg-[var(--bg-pane)] p-2 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={item.kind === "upgrade" ? "text-[var(--warn)]" : "text-[var(--err)]"}>
          {item.kind === "upgrade" ? "upgrade" : "missing"}
        </span>
        <span className="text-[var(--text)]">{title}</span>
      </div>
      <div className="text-[10px] text-[var(--text-faint)] break-all">
        detected: {health.path ?? "(none)"}
        {health.version ? ` · version: ${health.version}` : ""}
        {health.configPath ? ` · config: ${health.configPath}` : ""}
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <code className="flex-1 min-w-0 border border-[var(--border)] px-1.5 py-1 bg-[var(--bg)] text-[10px] break-all">
          {command}
        </code>
        <button
          type="button"
          onClick={() => void onCopy(command)}
          className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)]"
          title={`Copy ${health.displayName} command`}
        >
          copy
        </button>
      </div>
      <div className="flex items-center gap-2 text-[10px]">
        <a
          href={health.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--accent)] hover:underline"
        >
          docs
        </a>
        <span className="text-[var(--text-faint)]">
          {copied === command ? "copied" : "close to continue using Ensemble"}
        </span>
      </div>
    </div>
  );
}
