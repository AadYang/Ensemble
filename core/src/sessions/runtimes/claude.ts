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
import { spawn, type ChildProcess } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { LivenessProbeKind, SdkMessage } from "@agentorch/shared";
import type { AgentRuntime, RuntimeEvent, RuntimeLivenessReporter, RuntimeOptions } from "./types.js";

/** Phase 4: spawn the Claude Code child ourselves, so the run has a PROCESS we
 *  can observe.
 *
 *  This is not a behavioural change to how the CLI is launched. The SDK's own
 *  local spawn is literally
 *  `spawn(command, args, { cwd, stdio: ["pipe","pipe","pipe"], signal, env, windowsHide: true })`
 *  — the same call, with the same stdio triple and the same forwarded signal
 *  (the SDK hands us a signal that fires only after its stdin-EOF graceful-close
 *  window, so the CLI still shuts down cleanly). What changes is that WE keep
 *  the handle. That handle is the difference between "nothing has been printed
 *  for twenty minutes" — which used to be a kill, and is not evidence of
 *  anything — and "the process is still running", which is a fact a health check
 *  can report.
 *
 *  Returns `null` when there is no reporter, so the SDK's default spawn is used
 *  verbatim and a turn with no liveness wiring is byte-for-byte what it was.
 *
 *  Exported so the wiring can be PROVED rather than inspected: the phase-4 gate
 *  has to show that this route really hands over a child handle and that the
 *  probe really answers from it, and a `claude.ts` private helper could only
 *  ever be asserted by reading the file. */
export function makeClaudeSpawner(liveness: RuntimeLivenessReporter | null): {
  /** Typed as the SDK's own return type: a real `ChildProcess` satisfies
   *  `SpawnedProcess` (the SDK says as much), but the two differ on whether
   *  `stdin` can be null, so the widening is stated here rather than at the
   *  call site. */
  spawner: (options: SpawnOptions) => SpawnedProcess;
  probe: () => LivenessProbeKind;
} | null {
  if (!liveness) return null;
  let started = false;
  let exited = false;

  const spawner = (options: SpawnOptions): SpawnedProcess => {
    const proc: ChildProcess = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
      env: options.env as NodeJS.ProcessEnv,
      windowsHide: true,
    });
    started = true;
    liveness.childProcessStarted({ pid: proc.pid ?? null });
    proc.once("exit", (code, signal) => {
      exited = true;
      liveness.childProcessExited({ pid: proc.pid ?? null, exitCode: code, signal: signal ?? null });
    });
    // A spawn failure means there is no live child, which is the same
    // observation as an exit as far as liveness goes — recorded as one, with no
    // exit code, because the SDK's own error path is what explains the turn.
    proc.once("error", () => {
      if (exited) return;
      exited = true;
      liveness.childProcessExited({ pid: proc.pid ?? null, exitCode: null, signal: null });
    });
    return proc as unknown as SpawnedProcess;
  };

  // `unknown` before a child exists at all: "we have not spawned one yet" is not
  // "it is alive" and it is certainly not "it is dead". After that, the local
  // observation is the truth — `exitCode` stays null while the child lives, and
  // the flags above are what a spawn failure sets.
  const probe = (): LivenessProbeKind => (!started ? "unknown" : exited ? "dead" : "alive");
  return { spawner, probe };
}

/** The levels THIS runtime can express, and the thinking budget each maps to.
 *
 *  This is a statement about the Claude Code adapter, not about any model: the
 *  SDK's only reasoning knob is `maxThinkingTokens`, so the adapter can carry
 *  exactly these six levels. A level from the plan that is absent here is
 *  unrepresentable on this runtime — reported, never dropped. Keyed by plain
 *  string because the protocol's level type is open. */
const THINKING_TOKEN_BUDGETS: Readonly<Record<string, number>> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 64000,
};

const CLAUDE_REASONING_SOURCE =
  "Claude Code runtime: the SDK exposes reasoning only as a thinking-token budget, so this adapter can carry exactly these levels";

type ThinkingBudget =
  | { ok: true; maxThinkingTokens: number | undefined }
  | { ok: false; requested: string };

/** `undefined` means `inherit`: nothing was asked for, so no parameter is sent
 *  and the upstream default applies. Every other value must be one this adapter
 *  can actually express. */
function thinkingBudgetFor(level: string | undefined): ThinkingBudget {
  if (level === undefined) return { ok: true, maxThinkingTokens: undefined };
  const maxThinkingTokens = THINKING_TOKEN_BUDGETS[level];
  if (maxThinkingTokens === undefined) return { ok: false, requested: level };
  return { ok: true, maxThinkingTokens };
}

export const CLAUDE_SUPPORTED_REASONING_LEVELS: readonly string[] =
  Object.keys(THINKING_TOKEN_BUDGETS);

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

/** Declare a third-party model's real context window to Claude Code.
 *
 *  Claude Code has no metadata for anthropic-compat models (deepseek / glm /
 *  minimax), so it falls back to "default for an unrecognized model" ≈200k and
 *  auto-compacts at ~85% of that. Measured on a `deepseek-flash` agent whose
 *  provider window is 1M: six auto-compactions at 167k–172k `pre_tokens`,
 *  ~1.1M tokens of context dropped for nothing. So we declare the CAPACITY —
 *  the model really does hold 1M input tokens — and nothing else.
 *
 *  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` are
 *  NOT the same knob and are deliberately not set together any more:
 *
 *    • MAX_CONTEXT_TOKENS is a CAPACITY declaration. It answers "how big is
 *      this model", which is exactly the documented catalog value.
 *    • AUTO_COMPACT_WINDOW is a POLICY trigger. It answers "at how many tokens
 *      should the runtime throw context away" — a decision that must leave room
 *      for the output tokens and protocol overhead of the request that follows.
 *      Pinning it to the model maximum means the runtime fills the window to
 *      100% and then has nowhere to put the response.
 *
 *  We only set the policy value when the plan actually resolved a compaction
 *  threshold (a version-matched observation — context-window.ts). Unknown stays
 *  unknown: the CLI keeps its own policy, which is tuned by people who know the
 *  headroom requirement. A bare number from a docs table is not evidence about
 *  a runtime's compaction behaviour, and the plan leaves it null in that case.
 *
 *  Both values are taken from `runPlan.context` — the same fields the history
 *  budget was derived from, resolved once by the planner through the `confirmed`
 *  catalog entries. An explicit value from the provider env still wins, because
 *  it is the operator's own statement about their deployment. */
function mergeContextWindowEnv(
  opts: RuntimeOptions,
  env: Record<string, string>,
): Record<string, string> {
  // Read from the PLAN, not from a second resolution. The window and the
  // compaction trigger are the same two numbers the turn's history budget was
  // derived from, so the CLI's auto-compact cannot fire at a point the plan
  // believes is still inside the budget (or vice versa). Re-deriving them here
  // was a second answer to a question the plan had already answered.
  const window =
    opts.runPlan.context.effectiveWindow ?? opts.runPlan.context.advertisedContextWindow;
  const compactAt = opts.runPlan.context.compactionThreshold;
  if (!window && !compactAt) return env;
  const merged = { ...env };
  if (window && !merged.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    merged.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window);
  }
  if (compactAt && !merged.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
    merged.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(compactAt);
  }
  return merged;
}

export class ClaudeAgentRuntime implements AgentRuntime {
  async *query(opts: RuntimeOptions): AsyncIterable<RuntimeEvent> {
    // The level comes from the plan — the same field `/status` reports and the
    // same snapshot the SDK parameters are derived from. It is NOT re-read from
    // agent metadata here; a runtime that resolves its own value is how one turn
    // ends up running two different settings.
    const reasoning = opts.runPlan.execution.reasoningEffort;
    const budget = thinkingBudgetFor(reasoning);
    if (!budget.ok) {
      // Refuse BEFORE the request. Sending the turn without the setting would
      // silently downgrade what the user asked for — the exact failure this
      // contract exists to prevent — and the SDK has no way to express it.
      yield {
        type: "error",
        code: "REASONING_EFFORT_UNSUPPORTED",
        message: `reasoning level "${budget.requested}" cannot be expressed on the Claude Code runtime (supported: ${CLAUDE_SUPPORTED_REASONING_LEVELS.join(", ")})`,
        recoverable: false,
        reasoning: {
          requested: budget.requested,
          runtime: opts.runPlan.identity.runtime,
          model: opts.runPlan.identity.modelId,
          supportedLevels: [...CLAUDE_SUPPORTED_REASONING_LEVELS],
          source: CLAUDE_REASONING_SOURCE,
        },
      };
      return;
    }
    const maxThinkingTokens = budget.maxThinkingTokens;
    // The working directory, from the plan — the same field `/status` shows and
    // the tools resolve against. It is not `process.cwd()` and not a pinned
    // home directory: the CLI scopes its session files AND its project
    // instructions (CLAUDE.md / memory files) by this path, so it has to be the
    // agent's actual project. A plan whose root is unusable never reaches a
    // runtime (the turn is refused before dispatch), so a null here is a caller
    // that bypassed the type — refused rather than guessed.
    const cwd = opts.runPlan.execution.projectRoot.value;
    if (cwd === null) {
      yield {
        type: "error",
        code: "PROJECT_ROOT_NOT_FOUND",
        message: `no working directory for this turn: ${opts.runPlan.execution.projectRoot.invalid?.reason ?? "the plan carries no project root"}`,
        recoverable: false,
      };
      return;
    }
    const env = mergeContextWindowEnv(opts, mergeClaudeLocalAuthEnv(opts));
    // The child-process observer, when there is a run to report to. `probe` is
    // handed to the controller by the caller, not used here.
    const observer = makeClaudeSpawner(opts.liveness ?? null);
    if (observer) opts.liveness?.registerProbe?.(observer.probe);
    const stream = query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        ...(maxThinkingTokens !== undefined ? { maxThinkingTokens } : {}),
        permissionMode: opts.permissionMode,
        ...(opts.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        tools: opts.tools,
        allowedTools: opts.allowedTools,
        canUseTool: opts.canUseTool,
        includePartialMessages: opts.includePartialMessages ?? true,
        abortController: opts.abortController,
        ...(opts.claudeCliPath ? { pathToClaudeCodeExecutable: opts.claudeCliPath } : {}),
        ...(observer ? { spawnClaudeCodeProcess: observer.spawner } : {}),
        ...(opts.onStderr ? { stderr: opts.onStderr } : {}),
        cwd,
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

    // Phase 4: the stream's own ending is a fact worth recording, and WHETHER it
    // ended abnormally is decided by whether the terminal `result` ever arrived
    // — not by the loop's exit code, which is normal in both cases.
    let sawResult = false;
    let closedByError: string | null = null;
    try {
      for await (const msg of stream) {
        if ((msg as { type?: string }).type === "result") {
          sawResult = true;
          opts.liveness?.resultSeen();
        }
        // SDK's SDKMessage is structurally a superset of shared's SdkMessage
        // (which uses `[k: string]: unknown`). Cast to widen for the protocol type.
        yield { type: "sdk_message", payload: msg as unknown as SdkMessage };
      }
    } catch (err) {
      closedByError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // `abnormal` is narrow on purpose: a close the runtime already reported as
      // an error is explained, and an abort is something WE did. What remains is
      // a stream that vanished without a result and without an explanation —
      // the only close that is evidence.
      opts.liveness?.streamClosed(
        !sawResult && closedByError === null && !opts.abortController.signal.aborted,
      );
    }
  }
}
