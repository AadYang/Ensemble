import type { StreamDisplayKind } from "./thinking-display.js";

/** One paint of coalesced stream text. 32ms is ~2 frames — enough to fold
 *  1-char DeepSeek/Claude deltas without looking buffered. */
export const STREAM_DISPLAY_FLUSH_MS = 32;

export interface StreamDisplayChunk {
  seq: number;
  kind: StreamDisplayKind;
  text: string;
}

export interface StreamDisplayBatcher {
  push(sessionId: string, chunk: StreamDisplayChunk): void;
  flushSession(sessionId: string): void;
  dropSession(sessionId: string): void;
  flushAll(): void;
}

interface SessionBuffer {
  chunks: StreamDisplayChunk[];
  timer: number | null;
}

function concatChunk(pending: StreamDisplayChunk[], next: StreamDisplayChunk): void {
  const last = pending[pending.length - 1];
  if (last && last.kind === next.kind && last.seq === next.seq) {
    last.text += next.text;
    return;
  }
  pending.push({ seq: next.seq, kind: next.kind, text: next.text });
}

/** Fold per-token WS stream_events into one emit per flush window.
 *  Without this, ChatPane commits (and re-parses markdown) once per character;
 *  a 989-char answer at ~250ms/commit paints for 3–5 minutes after the model
 *  already finished. */
export function createStreamDisplayBatcher(opts: {
  emit: (sessionId: string, chunks: readonly StreamDisplayChunk[]) => void;
  flushMs?: number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (id: number) => void;
}): StreamDisplayBatcher {
  const flushMs = opts.flushMs ?? STREAM_DISPLAY_FLUSH_MS;
  const schedule = opts.schedule ?? ((fn, ms) => Number(globalThis.setTimeout(fn, ms)));
  const cancel = opts.cancel ?? ((id) => globalThis.clearTimeout(id));
  const buffers = new Map<string, SessionBuffer>();

  function take(sessionId: string): StreamDisplayChunk[] | null {
    const buf = buffers.get(sessionId);
    if (!buf) return null;
    if (buf.timer != null) {
      cancel(buf.timer);
      buf.timer = null;
    }
    if (buf.chunks.length === 0) return null;
    const chunks = buf.chunks;
    buf.chunks = [];
    return chunks;
  }

  function flushSession(sessionId: string): void {
    const chunks = take(sessionId);
    if (chunks) opts.emit(sessionId, chunks);
  }

  function push(sessionId: string, chunk: StreamDisplayChunk): void {
    if (!chunk.text && chunk.kind !== "thinking") return;
    let buf = buffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], timer: null };
      buffers.set(sessionId, buf);
    }
    concatChunk(buf.chunks, chunk);
    if (buf.timer == null) {
      buf.timer = schedule(() => {
        buf!.timer = null;
        flushSession(sessionId);
      }, flushMs);
    }
  }

  function dropSession(sessionId: string): void {
    const buf = buffers.get(sessionId);
    if (!buf) return;
    if (buf.timer != null) {
      cancel(buf.timer);
      buf.timer = null;
    }
    buffers.delete(sessionId);
  }

  function flushAll(): void {
    for (const sessionId of [...buffers.keys()]) flushSession(sessionId);
  }

  return { push, flushSession, dropSession, flushAll };
}
