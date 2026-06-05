"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LOCALES, type Locale } from "@/i18n/dict";
import { useT } from "@/i18n/useT";
import { useStore } from "@/store/agents";
import { getCliSettings, patchCliSettings, type CliSettingsHealth } from "@/lib/settings-api";
import {
  checkForUpdates,
  getCurrentVersion,
  type UpdateState,
} from "@/lib/update-check";

interface GlobalSettingsProps {
  onClose: () => void;
  /** Called when a manual update check finds a newer release. The parent
   *  owns the UpdateDialog so it can be shown both here (manual) and on
   *  the app's auto-check at launch. */
  onShowUpdate: (state: UpdateState) => void;
}

export function GlobalSettings({ onClose, onShowUpdate }: GlobalSettingsProps) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [cli, setCli] = useState<CliSettingsHealth | null>(null);
  const [claudePath, setClaudePath] = useState("");
  const [codexPath, setCodexPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Version-section state. `currentVersion` is read once on mount.
  // `versionStatus` reflects the most recent manual check outcome.
  const [currentVersion, setCurrentVersion] = useState<string>("…");
  const [versionChecking, setVersionChecking] = useState(false);
  const [versionStatus, setVersionStatus] = useState<
    | { kind: "idle" }
    | { kind: "up-to-date"; latest: string }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const refreshCli = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await getCliSettings();
      setCli(next);
      setClaudePath(next.claude.manualPath ?? "");
      setCodexPath(next.codex.manualPath ?? "");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (mounted) void refreshCli();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Read the app version once when the dialog mounts. Fast (sync IPC call
  // through @tauri-apps/api/app) so no separate loading state.
  useEffect(() => {
    if (!mounted) return;
    void getCurrentVersion().then(setCurrentVersion);
  }, [mounted]);

  const onCheckUpdate = async () => {
    setVersionChecking(true);
    setVersionStatus({ kind: "idle" });
    try {
      const result = await checkForUpdates();
      if (!result) {
        setVersionStatus({
          kind: "failed",
          message: t("globalSettings.version.failed"),
        });
        return;
      }
      if (result.hasNewer) {
        if (result.asset === null && !result.mustUpgrade) {
          setVersionStatus({ kind: "up-to-date", latest: result.release.version });
          return;
        }
        // Hand off to the parent — the same dialog UI used by the auto-
        // check at launch, so users see one consistent prompt.
        onShowUpdate(result);
      } else {
        setVersionStatus({ kind: "up-to-date", latest: result.release.version });
      }
    } finally {
      setVersionChecking(false);
    }
  };

  useEffect(() => {
    if (!mounted || pos !== null) return;
    const el = dialogRef.current;
    const w = el?.offsetWidth ?? 520;
    const h = el?.offsetHeight ?? 480;
    setPos({
      x: Math.max(8, Math.floor((window.innerWidth - w) / 2)),
      y: Math.max(8, Math.floor((window.innerHeight - h) / 2)),
    });
  }, [mounted, pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onMove = (e: MouseEvent) => {
      const off = dragOffsetRef.current;
      if (!off) return;
      e.preventDefault();
      e.stopPropagation();
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 60, e.clientX - off.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 30, e.clientY - off.dy)),
      });
    };
    const onUp = () => {
      dragOffsetRef.current = null;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousemove", onMove, { capture: true });
    document.addEventListener("mouseup", onUp, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousemove", onMove, { capture: true });
      document.removeEventListener("mouseup", onUp, { capture: true });
    };
  }, [onClose]);

  if (!mounted) return null;

  const cliHints = getCliPathHints();

  const saveCli = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await patchCliSettings({
        claudePath: claudePath.trim() || null,
        codexPath: codexPath.trim() || null,
      });
      setCli(next);
      setClaudePath(next.claude.manualPath ?? "");
      setCodexPath(next.codex.manualPath ?? "");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onHeaderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = dialogRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.preventDefault();
    e.stopPropagation();
  };

  const dialog = (
    <div
      ref={dialogRef}
      className="tool-card bg-[var(--bg-elevated)] w-[520px] max-w-full text-xs shadow-2xl shadow-black/50"
      style={{
        position: "fixed",
        zIndex: 9999,
        left: pos?.x ?? "50%",
        top: pos?.y ?? "30vh",
        transform: pos ? undefined : "translateX(-50%)",
      }}
    >
      <div
        onMouseDown={onHeaderMouseDown}
        className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2 cursor-move select-none"
        title={t("settings.dragHint")}
      >
        <span className="text-[var(--text-faint)]">⋮⋮</span>
        <span className="text-[var(--text-dim)] tracking-wider">{t("globalSettings.title")}</span>
        <span className="flex-1" />
        <button
          onClick={onClose}
          title={t("settings.closeDialog")}
          className="px-1.5 text-[var(--text-faint)] hover:text-[var(--err)]"
        >
          ✕
        </button>
      </div>
      <div className="p-3 flex flex-col gap-4">
        <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
          {t("globalSettings.language")}
        </span>
        <div className="flex flex-col gap-1">
          {LOCALES.map((l) => (
            <button
              key={l.value}
              onClick={() => setLocale(l.value as Locale)}
              className={`text-left px-2 py-1 border transition-colors ${
                locale === l.value
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
              }`}
            >
              {locale === l.value ? "● " : "○ "}
              {l.label}
            </button>
          ))}
        </div>

        <div className="border-t border-[var(--border)] pt-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">CLI paths</span>
            <span className="flex-1" />
            <button
              onClick={() => void refreshCli()}
              disabled={busy}
              className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] disabled:opacity-30"
            >
              refresh
            </button>
          </div>
          <CliPathRow
            label="Claude"
            value={claudePath}
            onChange={setClaudePath}
            health={cli?.claude ?? null}
            placeholder={cliHints.claudePlaceholder}
            onUseDetected={() => cli?.claude.path && setClaudePath(cli.claude.path)}
          />
          <CliPathRow
            label="Codex"
            value={codexPath}
            onChange={setCodexPath}
            health={cli?.codex ?? null}
            placeholder={cliHints.codexPlaceholder}
            onUseDetected={() => cli?.codex.path && setCodexPath(cli.codex.path)}
          />
          <div className="text-[10px] text-[var(--text-faint)] leading-tight">
            {cliHints.note}
          </div>
          {error && <div className="text-[10px] text-[var(--err)] whitespace-pre-wrap">{error}</div>}
          <div className="flex gap-2">
            <button
              onClick={() => void saveCli()}
              disabled={busy}
              className="flex-1 px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
            >
              save CLI paths
            </button>
            <button
              onClick={() => {
                setClaudePath("");
                setCodexPath("");
              }}
              disabled={busy}
              className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30"
              title="Clear manual paths; Ensemble will auto-detect from PATH and common install locations."
            >
              auto-detect
            </button>
          </div>
        </div>

        {/* Version + update check.
            Shows the running app's version and lets the user manually
            poll the server's update endpoint. Found-newer hands off to
            the shared UpdateDialog via onShowUpdate(); up-to-date /
            unreachable show inline status. */}
        <div className="border-t border-[var(--border)] pt-3 flex flex-col gap-2">
          <span className="text-[10px] tracking-wider text-[var(--text-faint)]">
            {t("globalSettings.version")}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-dim)]">
              {t("globalSettings.version.current")}:
            </span>
            <span className="text-[var(--text)] font-mono tabular-nums">
              {currentVersion}
            </span>
            <span className="flex-1" />
            <button
              onClick={() => void onCheckUpdate()}
              disabled={versionChecking}
              className="px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30 transition-colors"
            >
              {versionChecking
                ? t("globalSettings.version.checking")
                : t("globalSettings.version.check")}
            </button>
          </div>
          {versionStatus.kind === "up-to-date" && (
            <div className="text-[10px] text-[var(--text-dim)]">
              ✓ {t("globalSettings.version.upToDate")} ·{" "}
              {t("globalSettings.version.latest")}: {versionStatus.latest}
            </div>
          )}
          {versionStatus.kind === "failed" && (
            <div className="text-[10px] text-[var(--err)]">
              {versionStatus.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

function CliPathRow({
  label,
  value,
  onChange,
  health,
  placeholder,
  onUseDetected,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  health: CliSettingsHealth["claude"] | null;
  placeholder: string;
  onUseDetected: () => void;
}) {
  const ok = health?.found === true;
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{label}</span>
        <span className={ok ? "text-[var(--ok)]" : "text-[var(--warn)]"}>
          {health ? (ok ? `found via ${health.source}` : "not found") : "checking..."}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onUseDetected}
          disabled={!health?.path}
          className="px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] disabled:opacity-30"
          title="Copy the detected executable path into the manual path field."
        >
          use detected
        </button>
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] font-mono text-[11px]"
      />
      <div className="text-[10px] text-[var(--text-faint)] leading-tight break-all">
        detected: {health?.path ?? "(none)"}
        {health?.authPath ? ` · auth: ${health.authPresent ? "ok" : "missing"} (${health.authPath})` : ""}
        {health?.error ? ` · ${health.error}` : ""}
      </div>
    </label>
  );
}

function getCliPathHints(): {
  claudePlaceholder: string;
  codexPlaceholder: string;
  note: string;
} {
  const platform = typeof navigator === "undefined"
    ? ""
    : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (platform.includes("mac")) {
    return {
      claudePlaceholder: "claude or /opt/homebrew/bin/claude",
      codexPlaceholder: "codex or /opt/homebrew/bin/codex",
      note: "macOS GUI apps may not inherit your shell PATH. Leave blank for auto-detect, type the command name, or paste /opt/homebrew/bin/... / /usr/local/bin/....",
    };
  }
  if (platform.includes("win")) {
    return {
      claudePlaceholder: "claude.exe or full path to Claude Code",
      codexPlaceholder: "codex.exe or full path to Codex",
      note: "Leave blank for auto-detect, or paste a full .exe/.cmd path. Command names like claude/codex are also accepted when they are on PATH.",
    };
  }
  return {
    claudePlaceholder: "claude or /usr/local/bin/claude",
    codexPlaceholder: "codex or /usr/local/bin/codex",
    note: "Leave blank for auto-detect, type the command name, or paste a full executable path.",
  };
}
