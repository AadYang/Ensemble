import type { SdkMessage } from "@agentorch/shared";

/** Chat text that may appear in a reconstructed prompt.
 *
 *  The Message table is the archive (UI + conversation_search). Official
 *  agent context is a compact summary plus recent chat — not thinking, not
 *  tool_use/tool_result blobs, not a replay of every file the model already
 *  read. Those stay on disk for retrieval. */
export function chatTextForLocalRebuild(
  msg: SdkMessage,
): { role: "user" | "assistant"; text: string } | null {
  if (msg.type === "user") {
    const content = (msg as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") {
      const text = content.trim();
      return text ? { role: "user", text } : null;
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (b): b is { type: string; text: string } =>
            !!b &&
            typeof b === "object" &&
            ((b as { type?: unknown }).type === "text" || (b as { type?: unknown }).type === "output_text") &&
            typeof (b as { text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("")
        .trim();
      return text ? { role: "user", text } : null;
    }
    return null;
  }
  if (msg.type === "assistant") {
    const blocks =
      (msg as { message?: { content?: Array<{ type?: unknown; text?: unknown }> } }).message?.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    return text ? { role: "assistant", text } : null;
  }
  return null;
}

export function claudeLocalRebuildPrompt(prompt: string, history: readonly SdkMessage[]): string {
  const turns: string[] = [];
  for (const msg of history) {
    const row = chatTextForLocalRebuild(msg);
    if (!row) continue;
    turns.push(`${row.role === "user" ? "User" : "Assistant"}:\n${row.text}`);
  }
  if (turns.length === 0) return prompt;
  return [
    "Working context reconstructed by Ensemble because no native CLI session is being resumed.",
    "This is compact summaries plus recent chat text only.",
    "Thinking, tool calls, and tool results are not replayed; they remain in the archive.",
    "Use conversation_search if you need an older detail.",
    "The final <current-user-request> block is the active task for this turn.",
    "",
    turns.join("\n\n---\n\n"),
    "",
    "<current-user-request>",
    prompt,
    "</current-user-request>",
  ].join("\n");
}
