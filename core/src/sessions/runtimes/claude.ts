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

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMessage } from "@agentorch/shared";
import type { AgentRuntime, RuntimeEvent, RuntimeOptions } from "./types.js";

export class ClaudeAgentRuntime implements AgentRuntime {
  async *query(opts: RuntimeOptions): AsyncIterable<RuntimeEvent> {
    const stream = query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
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
        ...(Object.keys(opts.env).length > 0 ? { env: opts.env } : {}),
        // The SDK's public option is `systemPrompt`, not `customSystemPrompt` —
        // any unknown key gets silently dropped into ...rest, and the SDK then
        // falls back to the built-in `claude_code` preset which auto-loads
        // ~/.claude/projects/<cwd-sanitized>/memory/MEMORY.md plus referenced
        // files. We saw an Ensemble team member greet the user as "Agent
        // Orchestrator WebUI 项目" because that's what the cwd=homedir auto-
        // memory file said — never our team-context block.
        //
        // Passing a string here switches the SDK out of preset mode entirely:
        // no auto-memory, no CLAUDE.md walk-up, no settings.json. Our prompt
        // is the WHOLE system prompt the model sees.
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
        // Explicitly disable filesystem settings loading. SDK doc: "When
        // omitted or empty, no filesystem settings are loaded (SDK isolation
        // mode)." We want isolation: every Ensemble agent's identity comes
        // from our composed systemPrompt, period. No surprise content from
        // ~/.claude/settings.json or .claude/settings.local.json.
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
