"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  gitRefLabel,
  gitSwitchBlock,
  isDirty,
  validateBranchName,
  type GitBranches,
  type GitCheckoutRequest,
  type GitStatus,
} from "@agentorch/shared";
import { checkoutGitBranch, getGitStatus, listGitBranches } from "@/lib/git-api";
import { getAgentStatusReport } from "@/lib/agent-api";
import { useT } from "@/i18n/useT";
import { useStore } from "@/store/agents";
import { getDialog } from "@/lib/dialog";

/**
 * The window-level branch chip: the branch of the project the FOCUSED pane's
 * agent works in, and the switch control for it.
 *
 * The server is the only source. Nothing here derives a repository from a path,
 * keeps the last answer as a fallback, or assumes the branch it asked for is
 * the branch it got — every state on screen came from a `/git` read, including
 * the one after a checkout (the server re-reads the repository and returns it).
 *
 * `running` is passed in rather than read here because it is the caller that
 * knows which signals count as "mid-turn" for this agent; the chip only decides
 * what a running agent means for switching, which is "not now".
 */
export function GitBranchChip({ agentId, running }: { agentId: string | null; running: boolean }) {
  const t = useT();
  const setRunPlan = useStore((s) => s.setRunPlan);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [open, setOpen] = useState(false);
  /** Viewport coordinates, measured when the picker opens. The panel is
   *  `position: fixed` inside a portal because the app shell is `overflow:
   *  hidden`; anchoring to the button's box is what keeps it attached to the
   *  chip without restructuring the header. */
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await getGitStatus(agentId));
    } catch {
      // Do not keep a stale branch. A transport failure is still a state the
      // chip can show — hiding it looks like "this project has no git".
      setStatus({
        state: "unavailable",
        code: "GIT_UNAVAILABLE",
        root: null,
        branch: null,
        detached: false,
        head: null,
        upstream: null,
        ahead: null,
        behind: null,
        dirty: null,
        error: "could not reach the git API",
        detail: null,
      });
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const openPicker = async () => {
    if (!agentId) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    setError(null);
    setQuery("");
    setNewName("");
    setBranches(null);
    setOpen(true);
    try {
      setBranches(await listGitBranches(agentId));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const switchTo = async (req: GitCheckoutRequest) => {
    if (!agentId) return;
    // A dirty work tree is not an error — it is a reason to ask. git would
    // refuse the checkout anyway when the changes are in the way, and that
    // refusal is shown verbatim below; this prompt is for the cases git would
    // happily switch over and carry the changes along.
    if (isDirty(status?.dirty ?? null)) {
      const counts = status?.dirty;
      const ok = await getDialog().confirm({
        title: t("git.confirmDirty", { branch: req.branch }),
        message: counts
          ? t("git.dirty.summary", {
              staged: counts.staged,
              unstaged: counts.unstaged,
              untracked: counts.untracked,
            })
          : undefined,
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await checkoutGitBranch(agentId, req);
      if (!res.ok) {
        // git's own sentence ("your local changes would be overwritten…"), kept
        // whole: it is the part the user has to act on.
        setError(res.detail || res.error);
        return;
      }
      setStatus(res.status);
      setOpen(false);
      // `/status` is refreshed for the same reason the chip is: the window and
      // the pane must not describe the project from two different reads. The
      // report resolves the plan as a PREVIEW, and it is stored under that
      // source — never relabelled as a turn's own plan.
      const report = await getAgentStatusReport(agentId);
      if (report?.planView) setRunPlan(agentId, report.planView);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Bound folders that are not a repository still get a chip: hiding them
  // looks identical to "the git API never answered", and a user who just set
  // a project folder has no way to tell those apart.
  if (!status) return null;

  const block = gitSwitchBlock(status.state, running);
  const readable = status.state === "ok";
  const label = readable ? gitRefLabel(status.branch, status.head) : null;
  const dirty = isDirty(status.dirty);
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;

  const chipText = readable
    ? (label ?? t("git.unborn"))
    : status.state === "unbound"
      ? t("git.unbound")
      : status.state === "not-a-repo"
        ? t("git.notARepo")
        : t("git.unavailable");

  const chipTitle = readable
    ? [
        status.detached && status.head ? t("git.tip.detached", { sha: status.head.slice(0, 7) }) : null,
        status.root,
        status.upstream
          ? t("git.tip.tracking", { upstream: status.upstream, ahead, behind })
          : t("git.tip.noUpstream"),
        status.dirty
          ? t("git.tip.dirty", {
              staged: status.dirty.staged,
              unstaged: status.dirty.unstaged,
              untracked: status.dirty.untracked,
            })
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : (status.error ?? "");

  const needle = query.trim().toLowerCase();
  const localList = (branches?.local ?? []).filter((b) => needle === "" || b.name.toLowerCase().includes(needle));
  const remoteList = (branches?.remote ?? []).filter((b) => needle === "" || b.name.toLowerCase().includes(needle));
  const trimmedNew = newName.trim();
  const newCheck = trimmedNew === "" ? null : validateBranchName(trimmedNew);
  const switchingBlocked = busy || block !== null;

  return (
    <>
      {/* The separator belongs to the chip, not to the header: when there is no
          repository to show, nothing at all is rendered — no empty divider.
          The `title` also sits here because a DISABLED button does not reliably
          show one, and the disabled states are exactly the ones whose whole
          point is the reason they carry. */}
      <span className="flex items-center border-l border-[var(--border)] pl-3" title={chipTitle}>
      <button
        ref={buttonRef}
        type="button"
        disabled={!readable}
        aria-haspopup={readable ? "dialog" : undefined}
        aria-expanded={readable ? open : undefined}
        onClick={() => (open ? setOpen(false) : void openPicker())}
        title={chipTitle}
        className={
          "flex items-center gap-1 max-w-[20ch] px-1.5 py-0.5 border transition-colors " +
          (readable
            ? "border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)] " +
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            : "border-[var(--border)] text-[var(--text-dim)] cursor-not-allowed")
        }
      >
        <span className={readable ? "text-[var(--accent)]" : "text-[var(--text-faint)]"}>⑂</span>
        <span className="truncate">{chipText}</span>
        {status.detached && <span className="text-[var(--warn)] text-[10px]">{t("git.detached")}</span>}
        {dirty && (
          <span className="text-[var(--warn)]" title={chipTitle}>
            ●
          </span>
        )}
        {status.state === "ok" && ahead > 0 && <span className="text-[var(--ok)] text-[10px]">↑{ahead}</span>}
        {status.state === "ok" && behind > 0 && <span className="text-[var(--warn)] text-[10px]">↓{behind}</span>}
      </button>
      </span>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("git.picker.title")}
            style={{ top: anchor.top, right: anchor.right }}
            className="fixed z-50 w-[380px] max-h-[70vh] overflow-y-auto overscroll-contain border border-[var(--border-active)] bg-[var(--bg-elevated)] text-xs shadow-lg"
          >
            <div className="px-2 py-1.5 border-b border-[var(--border)] flex items-center gap-2">
              <span className="text-[var(--accent)]">⑂</span>
              <span className="text-[var(--text)] truncate" title={status.root ?? undefined}>
                {status.root}
              </span>
            </div>

            <div className="p-2 border-b border-[var(--border)] flex flex-col gap-1">
              <div className="flex gap-1">
                <input
                  className="flex-1 min-w-0 bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] text-[var(--text)]"
                  placeholder={t("git.new.placeholder")}
                  value={newName}
                  disabled={switchingBlocked}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newCheck?.ok) void switchTo({ branch: trimmedNew, create: true });
                  }}
                />
                <button
                  type="button"
                  disabled={switchingBlocked || !newCheck?.ok}
                  onClick={() => void switchTo({ branch: trimmedNew, create: true })}
                  className="shrink-0 px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--accent)]"
                >
                  {t("git.new.button")}
                </button>
              </div>
              {newCheck && !newCheck.ok && <div className="text-[10px] text-[var(--err)]">{newCheck.reason}</div>}
            </div>

            <div className="p-2 border-b border-[var(--border)]">
              <input
                className="w-full bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] text-[var(--text)]"
                placeholder={t("git.search.placeholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {block === "running" && (
              <div className="px-2 py-1.5 border-b border-[var(--border)] text-[10px] text-[var(--warn)]">
                {t("git.block.running")}
              </div>
            )}
            {busy && (
              <div className="px-2 py-1.5 border-b border-[var(--border)] text-[10px] text-[var(--text-dim)]">
                {t("git.switching")}
              </div>
            )}
            {error && (
              <div className="px-2 py-1.5 border-b border-[var(--border)] text-[10px] text-[var(--err)] whitespace-pre-wrap">
                {error}
              </div>
            )}

            {branches === null && error === null && (
              <div className="px-2 py-2 text-[var(--text-dim)]">{t("git.loading")}</div>
            )}
            {branches !== null && branches.state !== "ok" && (
              <div className="px-2 py-2 text-[var(--err)] whitespace-pre-wrap">
                {branches.error ?? t("git.branchListFailed")}
              </div>
            )}

            {branches?.state === "ok" && (
              <>
                <div className="px-2 py-1 text-[10px] tracking-wider text-[var(--text-dim)] bg-[var(--bg-pane)]/40">
                  {t("git.local.header")}
                </div>
                {localList.length === 0 && (
                  <div className="px-2 py-1.5 text-[var(--text-dim)]">{t("git.noMatch")}</div>
                )}
                {localList.map((b) => (
                  <button
                    key={`local:${b.name}`}
                    type="button"
                    disabled={switchingBlocked || b.current}
                    onClick={() => void switchTo({ branch: b.name })}
                    title={b.upstream ? t("git.tip.tracking", { upstream: b.upstream, ahead: b.ahead ?? 0, behind: b.behind ?? 0 }) : undefined}
                    className="w-full text-left px-2 py-1 flex items-center gap-2 border-l-2 border-transparent hover:border-[var(--accent)] hover:bg-[var(--bg-pane)] disabled:opacity-50"
                  >
                    <span className="w-2 shrink-0 text-[var(--accent)]">{b.current ? "●" : ""}</span>
                    <span className="truncate flex-1 text-[var(--text)]">{b.name}</span>
                    {b.current && <span className="text-[10px] text-[var(--text-dim)]">{t("git.current")}</span>}
                    {(b.ahead ?? 0) > 0 && <span className="text-[10px] text-[var(--ok)]">↑{b.ahead}</span>}
                    {(b.behind ?? 0) > 0 && <span className="text-[10px] text-[var(--warn)]">↓{b.behind}</span>}
                  </button>
                ))}

                <div className="px-2 py-1 text-[10px] tracking-wider text-[var(--text-dim)] bg-[var(--bg-pane)]/40 border-t border-[var(--border)]">
                  {t("git.remote.header")}
                </div>
                {remoteList.length === 0 && (
                  <div className="px-2 py-1.5 text-[var(--text-dim)]">{t("git.remote.empty")}</div>
                )}
                {remoteList.map((b) => (
                  <button
                    key={`remote:${b.name}`}
                    type="button"
                    disabled={switchingBlocked}
                    onClick={() => void switchTo({ branch: b.name })}
                    title={t("git.remote.hint")}
                    className="w-full text-left px-2 py-1 flex items-center gap-2 border-l-2 border-transparent hover:border-[var(--accent)] hover:bg-[var(--bg-pane)] disabled:opacity-50"
                  >
                    <span className="w-2 shrink-0" />
                    <span className="truncate flex-1 text-[var(--text-dim)]">{b.name}</span>
                    <span className="text-[10px] text-[var(--text-faint)]">{t("git.remote.tag")}</span>
                  </button>
                ))}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
