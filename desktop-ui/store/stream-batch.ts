"use client";

import {
  admitLivePaneMessage,
  createStreamDisplayBatcher,
  listLeaves,
  STREAM_DISPLAY_FLUSH_MS,
  STREAM_DISPLAY_HIDDEN_FLUSH_MS,
  streamDisplayDeltaFromSdkMessage,
  type SdkMessage,
} from "@agentorch/shared";
import { useStore } from "./agents";

function isAgentOnScreen(sessionId: string): boolean {
  for (const w of useStore.getState().windows) {
    for (const leaf of listLeaves(w.root)) {
      if (leaf.agentId === sessionId) return true;
    }
  }
  return false;
}

const batcher = createStreamDisplayBatcher({
  flushMs: STREAM_DISPLAY_FLUSH_MS,
  flushMsFor: (sessionId) =>
    isAgentOnScreen(sessionId) ? STREAM_DISPLAY_FLUSH_MS : STREAM_DISPLAY_HIDDEN_FLUSH_MS,
  emit(sessionId, chunks) {
    useStore.getState().ingestStreamDisplayChunks(sessionId, chunks);
  },
});

/** Live WS path: fold 1-char stream_events before Zustand/ChatPane see them.
 *  History hydrate still goes through ingestSdkMessage directly. */
export function ingestLiveSdkMessage(sessionId: string, seq: number, msg: SdkMessage): void {
  const status = useStore.getState().agents[sessionId]?.summary.status;
  if (!admitLivePaneMessage(status, msg)) {
    batcher.dropSession(sessionId);
    return;
  }
  if (msg.type === "stream_event") {
    const delta = streamDisplayDeltaFromSdkMessage(msg);
    if (delta) batcher.push(sessionId, { seq, kind: delta.kind, text: delta.text });
    return;
  }
  batcher.flushSession(sessionId);
  useStore.getState().ingestSdkMessage(sessionId, seq, msg);
}

export function dropLiveStream(sessionId: string): void {
  batcher.dropSession(sessionId);
}

export function flushLiveStream(sessionId: string): void {
  batcher.flushSession(sessionId);
}
