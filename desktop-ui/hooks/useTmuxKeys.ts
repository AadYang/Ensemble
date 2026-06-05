"use client";

import { useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { focusCycle, focusDir } from "@agentorch/shared";
import { selectActiveWindow, useStore } from "@/store/agents";
import { getDialog } from "@/lib/dialog";

const PREFIX_TIMEOUT_MS = 1500;
const RESIZE_STEP = 0.05;

const isFormTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
};

const isModifierKey = (key: string): boolean =>
  key === "Shift" || key === "Control" || key === "Alt" || key === "Meta";

export function useTmuxKeys(): { prefixed: boolean } {
  const [prefixed, setPrefixed] = useState(false);

  useHotkeys(
    "ctrl+b",
    () => setPrefixed(true),
    { preventDefault: true, enableOnFormTags: false },
  );

  useEffect(() => {
    if (!prefixed) return;
    const t = window.setTimeout(() => setPrefixed(false), PREFIX_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [prefixed]);

  useEffect(() => {
    if (!prefixed) return;

    const onKey = (e: KeyboardEvent) => {
      if (isFormTarget(e.target)) return;
      if (isModifierKey(e.key)) return;

      const s = useStore.getState();
      const aw = selectActiveWindow(s);
      let consumed = true;

      // Window-index keys 1..9 (no aw needed)
      if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const target = s.windows[idx];
        if (target) s.setActiveWindow(target.id);
      } else if (aw) {
        switch (e.key) {
          case "%":
            s.splitActive("h");
            break;
          case '"':
            s.splitActive("v");
            break;
          case "x":
            s.closeActive();
            break;
          case "o":
          case "Tab":
            s.setActivePane(focusCycle(aw.root, aw.activePaneId, "next"));
            break;
          case "ArrowUp":
            s.setActivePane(focusDir(aw.root, aw.activePaneId, "up"));
            break;
          case "ArrowDown":
            s.setActivePane(focusDir(aw.root, aw.activePaneId, "down"));
            break;
          case "ArrowLeft":
            s.setActivePane(focusDir(aw.root, aw.activePaneId, "left"));
            break;
          case "ArrowRight":
            s.setActivePane(focusDir(aw.root, aw.activePaneId, "right"));
            break;
          case "H":
            s.resizeActivePane("left", RESIZE_STEP);
            break;
          case "L":
            s.resizeActivePane("right", RESIZE_STEP);
            break;
          case "J":
            s.resizeActivePane("down", RESIZE_STEP);
            break;
          case "K":
            s.resizeActivePane("up", RESIZE_STEP);
            break;
          case "c":
            s.createWindow();
            break;
          case "n":
            s.cycleWindow("next");
            break;
          case "p":
            s.cycleWindow("prev");
            break;
          case ",": {
            void getDialog()
              .prompt({ title: "rename window:", defaultValue: aw.name })
              .then((next) => {
                if (next && next.trim()) s.renameWindow(aw.id, next.trim());
              });
            break;
          }
          case "&":
            s.closeWindow(aw.id);
            break;
          case ":":
            s.setPaletteOpen(true);
            break;
          case "?":
            s.setHelpOpen(true);
            break;
          case "Escape":
            break;
          default:
            consumed = false;
        }
      } else {
        consumed = false;
      }

      if (consumed) {
        e.preventDefault();
        e.stopPropagation();
        setPrefixed(false);
      } else {
        // Unrecognized key cancels prefix without swallowing the event.
        setPrefixed(false);
      }
    };

    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [prefixed]);

  return { prefixed };
}
