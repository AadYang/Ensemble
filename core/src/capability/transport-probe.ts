// Phase 1: the one place that asks a compat endpoint what it speaks.
//
// Two rules drive the design.
//
// LAZY, NOT ON SAVE. Saving a provider must never depend on the network: a user
// configuring a base URL behind a VPN, or offline, gets their provider saved.
// The question is asked at the first turn that actually needs the answer.
//
// A CAPABILITY VERDICT EXPIRES; A NETWORK FAILURE IS NOT A VERDICT. A supported
// or unsupported answer is cached for 24h, per provider identity + normalized
// base URL. 401/403, 429, 5xx, and connection/timeout failures are recorded as
// inconclusive and cached NOWHERE: they say nothing about the route, and writing
// them would turn "the key was rotated" into "this endpoint has no /responses"
// for the next day.
//
// The probe asks the RESPONSES route only. Chat Completions is the compat
// baseline — an endpoint that lacks it fails loudly on the real request — so the
// only useful question is whether the better transport is there.

import { prisma } from "../db.js";
import { classifyTransportError, type ClassifiedTransportError } from "./transport-errors.js";
import type { RunPlanTransport } from "./types.js";

/** How long a capability verdict stands. 24h is the stated contract: long
 *  enough to stop re-probing on every turn, short enough that a gateway upgrade
 *  is noticed the next day. */
export const TRANSPORT_PROBE_TTL_MS = 24 * 60 * 60 * 1000;

/** AppSetting key holding every endpoint's last verdict. One row, keyed inside
 *  the JSON by provider identity + normalized base URL — a row per endpoint
 *  would be a migration-shaped decision for data that is a cache. */
export const TRANSPORT_PROBE_SETTING_KEY = "capability.transport.probe.v1";

export type TransportProbeOutcome = "supported" | "unsupported" | "inconclusive";

export interface TransportProbeEntry {
  /** Stable provider row id. Two providers can share a base URL, and one
   *  provider can be repointed — neither may inherit the other's verdict. */
  providerId: string;
  /** Normalized base URL (`normalizeBaseUrlKey`) — the same endpoint written two
   *  ways is one endpoint. */
  baseUrl: string;
  /** The transport the verdict is about. Only "responses" is probed today; the
   *  field is explicit so a future chat-completions probe cannot be mistaken for
   *  this one. */
  transport: RunPlanTransport;
  outcome: TransportProbeOutcome;
  /** HTTP status seen, when there was one. */
  httpStatus: number | null;
  upstreamCode: string | null;
  upstreamType: string | null;
  detail: string;
  /** ISO timestamp of the probe. */
  probedAt: string;
  /** How the answer was obtained, so a verdict can be audited. */
  method: "responses-route-probe";
}

export interface TransportProbeStore {
  read(): TransportProbeEntry[];
  write(entries: TransportProbeEntry[]): void;
}

/** `https://API.DeepSeek.com/v1/` and `https://api.deepseek.com/v1` are the same
 *  endpoint. Scheme + host are lowercased, a default port is dropped, trailing
 *  slashes are removed. The path is KEPT: a gateway commonly serves
 *  `/openai/v1/responses` rather than `/v1/responses`. */
export function normalizeBaseUrlKey(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed);
    const defaultPort =
      (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80");
    const port = url.port && !defaultPort ? `:${url.port}` : "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** Cache key for one endpoint's verdict. Exported so tests and the UI-facing
 *  code agree with the writer about what "the same endpoint" means. */
export function transportProbeKey(providerId: string, baseUrl: string): string {
  return `${providerId}::${normalizeBaseUrlKey(baseUrl)}`;
}

function isEntry(value: unknown): value is TransportProbeEntry {
  if (value === null || typeof value !== "object") return false;
  const e = value as Partial<TransportProbeEntry>;
  return (
    typeof e.providerId === "string" &&
    typeof e.baseUrl === "string" &&
    typeof e.transport === "string" &&
    typeof e.outcome === "string" &&
    typeof e.probedAt === "string"
  );
}

const appSettingStore: TransportProbeStore = {
  read(): TransportProbeEntry[] {
    const row = prisma.appSetting.findUnique({ where: { key: TRANSPORT_PROBE_SETTING_KEY } });
    if (!row || !Array.isArray(row.value)) return [];
    return row.value.filter(isEntry);
  },
  write(entries: TransportProbeEntry[]): void {
    const existing = prisma.appSetting.findUnique({ where: { key: TRANSPORT_PROBE_SETTING_KEY } });
    if (existing) {
      prisma.appSetting.update({ where: { key: TRANSPORT_PROBE_SETTING_KEY }, data: { value: entries } });
      return;
    }
    prisma.appSetting.create({ data: { key: TRANSPORT_PROBE_SETTING_KEY, value: entries } });
  },
};

/** The cached verdict for this endpoint, or null when there is none or it has
 *  aged out. Only conclusive verdicts are ever stored, so a stale check is the
 *  whole staleness rule. */
export function readCachedProbe(
  providerId: string,
  baseUrl: string,
  now: Date,
  store: TransportProbeStore = appSettingStore,
): TransportProbeEntry | null {
  const key = transportProbeKey(providerId, baseUrl);
  const entry = store.read().find((e) => transportProbeKey(e.providerId, e.baseUrl) === key);
  if (!entry) return null;
  if (entry.outcome === "inconclusive") return null;
  const age = now.getTime() - new Date(entry.probedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > TRANSPORT_PROBE_TTL_MS) return null;
  return entry;
}

/** Persist a verdict, replacing this endpoint's previous one.
 *
 *  `inconclusive` is NOT written — deliberately, not by omission. See the module
 *  header: it is not a capability conclusion, and caching it would let a
 *  ten-second outage decide the next day's transport. */
export function writeProbe(
  entry: TransportProbeEntry,
  store: TransportProbeStore = appSettingStore,
): void {
  if (entry.outcome === "inconclusive") return;
  const key = transportProbeKey(entry.providerId, entry.baseUrl);
  const others = store.read().filter((e) => transportProbeKey(e.providerId, e.baseUrl) !== key);
  // Newest last; the reader is indifferent to order, but a stable file is
  // easier to audit by hand than one that reorders on every write.
  store.write([...others, { ...entry, baseUrl: normalizeBaseUrlKey(entry.baseUrl) }]);
}

export interface ProbeResponsesOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Abort window. A probe must never be the reason a turn hangs. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Abort window for the whole probe. Short on purpose.
 *
 *  A probe that gives up early loses NOTHING: "inconclusive" is not a verdict,
 *  the turn then runs on the compat baseline, and an `auto` turn that the
 *  endpoint rejects is switched by the runtime on the endpoint's own answer —
 *  which is a far better authority than a slow connect. What a long window WOULD
 *  cost is real: an unreachable base URL (VPN down, DNS blackholed) would park
 *  the user's first message for the full window before the same request is sent
 *  anyway. */
const PROBE_TIMEOUT_MS = 2_500;

/** Ask the endpoint whether `/responses` exists.
 *
 *  A POST against the real model with a one-token cap, because a request the
 *  route can ANSWER is the only unambiguous evidence: a 400 that rejects our
 *  body still proves the route is there, while a bare 404 proves it is not.
 *
 *  ONE DECISION. The response goes through `classifyTransportError` (the same
 *  classifier the runtime uses) and the probe's verdict is DERIVED from that
 *  single classification. Two independent readings of one response — a status
 *  table here, a body table there — is how a 400 naming an unsupported endpoint
 *  ends up classified `unsupported` while the cache records "supported" for the
 *  next 24 hours. */
export async function probeResponsesRoute(opts: ProbeResponsesOptions): Promise<{
  outcome: TransportProbeOutcome;
  classified: ClassifiedTransportError;
}> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/responses`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      // The plainest valid Responses body there is: a string input and a
      // one-token cap. A rejection here still proves the route exists, which is
      // the only question being asked.
      body: JSON.stringify({
        model: opts.model,
        input: "ping",
        max_output_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    const body = await res.text().catch(() => "");
    // An ok response is drained, and says nothing structured about the route
    // beyond "it answered" — so it is classified as a request that came back.
    const fields = structuredFields(body);
    const classified: ClassifiedTransportError = res.ok
      ? {
          classification: "request",
          httpStatus: res.status,
          upstreamCode: null,
          upstreamType: null,
          message: `the endpoint answered /responses with HTTP ${res.status}`,
        }
      : classifyTransportError({
          status: res.status,
          code: fields.code,
          type: fields.type,
          message: fields.message ?? `the endpoint answered /responses with HTTP ${res.status}`,
        });
    return { outcome: outcomeFor(classified), classified };
  } catch (err) {
    // Connection refused, DNS, TLS, or our own abort: weather, never a verdict.
    const classified = classifyTransportError(err);
    return { outcome: outcomeFor(classified), classified };
  } finally {
    clearTimeout(timer);
  }
}

/** The structured fields an error body carries, in the shape the shared
 *  classifier reads. Prose is deliberately NOT extracted: a message is for the
 *  log, and the classifier must not see it. */
function structuredFields(body: string): {
  code: string | null;
  type: string | null;
  message: string | null;
} {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const inner = (parsed.error ?? parsed) as Record<string, unknown>;
    return {
      code: typeof inner.code === "string" ? inner.code : null,
      type: typeof inner.type === "string" ? inner.type : null,
      message: typeof inner.message === "string" ? inner.message : null,
    };
  } catch {
    // Not JSON — an HTML error page says nothing structured, so nothing is read
    // from it. The status alone decides.
    return { code: null, type: null, message: null };
  }
}

/** Classified failure → capability verdict, for the PROBE only.
 *
 *  `unsupported` is the only classification that establishes a fact about the
 *  route, and it is cached. Everything the classifier calls auth / rate-limit /
 *  server / network is weather and stays inconclusive. A `request` failure means
 *  the route heard us and rejected the body — that is the route existing, which
 *  is the question — EXCEPT for a 404 that named a model or resource: the
 *  classifier leaves that as `request` because it is not a capability
 *  conclusion, and a probe must not turn it into the positive one either. */
function outcomeFor(classified: ClassifiedTransportError): TransportProbeOutcome {
  if (classified.classification === "unsupported") return "unsupported";
  if (classified.classification !== "request") return "inconclusive";
  if (classified.httpStatus === 404) return "inconclusive";
  return "supported";
}

/** How long a FAILED attempt is remembered so it is not repeated immediately.
 *
 *  This is a retry throttle, NOT a cached verdict: it holds no conclusion about
 *  the endpoint, it is process-local, and it expires in a minute. Without it, an
 *  endpoint that is merely unreachable would be asked again on every single
 *  turn — the probe's timeout added to each one — while the spec's "do not write
 *  a negative cache" rule (correctly) keeps the failure out of AppSetting. */
const INCONCLUSIVE_RETRY_MS = 60_000;
const lastAttemptAt = new Map<string, number>();

export interface EnsureTransportFactOptions {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  store?: TransportProbeStore;
}

/** The lazy entry point used by the turn: return the cached verdict, or probe
 *  once and cache a conclusive result. Never throws — a failed probe is an
 *  inconclusive result, and an inconclusive result simply leaves the transport
 *  fact unknown for this turn. */
export async function ensureResponsesProbeFact(
  opts: EnsureTransportFactOptions,
): Promise<TransportProbeEntry | null> {
  const now = opts.now ?? (() => new Date());
  const cached = readCachedProbe(opts.providerId, opts.baseUrl, now(), opts.store);
  if (cached) return cached;

  const key = transportProbeKey(opts.providerId, opts.baseUrl);
  const previousAttempt = lastAttemptAt.get(key);
  if (previousAttempt !== undefined && now().getTime() - previousAttempt < INCONCLUSIVE_RETRY_MS) {
    return null;
  }
  lastAttemptAt.set(key, now().getTime());

  const { outcome, classified } = await probeResponsesRoute({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    fetchImpl: opts.fetchImpl,
  });
  const entry: TransportProbeEntry = {
    providerId: opts.providerId,
    baseUrl: normalizeBaseUrlKey(opts.baseUrl),
    transport: "responses",
    outcome,
    httpStatus: classified.httpStatus,
    upstreamCode: classified.upstreamCode,
    upstreamType: classified.upstreamType,
    detail: probeDetail(outcome, classified),
    probedAt: now().toISOString(),
    method: "responses-route-probe",
  };
  writeProbe(entry, opts.store);
  return entry;
}

function probeDetail(outcome: TransportProbeOutcome, c: ClassifiedTransportError): string {
  const status = c.httpStatus === null ? "no HTTP status" : `HTTP ${c.httpStatus}`;
  const code = c.upstreamCode ? ` code=${c.upstreamCode}` : "";
  switch (outcome) {
    case "supported":
      return `the endpoint answered /responses (${status}${code}), so Responses is available`;
    case "unsupported":
      return `the endpoint rejected /responses as a route (${status}${code})`;
    case "inconclusive":
      return `${status}${code} is not a capability verdict; no transport fact was recorded`;
  }
}
