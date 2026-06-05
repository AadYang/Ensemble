"use client";

import { useEffect, useState } from "react";
import { useT } from "@/i18n/useT";

type LoadState = "checking" | "ready" | "missing";

export function TutorialDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [state, setState] = useState<LoadState>("checking");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Probe tutorial.html BEFORE rendering the iframe. Belt-and-suspenders even
  // though sidecar's 404 handler no longer falls back to index.html for
  // file-extension URLs — this guarantees a clean error UI in the dialog
  // itself instead of WebView2's generic "This page couldn't load" page.
  useEffect(() => {
    let cancelled = false;
    void fetch("/tutorial.html", { method: "HEAD" })
      .then((res) => {
        if (cancelled) return;
        setState(res.ok ? "ready" : "missing");
      })
      .catch(() => {
        if (!cancelled) setState("missing");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-white text-black w-full max-w-[1200px] h-full max-h-[92vh] flex flex-col shadow-2xl">
        <div className="flex items-center px-3 py-1.5 border-b border-gray-300 bg-gray-100 text-xs">
          <span className="font-bold tracking-wider text-gray-800">{t("tutorial.title")}</span>
          <span className="flex-1" />
          <button
            onClick={onClose}
            title={t("tutorial.close")}
            className="px-2 py-0.5 border border-gray-400 text-gray-700 hover:text-white hover:bg-red-600 hover:border-red-600 transition-colors"
          >
            ✕
          </button>
        </div>
        {state === "checking" && (
          <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
            {t("tutorial.loading")}
          </div>
        )}
        {state === "missing" && (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-700 text-sm p-8 text-center gap-3">
            <div className="text-base font-bold text-red-600">{t("tutorial.missing.title")}</div>
            <div>{t("tutorial.missing.body")}</div>
            <code className="bg-gray-100 px-2 py-1 text-xs">/tutorial.html</code>
          </div>
        )}
        {state === "ready" && (
          <iframe
            src="/tutorial.html"
            // sandbox without `allow-same-origin` prevents the iframe from
            // touching the parent's WebSocket / Zustand singletons even in
            // pathological cases. allow-scripts only — enough for the scroll-
            // spy inside the static tutorial; no DOM access into the parent.
            sandbox="allow-scripts"
            className="flex-1 w-full border-0 bg-white"
            title={t("tutorial.title")}
          />
        )}
      </div>
    </div>
  );
}
