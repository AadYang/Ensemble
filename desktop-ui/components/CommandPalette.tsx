"use client";

import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { focusCycle } from "@agentorch/shared";
import { selectActiveWindow, useStore } from "@/store/agents";
import { useT } from "@/i18n/useT";
import { getDialog } from "@/lib/dialog";

interface CommandItem {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const splitActive = useStore((s) => s.splitActive);
  const closeActive = useStore((s) => s.closeActive);
  const setActivePane = useStore((s) => s.setActivePane);
  const createWindow = useStore((s) => s.createWindow);
  const closeWindow = useStore((s) => s.closeWindow);
  const cycleWindow = useStore((s) => s.cycleWindow);
  const renameWindow = useStore((s) => s.renameWindow);
  const t = useT();

  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  if (!open) return null;

  const aw = selectActiveWindow(useStore.getState());
  const close = () => setOpen(false);

  const commands: CommandItem[] = [
    {
      id: "split-h",
      label: t("cmd.splitH"),
      group: t("cmd.group.pane"),
      hint: "C-b %",
      run: () => splitActive("h"),
    },
    {
      id: "split-v",
      label: t("cmd.splitV"),
      group: t("cmd.group.pane"),
      hint: "C-b \"",
      run: () => splitActive("v"),
    },
    {
      id: "close-pane",
      label: t("cmd.closePane"),
      group: t("cmd.group.pane"),
      hint: "C-b x",
      run: closeActive,
    },
    {
      id: "focus-next",
      label: t("cmd.focusNext"),
      group: t("cmd.group.pane"),
      hint: "C-b o",
      run: () => {
        const w = selectActiveWindow(useStore.getState());
        if (w) setActivePane(focusCycle(w.root, w.activePaneId, "next"));
      },
    },
    {
      id: "new-window",
      label: t("cmd.newWin"),
      group: t("cmd.group.window"),
      hint: "C-b c",
      run: () => createWindow(),
    },
    {
      id: "next-window",
      label: t("cmd.nextWin"),
      group: t("cmd.group.window"),
      hint: "C-b n",
      run: () => cycleWindow("next"),
    },
    {
      id: "prev-window",
      label: t("cmd.prevWin"),
      group: t("cmd.group.window"),
      hint: "C-b p",
      run: () => cycleWindow("prev"),
    },
    {
      id: "rename-window",
      label: t("cmd.renameWin"),
      group: t("cmd.group.window"),
      hint: "C-b ,",
      run: async () => {
        if (!aw) return;
        const next = await getDialog().prompt({ title: t("win.rename.prompt"), defaultValue: aw.name });
        if (next?.trim()) renameWindow(aw.id, next.trim());
      },
    },
    {
      id: "close-window",
      label: t("cmd.closeWin"),
      group: t("cmd.group.window"),
      hint: "C-b &",
      run: () => {
        if (aw) closeWindow(aw.id);
      },
    },
  ];

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center pt-[10vh] bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <Command
        className="w-[640px] max-w-[90vw] tool-card bg-[var(--bg-elevated)]"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
          <span className="text-[var(--accent)]">:</span>
          <Command.Input
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder={t("cmd.placeholder")}
            className="flex-1 bg-transparent outline-none text-[var(--text)] text-sm"
          />
          <span className="text-[10px] text-[var(--text-faint)]">{t("cmd.escClose")}</span>
        </div>
        <Command.List className="max-h-[50vh] overflow-y-auto py-1">
          <Command.Empty className="px-3 py-4 text-[var(--text-faint)] text-xs">
            {t("cmd.empty")}
          </Command.Empty>
          {Array.from(new Set(commands.map((c) => c.group))).map((group) => (
            <Command.Group
              key={group}
              heading={
                <span className="px-3 py-1 text-[10px] tracking-wider text-[var(--text-faint)] uppercase">
                  {group}
                </span>
              }
            >
              {commands
                .filter((c) => c.group === group)
                .map((c) => (
                  <Command.Item
                    key={c.id}
                    value={c.label}
                    onSelect={() => {
                      void c.run();
                      close();
                    }}
                    className="px-3 py-1.5 text-xs flex items-center gap-2 cursor-pointer aria-selected:bg-[var(--bg-pane)] aria-selected:text-[var(--accent)]"
                  >
                    <span className="flex-1">{c.label}</span>
                    {c.hint && (
                      <span className="text-[10px] text-[var(--text-faint)]">{c.hint}</span>
                    )}
                  </Command.Item>
                ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}
