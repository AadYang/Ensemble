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
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { LivenessProbeKind, SdkMessage } from "@agentorch/shared";
import type { AgentRuntime, RuntimeEvent, RuntimeLivenessReporter, RuntimeOptions } from "./types.js";
import { takeUntilAbort } from "../abort-iterable.js";
import { promptTextFromMessage } from "../../context-usage.js";

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
export function makeClaudeSpawner(
  liveness: RuntimeLivenessReporter | null,
  abortSignal?: AbortSignal,
): {
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
    // The SDK's spawn `signal` fires only after a stdin-EOF graceful window.
    // User cancel must not wait for that: kill the tree the moment our
    // AbortController aborts, the same way Codex does.
    const hardKill = () => killClaudeChildTree(proc);
    if (abortSignal?.aborted) hardKill();
    else abortSignal?.addEventListener("abort", hardKill, { once: true });
    proc.once("exit", () => abortSignal?.removeEventListener("abort", hardKill));
    return proc as unknown as SpawnedProcess;
  };

  // `unknown` before a child exists at all: "we have not spawned one yet" is not
  // "it is alive" and it is certainly not "it is dead". After that, the local
  // observation is the truth — `exitCode` stays null while the child lives, and
  // the flags above are what a spawn failure sets.
  const probe = (): LivenessProbeKind => (!started ? "unknown" : exited ? "dead" : "alive");
  return { spawner, probe };
}

function killClaudeChildTree(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

/** The levels THIS runtime can express.
 *
 *  Claude Agent SDK's live knob is `effort` (`output_config.effort` on the
 *  Messages API). `maxThinkingTokens` is deprecated: on Opus 4.6+ it is
 *  treated as on/off, so mapping named levels onto token budgets made every
 *  non-zero choice look the same. A level absent from this list is
 *  unrepresentable here — reported, never dropped. */
const CLAUDE_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

const CLAUDE_REASONING_SOURCE =
  "Claude Code runtime: the SDK exposes reasoning as Options.effort (https://platform.claude.com/docs/en/build-with-claude/effort)";

type EffortChoice =
  | { ok: true; effort: EffortLevel | undefined }
  | { ok: false; requested: string };

/** `undefined` means `inherit`: nothing was asked for, so no parameter is sent
 *  and the upstream default applies (`high` on current Claude models). */
function effortFor(level: string | undefined): EffortChoice {
  if (level === undefined) return { ok: true, effort: undefined };
  if ((CLAUDE_EFFORT_LEVELS as readonly string[]).includes(level)) {
    return { ok: true, effort: level as EffortLevel };
  }
  return { ok: false, requested: level };
}

export const CLAUDE_SUPPORTED_REASONING_LEVELS: readonly string[] = CLAUDE_EFFORT_LEVELS;

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
  // Read from the PLAN, not from a second resolution. Capacity declaration,
  // observed effective window and compaction policy are separate answers; this
  // adapter consumes only the two policy fields it is allowed to configure.
  // Runtime configuration is allowed to consume only the policy-gated
  // declaration value. `advertisedContextWindow` is display metadata and an
  // observed effective clamp is not a request to redeclare a different value.
  const window = opts.runPlan.context.requestedRuntimeWindow;
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
    const chosen = effortFor(reasoning);
    if (!chosen.ok) {
      // Refuse BEFORE the request. Sending the turn without the setting would
      // silently downgrade what the user asked for — the exact failure this
      // contract exists to prevent — and the SDK has no way to express it.
      yield {
        type: "error",
        code: "REASONING_EFFORT_UNSUPPORTED",
        message: `reasoning level "${chosen.requested}" cannot be expressed on the Claude Code runtime (supported: ${CLAUDE_SUPPORTED_REASONING_LEVELS.join(", ")})`,
        recoverable: false,
        reasoning: {
          requested: chosen.requested,
          runtime: opts.runPlan.identity.runtime,
          model: opts.runPlan.identity.modelId,
          supportedLevels: [...CLAUDE_SUPPORTED_REASONING_LEVELS],
          source: CLAUDE_REASONING_SOURCE,
        },
      };
      return;
    }
    const effort = chosen.effort;
    // The working directory, from the plan — the same field `/status` shows and
    // the tools resolve against. It is not `process.cwd()` and not a pinned
    // home directory: the CLI scopes its session files by this path, while
    // SessionManager injects project instructions because this adapter's
    // custom systemPrompt disables CLAUDE.md walk-up. It still has to be the
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
    const observer = makeClaudeSpawner(opts.liveness ?? null, opts.abortController.signal);
    if (observer) opts.liveness?.registerProbe?.(observer.probe);
    const stream = query({
      prompt: claudePromptForTurn(opts),
      options: {
        model: opts.model,
        ...(effort !== undefined ? { effort } : {}),
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
        ...(opts.captureCompactSummary
          ? {
              hooks: {
                PostCompact: [
                  {
                    hooks: [
                      async (input: { hook_event_name?: string; compact_summary?: string; trigger?: string }) => {
                        if (
                          input.hook_event_name === "PostCompact" &&
                          typeof input.compact_summary === "string" &&
                          input.compact_summary.trim()
                        ) {
                          opts.captureCompactSummary!(input.compact_summary, {
                            trigger: input.trigger === "auto" ? "auto" : "manual",
                          });
                        }
                        return { continue: true };
                      },
                    ],
                  },
                ],
              },
            }
          : {}),
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
    // `for await` invokes the generator's `return()` when its CONSUMER throws
    // while processing a yielded message. That runs this finally block too,
    // but says nothing about the producer stream. Only reaching the statement
    // after the loop proves that the SDK iterator itself drained naturally.
    let drainedNaturally = false;
    try {
      for await (const msg of takeUntilAbort(stream, opts.abortController.signal)) {
        if ((msg as { type?: string }).type === "result") {
          sawResult = true;
          opts.liveness?.resultSeen();
        }
        // SDK's SDKMessage is structurally a superset of shared's SdkMessage
        // (which uses `[k: string]: unknown`). Cast to widen for the protocol type.
        yield { type: "sdk_message", payload: msg as unknown as SdkMessage };
      }
      drainedNaturally = true;
    } catch (err) {
      closedByError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // `abnormal` is narrow on purpose: a close the runtime already reported as
      // an error is explained, and an abort is something WE did. What remains is
      // a stream that vanished without a result and without an explanation —
      // the only close that is evidence.
      opts.liveness?.streamClosed(
        drainedNaturally && !sawResult && closedByError === null && !opts.abortController.signal.aborted,
      );
    }
  }
}

/** When the CLI is not resuming a session file, `opts.history` is the only
 *  prior context the model will see. The SDK `query()` prompt is a string, so
 *  the local-rebuild transcript has to ride in that string — leaving it in
 *  `history` unused is how DeepSeek-via-Claude-CLI forgot every previous turn. */
export function claudePromptForTurn(opts: Pick<RuntimeOptions, "prompt" | "history" | "resume">): string {
  if (opts.resume || opts.history.length === 0) return opts.prompt;
  const turns: string[] = [];
  for (const msg of opts.history) {
    const text = promptTextFromMessage(msg).trim();
    if (!text) continue;
    if (msg.type === "user") turns.push(`User:\n${text}`);
    else if (msg.type === "assistant") turns.push(`Assistant:\n${text}`);
  }
  if (turns.length === 0) return opts.prompt;
  return [
    "This is an Ensemble pane transcript reconstructed from local history because no native Claude CLI session is being resumed.",
    "The transcript is background only. The final <current-user-request> block is the active task for this turn.",
    "",
    turns.join("\n\n---\n\n"),
    "",
    "<current-user-request>",
    opts.prompt,
    "</current-user-request>",
  ].join("\n");
}
