/**
 * Pure functions on LayoutNode trees. No mutation, no side effects.
 * Coverage target per CLAUDE.md 3.3 = 100%.
 */

import type { FocusDirection, LayoutNode, NormRect, SplitDir } from "./layout";

const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function findPane(root: LayoutNode, paneId: string): LayoutNode | null {
  if (root.kind === "pane") return root.id === paneId ? root : null;
  return findPane(root.a, paneId) ?? findPane(root.b, paneId);
}

export function listLeaves(root: LayoutNode): Array<{ id: string; agentId: string | null }> {
  if (root.kind === "pane") return [{ id: root.id, agentId: root.agentId }];
  return [...listLeaves(root.a), ...listLeaves(root.b)];
}

export function paneRect(
  root: LayoutNode,
  paneId: string,
  bounds: NormRect = { x: 0, y: 0, w: 1, h: 1 },
): NormRect | null {
  if (root.kind === "pane") return root.id === paneId ? bounds : null;
  if (root.dir === "h") {
    const aw = bounds.w * root.ratio;
    const aBounds: NormRect = { x: bounds.x, y: bounds.y, w: aw, h: bounds.h };
    const bBounds: NormRect = { x: bounds.x + aw, y: bounds.y, w: bounds.w - aw, h: bounds.h };
    return paneRect(root.a, paneId, aBounds) ?? paneRect(root.b, paneId, bBounds);
  }
  const ah = bounds.h * root.ratio;
  const aBounds: NormRect = { x: bounds.x, y: bounds.y, w: bounds.w, h: ah };
  const bBounds: NormRect = { x: bounds.x, y: bounds.y + ah, w: bounds.w, h: bounds.h - ah };
  return paneRect(root.a, paneId, aBounds) ?? paneRect(root.b, paneId, bBounds);
}

export interface SplitOpts {
  newPaneId: string;
  newAgentId?: string | null;
  splitId: string;
  ratio?: number;
  placeNewIn?: "a" | "b";
}

export function splitPane(
  root: LayoutNode,
  paneId: string,
  dir: SplitDir,
  opts: SplitOpts,
): LayoutNode {
  if (root.kind === "pane") {
    if (root.id !== paneId) return root;
    const newPane: LayoutNode = {
      kind: "pane",
      id: opts.newPaneId,
      agentId: opts.newAgentId ?? null,
    };
    const ratio = clamp(opts.ratio ?? 0.5, MIN_RATIO, MAX_RATIO);
    const placeNewIn = opts.placeNewIn ?? "b";
    return {
      kind: "split",
      id: opts.splitId,
      dir,
      ratio,
      a: placeNewIn === "a" ? newPane : root,
      b: placeNewIn === "a" ? root : newPane,
    };
  }
  const newA = splitPane(root.a, paneId, dir, opts);
  const newB = splitPane(root.b, paneId, dir, opts);
  if (newA === root.a && newB === root.b) return root;
  return { ...root, a: newA, b: newB };
}

/** Returns null when the only remaining pane is closed. */
export function closePane(root: LayoutNode, paneId: string): LayoutNode | null {
  if (root.kind === "pane") return root.id === paneId ? null : root;
  const newA = closePane(root.a, paneId);
  const newB = closePane(root.b, paneId);
  if (newA === null && newB === null) return null;
  if (newA === null) return newB;
  if (newB === null) return newA;
  if (newA === root.a && newB === root.b) return root;
  return { ...root, a: newA, b: newB };
}

export function focusCycle(
  root: LayoutNode,
  currentId: string,
  direction: "next" | "prev",
): string {
  const leaves = listLeaves(root);
  if (leaves.length === 0) return currentId;
  const idx = leaves.findIndex((l) => l.id === currentId);
  if (idx < 0) return leaves[0]!.id;
  const step = direction === "next" ? 1 : -1;
  const newIdx = (idx + step + leaves.length) % leaves.length;
  return leaves[newIdx]!.id;
}

const overlapRange = (a1: number, a2: number, b1: number, b2: number): number =>
  Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/**
 * Center-overlap heuristic (per user decision):
 * 1. require candidate's center to be on the requested side of current's center
 * 2. require non-zero overlap on the perpendicular axis (so a "right" pane must share
 *    some vertical span with current — prevents jumping diagonally)
 * 3. minimize main-axis distance, with a small tiebreaker on cross-axis distance
 */
export function focusDir(root: LayoutNode, currentId: string, dir: FocusDirection): string {
  const cur = paneRect(root, currentId);
  if (!cur) return currentId;
  const curCx = cur.x + cur.w / 2;
  const curCy = cur.y + cur.h / 2;
  const horizontal = dir === "left" || dir === "right";

  let best: { id: string; score: number } | null = null;

  for (const leaf of listLeaves(root)) {
    if (leaf.id === currentId) continue;
    const r = paneRect(root, leaf.id);
    if (!r) continue;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;

    if (dir === "left" && cx >= curCx) continue;
    if (dir === "right" && cx <= curCx) continue;
    if (dir === "up" && cy >= curCy) continue;
    if (dir === "down" && cy <= curCy) continue;

    const overlap = horizontal
      ? overlapRange(cur.y, cur.y + cur.h, r.y, r.y + r.h)
      : overlapRange(cur.x, cur.x + cur.w, r.x, r.x + r.w);
    if (overlap <= 0) continue;

    const mainDist = horizontal ? Math.abs(cx - curCx) : Math.abs(cy - curCy);
    const crossDist = horizontal ? Math.abs(cy - curCy) : Math.abs(cx - curCx);
    const score = mainDist + crossDist * 0.1;

    if (!best || score < best.score) best = { id: leaf.id, score };
  }

  return best?.id ?? currentId;
}

/** Set every pane bound to `agentId` back to null. Referentially identical when no pane matches.
 * Used to enforce single-binding when re-attaching an agent to a different pane. */
export function clearAgentFromTree(root: LayoutNode, agentId: string): LayoutNode {
  if (root.kind === "pane") {
    return root.agentId === agentId ? { ...root, agentId: null } : root;
  }
  const newA = clearAgentFromTree(root.a, agentId);
  const newB = clearAgentFromTree(root.b, agentId);
  if (newA === root.a && newB === root.b) return root;
  return { ...root, a: newA, b: newB };
}

/** Replace the agentId on the named pane. No-op if pane missing or value unchanged. */
export function setPaneAgent(
  root: LayoutNode,
  paneId: string,
  agentId: string | null,
): LayoutNode {
  if (root.kind === "pane") {
    if (root.id !== paneId || root.agentId === agentId) return root;
    return { ...root, agentId };
  }
  const newA = setPaneAgent(root.a, paneId, agentId);
  const newB = setPaneAgent(root.b, paneId, agentId);
  if (newA === root.a && newB === root.b) return root;
  return { ...root, a: newA, b: newB };
}

/** Set ratio of the named split node directly (clamped). Used by drag-resize from UI. */
export function resizeSplit(root: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (root.kind === "pane") return root;
  if (root.id === splitId) {
    const clamped = clamp(ratio, MIN_RATIO, MAX_RATIO);
    if (clamped === root.ratio) return root;
    return { ...root, ratio: clamped };
  }
  const newA = resizeSplit(root.a, splitId, ratio);
  const newB = resizeSplit(root.b, splitId, ratio);
  if (newA === root.a && newB === root.b) return root;
  return { ...root, a: newA, b: newB };
}

/**
 * Keyboard resize (vim H/J/K/L style — adjusts pane's own size, not its boundary).
 *   right/down with delta>0 → grow the pane on that axis
 *   left/up    with delta>0 → shrink the pane on that axis
 * Walks from pane up; the first ancestor split whose axis matches the requested
 * direction is adjusted. Direction of ratio change depends on which side the pane
 * sits on. Returns root unchanged if no axis-matching ancestor exists.
 */
export function resize(
  root: LayoutNode,
  paneId: string,
  dir: FocusDirection,
  delta: number,
): LayoutNode {
  const wantAxis: SplitDir = dir === "left" || dir === "right" ? "h" : "v";
  const expandSign = dir === "right" || dir === "down" ? 1 : -1;

  const go = (node: LayoutNode): { node: LayoutNode; pendingFound: boolean } => {
    if (node.kind === "pane") {
      return { node, pendingFound: node.id === paneId };
    }
    const ra = go(node.a);
    if (ra.pendingFound) {
      if (node.dir === wantAxis) {
        const newRatio = clamp(node.ratio + expandSign * delta, MIN_RATIO, MAX_RATIO);
        if (newRatio === node.ratio && ra.node === node.a) {
          return { node, pendingFound: false };
        }
        return { node: { ...node, a: ra.node, ratio: newRatio }, pendingFound: false };
      }
      if (ra.node === node.a) return { node, pendingFound: true };
      return { node: { ...node, a: ra.node }, pendingFound: true };
    }
    const rb = go(node.b);
    if (rb.pendingFound) {
      if (node.dir === wantAxis) {
        const newRatio = clamp(node.ratio - expandSign * delta, MIN_RATIO, MAX_RATIO);
        if (newRatio === node.ratio && rb.node === node.b) {
          return { node, pendingFound: false };
        }
        return { node: { ...node, b: rb.node, ratio: newRatio }, pendingFound: false };
      }
      if (rb.node === node.b) return { node, pendingFound: true };
      return { node: { ...node, b: rb.node }, pendingFound: true };
    }
    return { node, pendingFound: false };
  };

  return go(root).node;
}
