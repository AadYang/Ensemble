// W16 Slice 2.1: OpenAIAgentRuntime — minimal chat over @openai/agents.
//
// This is the first OpenAI-side runtime to land. It does CHAT ONLY:
//   • no tools (Slice 3 adds NormalizedTool + 6 file/shell/grep/glob tools)
//   • no permission interrupt-resume (Slice 4 adds the state machine)
//   • no MCP / peer_send / ask_user (Slice 5)
//   • no Task / handoff (Slice 5)
// History is reconstructed from opts.history (which SessionManager passes from
// the messages table) since OpenAI Agents SDK has no equivalent to Claude
// CLI's ~/.claude session-file resume.
//
// SdkMessage synthesis: the runtime emits Claude-shaped SdkMessages
// (system/init → stream_event/content_block_delta/text_delta → assistant →
// result/success) so the existing frontend rendering works unmodified per
// the W16-S0 acceptance "ServerMsg union 不变" hard constraint.

import { randomUUID } from "node:crypto";
import {
  Agent,
  Runner,
  user,
  assistant,
  OpenAIProvider,
  type AgentInputItem,
} from "@openai/agents";
import type { ResolvedRunPlan } from "@agentorch/shared";
import type { AgentRuntime, RuntimeErrorCode, RuntimeEvent, RuntimeOptions } from "./types.js";
import {
  classifyTransportError,
  describeTransportError,
  type TransportErrorClass,
} from "../../capability/transport-errors.js";
import {
  NORMALIZED_TOOLS,
  toOpenAITool,
  makePeerSendTool,
  makePeerQueryTool,
  makeConversationSearchTool,
  makeAskUserTool,
  makeTaskTool,
  makeEnsembleHelpTool,
  makeSkillListTool,
  makeSkillInvokeTool,
  makeArtifactReadTool,
  makeArtifactSearchTool,
  makeJobTools,
} from "../tools/index.js";
import type { AnyNormalizedTool } from "../tools/types.js";
import { toOpenAIMcpServers, connectAll, closeAll } from "./mcp-adapter.js";
import { chatTextForLocalRebuild } from "../local-rebuild-prompt.js";
import { countTokens, countTokensMany } from "../../local-tokenizer.js";
import { rejectWhenAborted, takeUntilAbort } from "../abort-iterable.js";

/** The SDK's own `modelSettings` type, taken from the `Agent` constructor rather
 *  than restated: the SDK does not export the effort union from its umbrella
 *  module, and copying the union into this file would create exactly the second,
 *  narrower level list this batch removed. */
type SdkModelSettings = ConstructorParameters<typeof Agent>[0]["modelSettings"];

export class OpenAIAgentRuntime implements AgentRuntime {
  async *query(opts: RuntimeOptions): AsyncIterable<RuntimeEvent> {
    const label = `${opts.provider.kind || "openai"} provider "${opts.provider.name}"`;
    if (!opts.provider.baseUrl) {
      yield { type: "error", message: `${label} missing baseUrl` };
      return;
    }
    if (!opts.provider.apiKey) {
      yield { type: "error", message: `${label} missing apiKey` };
      return;
    }
    // The transport is read from the turn's plan — never re-derived here from
    // the provider kind or the host name. Two authorities is how `/status` ends
    // up describing a route the SDK is not calling.
    const planned = planTransportAttempts(opts.runPlan, label);
    if (!planned.ok) {
      yield { type: "error", message: planned.message };
      return;
    }
    const { attempts } = planned;
    // The type says a plan is required, but a JS caller (or an older client)
    // can still arrive without one, which is why the refusal above stays.
    const plan = opts.runPlan!;
    // ONE session id for the whole turn, minted here and handed to every
    // attempt. `system/init`, the assistant/result messages and the stream all
    // have to name the same session: a fallback re-runs the turn, and an id per
    // attempt would split one turn into two sessions the UI and the persistence
    // layer could no longer relate. (`newSessionId` is the injection seam; a
    // test needs no network to pin this.)
    const sessionId = (opts.newSessionId ?? randomUUID)();

    // System/init is emitted ONCE, before any attempt: a fallback re-runs the
    // turn, and a second init would tell the UI a second turn had started.
    yield {
      type: "sdk_message",
      payload: {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: opts.model,
      },
    };

    // Phase 4: this route speaks HTTP through the SDK and hands us no process
    // or socket, so there is nothing to probe — a health check here answers
    // `unknown`, which is a real answer that never ends a run. What IS
    // observable is whether the stream concluded, so that is all this reports.
    //
    // Note what is deliberately NOT done here: no `registerProbe` is called.
    // The alternative — registering a probe that always answers `unknown` —
    // would make the run report `probeRegistered: true` and turn "this route
    // has no handle to hold" into "a health check ran and could not tell",
    // which is a different fact and a worse one to debug. Absent registration
    // is visible in the snapshot as `probeRegistered: false`.
    let settled = false;
    for (let i = 0; i < attempts.length; i++) {
      const transport = attempts[i]!;
      const outcome = yield* runTurnOnce(opts, transport === "responses", sessionId);
      if (!outcome.error) {
        settled = true;
        opts.liveness?.streamClosed(false);
        return;
      }
      if (opts.abortController.signal.aborted) {
        opts.liveness?.streamClosed(false);
        return;
      }

      const classified = classifyTransportError(outcome.error);
      const canFallback =
        i + 1 < attempts.length &&
        !outcome.emittedOutput &&
        !outcome.sawResponseDone &&
        classified.classification === "unsupported";
      if (!canFallback) {
        // The runtime explains this ending itself, so the stream did not
        // "close abnormally" — it closed with a structured reason, which is a
        // different fact and must not be turned into a second verdict.
        settled = true;
        opts.liveness?.streamClosed(false);
        yield {
          type: "error",
          message: classified.message,
          // A stable code AND the raw fields: the code is what a persisted turn
          // reason or a UI badge can key on, the status/code/type are what an
          // operator reads. Neither alone survives.
          code: errorCodeFor(classified.classification),
          recoverable: false,
          classification: classified.classification,
          httpStatus: classified.httpStatus,
          upstreamCode: classified.upstreamCode,
          upstreamType: classified.upstreamType,
          transport,
        };
        return;
      }
      const nextTransport = attempts[i + 1]!;
      const at = new Date().toISOString();
      console.error(
        `[openai-runtime] transport fallback ${transport} → ${nextTransport} for ${label}: ` +
          `${describeTransportError(classified)}`,
      );
      opts.onTransportFallback?.({
        from: transport,
        to: nextTransport,
        policyReason: plan.transport.fallbackReason,
        httpStatus: classified.httpStatus,
        upstreamCode: classified.upstreamCode,
        upstreamType: classified.upstreamType,
        classification: classified.classification,
        at,
      });
    }
    // Every attempt returned an error and none was fatal-reported: if we get
    // here the generator is ending without a result AND without an explanation
    // the runtime gave itself, which is the one close that is evidence.
    if (!settled && !opts.abortController.signal.aborted) opts.liveness?.streamClosed(true);
  }
}

/** Which transports this turn will attempt, read from the plan — and, when it
 *  cannot be attempted at all, why.
 *
 *  Pure on purpose: "does an explicit choice actually run?" is the question the
 *  plan/runtime seam got wrong, and answering it must not require a provider, a
 *  socket or a fake upstream. `query` yields the message verbatim when this
 *  refuses. */
export function planTransportAttempts(
  plan: ResolvedRunPlan | undefined,
  label: string,
):
  | { ok: true; attempts: Array<"responses" | "chat-completions"> }
  | { ok: false; message: string } {
  if (!plan) {
    return {
      ok: false,
      message:
        `${label} was invoked without a resolved run plan; the transport has one source ` +
        "(ResolvedRunPlan.transport.resolved) and this runtime refuses to guess it",
    };
  }
  const startTransport = plan.transport.resolved;
  if (startTransport !== "responses" && startTransport !== "chat-completions") {
    return {
      ok: false,
      message:
        `${label} cannot be driven over transport "${startTransport}"` +
        (startTransport === "unknown"
          ? ": no transport was established for this endpoint. Probe it, or set an explicit " +
            "transport in the provider settings."
          : ""),
    };
  }
  const attempts: Array<"responses" | "chat-completions"> = [startTransport];
  const target = plan.transport.fallbackTarget;
  if (plan.transport.fallbackAllowed && (target === "responses" || target === "chat-completions")) {
    attempts.push(target);
  }
  return { ok: true, attempts };
}

/** The stable code for a failed provider request. */
function errorCodeFor(classification: TransportErrorClass): RuntimeErrorCode {
  switch (classification) {
    case "unsupported":
      return "TRANSPORT_UNSUPPORTED";
    case "auth":
      return "PROVIDER_AUTH_FAILED";
    case "rate-limit":
      return "PROVIDER_RATE_LIMITED";
    case "network":
      return "PROVIDER_NETWORK_FAILED";
    case "server":
      return "PROVIDER_SERVER_ERROR";
    case "request":
      return "PROVIDER_REQUEST_REJECTED";
    default:
      return "PROVIDER_REQUEST_FAILED";
  }
}

/** One attempt over ONE transport, until it completes or throws.
 *
 *  `emittedOutput` / `sawResponseDone` are what make a retry safe: once the
 *  model has produced text or a completed response, re-running the turn on
 *  another transport would duplicate output the user already saw, so the
 *  failure is surfaced instead. */
async function* runTurnOnce(
  opts: RuntimeOptions,
  useResponses: boolean,
  sessionId: string,
): AsyncGenerator<RuntimeEvent, { error?: unknown; emittedOutput: boolean; sawResponseDone: boolean }> {
  // The tools' working directory is the TURN's project root, from the plan.
  // These tools run in-process, so without this they would resolve Bash/Glob/
  // Grep against the sidecar's own directory — a tree the model never chose and
  // cannot see. Checked before anything is built: a turn with no directory has
  // nothing to run in, and refusing here keeps the refusal ahead of the MCP
  // connections and the provider client below.
  const projectRoot = opts.runPlan.execution.projectRoot.value;
  if (projectRoot === null) {
    yield {
      type: "error",
      code: "PROJECT_ROOT_NOT_FOUND",
      message: `no working directory for this turn: ${opts.runPlan.execution.projectRoot.invalid?.reason ?? "the plan carries no project root"}`,
      recoverable: false,
    };
    return { emittedOutput: false, sawResponseDone: false };
  }
  // Non-null asserted: `query` refuses to dispatch without both.
  const baseUrl = opts.provider.baseUrl!;
  const apiKey = opts.provider.apiKey!;
  const provider = new OpenAIProvider({
      apiKey,
      baseURL: baseUrl,
      useResponses,
    });
    const runner = new Runner({ modelProvider: provider });
    // Slice 3.4 / 4.3 / 5.1: register built-in NormalizedTools + session-aware
    // closures. needsApproval derived from permissionMode (see tools/index.ts
    // shouldRequireApproval table).
    // opts.tools gates BUILT-IN tools (Read/Edit/Write/Bash/Grep/Glob/...) the
    // model can request. Session-aware coordination tools (peer_send /
    // peer_query / ask_user / Task) are gated SOLELY by callback presence —
    // capability == "SessionManager handed us the closure". They are system-
    // level safe (Claude side has them in allowedTools) and putting them in
    // opts.tools would either confuse the Claude SDK (unknown names) or
    // require dual-purposing the field. Keep `opts.tools` for builtins only.
    const allowedNames = new Set(opts.tools);
    const builtIns = NORMALIZED_TOOLS.filter(
      (t) => allowedNames.size === 0 || allowedNames.has(t.name),
    );
    const sessionAware: AnyNormalizedTool[] = [];
    if (opts.peerSend) sessionAware.push(makePeerSendTool(opts.peerSend));
    if (opts.peerQuery) sessionAware.push(makePeerQueryTool(opts.peerQuery));
    if (opts.conversationSearch) sessionAware.push(makeConversationSearchTool(opts.conversationSearch));
    if (opts.askUser) sessionAware.push(makeAskUserTool(opts.askUser));
    if (opts.spawnTask) sessionAware.push(makeTaskTool(opts.spawnTask));
    if (opts.ensembleHelp) sessionAware.push(makeEnsembleHelpTool(opts.ensembleHelp));
    if (opts.skillList) sessionAware.push(makeSkillListTool(opts.skillList));
    if (opts.skillInvoke) sessionAware.push(makeSkillInvokeTool(opts.skillInvoke));
    // Reading a stored artifact. Same reason as the peer tools: capability ==
    // "SessionManager handed us the closure", so a runtime without it simply
    // does not offer the tool rather than offering one that cannot work.
    if (opts.artifactRead) sessionAware.push(makeArtifactReadTool(opts.artifactRead));
    if (opts.artifactSearch) sessionAware.push(makeArtifactSearchTool(opts.artifactSearch));
    // Jobs: long work whose owner is core. Same four operations the Claude
    // runtime gets as MCP tools; the context arrives already bound to this
    // agent, so the runtime cannot offer a job tool that addresses the wrong
    // agent or the wrong project root.
    if (opts.jobs) sessionAware.push(...makeJobTools(opts.jobs));
    const sdkTools = [...builtIns, ...sessionAware].map((t) =>
      // The sink is threaded straight through by identity — it is the session's
      // own capability, and wrapping or re-deriving it here would make a second
      // place that decides what "over budget" means.
      toOpenAITool(t, {
        permissionMode: opts.permissionMode,
        projectRoot,
        ...(opts.toolOutput ? { toolOutput: opts.toolOutput } : {}),
      }),
    );

    // W20 Slice 5.5b: external user MCP servers via the @openai/agents
    // MCPServer transports. peer_send / ask_user / Task stay on the
    // NormalizedTool path (already wired above). connect() before passing
    // to Agent, close() in finally — per agent.d.ts lifecycle contract.
    const mcpInstances = toOpenAIMcpServers(opts.mcpServers as unknown as Record<string, unknown>);
    await connectAll(mcpInstances);

    // From the plan — the same field `/status` reports. Not re-read from agent
    // metadata and not gated on the provider kind: whether the ADAPTER can carry
    // the setting (it can) is a different question from which levels the model
    // has (the plan's business).
    const reasoningEffort = opts.runPlan.execution.reasoningEffort;
    // Chat Completions: @openai/agents maps `reasoning.effort` onto the
    // top-level `reasoning_effort` field (openaiChatCompletionsModel #fetchResponse).
    // DeepSeek also wants thinking mode ON for that field to mean anything —
    // default is enabled, but compat gateways do not all honour the default, so
    // an explicit effort also sends `thinking: { type: "enabled" }` via
    // providerData (the Chat Completions extra-body slot). Responses already
    // carries `reasoning.effort` natively and must not get that extra field.
    const chatCompletionsThinking =
      !useResponses && reasoningEffort
        ? { providerData: { thinking: { type: "enabled" as const } } }
        : null;
    // The server-side conversation this turn continues, if any. It is a
    // validated id (see RuntimeOptions.serverConversationId): SessionManager
    // only supplies it when the stored id was issued for THIS provider, model,
    // project root, system prompt and transport, and when the route is
    // established as able to continue (facts.supportsServerConversation).
    //
    // Gated on the ATTEMPT, not just on the plan: this function also runs the
    // chat-completions fallback, where `previous_response_id` does not exist. A
    // fallback attempt therefore rebuilds the transcript locally instead of
    // sending a delta to a route that holds nothing — which is the one way this
    // feature could silently lose history.
    const continueFrom = useResponses ? opts.serverConversationId ?? null : null;
    // Whether the route earned the continuation at all — read from the plan, so
    // "we store what we may later continue" and "we may continue what was
    // stored" are one decision instead of two. On such a route the response is
    // explicitly stored: `previous_response_id` can only point at a response the
    // server kept, and leaving `store` to the endpoint's default would make the
    // next turn's continuation depend on a default we never verified.
    const serverConversationRoute = useResponses && opts.runPlan.facts.supportsServerConversation.value === true;
    // The compaction POLICY comes from the plan, exactly like the CLI envelope
    // numbers: `null` means no verified threshold exists for this route, and the
    // runtime then keeps its own policy. Inventing one here would trade a dropped
    // transcript for a server-side compaction nobody measured the headroom of.
    const compactionThreshold = opts.runPlan.context.compactionThreshold;
    const serverManagedSettings: SdkModelSettings | null = serverConversationRoute
      ? {
          store: true,
          ...(compactionThreshold !== null && compactionThreshold > 0
            ? { contextManagement: [{ type: "compaction", compactThreshold: compactionThreshold }] }
            : {}),
        }
      : null;

    const agent = new Agent({
      name: opts.sessionId,
      instructions: opts.systemPrompt ?? "You are a helpful assistant.",
      model: opts.model,
      tools: sdkTools,
      mcpServers: mcpInstances,
      // W24: forward the reasoning level from the plan to OpenAI-compat
      // reasoning models (DeepSeek flash/v4-pro, GLM, etc.). The SDK maps
      // modelSettings.reasoning.effort to the chat-completions reasoning
      // payload. `undefined` is `inherit`: the key is omitted entirely and the
      // provider's own default applies — no level, no presence, no empty
      // sentinel that a provider could read as "lowest".
      //
      // Any provider kind reaches here as long as it speaks this API: which
      // LEVELS a model has is the model's capability (the plan's business), and
      // `openai-local` is not excluded from the setting by a kind whitelist.
      //
      // The cast is the SDK's stale typing, not ours: its union stops at `max`
      // and has no `ultra`, which the vendor's own model list gives gpt-5.6-sol.
      // The plan resolved this level against the MODEL's ladder, so it is
      // forwarded verbatim — an endpoint that does not know a level says so,
      // which is a real answer, while substituting a level the user did not ask
      // for is the silent edit this whole contract forbids.
      ...(reasoningEffort || serverManagedSettings
        ? {
            modelSettings: {
              ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
              ...(chatCompletionsThinking ?? {}),
              ...(serverManagedSettings ?? {}),
            } as SdkModelSettings,
          }
        : {}),
    });

    const inputs = buildInputItems(opts, { continueFrom });
    // The messages below report `sessionId`, the id `query` minted for the whole
    // turn: minting one here would give the assistant/result messages a session
    // that system/init (and, on a fallback, the other attempt) never named.

    // Local tokenizer billing audit (compat-providers): count tokens of every
    // text payload we actually SEND, independent of what the upstream API
    // reports. Caveats: see local-tokenizer.ts header — this is an
    // approximation suitable for spotting gross over-reporting, not contract.
    const inputTextsForLocal: string[] = [];
    if (opts.systemPrompt) inputTextsForLocal.push(opts.systemPrompt);
    for (const m of opts.history) {
      const row = chatTextForLocalRebuild(m);
      if (row) inputTextsForLocal.push(row.text);
    }
    inputTextsForLocal.push(opts.prompt);
    const auditChars = inputTextsForLocal.reduce((n, t) => n + t.length, 0);
    const inputTokensLocal =
      auditChars > 80_000 ? 0 : countTokensMany(opts.model, inputTextsForLocal);

    let finalText = "";
    let thinkingText = "";
    let rounds = 0;
    // The bound on the approval loop is OBSERVABLE, not a round budget. A turn
    // that keeps making progress (different calls, different arguments) is not
    // bounded here at all: the plan's `maxModelTurns` is null on purpose, and
    // what ends a runaway is the user's cancel, the wall-clock deadline and the
    // liveness state machine. What this catches is the one shape a clock cannot
    // see: the SAME call, with the SAME arguments, coming back for approval over
    // and over while every round looks alive.
    const approvalLoop = makeApprovalLoopTracker();
    // What a retry on another transport would cost the user: re-running a turn
    // that already streamed text would show that text twice, so a failure after
    // either of these is surfaced rather than retried.
    let emittedOutput = false;
    let sawResponseDone = false;

    // W17.1: per-model accumulator for usage stats. The SDK emits
    // StreamEventResponseCompleted with `response.usage` (final per-response
    // counts) and `response.model` (the actual model used). One turn can
    // include multiple responses (tool-loop), and in theory the model could
    // shift mid-turn though that's rare; we accumulate per-model just in case.
    const usageAccum: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }> = {};

    // W22: the LAST response's usage (not accumulated) for the context bar.
    // Each tool-loop response resends the full history, so `usageAccum`
    // double-counts for "current context usage" purposes; only the final
    // response reflects the true current window occupancy.
    let lastUsage: ReturnType<typeof readResponseUsage> = null;

    // The newest server-side response id this turn produced, when the route
    // issued one. Reported to SessionManager, which is the ONLY writer of the
    // stored continuation (see capability/server-conversation.ts) — the runtime
    // observes an id, it does not decide what to do with it.
    let serverResponseId: string | null = null;

    try {
      // Slice 4.2 interrupt-resume loop. Each iteration runs the agent until
      // the SDK pauses for tool approval (or completes). When interruptions
      // come back, we await opts.canUseTool for each — that callback round-
      // trips through SessionManager to the UI permission dialog — then
      // approve/reject on the RunState and re-run with that state.
      // Per docs/plans/openai-permission-state-machine.md the state lives
      // in this closure across loop iterations; no module-level Map needed.
      // The SDK's Agent / RunState / StreamedRunResult generics chain through
      // outputType ("text" vs ZodObjectLike) and don't unify cleanly when
      // run() is called twice with different input shapes. Widen the loop
      // carriers to any — the runtime API surface we use is well-defined.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let runInput: any = inputs;
      let loopedApproval: { tool: string; count: number } | null = null;
      for (;;) {
        if (opts.abortController.signal.aborted) break;
        rounds++;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await rejectWhenAborted(
          opts.abortController.signal,
          runner.run(
            agent as any,
            runInput,
            // The continuation id goes on the FIRST call only: from round two on we
            // hand the SDK its own RunState, which already carries the newest
            // response id, and repeating the opening id would rewind the server
            // conversation to the response the turn started from.
            buildRunnerRunOptions(
              opts.abortController.signal,
              rounds === 1 ? (continueFrom ?? undefined) : undefined,
            ),
          ),
        );
        // The newest server-side response id, when the route has one. Read after
        // every round: the last one belongs to the response this turn ends on,
        // which is the id the next turn continues from.
        //
        // Only from the Responses attempt: this same function runs the
        // chat-completions fallback, and an id issued by THAT route must never be
        // stored as a server-side conversation (it would be replayed as
        // `previous_response_id` on a route that never issued one).
        const roundResponseId = useResponses
          ? (result as { lastResponseId?: unknown }).lastResponseId
          : undefined;
        if (typeof roundResponseId === "string" && roundResponseId.length > 0) {
          serverResponseId = roundResponseId;
        }

        // One Claude-shaped tool_use per call id, matching Codex. Without this
        // the frontend only ever sees assistant text — openai-compat used to
        // render ToolCards, then this stream path stopped forwarding the
        // SDK's tool_called / approval events.
        const emittedToolCallIds = new Set<string>();

        for await (const event of takeUntilAbort(result, opts.abortController.signal)) {
          if (opts.abortController.signal.aborted) break;

          if (event.type === "raw_model_stream_event") {
            const data = event.data as { type?: string; delta?: unknown; response?: unknown };
            if (data?.type === "output_text_delta" && typeof data.delta === "string" && data.delta.length > 0) {
              finalText += data.delta;
              emittedOutput = true;
              yield {
                type: "sdk_message",
                payload: {
                  type: "stream_event",
                  session_id: sessionId,
                  event: {
                    type: "content_block_delta",
                    delta: { type: "text_delta", text: data.delta },
                  },
                },
              };
            } else {
              const reason = rawReasoningDelta(data);
              if (reason) {
                thinkingText += reason;
                emittedOutput = true;
                yield {
                  type: "sdk_message",
                  payload: {
                    type: "stream_event",
                    session_id: sessionId,
                    event: {
                      type: "content_block_delta",
                      delta: { type: "thinking_delta", thinking: reason },
                    },
                  },
                };
              } else if (data?.type === "response_done" && data.response) {
                // W17.1: capture final per-response usage. `response.usage` is
                // populated only at completion; tool-loop runs surface multiple
                // response_done events per turn, so accumulate per model rather
                // than overwrite.
                sawResponseDone = true;
                const rec = readResponseUsage(data.response, opts.model);
                if (rec) {
                  _accumulateUsageForTest(usageAccum, data.response, opts.model);
                  lastUsage = rec;
                }
                // Chat Completions only attaches CoT on the final output item
                // when the SDK recognized `delta.reasoning`. If live deltas
                // never arrived, still persist that block so the UI can show it.
                if (!thinkingText) {
                  const leftover = reasoningFromResponseOutput(data.response);
                  if (leftover) thinkingText = leftover;
                }
              }
            }
          } else if (event.type === "run_item_stream_event") {
            if (event.name === "message_output_created") {
              const text = extractItemText(event.item) || finalText;
              const payload = assistantVisibleMessage(sessionId, thinkingText, text);
              thinkingText = "";
              if (payload) {
                emittedOutput = true;
                yield { type: "sdk_message", payload };
              }
            } else if (event.name === "tool_called" || event.name === "tool_approval_requested") {
              const thinkingPayload = assistantVisibleMessage(sessionId, thinkingText, "");
              thinkingText = "";
              if (thinkingPayload) {
                emittedOutput = true;
                yield { type: "sdk_message", payload: thinkingPayload };
              }
              const call = extractToolCallFromItem(event.item);
              if (call && !emittedToolCallIds.has(call.id)) {
                emittedToolCallIds.add(call.id);
                emittedOutput = true;
                opts.liveness?.toolProgress();
                yield {
                  type: "sdk_message",
                  payload: assistantToolUseMessage(sessionId, call),
                };
              }
            } else if (event.name === "tool_output") {
              opts.liveness?.toolProgress();
            }
          }
        }

        const interruptions = result.interruptions ?? [];
        if (interruptions.length === 0) break;

        // Pending tool approvals — funnel each through opts.canUseTool which
        // SessionManager wires to the UI permission dialog. canUseTool returns
        // { behavior: "allow" } or { behavior: "deny", message? }; map to the
        // SDK's approve/reject and resume the run.
        for (const item of interruptions) {
          if (opts.abortController.signal.aborted) break;
          const call = extractToolCallFromItem(item);
          const toolName = call?.name ?? item.toolName ?? "unknown";
          const parsedArgs = (call?.input && typeof call.input === "object"
            ? call.input
            : {}) as Record<string, unknown>;
          if (thinkingText) {
            const thinkingPayload = assistantVisibleMessage(sessionId, thinkingText, "");
            thinkingText = "";
            if (thinkingPayload) {
              emittedOutput = true;
              yield { type: "sdk_message", payload: thinkingPayload };
            }
          }
          if (call && !emittedToolCallIds.has(call.id)) {
            emittedToolCallIds.add(call.id);
            emittedOutput = true;
            yield {
              type: "sdk_message",
              payload: assistantToolUseMessage(sessionId, call),
            };
          }
          // Proof of life: an approval round is work in progress, so the liveness
          // controller must not read a run waiting on the user as a stall. It is
          // also the observable that a loop detector needs and that a round
          // counter never had — WHO is being asked for WHAT, not just how many.
          const repetition = approvalLoop.record(toolName, parsedArgs);
          if (repetition.loop) {
            loopedApproval = { tool: toolName, count: repetition.count };
            break;
          }
          if (repetition.count > 1) {
            // Visible before it trips, not only when it trips: a repeat that is
            // legitimate (the user denied the first one and the model retried)
            // looks the same as the start of a loop, and the log is where the
            // two can be told apart by a human.
            console.warn(
              `[openai-runtime] approval request repeated ${repetition.count}× in one turn: ${repetition.key}`,
            );
          }
          opts.liveness?.toolProgress();
          const decision = await opts.canUseTool(toolName, parsedArgs, {
            signal: opts.abortController.signal,
            suggestions: [],
            // The Claude SDK's CanUseTool extra-options shape requires
            // toolUseID; OpenAI runtime synthesizes one since the SDK's
            // raw item doesn't surface a stable call id we can borrow.
            toolUseID: call?.id ?? item.rawItem.id ?? randomUUID(),
            // SDK 0.3.x added a required requestId (control-response
            // correlation id for out-of-band responses). The OpenAI runtime
            // resolves permissions inline and never uses it — synthesize a
            // value purely to satisfy the shared CanUseTool contract.
            requestId: randomUUID(),
          });
          // canUseTool return widened to PermissionResult | null in SDK 0.3.x.
          // SessionManager's implementation always returns a non-null result on
          // the normal path; treat a null defensively as a conservative deny so
          // a future/abnormal implementation can never silently auto-approve.
          if (decision?.behavior === "allow") {
            result.state.approve(item);
          } else {
            const message = decision && decision.behavior === "deny" ? decision.message : undefined;
            result.state.reject(item, message ? { message } : undefined);
          }
        }
        if (loopedApproval) break;
        runInput = result.state;
      }

      if (loopedApproval) {
        // The structured reason, not a round count: which call repeated, how
        // many times, and what the user can do about it. The previous message
        // named a number nobody could act on and said nothing about the tool.
        yield {
          type: "error",
          code: "RUNTIME_TOOL_APPROVAL_LOOP",
          recoverable: false,
          message:
            `the model asked to run "${loopedApproval.tool}" with identical arguments ` +
            `${loopedApproval.count} times in this turn — stopping here rather than repeating it again. ` +
            "Deny the call, change the request, or cancel the turn if this is not what you wanted.",
        };
        return { emittedOutput, sawResponseDone };
      }

      // W17.1: emit a Claude-shaped result with modelUsage so the W17
      // aggregator (extractUsageEvents) treats Claude and OpenAI uniformly.
      // costUSD is intentionally omitted/0 here — pricing.ts computes it at
      // the aggregation step using pricing.json (which is the single
      // authoritative price source per the v2 decision).
      const modelUsage: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
        webSearchRequests: number;
        contextWindow: number;
        inputTokensLocal?: number;
        outputTokensLocal?: number;
      }> = {};
      const contextWindow = openaiResultContextWindow(opts.runPlan);
      for (const [m, u] of Object.entries(usageAccum)) {
        modelUsage[m] = {
          ...u,
          costUSD: 0,         // ignored by aggregator; pricing.ts is authoritative
          webSearchRequests: 0,
          contextWindow,
        };
      }
      // Attach local counts to the entry matching opts.model. If upstream
      // didn't report under that exact key (model id mismatch / mid-turn
      // shift), synthesize an entry so the audit data isn't lost.
      const outputTokensLocal = countTokens(opts.model, finalText);
      if (!modelUsage[opts.model]) {
        modelUsage[opts.model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
          webSearchRequests: 0,
          contextWindow,
        };
      }
      const entry = modelUsage[opts.model]!;
      entry.inputTokensLocal = inputTokensLocal;
      entry.outputTokensLocal = outputTokensLocal;
      opts.liveness?.resultSeen();
      yield {
        type: "sdk_message",
        payload: {
          type: "result",
          subtype: "success",
          session_id: sessionId,
          modelUsage,
          // W22: last response usage for the context bar. Kept separate from
          // modelUsage (which is accumulated across the tool loop).
          contextUsage: lastUsage ?? undefined,
          // The id the server issued for this turn's final response, when it
          // issued one. Absent means "this route has no server-side
          // conversation", which is a different fact from "we forgot to store
          // it" — the field's presence is the observation.
          ...(serverResponseId ? { serverResponseId } : {}),
        },
      };
      return { emittedOutput, sawResponseDone };
    } catch (err) {
      // Abort is user-initiated; treat as a clean exit (Slice 4 §5). Not an
      // error the caller may retry on: the user asked us to stop.
      if (opts.abortController.signal.aborted) return { emittedOutput, sawResponseDone };
      // The error is RETURNED, not yielded: the caller decides whether a
      // permitted transport switch applies, and it is the only place that knows
      // whether anything was already shown to the user.
      return { error: err, emittedOutput, sawResponseDone };
    } finally {
      // W20 Slice 5.5b: tear down MCP transports so stdio child procs exit
      // and HTTP/SSE keep-alives release. closeAll swallows per-server
      // failures to avoid blocking when one transport hangs on close.
      await closeAll(mcpInstances);
    }
}

/** Options for every `Runner.run` call in a turn.
 *
 *  `maxTurns: null` is the SDK's own "no cap" value (`turnPreparation` only
 *  throws when `state._maxTurns !== null`). Leaving it undefined is NOT
 *  unbounded: @openai/agents substitutes `DEFAULT_MAX_TURNS = 10`, so a task
 *  needing a 12th model turn dies mid-flight with "Max turns (10) exceeded".
 *  The run plan forbids a global model-turn cap — the bound on a runaway loop
 *  is cancellation, loop detection and the liveness state machine, not a
 *  number that truncates long work.
 *
 *  `previousResponseId` is the ONE server-side conversation owner. It is passed
 *  only on the turn's FIRST model call: the SDK threads the newest id through
 *  the rest of the turn itself (`ServerConversationTracker.trackServerItems`
 *  writes each response id back into `RunState`), and re-sending the id we
 *  started from would point the SDK back at an older response than the state it
 *  is resuming (its resolution order is `options.previousResponseId ??
 *  state._previousResponseId`). */
export function buildRunnerRunOptions(
  signal: AbortSignal,
  previousResponseId?: string,
): {
  stream: true;
  signal: AbortSignal;
  maxTurns: null;
  previousResponseId?: string;
} {
  return {
    stream: true,
    signal,
    maxTurns: null,
    ...(previousResponseId ? { previousResponseId } : {}),
  };
}

/** The input items for this turn.
 *
 *  TWO shapes, and the difference is the whole point of the continuation:
 *
 *   • `local-rebuild` (no continuation) — the transcript travels in the request
 *     body, exactly as the plan's history budget measured it.
 *   • server continuation — ONLY this turn's prompt goes over the wire. The
 *     server already holds the prior items (reasoning, tool calls and their
 *     outputs included, in their native form), and it recovers them from
 *     `previous_response_id`. Sending the transcript alongside the id would
 *     duplicate every prior turn.
 *
 *  Instructions are NOT what carries the context here: the Responses API does
 *  not inherit them from the previous response, so the agent's system prompt is
 *  re-sent every turn by the SDK (see openaiResponsesModel's `instructions`). */
export function buildInputItems(
  opts: RuntimeOptions,
  args: { continueFrom?: string | null } = {},
): AgentInputItem[] {
  if (args.continueFrom) return [user(opts.prompt)];
  const items: AgentInputItem[] = [];
  for (const m of opts.history) {
    const row = chatTextForLocalRebuild(m);
    if (!row) continue;
    items.push(row.role === "user" ? user(row.text) : assistant(row.text));
  }
  items.push(user(opts.prompt));
  return items;
}

/** How many times ONE identical approval request may come back in a single turn.
 *
 *  Three, because a legitimate repeat is a thing that happens (re-running the
 *  same build after a deny, a retried command) while a fourth identical ask is
 *  the loop. The counter is per (tool, arguments) pair, so a long turn that
 *  keeps doing NEW work is never touched by it — which is the whole reason this
 *  replaces a round budget. */
export const REPEATED_APPROVAL_LIMIT = 3;

export interface ApprovalLoopTracker {
  /** Record one approval request. `loop` is true when this request is the one
   *  that exceeds the limit — the caller must not approve it. */
  record(toolName: string, args: unknown): { key: string; count: number; loop: boolean };
}

/** Per-turn detector for the approval loop a round budget used to stand in for.
 *
 *  The key is the tool name plus the request's own serialized arguments. Two
 *  requests with the same args in a different key order are the same request as
 *  far as a model's repetition goes (both are `JSON.parse` of what the model
 *  sent, so the order follows the model's own text and is stable in practice);
 *  arguments that fail to parse are keyed by their raw text instead, so an
 *  unparseable request can still be recognised as repeated. */
export function makeApprovalLoopTracker(limit = REPEATED_APPROVAL_LIMIT): ApprovalLoopTracker {
  const seen = new Map<string, number>();
  return {
    record(toolName: string, args: unknown) {
      let serialized: string;
      try {
        serialized = JSON.stringify(args ?? null) ?? "null";
      } catch {
        serialized = String(args);
      }
      const key = `${toolName}(${serialized})`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return { key, count, loop: count >= limit };
    },
  };
}

/** W17.1: pull a final per-response usage record out of a
 *  StreamEventResponseCompleted event payload and merge into the per-model
 *  accumulator. Field names follow @openai/agents protocol.d.ts (camelCase
 *  for the top-level shape; `prompt_tokens_details.cached_tokens` snake when
 *  it falls through to the OpenAI SDK shape). Best-effort: if the SDK
 *  reshuffles names, we end up under-counting rather than crashing. */
export function readResponseUsage(
  response: unknown,
  fallbackModel: string,
): {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
} | null {
  const r = response as {
    model?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      inputTokensDetails?: { cached_tokens?: number; cachedTokens?: number };
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  if (!r?.usage) return null;
  const u = r.usage;
  const model = r.model || fallbackModel;
  const reportedInputTokens = u.inputTokens ?? u.input_tokens ?? 0;
  const outputTokens = u.outputTokens ?? u.output_tokens ?? 0;
  const cacheReadInputTokens =
    u.inputTokensDetails?.cached_tokens ??
    u.inputTokensDetails?.cachedTokens ??
    u.prompt_tokens_details?.cached_tokens ??
    0;
  const inputTokens = Math.max(0, reportedInputTokens - cacheReadInputTokens);
  // OpenAI's prompt-caching only reports reads; creation is implicit in input
  // count (first send pays input price, subsequent reads pay cache_read).
  // We leave cacheCreationInputTokens=0 — there's no separate counter.
  return { model, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens: 0 };
}

export function _accumulateUsageForTest(
  accum: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }>,
  response: unknown,
  fallbackModel: string,
): void {
  const rec = readResponseUsage(response, fallbackModel);
  if (!rec) return;
  const slot = accum[rec.model] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  slot.inputTokens += rec.inputTokens;
  slot.outputTokens += rec.outputTokens;
  slot.cacheReadInputTokens += rec.cacheReadInputTokens;
  accum[rec.model] = slot;
}

function extractItemText(item: unknown): string {
  // RunItem shape: see runner/items. message_output_created carries a
  // RunMessageOutputItem with `rawItem` whose `content` is an array of
  // text blocks.
  const r = item as { rawItem?: { content?: Array<{ type?: string; text?: string }> } };
  const content = r.rawItem?.content ?? [];
  return content
    .filter((b) => typeof b.text === "string" && b.type !== "thinking" && b.type !== "reasoning")
    .map((b) => b.text!)
    .join("");
}

function reasoningString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function chatCompletionDelta(data: { type?: unknown; event?: unknown }): Record<string, unknown> | null {
  if (data.type !== "model") return null;
  const event = data.event as
    | { choices?: Array<{ index?: number; delta?: Record<string, unknown> }> }
    | undefined;
  const choices = event?.choices;
  if (!Array.isArray(choices)) return null;
  const primary = choices.find((c) => (c.index ?? 0) === 0) ?? choices[0];
  const delta = primary?.delta;
  return delta && typeof delta === "object" ? delta : null;
}

function rawReasoningDelta(data: { type?: unknown; delta?: unknown; event?: unknown }): string | null {
  const type = typeof data.type === "string" ? data.type : "";
  if (typeof data.delta === "string" && data.delta.length > 0) {
    if (type.includes("reasoning") || type === "reasoning_content") return data.delta;
  }
  if (data.delta && typeof data.delta === "object") {
    const nested = data.delta as { reasoning_content?: unknown; text?: unknown; reasoning?: unknown };
    const nestedReason =
      reasoningString(nested.reasoning_content) ??
      reasoningString(nested.reasoning) ??
      (type.includes("reasoning") ? reasoningString(nested.text) : null);
    if (nestedReason) return nestedReason;
  }
  // Chat Completions: @openai/agents yields every chunk as `{ type: "model", event: chunk }`
  // and never synthesizes a reasoning delta. DeepSeek puts CoT on
  // `choices[0].delta.reasoning_content`; some gateways use `delta.reasoning`.
  const chatDelta = chatCompletionDelta(data);
  if (chatDelta) {
    return reasoningString(chatDelta.reasoning_content) ?? reasoningString(chatDelta.reasoning);
  }
  return null;
}

function reasoningFromResponseOutput(response: unknown): string | null {
  const output = (response as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const it = item as {
      type?: unknown;
      rawContent?: Array<{ type?: string; text?: string }>;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (it.type !== "reasoning") continue;
    for (const block of [...(it.rawContent ?? []), ...(it.content ?? [])]) {
      const text = reasoningString(block.text);
      if (text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function assistantVisibleMessage(
  sessionId: string,
  thinking: string,
  text: string,
): { type: "assistant"; session_id: string; message: { content: Array<{ type: string; thinking?: string; text?: string }> } } | null {
  const content: Array<{ type: string; thinking?: string; text?: string }> = [];
  if (thinking) content.push({ type: "thinking", thinking });
  if (text) content.push({ type: "text", text });
  if (content.length === 0) return null;
  return { type: "assistant", session_id: sessionId, message: { content } };
}

export interface ExtractedToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** Pull a tool name + arguments out of an Agents SDK run item or interruption.
 *
 *  The SDK wraps the protocol `function_call` / `hosted_tool_call` in `rawItem`;
 *  interruptions also expose `toolName`. Missing arguments stay `{}` rather than
 *  dropping the card — a nameless call is the one thing we cannot surface. */
export function extractToolCallFromItem(item: unknown): ExtractedToolCall | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const raw = (rec.rawItem && typeof rec.rawItem === "object"
    ? rec.rawItem
    : rec) as Record<string, unknown>;
  const name =
    (typeof raw.name === "string" && raw.name) ||
    (typeof rec.toolName === "string" && rec.toolName) ||
    null;
  if (!name) return null;
  const id =
    (typeof raw.callId === "string" && raw.callId) ||
    (typeof raw.id === "string" && raw.id) ||
    (typeof rec.id === "string" && rec.id) ||
    randomUUID();
  let input: unknown = {};
  const args = raw.arguments;
  if (typeof args === "string" && args.length > 0) {
    try {
      input = JSON.parse(args) as unknown;
    } catch {
      input = { _raw: args };
    }
  } else if (args && typeof args === "object") {
    input = args;
  }
  return { id, name, input };
}

export function assistantToolUseMessage(
  sessionId: string,
  call: ExtractedToolCall,
): {
  type: "assistant";
  session_id: string;
  message: { content: Array<{ type: "tool_use"; id: string; name: string; input: unknown }> };
} {
  return {
    type: "assistant",
    session_id: sessionId,
    message: {
      content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input }],
    },
  };
}

/** Window published on the OpenAI result's modelUsage.
 *
 *  The Agents SDK does not surface a context window. This in-process runtime
 *  also does not clamp, so a confirmed advertised figure IS the session window
 *  when the plan has no effective/requested value. Unverified advertised
 *  numbers stay 0 — the bar then shows used tokens against an unknown ceiling
 *  rather than presenting a community snapshot as the denominator. */
export function openaiResultContextWindow(plan: ResolvedRunPlan): number {
  const effective = plan.context.effectiveWindow;
  if (typeof effective === "number" && effective > 0) return effective;
  const requested = plan.context.requestedRuntimeWindow;
  if (typeof requested === "number" && requested > 0) return requested;
  const advertised = plan.facts.advertisedContextWindow;
  if (
    advertised.confidence === "confirmed" &&
    typeof advertised.value === "number" &&
    advertised.value > 0
  ) {
    return advertised.value;
  }
  return 0;
}
