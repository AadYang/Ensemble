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

import { unknownCapability, type ConsideredRung, type ResolvedCapability } from "./types.js";

export const SERVER_CONVERSATION_KEY = "serverConversation";

/** Where a REJECTION of server-side continuation is remembered, per provider.
 *
 *  A capability verdict, not a setting — and it expires for the same reason the
 *  transport probe's verdict does: an endpoint that refused `previous_response_id`
 *  today may be a gateway mid-upgrade, a rotated organization setting
 *  ("store: false" enforced) or a fixed bug, and a verdict written once and kept
 *  forever would turn a temporary condition into a permanent downgrade nobody can
 *  clear from the UI. 24h is the transport probe's contract, kept identical so
 *  the two caches cannot tell different stories about the same endpoint. */
export const SERVER_CONVERSATION_REJECTED_KEY = "serverConversationRejected";
export const SERVER_CONVERSATION_REJECTION_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredServerConversationRejection {
  /** What the endpoint said, verbatim where we had it. */
  reason: string;
  httpStatus: number | null;
  upstreamCode: string | null;
  /** ISO timestamp of the failed continuation. */
  at: string;
  /** ISO timestamp after which the verdict is stale and the route may be tried
   *  again. Never a validity input for the id itself — the id was already
   *  discarded when this was written. */
  until: string;
}

/** The official OpenAI endpoint, by host.
 *
 *  The provider KIND is not enough on its own: `openai-local` providers carry a
 *  baseUrl, and a kind is a label a user can point anywhere. Scheme + host are
 *  checked, the path is not — a gateway serving the API under `/openai/v1` is
 *  still api.openai.com. A value that does not parse as a URL is NOT the official
 *  endpoint: "we could not read it" is not "it is OpenAI". */
export function isOfficialOpenAIEndpoint(baseUrl: string | null | undefined): boolean {
  const trimmed = (baseUrl ?? "").trim();
  if (trimmed === "") return false;
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

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

/** The rejection this endpoint last gave us, while it is still fresh. */
export function readServerConversationRejection(
  metadata: unknown,
  now: Date = new Date(),
): StoredServerConversationRejection | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[SERVER_CONVERSATION_REJECTED_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { reason, httpStatus, upstreamCode, at, until } = raw as Record<string, unknown>;
  if (typeof reason !== "string" || typeof at !== "string" || typeof until !== "string") return null;
  const expiry = Date.parse(until);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) return null;
  return {
    reason,
    httpStatus: typeof httpStatus === "number" ? httpStatus : null,
    upstreamCode: typeof upstreamCode === "string" ? upstreamCode : null,
    at,
    until,
  };
}

/** Record that the endpoint REJECTED a continuation, so the next turn stops
 *  claiming one. The stored id is cleared by the caller in the same breath —
 *  a rejection means the id is unusable, and keeping it would make the next turn
 *  fail the same way. */
export function withServerConversationRejection(
  metadata: unknown,
  rejection: { reason: string; httpStatus: number | null; upstreamCode: string | null },
  now: Date = new Date(),
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
  const entry: StoredServerConversationRejection = {
    reason: rejection.reason,
    httpStatus: rejection.httpStatus,
    upstreamCode: rejection.upstreamCode,
    at: now.toISOString(),
    until: new Date(now.getTime() + SERVER_CONVERSATION_REJECTION_TTL_MS).toISOString(),
  };
  base[SERVER_CONVERSATION_REJECTED_KEY] = entry;
  delete base[SERVER_CONVERSATION_KEY];
  return base;
}

export interface ServerConversationSupportInput {
  /** The plan's runtime scope id (`openai` for the in-process HTTP runtime). */
  runtime: string;
  /** The transport this turn's route RESOLVED to, from the plan. */
  transport: string;
  /** The provider row's base URL, exactly as configured. */
  baseUrl: string | null;
  /** The provider row's metadata, where a fresh rejection is remembered. */
  providerMetadata: unknown;
  now?: Date;
}

/** Whether this route has been ESTABLISHED as able to continue a conversation
 *  the server stored.
 *
 *  What earns the claim: the route is the in-process OpenAI runtime over the
 *  Responses API, pointed at the official OpenAI endpoint (by host, not by the
 *  provider's kind label), and no fresh rejection is on record.
 *
 *  What does not: a compat endpoint that merely answers `/responses`. It may
 *  accept the parameter and ignore it, which would send a delta against a
 *  conversation the server never stored — the transcript disappears with no
 *  error to show for it. `/responses` being present is evidence about a ROUTE,
 *  not about `store`/`previous_response_id` semantics, so those endpoints keep
 *  `local-rebuild` and say why. A rejection from the official endpoint is
 *  recorded and expires rather than becoming a permanent downgrade. */
export function serverConversationSupportFact(
  input: ServerConversationSupportInput,
): ResolvedCapability<boolean> {
  const now = input.now ?? new Date();
  const considered: ConsideredRung[] = [];
  if (input.runtime !== "openai") {
    return unknownCapability<boolean>(
      `runtime "${input.runtime}" does not issue a server-side conversation id to Ensemble`,
      [
        {
          origin: "provider-discovered",
          outcome: "absent",
          reason: "only the in-process OpenAI Responses runtime has a server that stores the conversation",
        },
      ],
    );
  }
  if (input.transport !== "responses") {
    return unknownCapability<boolean>(
      `this turn's route resolves to "${input.transport}", and only the Responses API carries a server-side conversation`,
      [
        {
          origin: "provider-discovered",
          outcome: "absent",
          reason: "chat-completions carries no response id, so there is nothing to continue",
        },
      ],
    );
  }
  const rejection = readServerConversationRejection(input.providerMetadata, now);
  if (rejection) {
    return {
      value: false,
      origin: "provider-discovered",
      confidence: "observed",
      source:
        `this endpoint rejected a previous_response_id at ${rejection.at} ` +
        `(${rejection.reason}); the verdict expires ${rejection.until}`,
      considered: [
        {
          origin: "provider-discovered",
          outcome: "rejected",
          reason: `the endpoint refused a continuation (${rejection.httpStatus ?? "no status"}${rejection.upstreamCode ? ` ${rejection.upstreamCode}` : ""})`,
        },
      ],
    };
  }
  if (!isOfficialOpenAIEndpoint(input.baseUrl)) {
    return unknownCapability<boolean>(
      "this endpoint answers /responses, but nothing has established that it STORES responses " +
        "or honours previous_response_id; a partial implementation would drop the transcript silently, " +
        "so the transcript is rebuilt locally until that is verified",
      [
        {
          origin: "provider-discovered",
          outcome: "absent",
          reason: "the base URL is not api.openai.com, so the official endpoint's continuation semantics are not established",
        },
      ],
    );
  }
  considered.push({
    origin: "provider-discovered",
    outcome: "used",
    reason: "the provider is pointed at api.openai.com over the Responses API, which stores responses and accepts previous_response_id",
  });
  return {
    value: true,
    origin: "provider-discovered",
    confidence: "observed",
    source:
      "the Responses API on api.openai.com stores each response and accepts previous_response_id, " +
      "so a continuation id issued by it can be reused while the turn's signature is unchanged",
    considered,
  };
}
