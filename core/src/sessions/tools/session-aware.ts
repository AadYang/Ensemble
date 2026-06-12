// Slice 5: session-aware NormalizedTools — peer_send / ask_user / Task.
//
// These three tools need a closure over SessionManager (or specific methods
// on it). They mirror the Claude side's peer-mcp / ask-user-mcp / Task with
// the same fromAgentId-binding pattern: SessionManager.sendMessage builds a
// fresh tool per call via these factories. Each factory takes a callback
// (not a SessionManager reference) so the abstraction stays clean — the
// callbacks are the Slice 1.7 makePeerSendHandler / makeAskUserHandler /
// (new) spawnTaskSubagent closures.
//
// Per docs/plans/openai-mcp-integration.md §2 these are plain function
// tools, not MCP — the OpenAI Agents SDK's MCP API is client-only, so an
// in-process MCP server would be 4-hop where 0-hop works.
//
// Per docs/plans/cross-runtime-peer-send.md §6.1 OpenAI names: short
// `peer_send` / `ask_user` / `Task`. Frontend normalizes vs Claude's
// `mcp__agentorch-peer__peer_send` long names in Slice 5.5.

import { z } from "zod";
import type { PeerIncludeSource } from "@agentorch/shared";
import type { NormalizedTool } from "./types.js";

const PEER_MODES = ["continue", "review", "fork", "raw"] as const;

type PeerSendCallback = (args: {
  target: string;
  message: string;
  mode?: typeof PEER_MODES[number];
  includeSource?: PeerIncludeSource;
  interrupt?: boolean;
  interruptReason?: string;
}) => Promise<string>;

type PeerQueryCallback = (args: { target: string; limit?: number }) => Promise<string>;

type AskUserCallback = (args: { question: string; options: string[] }) => Promise<string>;

type SpawnTaskCallback = (args: {
  description: string;
  prompt: string;
}) => Promise<{ finalText: string; subagentId: string }>;

type EnsembleHelpCallback = (args: { topic?: string }) => Promise<string>;
type SkillListCallback = () => Promise<string>;
type SkillInvokeCallback = (args: { name: string }) => Promise<string>;

const PEER_SEND_SCHEMA = z.object({
  target: z.string().min(1).describe("Name (preferred) or UUID of the recipient agent."),
  message: z.string().min(1).describe("Body of the message to send."),
  mode: z
    .enum(PEER_MODES)
    .optional()
    .describe("Handoff semantics: continue|review|fork|raw. Default 'raw'."),
  includeSource: z
    .union([z.boolean(), z.literal("auto")])
    .optional()
    .describe("Whether to include source-output. Default 'auto': raw=false, continue/review/fork=true."),
  interrupt: z
    .boolean()
    .optional()
    .describe("Emergency only. Interrupt the target's current run so this message is delivered immediately."),
  interruptReason: z
    .string()
    .optional()
    .describe("Required when interrupt=true. Explain why delayed delivery would be harmful or stale."),
});

/** peer_send NormalizedTool factory. Mirror of Claude side peer-mcp.ts.
 *  fromAgentId is bound inside the callback (see Slice 1.7), not here. */
export function makePeerSendTool(send: PeerSendCallback): NormalizedTool<typeof PEER_SEND_SCHEMA> {
  return {
    name: "peer_send",
    description: [
      "Send a chat message to another agent in this workspace. Bidirectional: anyone can",
      "send to anyone. If you received a peer-handoff and need more info, you can peer_send",
      "back to the source agent (their reply arrives as a new turn).",
      "",
      "Modes (cxsm-style handoff semantics):",
      "  - continue: hand off your work-in-progress; recipient continues from your trajectory.",
      "  - review:   ask recipient for a second-opinion audit of your work; quote verbatim.",
      "  - fork:     same task, different approach; recipient should NOT replicate your path.",
      "  - raw:      plain message forwarding (default).",
      "",
      "Source context defaults to includeSource='auto': raw sends only your message;",
      "continue/review/fork include a bounded <<<source-output>>> block with your current",
      "or most recent key output. Use peer_query when more context is needed.",
      "",
      "interrupt=true is emergency-only: use it only when delayed delivery would make",
      "the message stale or cause the target to continue incorrectly. You must provide",
      "interruptReason. Ordinary notifications, questions, and handoffs must not interrupt.",
      "",
      "Use the target agent's name (preferred) or its UUID.",
      "Returns delivery status; does NOT wait for the recipient to reply.",
      "For read-only context pulls without running anyone, prefer peer_query.",
    ].join("\n"),
    parameters: PEER_SEND_SCHEMA,
    async execute(args) {
      return send(args);
    },
  };
}

const PEER_QUERY_SCHEMA = z.object({
  target: z.string().min(1).describe("Name (preferred) or UUID of the peer agent."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max user-turn boundaries to walk back (default 20, max 50)."),
});

/** peer_query NormalizedTool factory. Read-only DB-only fetch of a peer
 *  agent's recent text turns. Use this when a handoff feels short on context. */
export function makePeerQueryTool(query: PeerQueryCallback): NormalizedTool<typeof PEER_QUERY_SCHEMA> {
  return {
    name: "peer_query",
    description: [
      "Pull another agent's recent text turns (read-only, synchronous). Use when",
      "you need more context than what arrived in a handoff, or to inspect a peer's",
      "state before sending them work.",
      "",
      "Does NOT cause the target agent to run; pure DB read. Returns oldest-first",
      "text turns prefixed with [user] / [assistant], tool-use noise stripped.",
    ].join("\n"),
    parameters: PEER_QUERY_SCHEMA,
    async execute(args) {
      return query(args);
    },
  };
}

const ASK_USER_SCHEMA = z.object({
  question: z.string().min(1).describe("Question text shown to the user."),
  options: z
    .array(z.string().min(1))
    .min(1)
    .describe("List of choice labels the user can pick from. At least one."),
});

/** ask_user NormalizedTool factory. Mirror of Claude side ask-user-mcp.ts. */
export function makeAskUserTool(ask: AskUserCallback): NormalizedTool<typeof ASK_USER_SCHEMA> {
  return {
    name: "ask_user",
    description:
      "Ask the human user a question and wait for their answer. Pass a list of options " +
      "(button labels). The tool returns the option string the user picked. Use this when " +
      "you need a decision before proceeding (clarification / branching / approval beyond " +
      "simple yes-no).",
    parameters: ASK_USER_SCHEMA,
    async execute(args) {
      return ask(args);
    },
  };
}

const TASK_SCHEMA = z.object({
  description: z.string().min(1).describe("Short task summary (3-5 words)."),
  prompt: z.string().min(1).describe("Full task description for the subagent."),
});

const ENSEMBLE_HELP_SCHEMA = z.object({
  topic: z
    .string()
    .optional()
    .describe(
      "Topic name. One of: overview, add_mcp_server, switch_provider, switch_model, create_agent, permissions, sandbox, peer_messaging, slash_commands, data_dir.",
    ),
});

/** ensemble_help NormalizedTool factory. Stateless — no closure needed —
 *  but kept on the factory pattern for consistency with peer_send / ask_user. */
export function makeEnsembleHelpTool(
  help: EnsembleHelpCallback,
): NormalizedTool<typeof ENSEMBLE_HELP_SCHEMA> {
  return {
    name: "ensemble_help",
    description: [
      "Ensemble runtime guidance. Call this BEFORE attempting Ensemble-specific",
      "tasks — Ensemble's source code is NOT on this machine; don't try to Grep",
      "for it. Returns UI paths + HTTP API hints for each topic.",
      "",
      "Topics: overview, add_mcp_server, switch_provider, switch_model,",
      "create_agent, permissions, sandbox, peer_messaging, slash_commands, data_dir.",
      "Call with no topic for the index.",
    ].join("\n"),
    parameters: ENSEMBLE_HELP_SCHEMA,
    async execute(args) {
      return help(args);
    },
  };
}

const SKILL_LIST_SCHEMA = z.object({});
const SKILL_INVOKE_SCHEMA = z.object({
  name: z.string().min(1).describe("Skill name (slug from SKILL.md frontmatter)."),
});

export function makeSkillListTool(list: SkillListCallback): NormalizedTool<typeof SKILL_LIST_SCHEMA> {
  return {
    name: "skill_list",
    description: [
      "List skills currently available to this agent. Each entry: name,",
      "description (when-to-use), source, optional tool restrictions.",
      "",
      "Skills may auto-activate based on the user's message — check your system",
      "prompt for ACTIVE SKILLS before invoking explicitly.",
    ].join("\n"),
    parameters: SKILL_LIST_SCHEMA,
    async execute() {
      return list();
    },
  };
}

export function makeSkillInvokeTool(
  invoke: SkillInvokeCallback,
): NormalizedTool<typeof SKILL_INVOKE_SCHEMA> {
  return {
    name: "skill_invoke",
    description: [
      "Load a specific skill's instructions by name. Use when auto-activation",
      "missed the skill you need, or when the user invokes by name.",
      "",
      "Returns the full skill body — treat its instructions as system-prompt",
      "guidance for the rest of this turn.",
    ].join("\n"),
    parameters: SKILL_INVOKE_SCHEMA,
    async execute(args) {
      return invoke(args);
    },
  };
}

/** Task NormalizedTool factory. Per docs/plans/openai-task-handoff.md §3 the
 *  callback round-trips through SessionManager.spawnTaskSubagent so the
 *  child agent is a real DB row, can be canceled with the parent, and its
 *  messages broadcast normally. */
export function makeTaskTool(spawn: SpawnTaskCallback): NormalizedTool<typeof TASK_SCHEMA> {
  return {
    name: "Task",
    description:
      "Delegate a subtask to a subagent. The subagent inherits this agent's model + " +
      "provider but runs in an isolated context. Returns the subagent's final response. " +
      "Use this for self-contained work that benefits from a clean slate (research, " +
      "exploration, multi-step decomposition). Subagent depth is capped at 3 levels.",
    parameters: TASK_SCHEMA,
    async execute(args) {
      const { finalText } = await spawn(args);
      return finalText;
    },
  };
}
