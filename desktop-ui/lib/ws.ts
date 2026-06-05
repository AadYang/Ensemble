"use client";

import type { ClientMsg, ServerMsg } from "@agentorch/shared";

type Listener = (msg: ServerMsg) => void;

class WSClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private url: string;
  private retryMs = 1000;
  private closedByUser = false;

  constructor(url: string) {
    this.url = url;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retryMs = 1000;
    });

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMsg;
        for (const l of this.listeners) l(msg);
      } catch {
        // ignore non-JSON frames
      }
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      if (!this.closedByUser) {
        const delay = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, 15000);
        setTimeout(() => this.connect(), delay);
      }
    });

    ws.addEventListener("error", () => {
      ws.close();
    });
  }

  send(msg: ClientMsg) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      // best-effort: drop. UI should disable controls until connected.
      console.warn("[ws] not open, dropping", msg.type);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}

let singleton: WSClient | null = null;

export function getWS(): WSClient {
  if (!singleton) {
    // Packaged EXE serves both static + WS from same origin; derive from
    // window.location so LAN access (192.168.x) and any non-default port
    // also work without rebuild. Dev still honors NEXT_PUBLIC_WS_URL.
    let url = process.env.NEXT_PUBLIC_WS_URL;
    if (!url) {
      if (typeof window !== "undefined") {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        url = `${proto}//${window.location.host}/ws`;
      } else {
        url = "ws://127.0.0.1:3001/ws";
      }
    }
    singleton = new WSClient(url);
  }
  return singleton;
}
