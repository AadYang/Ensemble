import { describe, expect, it } from "vitest";
import type { LayoutNode } from "./layout";
import {
  clearAgentFromTree,
  closePane,
  findPane,
  focusCycle,
  focusDir,
  listLeaves,
  paneRect,
  resize,
  resizeSplit,
  setPaneAgent,
  splitPane,
} from "./layout-ops";

const pane = (id: string, agentId: string | null = null): LayoutNode => ({ kind: "pane", id, agentId });

describe("findPane / listLeaves", () => {
  it("finds the only pane in a singleton tree", () => {
    const root = pane("p1");
    expect(findPane(root, "p1")).toEqual(root);
    expect(findPane(root, "missing")).toBeNull();
    expect(listLeaves(root)).toEqual([{ id: "p1", agentId: null }]);
  });

  it("traverses depth-first left-to-right", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    const tree2 = splitPane(tree, "p2", "v", { newPaneId: "p3", splitId: "s2" });
    expect(listLeaves(tree2).map((l) => l.id)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("splitPane", () => {
  it("splits the root pane → split node with original on the a side, new on b", () => {
    const root = pane("p1", "agent-1");
    const result = splitPane(root, "p1", "h", { newPaneId: "p2", splitId: "s1" });
    expect(result).toEqual({
      kind: "split",
      id: "s1",
      dir: "h",
      ratio: 0.5,
      a: { kind: "pane", id: "p1", agentId: "agent-1" },
      b: { kind: "pane", id: "p2", agentId: null },
    });
  });

  it("respects placeNewIn=a", () => {
    const root = pane("p1");
    const result = splitPane(root, "p1", "v", { newPaneId: "p2", splitId: "s1", placeNewIn: "a" });
    expect(result.kind).toBe("split");
    if (result.kind === "split") {
      expect((result.a as { id: string }).id).toBe("p2");
      expect((result.b as { id: string }).id).toBe("p1");
    }
  });

  it("splits a leaf inside a deep tree, leaving siblings untouched (referential)", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    const treeBefore = splitPane(tree, "p2", "v", { newPaneId: "p3", splitId: "s2" });
    const treeAfter = splitPane(treeBefore, "p3", "h", { newPaneId: "p4", splitId: "s3" });
    if (treeBefore.kind !== "split" || treeAfter.kind !== "split") throw new Error("expected splits");
    expect(treeAfter.a).toBe(treeBefore.a);
  });

  it("is a no-op when target pane id does not exist in the tree", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    const result = splitPane(tree, "missing", "v", { newPaneId: "px", splitId: "sx" });
    expect(result).toBe(tree);
  });

  it("clamps an out-of-range ratio to [0.05, 0.95]", () => {
    const tooSmall = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1", ratio: -0.5 });
    const tooLarge = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1", ratio: 1.5 });
    if (tooSmall.kind !== "split" || tooLarge.kind !== "split") throw new Error("expected splits");
    expect(tooSmall.ratio).toBeCloseTo(0.05);
    expect(tooLarge.ratio).toBeCloseTo(0.95);
  });

  it("survives many consecutive splits without ratio degeneracy", () => {
    let tree: LayoutNode = pane("p0");
    for (let i = 1; i <= 6; i++) {
      tree = splitPane(tree, `p${i - 1}`, i % 2 === 0 ? "v" : "h", {
        newPaneId: `p${i}`,
        splitId: `s${i}`,
      });
    }
    const leaves = listLeaves(tree);
    expect(leaves).toHaveLength(7);
    // All ratios remain in [0.05, 0.95]
    const visit = (n: LayoutNode) => {
      if (n.kind === "split") {
        expect(n.ratio).toBeGreaterThanOrEqual(0.05);
        expect(n.ratio).toBeLessThanOrEqual(0.95);
        visit(n.a);
        visit(n.b);
      }
    };
    visit(tree);
  });
});

describe("closePane", () => {
  it("closing the only pane in a singleton tree yields null", () => {
    expect(closePane(pane("p1"), "p1")).toBeNull();
  });

  it("closing a leaf promotes its sibling to take the split's place", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    const result = closePane(tree, "p2");
    expect(result).toEqual({ kind: "pane", id: "p1", agentId: null });
  });

  it("closing a deeply nested leaf keeps the rest of the tree intact", () => {
    let tree: LayoutNode = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    tree = splitPane(tree, "p2", "v", { newPaneId: "p3", splitId: "s2" });
    const result = closePane(tree, "p3");
    expect(listLeaves(result!).map((l) => l.id)).toEqual(["p1", "p2"]);
  });

  it("is a no-op (referentially) when target pane id does not exist", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    const result = closePane(tree, "missing");
    expect(result).toBe(tree);
  });
});

describe("paneRect", () => {
  it("singleton pane occupies the full unit square", () => {
    expect(paneRect(pane("p1"), "p1")).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("h split with ratio 0.3 places a on left 30% and b on right 70%", () => {
    const tree = splitPane(pane("p1"), "p1", "h", {
      newPaneId: "p2",
      splitId: "s1",
      ratio: 0.3,
    });
    expect(paneRect(tree, "p1")).toEqual({ x: 0, y: 0, w: 0.3, h: 1 });
    expect(paneRect(tree, "p2")).toEqual({ x: 0.3, y: 0, w: 0.7, h: 1 });
  });

  it("v split with ratio 0.4 places a on top 40% and b on bottom 60%", () => {
    const tree = splitPane(pane("p1"), "p1", "v", {
      newPaneId: "p2",
      splitId: "s1",
      ratio: 0.4,
    });
    expect(paneRect(tree, "p1")).toEqual({ x: 0, y: 0, w: 1, h: 0.4 });
    expect(paneRect(tree, "p2")).toEqual({ x: 0, y: 0.4, w: 1, h: 0.6 });
  });

  it("returns null for missing pane id", () => {
    expect(paneRect(pane("p1"), "missing")).toBeNull();
  });
});

describe("focusCycle", () => {
  it("cycles forward through leaves and wraps around", () => {
    let tree: LayoutNode = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    tree = splitPane(tree, "p2", "v", { newPaneId: "p3", splitId: "s2" });
    expect(focusCycle(tree, "p1", "next")).toBe("p2");
    expect(focusCycle(tree, "p2", "next")).toBe("p3");
    expect(focusCycle(tree, "p3", "next")).toBe("p1");
  });

  it("cycles backward through leaves", () => {
    let tree: LayoutNode = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    tree = splitPane(tree, "p2", "v", { newPaneId: "p3", splitId: "s2" });
    expect(focusCycle(tree, "p1", "prev")).toBe("p3");
  });

  it("returns the first leaf when current id is unknown", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    expect(focusCycle(tree, "missing", "next")).toBe("p1");
  });
});

describe("focusDir (center-overlap)", () => {
  // Build a 2x2 grid:
  //   p1 (top-left)  | p2 (top-right)
  //   ---------------+----------------
  //   p3 (bot-left)  | p4 (bot-right)
  // Topology: outer v split → top h split (p1, p2), bottom h split (p3, p4)
  const grid2x2 = (): LayoutNode => {
    const top: LayoutNode = {
      kind: "split",
      id: "top",
      dir: "h",
      ratio: 0.5,
      a: pane("p1"),
      b: pane("p2"),
    };
    const bot: LayoutNode = {
      kind: "split",
      id: "bot",
      dir: "h",
      ratio: 0.5,
      a: pane("p3"),
      b: pane("p4"),
    };
    return { kind: "split", id: "outer", dir: "v", ratio: 0.5, a: top, b: bot };
  };

  it("right of p1 is p2 (cross-nesting via top h split)", () => {
    expect(focusDir(grid2x2(), "p1", "right")).toBe("p2");
  });

  it("down of p1 is p3 (cross-nesting via outer v split)", () => {
    expect(focusDir(grid2x2(), "p1", "down")).toBe("p3");
  });

  it("up of p4 is p2 (cross-nesting bottom→top)", () => {
    expect(focusDir(grid2x2(), "p4", "up")).toBe("p2");
  });

  it("returns same id when no candidate exists in that direction", () => {
    expect(focusDir(grid2x2(), "p1", "left")).toBe("p1");
    expect(focusDir(grid2x2(), "p1", "up")).toBe("p1");
  });

  it("on a singleton, every direction returns the only pane", () => {
    expect(focusDir(pane("p1"), "p1", "right")).toBe("p1");
  });
});

describe("setPaneAgent", () => {
  it("attaches an agent id to a pane", () => {
    const result = setPaneAgent(pane("p1"), "p1", "agent-1");
    expect(result).toEqual({ kind: "pane", id: "p1", agentId: "agent-1" });
  });

  it("clears an agent id when given null", () => {
    const tree: LayoutNode = { kind: "pane", id: "p1", agentId: "agent-1" };
    const result = setPaneAgent(tree, "p1", null);
    expect((result as { agentId: string | null }).agentId).toBeNull();
  });

  it("is referentially identical when value already matches", () => {
    const tree: LayoutNode = { kind: "pane", id: "p1", agentId: "agent-1" };
    expect(setPaneAgent(tree, "p1", "agent-1")).toBe(tree);
  });

  it("is referentially identical when pane id is missing", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    expect(setPaneAgent(tree, "missing", "agent-1")).toBe(tree);
  });

  it("only changes the matching pane in a deep tree", () => {
    let tree: LayoutNode = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    tree = splitPane(tree, "p2", "v", { newPaneId: "p3", splitId: "s2" });
    const result = setPaneAgent(tree, "p3", "agent-x");
    const leaves = listLeaves(result);
    expect(leaves.find((l) => l.id === "p3")?.agentId).toBe("agent-x");
    expect(leaves.find((l) => l.id === "p1")?.agentId).toBeNull();
    expect(leaves.find((l) => l.id === "p2")?.agentId).toBeNull();
  });
});

describe("clearAgentFromTree", () => {
  it("clears the matching pane in a singleton", () => {
    const root: LayoutNode = { kind: "pane", id: "p1", agentId: "agent-x" };
    const result = clearAgentFromTree(root, "agent-x");
    expect((result as { agentId: string | null }).agentId).toBeNull();
  });

  it("is referentially identical when nothing matches", () => {
    const tree = splitPane(pane("p1", "agent-a"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    expect(clearAgentFromTree(tree, "agent-z")).toBe(tree);
  });

  it("clears multiple panes that bound the same agent", () => {
    let tree: LayoutNode = splitPane(pane("p1", "agent-x"), "p1", "h", {
      newPaneId: "p2",
      splitId: "s1",
      newAgentId: "agent-x",
    });
    tree = splitPane(tree, "p2", "v", { newPaneId: "p3", splitId: "s2", newAgentId: "agent-y" });
    const result = clearAgentFromTree(tree, "agent-x");
    const leaves = listLeaves(result);
    expect(leaves.find((l) => l.id === "p1")?.agentId).toBeNull();
    expect(leaves.find((l) => l.id === "p2")?.agentId).toBeNull();
    expect(leaves.find((l) => l.id === "p3")?.agentId).toBe("agent-y");
  });

  it("leaves panes bound to other agents intact", () => {
    const tree = splitPane(pane("p1", "agent-a"), "p1", "h", {
      newPaneId: "p2",
      splitId: "s1",
      newAgentId: "agent-b",
    });
    const result = clearAgentFromTree(tree, "agent-a");
    const leaves = listLeaves(result);
    expect(leaves.find((l) => l.id === "p1")?.agentId).toBeNull();
    expect(leaves.find((l) => l.id === "p2")?.agentId).toBe("agent-b");
  });
});

describe("resizeSplit", () => {
  it("clamps ratio to [0.05, 0.95]", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1", ratio: 0.5 });
    const tooSmall = resizeSplit(tree, "s1", 0.001);
    const tooLarge = resizeSplit(tree, "s1", 1.5);
    if (tooSmall.kind !== "split" || tooLarge.kind !== "split") throw new Error("expected splits");
    expect(tooSmall.ratio).toBeCloseTo(0.05);
    expect(tooLarge.ratio).toBeCloseTo(0.95);
  });

  it("is referentially identical when ratio is unchanged", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1", ratio: 0.5 });
    expect(resizeSplit(tree, "s1", 0.5)).toBe(tree);
  });

  it("is a no-op for unknown split id", () => {
    const tree = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });
    expect(resizeSplit(tree, "missing", 0.7)).toBe(tree);
  });
});

describe("resize (keyboard, vim-style)", () => {
  // Tree: h split [p1 | p2], ratio=0.5
  const hPair = (): LayoutNode =>
    splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "s1" });

  it("expanding right while pane is on the left grows ratio", () => {
    const tree = hPair();
    const result = resize(tree, "p1", "right", 0.1);
    if (result.kind !== "split") throw new Error("expected split");
    expect(result.ratio).toBeCloseTo(0.6);
  });

  it("expanding right while pane is on the right shrinks ratio", () => {
    const tree = hPair();
    const result = resize(tree, "p2", "right", 0.1);
    if (result.kind !== "split") throw new Error("expected split");
    expect(result.ratio).toBeCloseTo(0.4);
  });

  it("expanding left while pane is on the left shrinks ratio", () => {
    const tree = hPair();
    const result = resize(tree, "p1", "left", 0.1);
    if (result.kind !== "split") throw new Error("expected split");
    expect(result.ratio).toBeCloseTo(0.4);
  });

  it("clamps at 0.95 boundary so the pane cannot eat its sibling entirely", () => {
    const tree = hPair();
    const result = resize(tree, "p1", "right", 1.0);
    if (result.kind !== "split") throw new Error("expected split");
    expect(result.ratio).toBeCloseTo(0.95);
  });

  it("clamps at 0.05 boundary in the other direction", () => {
    const tree = hPair();
    const result = resize(tree, "p1", "left", 1.0);
    if (result.kind !== "split") throw new Error("expected split");
    expect(result.ratio).toBeCloseTo(0.05);
  });

  it("is a no-op when there is no matching ancestor split (e.g., resize vertically in a horizontal-only tree)", () => {
    const tree = hPair();
    expect(resize(tree, "p1", "down", 0.1)).toBe(tree);
  });

  it("is a no-op when target pane id is missing", () => {
    const tree = hPair();
    expect(resize(tree, "missing", "right", 0.1)).toBe(tree);
  });

  it("walks up past non-matching ancestors to find the right one", () => {
    // outer h split [p1 | inner], inner v split [p2 / p3]
    // resize p2 "right" should adjust outer h split (since inner is v, doesn't match)
    let tree: LayoutNode = splitPane(pane("p1"), "p1", "h", { newPaneId: "p2", splitId: "outer" });
    tree = splitPane(tree, "p2", "v", { newPaneId: "p3", splitId: "inner" });
    const result = resize(tree, "p2", "right", 0.1);
    if (result.kind !== "split") throw new Error("expected outer split");
    // p2 is in outer.b (right side); expanding right shrinks outer.ratio
    expect(result.ratio).toBeCloseTo(0.4);
    // inner split untouched
    if (result.b.kind !== "split") throw new Error("expected inner split");
    expect(result.b.ratio).toBeCloseTo(0.5);
  });
});
