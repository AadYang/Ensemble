"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * One collapsible section at the bottom of the sidebar.
 *
 * All three callers (providers / MCP / skills) had the same header markup, and
 * the same two problems: a `--text-faint` caret that read as decoration rather
 * than a control, and an open state that reset on every re-render because it
 * lived in a component the tree remounts. Both are fixed once, here, so the
 * three sections cannot drift into three different-looking controls.
 *
 * The content area is BOUNDED and scrolls on its own. That is the other half of
 * the sidebar fix: an expanded section used to push the sections below it out
 * of the viewport with no way to reach them, because nothing between the aside
 * and the list could scroll. A section now grows only to `max-h`, and its list
 * scrolls inside it.
 */

/** Persisted per section, so opening providers does not open MCP. */
export const PANEL_OPEN_KEYS = {
  providers: "ensemble.sidebar.providers.open",
  mcp: "ensemble.sidebar.mcp.open",
  skills: "ensemble.sidebar.skills.open",
} as const;

export function CollapsibleSection({
  storageKey,
  label,
  badge,
  defaultOpen = false,
  children,
}: {
  storageKey: string;
  label: string;
  /** The count on the right. Kept as a node so a section can say more than a
   *  number (`3/5` for MCP) without the section knowing what it means. */
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Read after mount rather than during render: the page is exported as static
  // HTML, and a first render that disagreed with it would be a hydration
  // mismatch — the persisted state is a client-only fact.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) setOpen(raw === "1");
    } catch {
      /* private mode — fall back to the default */
    }
  }, [storageKey]);

  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* quota — the section still opens, it just will not be remembered */
      }
      return next;
    });

  return (
    <div className="shrink-0 min-h-0 border-b border-[var(--border)] flex flex-col">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group w-full text-left px-3 py-2 flex items-center gap-2 text-xs border-l-2 border-transparent hover:border-[var(--accent)] hover:bg-[var(--bg-pane)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)] transition-colors"
      >
        <span className="w-3 shrink-0 text-center text-[var(--text)] group-hover:text-[var(--accent)]">
          {open ? "▾" : "▸"}
        </span>
        <span className="tracking-wider text-[var(--text)] group-hover:text-[var(--accent)]">{label}</span>
        {badge !== undefined && (
          <span className="ml-auto tabular-nums text-[var(--text-dim)] group-hover:text-[var(--text)]">{badge}</span>
        )}
      </button>
      {open && (
        <div className="min-h-0 max-h-[30vh] overflow-y-auto overscroll-contain px-2 pb-2 flex flex-col gap-1 text-[11px]">
          {children}
        </div>
      )}
    </div>
  );
}
