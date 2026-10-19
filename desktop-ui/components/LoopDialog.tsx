"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/i18n/useT";
import { MenuSelect } from "./MenuSelect";
import { startLoop, startTeamLoop, suggestLoop, type LoopStartBody } from "@/lib/loop-api";
import { useStore } from "@/store/agents";

type VerifierKind = "command" | "job" | "file-marker" | "peer-review";

export function LoopDialog({
  agentId,
  teamId,
  onClose,
}: {
  agentId: string;
  teamId?: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const teams = useStore((s) => s.teams);
  const agents = useStore((s) => s.agents);
  const [mounted, setMounted] = useState(false);
  const [goal, setGoal] = useState("");
  const [verifierKind, setVerifierKind] = useState<VerifierKind>("command");
  const [verifierSpec, setVerifierSpec] = useState("");
  const [doneKind, setDoneKind] = useState<"exit-0" | "file-contains" | "peer-lgtm">("file-contains");
  const [doneSpec, setDoneSpec] = useState("## DONE");
  const [session, setSession] = useState<"fresh-disk" | "resume">("resume");
  const [snapshot, setSnapshot] = useState<"none" | "git-commit">("none");
  const [maxIterations, setMaxIterations] = useState("20");
  const [permissionBump, setPermissionBump] = useState<"acceptEdits" | "bypassPermissions" | "">("acceptEdits");
  const [recipe, setRecipe] = useState<"" | "tdd" | "ralph" | "pr-gate">("");
  const [worktree, setWorktree] = useState(false);
  const [reviewerAgentId, setReviewerAgentId] = useState("");
  const [asTeam, setAsTeam] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [testCommands, setTestCommands] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bypassConfirm, setBypassConfirm] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    void suggestLoop(agentId).then((hint) => {
      setSource(hint.source);
      setTestCommands(hint.testCommands);
    });
  }, [agentId]);

  const teammates = Object.values(agents).filter((a) => a.summary.teamId && a.summary.teamId === (teamId ?? null) && a.summary.id !== agentId);
  const canStart = goal.trim().length > 0;
  const teamName = teamId ? teams[teamId]?.name : null;

  const applyRecipe = (next: "" | "tdd" | "ralph" | "pr-gate") => {
    setRecipe(next);
    if (next === "ralph") {
      setSession("fresh-disk");
      setSnapshot("git-commit");
      setDoneKind("file-contains");
      setDoneSpec("## DONE");
    }
    if (next === "tdd") {
      setSession("resume");
      setDoneKind("exit-0");
    }
    if (next === "pr-gate") {
      setDoneKind("peer-lgtm");
      setDoneSpec("LGTM");
    }
  };

  const onConfirm = async () => {
    if (!canStart || busy) return;
    if (permissionBump === "bypassPermissions" && !bypassConfirm) {
      setBypassConfirm(true);
      return;
    }
    setBusy(true);
    setError(null);
    const spec = verifierSpec.trim();
    const body: LoopStartBody = {
      goal: goal.trim(),
      ...(spec ? { verifier: { kind: verifierKind, spec } } : {}),
      doneWhen: { kind: doneKind, spec: doneSpec.trim() },
      maxIterations: Math.max(1, Number(maxIterations) || 20),
      session,
      snapshot,
      permissionBump: permissionBump || null,
      ...(recipe ? { recipe } : {}),
      ...(worktree ? { worktree: true } : {}),
      ...(reviewerAgentId ? { reviewerAgentId } : {}),
    };
    try {
      if (asTeam && teamId) await startTeamLoop(teamId, body);
      else await startLoop(agentId, body);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!mounted) return null;

  const dialog = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="@container tool-card bg-[var(--bg-elevated)] flex w-[560px] max-w-full max-h-[calc(100dvh-2rem)] min-h-0 min-w-0 flex-col overflow-hidden text-xs shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <span className="text-[var(--accent)]">LOOP</span>
          <span className="text-[var(--text-dim)] tracking-wider">{t("loop.dialog.title")}</span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            className="px-1.5 py-0.5 text-[var(--text-dim)] hover:text-[var(--err)] border border-[var(--border)]"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.goal")}</span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={6}
              placeholder={t("loop.field.goal.placeholder")}
              className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] min-h-[8rem] max-h-[40vh] resize-y"
            />
            <span className="text-[10px] text-[var(--text-dim)]">{t("loop.field.goal.hint")}</span>
          </label>
          <div className="grid grid-cols-1 @[400px]:grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.iterations")}</span>
              <input
                value={maxIterations}
                onChange={(e) => setMaxIterations(e.target.value)}
                className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.permission")}</span>
              <MenuSelect
                value={permissionBump}
                onChange={(v) => {
                  setPermissionBump(v as typeof permissionBump);
                  setBypassConfirm(false);
                }}
                items={[
                  { value: "acceptEdits", label: t("loop.perm.acceptEdits") },
                  { value: "bypassPermissions", label: t("loop.perm.bypass") },
                  { value: "", label: t("loop.perm.keep") },
                ]}
              />
            </label>
          </div>
          <details className="border border-[var(--border)] p-2">
            <summary className="cursor-pointer text-[10px] tracking-wider text-[var(--text-faint)]">
              {t("loop.field.advanced")}
            </summary>
            <div className="mt-2 flex flex-col gap-3">
              <p className="text-[10px] text-[var(--text-dim)]">{t("loop.field.verifierHint")}</p>
              <div className="grid grid-cols-1 @[400px]:grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.verifier")}</span>
                  <MenuSelect
                    value={verifierKind}
                    onChange={(v) => setVerifierKind(v as VerifierKind)}
                    items={[
                      { value: "command", label: t("loop.verifier.command") },
                      { value: "job", label: t("loop.verifier.job") },
                      { value: "file-marker", label: t("loop.verifier.file") },
                      { value: "peer-review", label: t("loop.verifier.peer") },
                    ]}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.verifierSpec")}</span>
                  <input
                    value={verifierSpec}
                    onChange={(e) => setVerifierSpec(e.target.value)}
                    placeholder={t("loop.field.verifierSpec.placeholder")}
                    className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
                  />
                  {source && (
                    <span className="text-[10px] text-[var(--text-dim)]">
                      {t("loop.prefill.from")} {source}
                    </span>
                  )}
                </label>
              </div>
              {testCommands.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {testCommands.map((cmd) => (
                    <button
                      key={cmd}
                      type="button"
                      onClick={() => {
                        setVerifierKind("command");
                        setVerifierSpec(cmd);
                      }}
                      className="px-1.5 py-0.5 border border-[var(--border)] text-[10px] text-[var(--text-dim)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-1 @[400px]:grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.doneWhen")}</span>
                  <MenuSelect
                    value={doneKind}
                    onChange={(v) => setDoneKind(v as typeof doneKind)}
                    items={[
                      { value: "file-contains", label: t("loop.done.file") },
                      { value: "exit-0", label: t("loop.done.exit0") },
                      { value: "peer-lgtm", label: t("loop.done.lgtm") },
                    ]}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.doneSpec")}</span>
                  <input
                    value={doneSpec}
                    onChange={(e) => setDoneSpec(e.target.value)}
                    placeholder="## DONE"
                    className="bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
                  />
                </label>
              </div>
              <div className="grid grid-cols-1 @[400px]:grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.session")}</span>
                  <MenuSelect
                    value={session}
                    onChange={(v) => setSession(v as typeof session)}
                    items={[
                      { value: "resume", label: t("loop.session.resume") },
                      { value: "fresh-disk", label: t("loop.session.fresh") },
                    ]}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.snapshot")}</span>
                  <MenuSelect
                    value={snapshot}
                    onChange={(v) => setSnapshot(v as typeof snapshot)}
                    items={[
                      { value: "none", label: t("loop.snapshot.none") },
                      { value: "git-commit", label: t("loop.snapshot.git") },
                    ]}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.recipe")}</span>
                <MenuSelect
                  value={recipe}
                  onChange={(v) => applyRecipe(v as typeof recipe)}
                  items={[
                    { value: "", label: t("loop.recipe.none") },
                    { value: "tdd", label: t("loop.recipe.tdd") },
                    { value: "ralph", label: t("loop.recipe.ralph") },
                    { value: "pr-gate", label: t("loop.recipe.pr") },
                  ]}
                />
              </label>
            </div>
          </details>
          {teamId && (
            <div className="flex flex-col gap-2 border border-[var(--border)] p-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={asTeam} onChange={(e) => setAsTeam(e.target.checked)} />
                <span>{t("loop.field.team", { name: teamName ?? teamId })}</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
                <span>{t("loop.field.worktree")}</span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] tracking-wider text-[var(--text-faint)]">{t("loop.field.reviewer")}</span>
                <MenuSelect
                  value={reviewerAgentId}
                  onChange={setReviewerAgentId}
                  placeholder={t("loop.field.reviewer.none")}
                  items={[
                    { value: "", label: t("loop.field.reviewer.none") },
                    ...teammates.map((a) => ({ value: a.summary.id, label: a.summary.name })),
                  ]}
                />
              </label>
            </div>
          )}
          {bypassConfirm && <div className="text-[var(--warn)]">{t("loop.perm.bypassConfirm")}</div>}
          {error && <div className="text-[var(--err)]">{error}</div>}
        </div>
        <div className="shrink-0 flex gap-2 border-t border-[var(--border)] px-3 py-2">
          <button
            onClick={() => void onConfirm()}
            disabled={!canStart || busy}
            className="flex-1 px-2 py-1 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-30"
          >
            {t("loop.dialog.start")}
          </button>
          <button
            onClick={onClose}
            className="px-2 py-1 border border-[var(--border)] text-[var(--text-dim)]"
          >
            {t("loop.dialog.cancel")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
