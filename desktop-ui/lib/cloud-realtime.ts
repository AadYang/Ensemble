"use client";

import type { CloudRealtimeClientMsg, CloudRealtimeServerMsg } from "@agentorch/shared";
import type { CloudSession } from "./cloud-api";

type Listener = (msg: CloudRealtimeServerMsg) => void;

function realtimeUrl(session: CloudSession, role: "desktop" | "web"): string {
  const base = new URL(session.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/v1/cloud/realtime";
  base.search = "";
  base.searchParams.set("role", role);
  base.searchParams.set("token", session.token);
  return base.toString();
}

export class CloudRealtimeClient {
  private ws: WebSocket | null = null;
  private retryMs = 1000;
  private closedByUser = false;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly session: CloudSession, private readonly role: "desktop" | "web") {}

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    const ws = new WebSocket(realtimeUrl(this.session, this.role));
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retryMs = 1000;
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data) as CloudRealtimeServerMsg;
        for (const listener of this.listeners) listener(msg);
      } catch {
        // Ignore non-JSON frames.
      }
    });
    ws.addEventListener("close", () => {
      this.ws = null;
      if (!this.closedByUser) {
        const delay = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, 15000);
        window.setTimeout(() => this.connect(), delay);
      }
    });
    ws.addEventListener("error", () => {
      ws.close();
    });
  }

  send(msg: CloudRealtimeClientMsg): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
    this.listeners.clear();
  }
}
