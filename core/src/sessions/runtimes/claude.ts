// W16 Slice 1.6: ClaudeAgentRuntime — thin wrapper over @anthropic-ai/claude-agent-sdk.
//
// Translates RuntimeOptions → SDK Options and re-yields the SDK's message
// stream as `sdk_message` RuntimeEvents. SessionManager owns:
//   • abort lifecycle (we just receive the controller)
//   • mcpServer construction (we never rebuild — closure over fromAgentId
//     would break, see peer-mcp.ts comment)
//   • stale-resume self-heal (we forward stderr; SessionManager does the
//     metadata scrub)
//
// Surface area is small on purpose — anything more complex belongs to
// SessionManager so OpenAIAgentRuntime (Slice 2+) doesn't need to duplicate it.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ReasoningEffort, SdkMessage } from "@agentorch/shared";
import type { AgentRuntime, RuntimeEvent, RuntimeOptions } from "./types.js";

const THINKING_TOKEN_BUDGETS: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 64000,
};

function maxThinkingTokensForEffort(effort?: ReasoningEffort | null): number | undefined {
  if (!effort) return undefined;
  return THINKING_TOKEN_BUDGETS[effort];
}

const CLAUDE_LOCAL_AUTH_ENV_KEYS = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claudeSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(configDir, "settings.json");
}

function readClaudeLocalAuthEnv(): Record<string, string> {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.env)) return {};

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.env)) {
      if (!CLAUDE_LOCAL_AUTH_ENV_KEYS.has(key)) continue;
      if (typeof value !== "string" || value.trim().length === 0) continue;
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function mergeClaudeLocalAuthEnv(opts: RuntimeOptions): Record<string, string> {
  if (opts.provider.kind !== "anthropic-local") return opts.env;

  const settingsEnv = readClaudeLocalAuthEnv();
  if (Object.keys(settingsEnv).length === 0) return opts.env;

  const merged = { ...opts.env };
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (!merged[key]) merged[key] = value;
  }
  return merged;
}

export class ClaudeAgentRuntime implements AgentRuntime {
  async *query(opts: RuntimeOptions): AsyncIterable<RuntimeEvent> {
    const maxThinkingTokens = maxThinkingTokensForEffort(opts.reasoningEffort);
    const env = mergeClaudeLocalAuthEnv(opts);
    const stream = query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
        permissionMode: opts.permissionMode,
        tools: opts.tools,
        allowedTools: opts.allowedTools,
        canUseTool: opts.canUseTool,
        includePartialMessages: opts.includePartialMessages ?? true,
        abortController: opts.abortController,
        ...(opts.claudeCliPath ? { pathToClaudeCodeExecutable: opts.claudeCliPath } : {}),
        ...(opts.onStderr ? { stderr: opts.onStderr } : {}),
        cwd: opts.cwd,
        ...(opts.resume ? { resume: opts.resume } : {}),
        mcpServers: opts.mcpServers,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        // The SDK's public option is `systemPrompt`, not `customSystemPrompt` —
        // any unknown key gets silently dropped into ...rest, and the SDK then
        // falls back to the built-in `claude_code` preset which auto-loads
        // ~/.claude/projects/<cwd-sanitized>/memory/MEMORY.md plus referenced
        // files. We saw an Ensemble team member greet the user as "Agent
        // Orchestrator WebUI 项目" because that's what the cwd=homedir auto-
        // memory file said — never our team-context block.
        //
        // Passing a string here switches the SDK out of preset mode entirely:
        // no auto-memory and no CLAUDE.md walk-up. Our prompt is the WHOLE
        // system prompt the model sees.
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
        // Explicitly disable SDK filesystem settings loading. We restore only
        // a small auth-env allowlist from user settings above, so agent
        // identity, memory, hooks, and MCP stay controlled by Ensemble.
        settingSources: [],
      },
    });

    for await (const msg of stream) {
      // SDK's SDKMessage is structurally a superset of shared's SdkMessage
      // (which uses `[k: string]: unknown`). Cast to widen for the protocol type.
      yield { type: "sdk_message", payload: msg as unknown as SdkMessage };
    }
  }
}
