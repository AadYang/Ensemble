// W16 Slice 1.5: chooseRuntime factory.
//
// Routes provider.kind → AgentRuntime instance. Slice 1 only ClaudeAgentRuntime
// is wired; openai-compat will route to OpenAIAgentRuntime in Slice 2 once the
// @openai/agents SDK lands.

import type { AgentRuntime } from "./types.js";
import { ClaudeAgentRuntime } from "./claude.js";
import { OpenAIAgentRuntime } from "./openai.js";
import { CodexCliRuntime } from "./codex.js";

const claudeRuntime = new ClaudeAgentRuntime();
const openaiRuntime = new OpenAIAgentRuntime();
const codexRuntime = new CodexCliRuntime();

export function chooseRuntime(kind: string): AgentRuntime {
  switch (kind) {
    case "anthropic-local":
    case "anthropic":
      return claudeRuntime;
    case "openai-local":
    case "openai-compat":
      return openaiRuntime;
    case "openai-codex":
      return codexRuntime;
    default:
      throw new Error(`unknown provider kind: ${kind}`);
  }
}

export type { AgentRuntime, RuntimeEvent, RuntimeOptions } from "./types.js";
