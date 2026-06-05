"use client";

import { Group, Panel, Separator } from "react-resizable-panels";
import type { LayoutNode } from "@agentorch/shared";
import { useStore } from "@/store/agents";
import { PaneShell } from "./PaneShell";

export function LayoutRenderer({ node }: { node: LayoutNode }) {
  const resizeSplitTo = useStore((s) => s.resizeSplitTo);

  if (node.kind === "pane") {
    return <PaneShell paneId={node.id} agentId={node.agentId} />;
  }

  const aPanelId = `${node.id}-a`;
  return (
    <Group
      id={node.id}
      orientation={node.dir === "h" ? "horizontal" : "vertical"}
      onLayoutChanged={(layout) => {
        const aPercent = layout[aPanelId];
        if (typeof aPercent === "number") resizeSplitTo(node.id, aPercent / 100);
      }}
      className="h-full w-full"
    >
      <Panel id={aPanelId} defaultSize={node.ratio * 100} minSize={5}>
        <LayoutRenderer node={node.a} />
      </Panel>
      <Separator
        className={
          node.dir === "h"
            ? "w-px bg-[var(--border)] hover:bg-[var(--accent)] data-[separator-active]:bg-[var(--accent)]"
            : "h-px bg-[var(--border)] hover:bg-[var(--accent)] data-[separator-active]:bg-[var(--accent)]"
        }
      />
      <Panel id={`${node.id}-b`} defaultSize={(1 - node.ratio) * 100} minSize={5}>
        <LayoutRenderer node={node.b} />
      </Panel>
    </Group>
  );
}
