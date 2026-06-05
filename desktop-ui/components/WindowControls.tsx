"use client";

import { useEffect, useState } from "react";

// Custom window controls for the borderless (decorations:false) Tauri window.
// Renders nothing outside Tauri so `next dev` in a browser stays clickable.
export function WindowControls() {
  const [inTauri, setInTauri] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const detected = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    setInTauri(detected);
    if (!detected) return;
    let unlistenResize: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      setMaximized(await w.isMaximized());
      unlistenResize = await w.onResized(async () => {
        setMaximized(await w.isMaximized());
      });
    })();
    return () => unlistenResize?.();
  }, []);

  if (!inTauri) return null;

  const call = async (method: "minimize" | "toggleMaximize" | "close") => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w[method]();
  };

  return (
    <div className="flex items-center -mr-2 -my-2 ml-1 self-stretch">
      <button
        onClick={() => void call("minimize")}
        title="Minimize"
        aria-label="Minimize"
        className="w-10 h-full flex items-center justify-center text-[var(--text-dim)] hover:bg-[var(--bg-pane)] hover:text-[var(--text)] transition-colors leading-none"
      >
        <span className="text-base">─</span>
      </button>
      <button
        onClick={() => void call("toggleMaximize")}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        className="w-10 h-full flex items-center justify-center text-[var(--text-dim)] hover:bg-[var(--bg-pane)] hover:text-[var(--text)] transition-colors leading-none"
      >
        <span className="text-[11px]">{maximized ? "❐" : "▢"}</span>
      </button>
      <button
        onClick={() => void call("close")}
        title="Close"
        aria-label="Close"
        className="w-10 h-full flex items-center justify-center text-[var(--text-dim)] hover:bg-[var(--err)] hover:text-black transition-colors leading-none"
      >
        <span className="text-sm">✕</span>
      </button>
    </div>
  );
}
