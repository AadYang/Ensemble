import { describe, expect, it } from "vitest";
import type { SdkMessage } from "@agentorch/shared";
import { chatTextForLocalRebuild, claudeLocalRebuildPrompt } from "../local-rebuild-prompt.js";

const user = (content: unknown): SdkMessage =>
  ({ type: "user", message: { role: "user", content } }) as SdkMessage;

const assistant = (content: unknown): SdkMessage =>
  ({ type: "assistant", message: { content } }) as SdkMessage;

describe("chatTextForLocalRebuild", () => {
  it("keeps user strings and assistant text blocks", () => {
    expect(chatTextForLocalRebuild(user("hello"))).toEqual({ role: "user", text: "hello" });
    expect(chatTextForLocalRebuild(user([{ type: "text", text: "from blocks" }]))).toEqual({
      role: "user",
      text: "from blocks",
    });
    expect(chatTextForLocalRebuild(assistant([{ type: "text", text: "ok" }]))).toEqual({
      role: "assistant",
      text: "ok",
    });
  });

  it("drops thinking, tool_use, and tool_result blobs", () => {
    expect(chatTextForLocalRebuild(assistant([{ type: "thinking", thinking: "secret chain" }]))).toBeNull();
    expect(
      chatTextForLocalRebuild(
        assistant([{ type: "tool_use", id: "1", name: "Read", input: { path: "/secret" } }]),
      ),
    ).toBeNull();
    expect(
      chatTextForLocalRebuild(
        user([{ type: "tool_result", tool_use_id: "1", content: "file contents that must stay in the archive" }]),
      ),
    ).toBeNull();
  });
});

describe("claudeLocalRebuildPrompt", () => {
  it("is compact summaries plus recent chat, not a replay of the archive", () => {
    const prompt = claudeLocalRebuildPrompt("do the next step", [
      user("Background context summary from Ensemble compact.\nSummary:\nwe installed the apk"),
      assistant([
        { type: "thinking", thinking: "I should reread every file" },
        { type: "text", text: "apk is installed" },
      ]),
      user([{ type: "tool_result", content: "19MB of logs" }]),
    ]);
    expect(prompt).toContain("we installed the apk");
    expect(prompt).toContain("apk is installed");
    expect(prompt).toContain("do the next step");
    expect(prompt).toContain("conversation_search");
    expect(prompt).not.toContain("I should reread every file");
    expect(prompt).not.toContain("19MB of logs");
  });
});
