"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { openUpgradeUrl, type UpdateState } from "@/lib/update-check";
import { useT } from "@/i18n/useT";

interface Props {
  state: UpdateState;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function formatPublished(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function UpdateDialog({ state, onClose }: Props) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Esc dismisses non-mandatory updates. Mandatory updates trap the dialog
  // open — the user can still close the app via the window controls, but
  // can't keep using a known-broken / unsupported build.
  useEffect(() => {
    if (state.mustUpgrade) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, state.mustUpgrade]);

  // Prefer the per-platform asset's URL when the resolver picked one for us;
  // otherwise fall back to the legacy top-level URL. The dialog still shows
  // even for asset===null releases when the release is mandatory, so the
  // user at least sees the release notes + has the legacy URL to work with.
  const downloadUrl = state.asset?.downloadUrl ?? state.latest.downloadUrl;
  const sizeBytes = state.asset?.sizeBytes ?? state.latest.sizeBytes;
  const noAssetForThisPlatform = state.asset === null;

  const copyDownloadUrl = async () => {
    try {
      await navigator.clipboard.writeText(downloadUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused — at least the URL is rendered as selectable
      // text in the dialog so the user can copy it by hand.
    }
  };

  const onUpgradeClick = async () => {
    setError(null);
    setBusy(true);
    try {
      await openUpgradeUrl(downloadUrl);
    } catch (err) {
      // shell:allow-open scope mismatches surface here. Salvage the click by
      // copying the URL to clipboard so the user can paste it into their
      // browser instead of being stuck with a cryptic regex error message.
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      void copyDownloadUrl();
      setBusy(false);
    }
  };

  if (!mounted) return null;

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="tool-card bg-[var(--bg-elevated)] w-full max-w-[480px] flex flex-col text-xs shadow-2xl shadow-black/60">
        {/* Header */}
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[var(--accent)] tracking-wider">
            {state.mustUpgrade ? t("update.title.mandatory") : t("update.title.optional")}
          </span>
          <span className="flex-1" />
          {!state.mustUpgrade && (
            <button
              onClick={onClose}
              title={t("update.later")}
              className="px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)]"
            >
              ✕
            </button>
          )}
        </div>

        <div className="p-4 flex flex-col gap-3">
          {/* Version diff: current → new */}
          <div className="flex items-baseline gap-3 text-base">
            <span className="text-[var(--text-faint)] line-through tabular-nums">
              {state.currentVersion}
            </span>
            <span className="text-[var(--text-faint)]">→</span>
            <span className="text-[var(--accent)] font-bold tabular-nums tracking-wider">
              {state.release.version}
            </span>
          </div>

          <div className="text-[10px] text-[var(--text-faint)] flex gap-3 flex-wrap">
            <span>{formatPublished(state.release.publishedAt)}</span>
            <span>·</span>
            <span>{formatBytes(sizeBytes)}</span>
          </div>

          {noAssetForThisPlatform && (
            <div className="border border-[var(--warn)] bg-[var(--warn-bg,rgba(255,179,0,0.08))] p-2 text-[var(--warn)] text-[11px]">
              {t("update.noAssetForPlatform")}
            </div>
          )}

          {/* Release notes */}
          {state.release.releaseNotes.trim().length > 0 && (
            <div className="border-t border-[var(--border)] pt-3 flex flex-col gap-1">
              <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
                {t("update.releaseNotes")}
              </span>
              <pre className="text-[var(--text-dim)] whitespace-pre-wrap break-words font-sans text-xs leading-relaxed max-h-[200px] overflow-auto m-0">
                {state.release.releaseNotes}
              </pre>
            </div>
          )}

          {state.mustUpgrade && (
            <div className="border border-[var(--warn)] bg-[var(--warn-bg,rgba(255,179,0,0.08))] p-2 text-[var(--warn)] text-[11px]">
              {t("update.mandatoryNotice")}
            </div>
          )}

          {error && (
            <div className="border border-[var(--err)] bg-black/30 p-2 flex flex-col gap-1 text-[11px]">
              <div className="text-[var(--err)]">{error}</div>
              <div className="text-[var(--text-dim)]">
                {t("update.fallbackPaste")}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <code
                  className="flex-1 text-[10px] text-[var(--text-dim)] bg-black/40 px-2 py-1 break-all select-all"
                >
                  {state.latest.downloadUrl}
                </code>
                <button
                  onClick={() => void copyDownloadUrl()}
                  className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] text-[10px] whitespace-nowrap"
                >
                  {copied ? t("update.copied") : t("update.copyUrl")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Action row */}
        <div className="px-3 py-2 border-t border-[var(--border)] flex justify-end gap-2">
          {!state.mustUpgrade && (
            <button
              onClick={onClose}
              disabled={busy}
              className="px-3 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30"
            >
              {t("update.later")}
            </button>
          )}
          <button
            onClick={() => void onUpgradeClick()}
            disabled={busy}
            className="px-3 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors disabled:opacity-30 font-bold"
          >
            {busy ? t("update.opening") : t("update.upgradeNow")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
