// Server-side conversation continuation for the Responses route.
//
// The rule this module exists to enforce: a continuation id is only reusable
// while EVERYTHING that shaped it is unchanged. A response id issued for
// provider P, model M, project root R, system prompt S and transport T refers to
// a conversation the server assembled under exactly those conditions. Reusing it
// after any of them changed silently drops the transcript: the server returns a
// continuation of a conversation that is no longer this agent's, and the model
// answers with no memory of the turns the plan believes it received.
//
// So the id is stored WITH its signature, and a turn reuses it only after
// recomputing that signature and finding it equal. When it is not equal the
// entry is discarded — never "repaired", never reused with a warning — and the
// turn falls back to `local-rebuild`, where the transcript travels in the
// request body.
//
// The module is deliberately registry-free: it operates on the agent's metadata
// blob the caller already read, so the same functions serve the turn path and
// `/status` without a second source of state.

import { createHash } from "node:crypto";

export const SERVER_CONVERSATION_KEY = "serverConversation";

export interface StoredServerConversation {
  /** The response/conversation id the server issued. */
  id: string;
  /** Hash over everything that shaped it. */
  signature: string;
  /** Unix seconds, for the UI only — never a validity input. */
  storedAt: number;
}

export interface ServerConversationSignatureInput {
  providerId: string | null;
  model: string;
  /** The resolved project root for the turn, or null for an unbound agent. */
  projectRoot: string | null;
  /** The stable system-prompt hash (the same one the resume decision uses). */
  systemPromptHash: string;
  /** The transport this turn ATTEMPTS, from the plan. */
  transport: string;
}

/** A stable hash of everything that shaped the conversation. */
export function serverConversationSignature(input: ServerConversationSignatureInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.providerId,
        input.model,
        input.projectRoot,
        input.systemPromptHash,
        input.transport,
      ]),
    )
    .digest("hex");
}

/** The stored entry, when it is well-formed. A malformed blob is treated as
 *  absent rather than partially trusted. */
export function readServerConversation(metadata: unknown): StoredServerConversation | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[SERVER_CONVERSATION_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { id, signature, storedAt } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof signature !== "string" || signature.length === 0) return null;
  return { id, signature, storedAt: typeof storedAt === "number" ? storedAt : 0 };
}

export interface ServerConversationDecision {
  /** The id to hand the runtime, or null when the turn must rebuild locally. */
  id: string | null;
  reason: string;
  /** True when a stored entry existed and was rejected: the caller must clear
   *  it, because a stale continuation is worse than none — it makes the server
   *  answer as a continuation of a conversation this agent is no longer in. */
  invalidated: boolean;
}

/** Decide whether the stored continuation may be reused this turn. */
export function resolveServerConversation(args: {
  metadata: unknown;
  signature: string;
  /** True only when the route was OBSERVED to support server-side
   *  conversations. A route that merely looks like it might is not enough. */
  supported: boolean;
}): ServerConversationDecision {
  if (!args.supported) {
    return {
      id: null,
      reason:
        "this route has not been observed to support server-side conversations, so no continuation is claimed",
      invalidated: false,
    };
  }
  const stored = readServerConversation(args.metadata);
  if (!stored) {
    return {
      id: null,
      reason: "no server-side conversation id is stored for this agent; the transcript is rebuilt locally",
      invalidated: false,
    };
  }
  if (stored.signature !== args.signature) {
    return {
      id: null,
      reason:
        "the stored server-side conversation was created under a different provider/model/project root/system prompt/transport, so it was discarded rather than continued",
      invalidated: true,
    };
  }
  return {
    id: stored.id,
    reason: "a server-side conversation id matching this turn's signature was reused",
    invalidated: false,
  };
}

/** The metadata entry to persist after a turn that received an id. */
export function withServerConversation(
  metadata: unknown,
  id: string,
  signature: string,
  now: number,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  base[SERVER_CONVERSATION_KEY] = { id, signature, storedAt: now } satisfies StoredServerConversation;
  return base;
}

/** The metadata entry to persist when the stored one was invalidated. */
export function withoutServerConversation(metadata: unknown): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  delete base[SERVER_CONVERSATION_KEY];
  return base;
}
