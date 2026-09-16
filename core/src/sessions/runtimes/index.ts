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

/** The runtime SCOPE a provider kind runs under — what the run plan records as
 *  `identity.runtime`. One table, read by both `chooseRuntime` and the plan, so
 *  a runtime cannot execute under a name other than the one `/status` resolved
 *  against. */
const RUNTIME_SCOPE_BY_KIND: Record<string, "claude" | "openai" | "codex"> = {
  "anthropic-local": "claude",
  anthropic: "claude",
  "openai-local": "openai",
  "openai-compat": "openai",
  "openai-codex": "codex",
};

export function runtimeScopeForKind(kind: string): string {
  const scope = RUNTIME_SCOPE_BY_KIND[kind];
  if (!scope) throw new Error(`unknown provider kind: ${kind}`);
  return scope;
}

export function chooseRuntime(kind: string): AgentRuntime {
  const scope = runtimeScopeForKind(kind);
  if (scope === "claude") return claudeRuntime;
  if (scope === "openai") return openaiRuntime;
  return codexRuntime;
}

export type { AgentRuntime, RuntimeEvent, RuntimeOptions } from "./types.js";
