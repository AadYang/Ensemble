// Phase 1: telling "this endpoint has no such route" apart from every other way
// an HTTP call can fail.
//
// The whole point of this module is that a transport switch is a CAPABILITY
// conclusion, and only a capability conclusion may move a turn onto another
// route. Authentication, quota, rate limiting, network weather and ordinary
// request semantics are not conclusions about what the endpoint speaks — a 401
// says the key is wrong, not that /responses does not exist, and a 400 that
// echoes our own malformed body says the OPPOSITE of "unsupported" (the route
// answered us).
//
// So this classifier reads STRUCTURED fields only — HTTP status, and the
// upstream's own `code`/`type` — and never matches on prose. Text matching is
// how "404 tokens not found in your account balance" becomes a transport
// fallback, and how a working endpoint gets declared unsupported by a wording
// change upstream.

import type { RunPlanTransport } from "./types.js";

export type TransportErrorClass =
  /** The endpoint explicitly said the route/transport does not exist. The ONLY
   *  class that may move an `auto` turn to its fallback transport. */
  | "unsupported"
  | "auth"
  | "rate-limit"
  | "network"
  | "server"
  | "request"
  | "unknown";

/** Upstream codes that name the ENDPOINT, not the request. Deliberately short:
 *  a code earns its place here only by saying "this route is not implemented",
 *  and adding a colloquial one silently widens the fallback path. */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  "unsupported_endpoint",
  "unsupported_transport",
  "endpoint_not_found",
  "not_implemented",
  "no_such_route",
]);


export interface ClassifiedTransportError {
  classification: TransportErrorClass;
  /** HTTP status, when the failure carried one. `null` for a connection error. */
  httpStatus: number | null;
  /** The upstream's structured error code (`error.code`, `error.error.code`). */
  upstreamCode: string | null;
  /** The upstream's structured error type. */
  upstreamType: string | null;
  /** Human-readable message — for the log and the UI, never for classification. */
  message: string;
}

interface ErrorShape {
  status?: unknown;
  code?: unknown;
  type?: unknown;
  message?: unknown;
  error?: unknown;
  cause?: unknown;
  name?: unknown;
}

function asRecord(value: unknown): ErrorShape | null {
  return value !== null && typeof value === "object" ? (value as ErrorShape) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Walk the error and its `cause` chain for the first structured HTTP status.
 *
 *  The chain matters because the SDK wraps provider failures: @openai/agents
 *  raises its own error with the provider's `APIError` underneath, and the
 *  status lives on the inner one. Reading only the outer message is exactly the
 *  degradation this module exists to prevent. */
function findStatus(err: unknown): number | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur != null; depth++) {
    const rec = asRecord(cur);
    if (!rec) break;
    const status = num(rec.status);
    if (status !== null) return status;
    cur = rec.cause;
  }
  return null;
}

/** The upstream's structured code/type. `code` first (it is the more specific
 *  of the two), then the nested `error` object both OpenAI and its clones use. */
function findCodeAndType(err: unknown): { code: string | null; type: string | null } {
  let code: string | null = null;
  let type: string | null = null;
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur != null; depth++) {
    const rec = asRecord(cur);
    if (!rec) break;
    const inner = asRecord(rec.error);
    const candidates: ErrorShape[] = [rec, ...(inner ? [inner] : [])];
    for (const c of candidates) {
      code ??= str(c.code);
      type ??= str(c.type);
    }
    cur = rec.cause;
  }
  return { code, type };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  const rec = asRecord(err);
  return str(rec?.message) ?? String(err);
}

/** Classify a failed model request.
 *
 *  THE STATUS DECIDES FIRST. Auth, quota and server failures outrank any error
 *  code, so no vendor string can demote "your key was rejected" or "you are
 *  rate limited" into a capability conclusion — an endpoint that answers 401
 *  with `unsupported_endpoint` is telling us about the key, and switching
 *  transports would hide a real, fixable problem behind a route change.
 *
 *  401 / 403 ........................... auth
 *  429 ................................. rate-limit
 *  405 / 501 ........................... unsupported (the method/route is not there)
 *  >= 500 (504, 502, …) ................ server
 *  an explicit unsupported code ........ unsupported (the vendor named the route)
 *  404 without a structured code ........ unsupported (the plainest "no such route")
 *  404 naming a model/resource .......... request (the route answered about it)
 *  any other status (400, 422, …) ...... request — the route ANSWERED us
 *  no status at all .................... network
 *
 *  Only `unsupported` may trigger a fallback; every other class is surfaced as
 *  a structured error and leaves the turn on the transport it started on. */
export function classifyTransportError(err: unknown): ClassifiedTransportError {
  const status = findStatus(err);
  const { code, type } = findCodeAndType(err);
  const message = messageOf(err);
  const lower = code === null ? null : code.toLowerCase();

  let classification: TransportErrorClass;
  if (status === 401 || status === 403) {
    classification = "auth";
  } else if (status === 429) {
    classification = "rate-limit";
  } else if (status === 405 || status === 501) {
    // Deeper than the "server" bucket they numerically belong to: these two
    // statuses NAME the route ("this method is not allowed here", "not
    // implemented") instead of describing the server's health.
    classification = "unsupported";
  } else if (status !== null && status >= 500) {
    classification = "server";
  } else if (lower !== null && UNSUPPORTED_CODES.has(lower)) {
    classification = "unsupported";
  } else if (status === 404) {
    // A 404 with a structured code we do not recognise is NOT read as "the route
    // is missing". Vendors use 404 for things the route answered about
    // (`model_not_found`, `resource_not_found`), and a gateway that validates the
    // model before the path returns exactly that for every unknown URL — so
    // treating it as a capability conclusion would strand an `auto` turn on a
    // transport that works, and hide the real error. Only a bare 404 (nothing
    // structured), or one that names a route (the unsupported codes above), says
    // anything about the endpoint. A missed fallback is recoverable; a wrong one
    // is silent.
    classification = lower === null ? "unsupported" : "request";
  } else if (status !== null) {
    classification = "request";
  } else {
    classification = "network";
  }

  return { classification, httpStatus: status, upstreamCode: code, upstreamType: type, message };
}

/** The alternative transport a permitted switch would use. `null` when the
 *  transport is not one of the two HTTP routes (a native CLI has no sibling,
 *  and `unknown` is not something to switch away from). */
export function siblingTransport(transport: RunPlanTransport): RunPlanTransport | null {
  if (transport === "responses") return "chat-completions";
  if (transport === "chat-completions") return "responses";
  return null;
}

/** A one-line, UI-safe description of why an attempt failed. Built from the
 *  structured fields, so the reason shown is the reason that decided it. */
export function describeTransportError(c: ClassifiedTransportError): string {
  const parts: string[] = [c.classification];
  if (c.httpStatus !== null) parts.push(`HTTP ${c.httpStatus}`);
  if (c.upstreamCode !== null) parts.push(`code=${c.upstreamCode}`);
  if (c.upstreamType !== null) parts.push(`type=${c.upstreamType}`);
  return `${parts.join(" ")} — ${c.message}`;
}
