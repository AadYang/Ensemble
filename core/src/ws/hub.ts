import type { WebSocket } from "@fastify/websocket";
import type { ServerMsg } from "@agentorch/shared";

interface ClientEntry {
  socket: WebSocket;
  /** Session ids the client wants per-session events for. */
  sessions: Set<string>;
}

export class WSHub {
  private clients = new Map<WebSocket, ClientEntry>();

  add(ws: WebSocket): void {
    this.clients.set(ws, { socket: ws, sessions: new Set() });
  }

  remove(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  subscribe(ws: WebSocket, sessionId: string): void {
    this.clients.get(ws)?.sessions.add(sessionId);
  }

  unsubscribe(ws: WebSocket, sessionId: string): void {
    this.clients.get(ws)?.sessions.delete(sessionId);
  }

  /** Send to one specific socket (used for per-socket replay on subscribe). */
  sendTo(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Global broadcast — used for events that aren't tied to a single agent
   * (hello, agent_created, top-level errors). */
  broadcast(msg: ServerMsg): void {
    const payload = JSON.stringify(msg);
    for (const { socket } of this.clients.values()) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  /** Send to clients subscribed to this sessionId. agent_created/hello-style events
   * go through broadcast(); per-session traffic (message/status/permission_request/error)
   * comes through here. */
  sendToSession(sessionId: string, msg: ServerMsg): void {
    const payload = JSON.stringify(msg);
    for (const entry of this.clients.values()) {
      if (entry.sessions.has(sessionId) && entry.socket.readyState === entry.socket.OPEN) {
        entry.socket.send(payload);
      }
    }
  }

  size(): number {
    return this.clients.size;
  }
}
