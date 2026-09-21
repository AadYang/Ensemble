import type { ServerMsg } from "@agentorch/shared";
import { occupancyDeltaFromStreamEvent } from "../context-usage.js";

/** Same window as the desktop pane batcher: fold 1-char deltas before
 *  JSON.stringify + ws.send, so Fastify/create_agent can run on this thread. */
export const STREAM_EVENT_WS_FLUSH_MS = 32;

function streamDeltaKind(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  if ((msg as { type?: unknown }).type !== "stream_event") return null;
  const event = (msg as { event?: { type?: unknown; delta?: { type?: unknown } } }).event;
  if (event?.type !== "content_block_delta") return null;
  const kind = event.delta?.type;
  return typeof kind === "string" ? kind : null;
}

function appendDeltaText(msg: Record<string, unknown>, extra: string): void {
  const event = msg.event as { delta?: Record<string, unknown> } | undefined;
  const delta = event?.delta;
  if (!delta) return;
  if (typeof delta.thinking === "string") delta.thinking += extra;
  else if (typeof delta.text === "string") delta.text += extra;
  else if (typeof delta.partial_json === "string") delta.partial_json += extra;
}

interface SessionBuf {
  kind: string;
  msg: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface StreamEventWsBatcher {
  push(sessionId: string, msg: unknown): void;
  flush(sessionId: string): void;
  flushAll(): void;
}

export function createStreamEventWsBatcher(opts: {
  send: (sessionId: string, payload: ServerMsg) => void;
  flushMs?: number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
}): StreamEventWsBatcher {
  const flushMs = opts.flushMs ?? STREAM_EVENT_WS_FLUSH_MS;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((id) => clearTimeout(id));
  const buffers = new Map<string, SessionBuf>();

  function flush(sessionId: string): void {
    const buf = buffers.get(sessionId);
    if (!buf) return;
    if (buf.timer != null) cancel(buf.timer);
    buffers.delete(sessionId);
    opts.send(sessionId, { type: "message", sessionId, seq: -1, msg: buf.msg as never });
  }

  function push(sessionId: string, msg: unknown): void {
    const kind = streamDeltaKind(msg);
    const text = occupancyDeltaFromStreamEvent(msg);
    if (!kind || text === null) {
      flush(sessionId);
      opts.send(sessionId, { type: "message", sessionId, seq: -1, msg: msg as never });
      return;
    }
    const existing = buffers.get(sessionId);
    if (existing && existing.kind === kind) {
      appendDeltaText(existing.msg, text);
      return;
    }
    if (existing) flush(sessionId);
    buffers.set(sessionId, {
      kind,
      msg: structuredClone(msg) as Record<string, unknown>,
      timer: schedule(() => {
        const cur = buffers.get(sessionId);
        if (cur) cur.timer = null;
        flush(sessionId);
      }, flushMs),
    });
  }

  function flushAll(): void {
    for (const sessionId of [...buffers.keys()]) flush(sessionId);
  }

  return { push, flush, flushAll };
}
