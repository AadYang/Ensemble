"use client";

import { useEffect, useState } from "react";
import {
  createSkill,
  deleteSkill,
  listSkills,
  patchSkill,
  reloadSkills,
  type SkillDTO,
  type SkillSource,
} from "@/lib/skill-api";
import { useT } from "@/i18n/useT";
import { getDialog } from "@/lib/dialog";

const SOURCE_BADGE: Record<SkillSource, { label: string; color: string }> = {
  project: { label: "project", color: "var(--accent)" },
  ensemble: { label: "ensemble", color: "var(--ok)" },
  "claude-user": { label: "claude", color: "var(--warn)" },
  "codex-user": { label: "codex", color: "#bb88ff" },
};

export function SkillPanel() {
  const [skills, setSkills] = useState<SkillDTO[]>([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [tools, setTools] = useState("");
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const refresh = async () => {
    try {
      setSkills(await listSkills());
    } catch (err) {
      console.warn("listSkills failed", err);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const resetForm = () => {
    setName("");
    setDescription("");
    setBody("");
    setTools("");
    setAdding(false);
    setEditing(null);
    setError(null);
  };

  const onAdd = async () => {
    if (!name.trim() || !description.trim() || !body.trim()) {
      setError(t("skill.err.required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parsedTools = tools
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await createSkill({
        name: name.trim(),
        description: description.trim(),
        body: body.trim(),
        ...(parsedTools.length > 0 ? { tools: parsedTools } : {}),
      });
      resetForm();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onSaveEdit = async () => {
    if (!editing) return;
    if (!description.trim() || !body.trim()) {
      setError(t("skill.err.required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parsedTools = tools
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await patchSkill(editing, {
        description: description.trim(),
        body: body.trim(),
        tools: parsedTools,
      });
      resetForm();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onEditClick = (s: SkillDTO) => {
    setEditing(s.name);
    setName(s.name);
    setDescription(s.description);
    setBody(s.body);
    setTools((s.tools ?? []).join(", "));
    setAdding(false);
    setError(null);
  };

  const onDelete = async (s: SkillDTO) => {
    if (s.source !== "ensemble") return;
    const ok = await getDialog().confirm({
      title: t("skill.confirmDelete", { name: s.name }),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSkill(s.name);
      await refresh();
    } catch (err) {
      console.warn("delete failed", err);
    }
  };

  const onReload = async () => {
    try {
      await reloadSkills();
      await refresh();
    } catch (err) {
      console.warn("reload failed", err);
    }
  };

  return (
    <div className="border-b border-[var(--border)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-3 py-2 flex items-center gap-2 text-xs hover:bg-[var(--bg-pane)]"
      >
        <span className="text-[var(--text-faint)]">{open ? "▾" : "▸"}</span>
        <span className="text-[var(--text-dim)] tracking-wider">{t("skill.label")}</span>
        <span className="text-[var(--text-faint)] ml-auto">{skills.length}</span>
      </button>
      {open && (
        <div className="px-2 pb-2 flex flex-col gap-1 text-[11px]">
          <div className="flex gap-1 mb-1">
            <button
              onClick={() => {
                resetForm();
                setAdding(true);
              }}
              className="flex-1 px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors"
            >
              {t("skill.add")}
            </button>
            <button
              onClick={onReload}
              className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
              title={t("skill.reload.title")}
            >
              ↻
            </button>
          </div>

          {skills.length === 0 && !adding && (
            <div className="px-2 py-1 text-[var(--text-faint)]">{t("skill.empty")}</div>
          )}

          {skills.map((s) => {
            const badge = SOURCE_BADGE[s.source];
            const editable = s.source === "ensemble";
            return (
              <div
                key={`${s.source}:${s.name}`}
                className="flex flex-col gap-0.5 px-2 py-1 border border-[var(--border)] bg-[var(--bg-pane)]"
              >
                <div className="flex items-center gap-1">
                  <span className="truncate font-bold flex-1" title={s.path}>
                    {s.name}
                  </span>
                  <span
                    className="text-[10px] px-1 border"
                    style={{ borderColor: badge.color, color: badge.color }}
                  >
                    {badge.label}
                  </span>
                  {editable && (
                    <>
                      <button
                        onClick={() => onEditClick(s)}
                        className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)]"
                        title={t("skill.edit")}
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => onDelete(s)}
                        className="px-1 text-[var(--text-dim)] hover:text-[var(--err)]"
                        title={t("skill.delete.title")}
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
                <div className="text-[var(--text-faint)] text-[10px] truncate" title={s.description}>
                  {s.description}
                </div>
                {s.tools && s.tools.length > 0 && (
                  <div className="text-[var(--text-faint)] text-[10px] truncate" title={s.tools.join(", ")}>
                    tools: {s.tools.join(", ")}
                  </div>
                )}
              </div>
            );
          })}

          {(adding || editing) && (
            <div className="flex flex-col gap-1 mt-1 p-2 border border-[var(--accent)] bg-[var(--bg-pane)]">
              <input
                className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)]"
                placeholder={t("skill.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!!editing || busy}
              />
              <input
                className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)]"
                placeholder={t("skill.descPlaceholder")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={busy}
              />
              <input
                className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)]"
                placeholder={t("skill.toolsPlaceholder")}
                value={tools}
                onChange={(e) => setTools(e.target.value)}
                disabled={busy}
              />
              <textarea
                className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] font-mono min-h-[140px]"
                placeholder={t("skill.bodyPlaceholder")}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={busy}
              />
              {error && <div className="text-[var(--err)] text-[10px]">{error}</div>}
              <div className="flex gap-1">
                <button
                  onClick={editing ? onSaveEdit : onAdd}
                  disabled={busy}
                  className="flex-1 px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors disabled:opacity-30"
                >
                  {editing ? t("skill.save") : t("skill.create")}
                </button>
                <button
                  onClick={resetForm}
                  disabled={busy}
                  className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-30"
                >
                  {t("skill.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
