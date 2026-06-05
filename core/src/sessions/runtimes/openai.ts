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
import type { AgentRuntime, RuntimeEvent, RuntimeOptions } from "./types.js";
import {
  NORMALIZED_TOOLS,
  toOpenAITool,
  makePeerSendTool,
  makePeerQueryTool,
  makeAskUserTool,
  makeTaskTool,
  makeEnsembleHelpTool,
  makeSkillListTool,
  makeSkillInvokeTool,
} from "../tools/index.js";
import type { AnyNormalizedTool } from "../tools/types.js";
import { toOpenAIMcpServers, connectAll, closeAll } from "./mcp-adapter.js";
import { countTokens, countTokensMany } from "../../local-tokenizer.js";

export class OpenAIAgentRuntime implements AgentRuntime {
  async *query(opts: RuntimeOptions): AsyncIterable<RuntimeEvent> {
    if (!opts.provider.baseUrl) {
      yield { type: "error", message: "openai-compat provider missing baseUrl" };
      return;
    }
    if (!opts.provider.apiKey) {
      yield { type: "error", message: "openai-compat provider missing apiKey" };
      return;
    }

    const provider = new OpenAIProvider({
      apiKey: opts.provider.apiKey,
      baseURL: opts.provider.baseUrl,
      // Force chat-completions transport for compat upstreams; the Responses
      // API (default) is OpenAI-only and 404s on DeepSeek / GLM / etc.
      useResponses: false,
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
    if (opts.askUser) sessionAware.push(makeAskUserTool(opts.askUser));
    if (opts.spawnTask) sessionAware.push(makeTaskTool(opts.spawnTask));
    if (opts.ensembleHelp) sessionAware.push(makeEnsembleHelpTool(opts.ensembleHelp));
    if (opts.skillList) sessionAware.push(makeSkillListTool(opts.skillList));
    if (opts.skillInvoke) sessionAware.push(makeSkillInvokeTool(opts.skillInvoke));
    const sdkTools = [...builtIns, ...sessionAware].map((t) =>
      toOpenAITool(t, { permissionMode: opts.permissionMode }),
    );

    // W20 Slice 5.5b: external user MCP servers via the @openai/agents
    // MCPServer transports. peer_send / ask_user / Task stay on the
    // NormalizedTool path (already wired above). connect() before passing
    // to Agent, close() in finally — per agent.d.ts lifecycle contract.
    const mcpInstances = toOpenAIMcpServers(opts.mcpServers as unknown as Record<string, unknown>);
    await connectAll(mcpInstances);

    const agent = new Agent({
      name: opts.sessionId,
      instructions: opts.systemPrompt ?? "You are a helpful assistant.",
      model: opts.model,
      tools: sdkTools,
      mcpServers: mcpInstances,
    });

    const inputs = buildInputItems(opts);
    const synthSessionId = randomUUID();

    // Local tokenizer billing audit (compat-providers): count tokens of every
    // text payload we actually SEND, independent of what the upstream API
    // reports. Caveats: see local-tokenizer.ts header — this is an
    // approximation suitable for spotting gross over-reporting, not contract.
    const inputTextsForLocal: string[] = [];
    if (opts.systemPrompt) inputTextsForLocal.push(opts.systemPrompt);
    for (const m of opts.history) {
      if (m.type === "user") {
        const c = extractUserText(m);
        if (c) inputTextsForLocal.push(c);
      } else if (m.type === "assistant") {
        const blocks =
          (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string" && b.text) {
            inputTextsForLocal.push(b.text);
          }
        }
      }
    }
    inputTextsForLocal.push(opts.prompt);
    const inputTokensLocal = countTokensMany(opts.model, inputTextsForLocal);

    // System/init — frontend uses this to know a turn started.
    yield {
      type: "sdk_message",
      payload: {
        type: "system",
        subtype: "init",
        session_id: synthSessionId,
        model: opts.model,
      },
    };

    let finalText = "";
    let rounds = 0;
    const MAX_INTERRUPT_ROUNDS = 32;

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
      while (rounds++ < MAX_INTERRUPT_ROUNDS) {
        if (opts.abortController.signal.aborted) break;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await runner.run(agent as any, runInput, {
          stream: true,
          signal: opts.abortController.signal,
        });

        for await (const event of result) {
          if (opts.abortController.signal.aborted) break;

          if (event.type === "raw_model_stream_event") {
            const data = event.data as { type?: string; delta?: string; response?: unknown };
            if (data?.type === "output_text_delta" && typeof data.delta === "string" && data.delta.length > 0) {
              finalText += data.delta;
              yield {
                type: "sdk_message",
                payload: {
                  type: "stream_event",
                  session_id: synthSessionId,
                  event: {
                    type: "content_block_delta",
                    delta: { type: "text_delta", text: data.delta },
                  },
                },
              };
            } else if (data?.type === "response_done" && data.response) {
              // W17.1: capture final per-response usage. `response.usage` is
              // populated only at completion; tool-loop runs surface multiple
              // response_done events per turn, so accumulate per model rather
              // than overwrite.
              accumulateUsage(usageAccum, data.response, opts.model);
            }
          } else if (event.type === "run_item_stream_event" && event.name === "message_output_created") {
            const text = extractItemText(event.item) || finalText;
            if (text) {
              yield {
                type: "sdk_message",
                payload: {
                  type: "assistant",
                  session_id: synthSessionId,
                  message: {
                    content: [{ type: "text" as const, text }],
                  },
                },
              };
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
          const rawItem = item.rawItem as { name?: string; arguments?: string };
          const toolName = rawItem.name ?? item.toolName ?? "unknown";
          let parsedArgs: Record<string, unknown> = {};
          if (rawItem.arguments) {
            try {
              parsedArgs = JSON.parse(rawItem.arguments) as Record<string, unknown>;
            } catch {
              parsedArgs = { _raw: rawItem.arguments };
            }
          }
          const decision = await opts.canUseTool(toolName, parsedArgs, {
            signal: opts.abortController.signal,
            suggestions: [],
            // The Claude SDK's CanUseTool extra-options shape requires
            // toolUseID; OpenAI runtime synthesizes one since the SDK's
            // raw item doesn't surface a stable call id we can borrow.
            toolUseID: item.rawItem.id ?? randomUUID(),
          });
          if (decision.behavior === "allow") {
            result.state.approve(item);
          } else {
            result.state.reject(item, decision.message ? { message: decision.message } : undefined);
          }
        }
        runInput = result.state;
      }

      if (rounds >= MAX_INTERRUPT_ROUNDS) {
        yield {
          type: "error",
          message: `agent exceeded ${MAX_INTERRUPT_ROUNDS} approval rounds in one turn — aborted to prevent infinite tool loop`,
        };
        return;
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
      for (const [m, u] of Object.entries(usageAccum)) {
        modelUsage[m] = {
          ...u,
          costUSD: 0,         // ignored by aggregator; pricing.ts is authoritative
          webSearchRequests: 0,
          contextWindow: 0,   // OpenAI SDK doesn't surface this consistently
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
          contextWindow: 0,
        };
      }
      const entry = modelUsage[opts.model]!;
      entry.inputTokensLocal = inputTokensLocal;
      entry.outputTokensLocal = outputTokensLocal;
      yield {
        type: "sdk_message",
        payload: {
          type: "result",
          subtype: "success",
          session_id: synthSessionId,
          modelUsage,
        },
      };
    } catch (err) {
      // Abort is user-initiated; treat as a clean exit (Slice 4 §5).
      if (opts.abortController.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: msg };
    } finally {
      // W20 Slice 5.5b: tear down MCP transports so stdio child procs exit
      // and HTTP/SSE keep-alives release. closeAll swallows per-server
      // failures to avoid blocking when one transport hangs on close.
      await closeAll(mcpInstances);
    }
  }
}

function buildInputItems(opts: RuntimeOptions): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  for (const m of opts.history) {
    if (m.type === "user") {
      const text = extractUserText(m);
      if (text) items.push(user(text));
    } else if (m.type === "assistant") {
      const blocks = (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? [];
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("");
      if (text) items.push(assistant(text));
    }
  }
  items.push(user(opts.prompt));
  return items;
}

function extractUserText(msg: { message?: unknown }): string {
  // SessionManager persists user messages as { type: "user", message: { role, content } }
  // where content is a string. Extract defensively in case shape evolves.
  const m = msg.message as { content?: unknown } | undefined;
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return "";
}

/** W17.1: pull a final per-response usage record out of a
 *  StreamEventResponseCompleted event payload and merge into the per-model
 *  accumulator. Field names follow @openai/agents protocol.d.ts (camelCase
 *  for the top-level shape; `prompt_tokens_details.cached_tokens` snake when
 *  it falls through to the OpenAI SDK shape). Best-effort: if the SDK
 *  reshuffles names, we end up under-counting rather than crashing. */
function accumulateUsage(
  accum: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }>,
  response: unknown,
  fallbackModel: string,
): void {
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
  if (!r?.usage) return;
  const u = r.usage;
  const model = r.model || fallbackModel;
  const inputTokens = u.inputTokens ?? u.input_tokens ?? 0;
  const outputTokens = u.outputTokens ?? u.output_tokens ?? 0;
  const cacheReadInputTokens =
    u.inputTokensDetails?.cached_tokens ??
    u.inputTokensDetails?.cachedTokens ??
    u.prompt_tokens_details?.cached_tokens ??
    0;
  // OpenAI's prompt-caching only reports reads; creation is implicit in input
  // count (first send pays input price, subsequent reads pay cache_read).
  // We leave cacheCreationInputTokens=0 — there's no separate counter.
  const slot = accum[model] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  slot.inputTokens += inputTokens;
  slot.outputTokens += outputTokens;
  slot.cacheReadInputTokens += cacheReadInputTokens;
  accum[model] = slot;
}

function extractItemText(item: unknown): string {
  // RunItem shape: see runner/items. message_output_created carries a
  // RunMessageOutputItem with `rawItem` whose `content` is an array of
  // text blocks.
  const r = item as { rawItem?: { content?: Array<{ type?: string; text?: string }> } };
  const content = r.rawItem?.content ?? [];
  return content
    .filter((b) => typeof b.text === "string")
    .map((b) => b.text!)
    .join("");
}
