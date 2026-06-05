/**
 * Layout tree shared between server (persistence) and web (rendering + ops).
 * Binary split only — see plan §5.1. Grid / free drag explicitly out of scope (CLAUDE.md 3.1).
 */

export type SplitDir = "h" | "v";

export type LayoutNode =
  | { kind: "pane"; id: string; agentId: string | null }
  | {
      kind: "split";
      id: string;
      dir: SplitDir;
      ratio: number;
      a: LayoutNode;
      b: LayoutNode;
    };

export interface LayoutWindow {
  id: string;
  name: string;
  root: LayoutNode;
  activePaneId: string;
}

export interface LayoutWorkspace {
  windows: LayoutWindow[];
  activeWindowId: string;
}

export type FocusDirection = "left" | "right" | "up" | "down";

/** Normalized rect in [0,1]² used by focusDir geometry. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
