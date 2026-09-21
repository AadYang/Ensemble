"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuSelectItem {
  value: string;
  label: string;
  group?: string;
}

/** In-dialog replacement for native `<select>`.
 *
 *  WebView2 paints the OS dropdown behind a `position:fixed` overlay (and
 *  `backdrop-filter` can swallow it entirely), so a create-agent dialog that
 *  uses `<select>` looks like the provider list cannot be opened. The menu is
 *  portaled to `document.body` so overflow on the dialog card cannot clip it.
 */
export function MenuSelect({
  value,
  onChange,
  items,
  placeholder,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  items: readonly MenuSelectItem[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const selected = items.find((i) => i.value === value);

  const openMenu = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const groups: Array<{ name: string | null; items: MenuSelectItem[] }> = [];
  for (const item of items) {
    const name = item.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(item);
    else groups.push({ name, items: [item] });
  }

  const menu =
    open && anchor ? (
      <>
        <div
          className="fixed inset-0 z-[10049]"
          onMouseDown={(e) => {
            e.preventDefault();
            setOpen(false);
          }}
        />
        <div
          ref={menuRef}
          role="listbox"
          style={{ top: anchor.top, left: anchor.left, width: Math.max(anchor.width, 160) }}
          className="fixed z-[10050] max-h-48 overflow-y-auto border border-[var(--border)] bg-[var(--bg-elevated)] shadow-xl shadow-black/50 text-xs"
        >
          {items.length === 0 && (
            <div className="px-1.5 py-1 text-[var(--text-faint)]">{placeholder}</div>
          )}
          {groups.map((g, gi) => (
            <div key={g.name ?? `g${gi}`}>
              {g.name && (
                <div className="px-1.5 py-0.5 text-[10px] tracking-wider text-[var(--text-faint)]">
                  {g.name}
                </div>
              )}
              {g.items.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="option"
                  aria-selected={item.value === value}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                  className={
                    "w-full text-left px-1.5 py-1 hover:bg-[var(--bg-pane)] hover:text-[var(--accent)] " +
                    (item.value === value ? "text-[var(--accent)]" : "text-[var(--text)]")
                  }
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </>
    ) : null;

  return (
    <div className={className}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={openMenu}
        className="w-full text-left bg-[var(--bg-pane)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)] disabled:opacity-50 truncate"
      >
        {selected?.label ?? placeholder ?? ""}
      </button>
      {typeof document !== "undefined" && menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
