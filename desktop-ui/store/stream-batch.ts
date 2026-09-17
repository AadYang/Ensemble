"use client";

import {
  createStreamDisplayBatcher,
  streamDisplayDeltaFromSdkMessage,
  type SdkMessage,
} from "@agentorch/shared";
import { useStore } from "./agents";

const batcher = createStreamDisplayBatcher({
  emit(sessionId, chunks) {
    useStore.getState().ingestStreamDisplayChunks(sessionId, chunks);
  },
});

/** Live WS path: fold 1-char stream_events before Zustand/ChatPane see them.
 *  History hydrate still goes through ingestSdkMessage directly. */
export function ingestLiveSdkMessage(sessionId: string, seq: number, msg: SdkMessage): void {
  if (msg.type === "stream_event") {
    const delta = streamDisplayDeltaFromSdkMessage(msg);
    if (delta) batcher.push(sessionId, { seq, kind: delta.kind, text: delta.text });
    return;
  }
  batcher.flushSession(sessionId);
  useStore.getState().ingestSdkMessage(sessionId, seq, msg);
}
