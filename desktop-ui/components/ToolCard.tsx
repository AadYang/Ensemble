"use client";

import { displayToolName } from "@/lib/tool-display";

export type ToolCardStatus = "pending" | "approved" | "denied" | "ran";

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
        {status && (
          <span className={`text-[10px] tracking-wider ${statusTone(status)}`}>
            [{status}]
          </span>
        )}
      </div>
      {input !== undefined && input !== null && (
        <pre className="text-[var(--text-dim)] overflow-x-auto whitespace-pre-wrap break-words leading-snug">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}
