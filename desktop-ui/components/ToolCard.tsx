"use client";

import { isSubagentToolName } from "@agentorch/shared";
import { displayToolName } from "@/lib/tool-display";
import { toolCardOperationLines } from "@/lib/tool-card-facts";

export type ToolCardStatus = "pending" | "approved" | "denied" | "ran";

function subagentCardFacts(input: unknown): {
  description?: string;
  kind?: string;
  background?: boolean;
} {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  const description = typeof o.description === "string" ? o.description.trim() : "";
  const kindRaw =
    (typeof o.subagent_type === "string" && o.subagent_type) ||
    (typeof o.tool === "string" && o.tool) ||
    "";
  return {
    description: description.length > 0 ? description : undefined,
    kind: kindRaw.trim() || undefined,
    background: o.background === true || o.run_in_background === true,
  };
}

export function ToolCard({
  name,
  input,
  status,
}: {
  name: string;
  input: unknown;
  status?: ToolCardStatus;
}) {
  const displayName = displayToolName(name);
  const isSubagent = isSubagentToolName(name);
  const facts = isSubagent ? subagentCardFacts(input) : undefined;
  const opLines = isSubagent ? [] : toolCardOperationLines(input);
  const statusTone = (s: ToolCardStatus | undefined): string => {
    switch (s) {
      case "pending": return "text-[var(--warn)]";
      case "approved": return "text-[var(--accent)]";
      case "ran": return "text-[var(--ok)]";
      case "denied": return "text-[var(--err)]";
      default: return "text-[var(--text-dim)]";
    }
  };

  return (
    <div className="tool-card text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[var(--warn)]">⌬</span>
        <span className="text-[var(--text)] font-bold tracking-wider">{displayName}</span>
        {facts?.kind && (
          <span className="text-[var(--text-dim)]">{facts.kind}</span>
        )}
        {isSubagent && (
          <span className="text-[10px] text-[var(--accent)] tracking-wider">[subagent]</span>
        )}
        {facts?.background && (
          <span className="text-[10px] text-[var(--text-dim)] tracking-wider">[bg]</span>
        )}
        {status && (
          <span className={`text-[10px] tracking-wider ${statusTone(status)}`}>
            [{status}]
          </span>
        )}
      </div>
      {facts?.description && (
        <div className="text-[var(--text-dim)]">→ {facts.description}</div>
      )}
      {opLines.map((line, i) => (
        <div key={i} className="text-[var(--text)] break-all leading-snug">
          {line}
        </div>
      ))}
    </div>
  );
}
