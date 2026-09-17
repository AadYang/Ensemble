export type StreamDisplayKind = "assistant_text" | "thinking";

export interface StreamDisplayDelta {
  kind: StreamDisplayKind;
  text: string;
}

function streamEvent(msg: unknown): Record<string, unknown> | null {
  if (!msg || typeof msg !== "object") return null;
  if ((msg as { type?: unknown }).type !== "stream_event") return null;
  const event = (msg as { event?: unknown }).event;
  if (!event || typeof event !== "object") return null;
  return event as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function thinkingBody(delta: Record<string, unknown>): string | null {
  return nonEmptyString(delta.thinking) ?? nonEmptyString(delta.text);
}

/** Live stream text the chat pane is allowed to show. Thinking is a
 *  first-class delta — dropping it made reasoning models look idle, then
 *  "slow", while they were already producing tokens. */
export function streamDisplayDeltaFromSdkMessage(msg: unknown): StreamDisplayDelta | null {
  const event = streamEvent(msg);
  if (!event) return null;
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "content_block_start") {
    const block = event.content_block;
    if (!block || typeof block !== "object") return null;
    const content = block as Record<string, unknown>;
    if (content.type === "thinking" || content.type === "reasoning") {
      return { kind: "thinking", text: thinkingBody(content) ?? "" };
    }
    return null;
  }

  if (type !== "content_block_delta" && type !== "content_block.delta") return null;
  const raw = event.delta;
  if (!raw || typeof raw !== "object") return null;
  const delta = raw as Record<string, unknown>;
  const deltaType = typeof delta.type === "string" ? delta.type : "";
  if (deltaType === "text_delta") {
    const text = nonEmptyString(delta.text);
    return text ? { kind: "assistant_text", text } : null;
  }
  if (deltaType === "thinking_delta" || deltaType === "reasoning_delta") {
    const text = thinkingBody(delta);
    return text ? { kind: "thinking", text } : null;
  }
  return null;
}

export function thinkingTextFromContentBlocks(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as { type?: unknown; thinking?: unknown; text?: unknown };
    if (block.type !== "thinking" && block.type !== "reasoning") continue;
    const text = nonEmptyString(block.thinking) ?? nonEmptyString(block.text);
    if (text) parts.push(text);
  }
  return parts.join("");
}

export function thinkingTokensEstimate(msg: unknown): number | null {
  if (!msg || typeof msg !== "object") return null;
  const rec = msg as { type?: unknown; subtype?: unknown; estimated_tokens?: unknown };
  if (rec.type !== "system" || rec.subtype !== "thinking_tokens") return null;
  const n = rec.estimated_tokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}
