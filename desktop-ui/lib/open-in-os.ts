"use client";

import { parseChatLink } from "@agentorch/shared";

export async function openInOs(raw: string): Promise<void> {
  const link = parseChatLink(raw);
  if (!link) return;
  const target = link.kind === "url" ? link.href : link.path;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("open_in_os", { target });
    } catch (err) {
      console.warn("[open-in-os]", err);
    }
    return;
  }
  if (link.kind === "url") {
    window.open(link.href, "_blank", "noopener,noreferrer");
  }
}
