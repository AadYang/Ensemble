import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { PACKAGED, WEB_ROOT, webRootExists } from "./paths.js";
import type {
  ClientMsg,
  LayoutNode,
  LayoutWindow,
  LayoutWorkspace,
  ServerMsg,
} from "@agentorch/shared";
import { WSHub } from "./ws/hub.js";
import { agentRowToSummary, SessionManager } from "./sessions/SessionManager.js";
import { prisma, closeDb, sqliteDb } from "./db.js";
import { createHash } from "node:crypto";
import {
  SUBAGENT_CATALOG,
  getCatalogEntry,
  inflateSystemPrompt,
  staticFallbackPicks,
} from "./subagent-catalog.js";
import { buildSuggestPrompt, extractJsonPicks } from "./subagent-suggest.js";
import { aggregateUsage } from "./usage-aggregate.js";
import {
  computeCost,
  deletePricingOverride,
  loadBuiltInPricingTable,
  loadPricingOverrides,
  loadPricingTable,
  pricingOverridesPath,
  savePricingOverride,
  type ModelPricing,
} from "./pricing.js";
import { execFileSync } from "node:child_process";
import { mountMcpBridge, setBridgePort } from "./mcp-bridge.js";
import { startTelemetry } from "./telemetry.js";
import { getCliSettingsHealth, getCodexCliPath, setManualCliPath } from "./cli-config.js";
import { runCodexStdioMcp } from "./codex-stdio-mcp.js";
import { currentPlatformKey } from "./platform-key.js";
import type { PlatformKey } from "@agentorch/shared";
import {
  deepSeekOfficialModelsFallback,
  probeModels,
  type ProbeFlavor,
} from "./providers/model-discovery.js";
import { DEFAULT_ANTHROPIC_MODELS } from "./providers/default-models.js";

// When ENSEMBLE_AUTO_PORT=1 (set by Tauri shell), listen on a random free port
// and announce it on stdout's first line as `ENSEMBLE_LISTENING <port>`. The
// shell parses that line to inject `window.__ENSEMBLE_PORT__` into the WebView.
// Otherwise honor WS_PORT or default to 3001 (standalone / dev path).
const AUTO_PORT = process.env.ENSEMBLE_AUTO_PORT === "1";
const PORT = AUTO_PORT ? 0 : Number(process.env.WS_PORT ?? 3001);
const CODEX_DEFAULT_SANDBOX = "danger-full-access" as const;

if (process.argv[2] === "codex-stdio-mcp") {
  void runCodexStdioMcp().catch((err) => {
    console.error(`[codex-stdio-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
} else {

// Bundled (SEA) mode skips pino-pretty: its transport spawns a worker thread
// by file path which doesn't survive single-file packaging. Dev keeps pretty logs.
const PRETTY = !PACKAGED && process.stdout.isTTY;
// In AUTO_PORT mode (under Tauri), reserve stdout for the ENSEMBLE_LISTENING
// protocol line — pino goes to stderr so the shell only ever reads our tokens.
const fastify = Fastify({
  logger: PRETTY
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", destination: 2 } } }
    : { level: "info", stream: AUTO_PORT ? process.stderr : process.stdout },
});

fastify.register(websocket);

const hub = new WSHub();
const sessions = new SessionManager(hub);
mountMcpBridge(fastify, {
  getFallbackHandlers: (agentId) => ({
    peerSend: ({ target, message, mode, includeSource, interrupt, interruptReason }) =>
      sessions.sendPeerMessage(agentId, target, message, mode, { includeSource, interrupt, interruptReason }),
    peerQuery: ({ target, limit }) => sessions.fetchPeerHistory(agentId, target, limit),
  }),
});

const PermissionDecisionSchema = z.discriminatedUnion("behavior", [
  z.object({
    behavior: z.literal("allow"),
    updatedInput: z.unknown().optional(),
    message: z.string().optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    message: z.string().optional(),
  }),
]);

const ClientMsgSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_agent"),
    name: z.string().min(1),
    systemPrompt: z.string().optional(),
    model: z.string().optional(),
    parentId: z.string().uuid().optional(),
    providerId: z.string().uuid().optional(),
    codexWorkspace: z.string().optional(),
    teamId: z.string().uuid().nullable().optional(),
  }),
  z.object({ type: z.literal("send_message"), sessionId: z.string().uuid(), text: z.string().min(1) }),
  z.object({
    type: z.literal("peer_send"),
    fromSessionId: z.string().uuid(),
    targetSessionId: z.string().uuid(),
    text: z.string().min(1),
    mode: z.enum(["continue", "review", "fork", "raw"]),
    includeSource: z.union([z.boolean(), z.literal("auto")]).optional(),
    interrupt: z.boolean().optional(),
    interruptReason: z.string().optional(),
  }),
  z.object({ type: z.literal("cancel"), sessionId: z.string().uuid() }),
  z.object({ type: z.literal("subscribe"), sessionId: z.string().uuid() }),
  z.object({ type: z.literal("unsubscribe"), sessionId: z.string().uuid() }),
  z.object({
    type: z.literal("permission_response"),
    sessionId: z.string().uuid(),
    reqId: z.string().uuid(),
    decision: PermissionDecisionSchema,
  }),
  z.object({
    type: z.literal("user_answer"),
    sessionId: z.string().uuid(),
    reqId: z.string().uuid(),
    choice: z.string().min(1),
  }),
]);

// Strip `/api/` prefix before routing so the same route handlers serve both:
//   - dev: next.js rewrites `/api/foo` → server `/foo` (already stripped)
//   - packaged: browser hits the EXE directly at `/api/foo` (we strip here)
// `/ws` and static assets (`/_next/*`, `/favicon.ico`, `/`) don't carry the
// prefix and are untouched. Mark stripped requests so the SPA fallback can
// still distinguish them. NOTE: must hook the underlying http.Server (via
// `prependListener('request')`) — Fastify's `onRequest` fires AFTER routing.
fastify.server.prependListener("request", (req) => {
  if (req.url && req.url.startsWith("/api/")) {
    (req as { _wasApi?: boolean })._wasApi = true;
    req.url = req.url.slice(4);
  }
});

fastify.get("/health", async () => ({ ok: true, time: new Date().toISOString(), wsClients: hub.size() }));

// MCP 2025-06 spec says HTTP MCP clients (codex CLI 0.130 included) probe a
// handful of OAuth 2.0 discovery endpoints when first attaching to a server,
// per RFC 9728 (OAuth 2.0 Protected Resource Metadata) and RFC 8414 (OAuth
// 2.0 Authorization Server Metadata):
//
//   GET /.well-known/oauth-authorization-server[/<rest>]
//   GET /.well-known/oauth-protected-resource[/<rest>]
//   GET <mcp-path>/.well-known/oauth-authorization-server
//
// The client treats:
//   - 404 → "no OAuth metadata published, treat as no-auth"  ← what we want
//   - 200 + invalid JSON → "metadata exists but malformed, REFUSE to connect"
//
// Our setup hit the second case: fastify-static's SPA fallback served
// index.html for these paths, so codex saw `<!doctype html>...`, gave up on
// tool discovery, and never called tools/list. peer_send/peer_query never
// reached the model's tool list. Catch these paths FIRST and return a clean
// JSON 404 with no SPA fallback.
// Update from 0.0.8: 404 alone wasn't enough — codex 0.130 also skips
// servers without valid metadata. Return a minimal-public PRM/ASM JSON.
function publicResourceMetadata(host: string): Record<string, unknown> {
  return {
    resource: `http://${host}/api/mcp/internal`,
    authorization_servers: [],
    bearer_methods_supported: [],
  };
}
function publicAuthServerMetadata(host: string): Record<string, unknown> {
  return {
    issuer: `http://${host}`,
    authorization_endpoint: `http://${host}/.well-known/no-auth`,
    token_endpoint: `http://${host}/.well-known/no-auth`,
    response_types_supported: [],
    grant_types_supported: [],
    token_endpoint_auth_methods_supported: ["none"],
  };
}
fastify.get("/.well-known/oauth-protected-resource", async (req, reply) => {
  reply.send(publicResourceMetadata(String(req.headers.host)));
});
fastify.get("/.well-known/oauth-protected-resource/*", async (req, reply) => {
  reply.send(publicResourceMetadata(String(req.headers.host)));
});
fastify.get("/.well-known/oauth-authorization-server", async (req, reply) => {
  reply.send(publicAuthServerMetadata(String(req.headers.host)));
});
fastify.get("/.well-known/oauth-authorization-server/*", async (req, reply) => {
  reply.send(publicAuthServerMetadata(String(req.headers.host)));
});
fastify.get("/mcp/internal/.well-known/oauth-authorization-server", async (req, reply) => {
  reply.send(publicAuthServerMetadata(String(req.headers.host)));
});
fastify.get("/mcp/internal/.well-known/oauth-protected-resource", async (req, reply) => {
  reply.send(publicResourceMetadata(String(req.headers.host)));
});

// Belt-and-suspenders: when an uncaught handler error reaches the framework,
// Fastify's default returns raw JSON ({"statusCode":500,...}). If a stray
// navigation in the Tauri webview lands on an API path that 500s, that JSON
// gets rendered as a fullscreen plaintext page — the user-reported
// "white-bg black-text covers the whole window" bug. By keying off
// Accept: text/html we keep API JSON for fetch() callers AND give browsers
// a small dark-themed page that at least includes a way to go home.
fastify.setErrorHandler((err, req, reply) => {
  const accept = req.headers["accept"] ?? "";
  const wantsHtml = accept.includes("text/html");
  req.log.error({ err, url: req.url }, "uncaught handler error");
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (wantsHtml) {
    reply.code(status).type("text/html").send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Ensemble</title>
<style>html,body{margin:0;height:100%;background:#0a0e14;color:#e6f0f7;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
display:flex;align-items:center;justify-content:center}
main{text-align:center;max-width:480px;padding:2rem}
h1{color:#00d9ff;margin:0 0 .8rem;letter-spacing:.04em}
p{color:#93a3b3;margin:.4rem 0}
a{color:#00d9ff;text-decoration:none}
code{color:#7c9c5e;font-family:monospace}</style></head>
<body><main>
<h1>Service hiccup · ${status}</h1>
<p>Ensemble's local service returned an error.</p>
<p><code>${String(req.url).replace(/[<>]/g, "")}</code></p>
<p><a href="/">← back to app</a></p>
</main></body></html>`,
    );
    return;
  }
  const errMsg = err instanceof Error ? err.message : String(err);
  reply.code(status).send({ error: "internal_error", message: errMsg });
});

const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pane"), id: z.string(), agentId: z.string().nullable() }),
    z.object({
      kind: z.literal("split"),
      id: z.string(),
      dir: z.union([z.literal("h"), z.literal("v")]),
      ratio: z.number().min(0).max(1),
      a: LayoutNodeSchema,
      b: LayoutNodeSchema,
    }),
  ]),
);

const LayoutWindowSchema: z.ZodType<LayoutWindow> = z.object({
  id: z.string(),
  name: z.string(),
  root: LayoutNodeSchema,
  activePaneId: z.string(),
});

const LayoutWorkspaceSchema: z.ZodType<LayoutWorkspace> = z.object({
  windows: z.array(LayoutWindowSchema).min(1),
  activeWindowId: z.string(),
});

const PutWorkspaceSchema = z.object({ layout: LayoutWorkspaceSchema });

const findFirstLeafId = (node: LayoutNode): string =>
  node.kind === "pane" ? node.id : findFirstLeafId(node.a);

const newDefaultWorkspace = (): LayoutWorkspace => {
  const root: LayoutNode = { kind: "pane", id: "p-root", agentId: null };
  return {
    windows: [{ id: "w-default", name: "main", root, activePaneId: "p-root" }],
    activeWindowId: "w-default",
  };
};

const normalizeLayout = (raw: unknown): LayoutWorkspace => {
  // Backward-compat with W2.4 rows that stored a raw LayoutNode in `layout`.
  if (raw && typeof raw === "object" && "kind" in (raw as object)) {
    const root = raw as LayoutNode;
    return {
      windows: [{ id: "w-default", name: "main", root, activePaneId: findFirstLeafId(root) }],
      activeWindowId: "w-default",
    };
  }
  return raw as LayoutWorkspace;
};

const ensureAtLeastOneWorkspace = async () => {
  const count = await prisma.workspace.count();
  if (count > 0) return;
  await prisma.workspace.create({
    data: { name: "default", layout: newDefaultWorkspace() as object },
  });
};

fastify.get("/workspaces", async () => {
  await ensureAtLeastOneWorkspace();
  const rows = await prisma.workspace.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
  }));
});

fastify.post("/workspaces", async (req, reply) => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const created = await prisma.workspace.create({
    data: { name: parsed.data.name, layout: newDefaultWorkspace() as object },
  });
  return { id: created.id, name: created.name, layout: created.layout };
});

fastify.get<{ Params: { id: string } }>("/workspaces/:id", async (req, reply) => {
  const ws = await prisma.workspace.findUnique({ where: { id: req.params.id } });
  if (!ws) {
    reply.code(404);
    return { error: "not found" };
  }
  return { id: ws.id, name: ws.name, layout: normalizeLayout(ws.layout) };
});

fastify.put<{ Params: { id: string } }>("/workspaces/:id", async (req, reply) => {
  const parsed = PutWorkspaceSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid layout", detail: parsed.error.issues };
  }
  const updated = await prisma.workspace.update({
    where: { id: req.params.id },
    data: { layout: parsed.data.layout as object },
  });
  return { id: updated.id, layout: updated.layout };
});

fastify.patch<{ Params: { id: string } }>("/workspaces/:id", async (req, reply) => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const updated = await prisma.workspace.update({
    where: { id: req.params.id },
    data: { name: parsed.data.name },
  });
  return { id: updated.id, name: updated.name };
});

fastify.delete<{ Params: { id: string } }>("/workspaces/:id", async (req, reply) => {
  const count = await prisma.workspace.count();
  if (count <= 1) {
    reply.code(400);
    return { error: "cannot delete the last workspace" };
  }
  await prisma.workspace.delete({ where: { id: req.params.id } });
  return { ok: true };
});

// ----- Global app settings -----

fastify.get("/settings/cli", async () => {
  return getCliSettingsHealth();
});

fastify.patch("/settings/cli", async (req, reply) => {
  const parsed = z.object({
    claudePath: z.string().optional().nullable(),
    codexPath: z.string().optional().nullable(),
  }).safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  try {
    if (parsed.data.claudePath !== undefined) {
      await setManualCliPath("claude", parsed.data.claudePath);
    }
    if (parsed.data.codexPath !== undefined) {
      await setManualCliPath("codex", parsed.data.codexPath);
    }
    return getCliSettingsHealth();
  } catch (err) {
    reply.code(400);
    return { error: "invalid_path", message: err instanceof Error ? err.message : String(err) };
  }
});

// ----- Providers (model providers; Claude direct + OpenAI-compat proxies) -----

const PROVIDER_KINDS = [
  "anthropic-local",
  "anthropic",
  "openai-local",
  "openai-codex",
  "openai-compat",
] as const;
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

interface ProviderRuntimeMetadata {
  platformKey: PlatformKey;
  cliPath: string | null;
  cliVersion: string | null;
  cliVersionTooOld?: boolean;
  cliMinSupportedVersion?: string | null;
  authPath: string | null;
  authPresent: boolean;
  models: string[];
  defaultSandbox?: string | null;
  lastHealthAt: string;
  lastError?: string | null;
}

function providerRuntimes(meta: Record<string, unknown>): Partial<Record<PlatformKey, ProviderRuntimeMetadata>> {
  const raw = meta.runtimes;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<Record<PlatformKey, ProviderRuntimeMetadata>>
    : {};
}

function currentProviderRuntime(meta: Record<string, unknown>): ProviderRuntimeMetadata | null {
  const runtime = providerRuntimes(meta)[currentPlatformKey()];
  return runtime && typeof runtime === "object" ? runtime : null;
}

// W20: discover codex models by parsing `codex debug models` JSON catalog
// — the same catalog the codex TUI uses. Filters to api-supported + visible
// rows, sorted by codex's own priority. Returns null if codex CLI missing
// or output unparseable so callers can fall back gracefully (empty list +
// UI banner already nudges the user to install / `codex login`).
async function discoverCodexModels(): Promise<string[] | null> {
  try {
    const codexPath = await getCodexCliPath();
    if (!codexPath) return null;
    const out = execFileSync(codexPath, ["debug", "models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const parsed = JSON.parse(out) as {
      models?: Array<{
        slug?: string;
        visibility?: string;
        supported_in_api?: boolean;
        priority?: number;
      }>;
    };
    if (!Array.isArray(parsed.models)) return null;
    return parsed.models
      .filter((m) => m.visibility === "list" && m.supported_in_api === true && typeof m.slug === "string")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => m.slug as string);
  } catch {
    return null;
  }
}

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const ProviderInputSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: z.string().url().optional().nullable(),
  apiKey: z.string().optional().nullable(),
  isDefault: z.boolean().optional(),
  autoManaged: z.boolean().optional(),
  upstreamProvider: z.string().min(1).optional().nullable(),
  upstreamModel: z.string().min(1).optional().nullable(),
  models: z.array(z.string().min(1)).optional(),
  defaultSandbox: z.enum(SANDBOX_MODES).optional().nullable(),
});

const ProviderPatchSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional().nullable(),
  apiKey: z.string().optional(), // empty string preserves existing; explicit value overwrites
  isDefault: z.boolean().optional(),
  autoManaged: z.boolean().optional(),
  upstreamProvider: z.string().min(1).optional().nullable(),
  upstreamModel: z.string().min(1).optional().nullable(),
  // Manual models override — escape hatch for upstreams whose /v1/models
  // endpoint doesn't list (e.g. MiniMax returns {data: null}).
  models: z.array(z.string().min(1)).optional(),
  defaultSandbox: z.enum(SANDBOX_MODES).optional().nullable(),
});

const sanitizeProvider = (p: {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  apiKey: string | null;
  autoManaged: boolean;
  upstreamProvider: string | null;
  upstreamModel: string | null;
  models: string[];
  isDefault: boolean;
  disabled: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
}) => {
  const meta = p.metadata && typeof p.metadata === "object" ? p.metadata : {};
  const runtime = currentProviderRuntime(meta);
  const isCodex = p.kind === "openai-codex";
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    hasApiKey: p.apiKey !== null && p.apiKey !== "",
    autoManaged: p.autoManaged,
    upstreamProvider: p.upstreamProvider,
    upstreamModel: p.upstreamModel,
    models: runtime?.models && runtime.models.length > 0 ? runtime.models : p.models,
    isDefault: p.isDefault,
    disabled: p.disabled,
    deprecated: typeof meta.deprecated === "string" ? (meta.deprecated as string) : null,
    deprecatedReason: typeof meta.deprecatedReason === "string" ? (meta.deprecatedReason as string) : null,
    currentPlatformKey: currentPlatformKey(),
    currentRuntime: runtime,
    runtimes: providerRuntimes(meta),
    // W20 legacy flags kept for current front-end compatibility.
    codexCliMissing: isCodex ? (runtime ? !runtime.cliPath : meta.codexCliMissing === true || undefined) : undefined,
    authMissing: isCodex ? (runtime ? !runtime.authPresent : meta.authMissing === true || undefined) : undefined,
    codexCliVersion: isCodex ? (runtime?.cliVersion ?? undefined) : undefined,
    codexCliVersionTooOld: isCodex ? (runtime?.cliVersionTooOld === true || undefined) : undefined,
    codexCliMinSupportedVersion: isCodex ? (runtime?.cliMinSupportedVersion ?? undefined) : undefined,
    defaultSandbox:
      runtime?.defaultSandbox ??
      (typeof meta.defaultSandbox === "string"
        ? (meta.defaultSandbox as string)
        : null),
    createdAt: p.createdAt.toISOString(),
  };
};

/** Migrate any pre-anthropic-local default rows. The historical default was
 * `kind=anthropic` + null baseUrl + null apiKey, which behaves identically
 * to anthropic-local but doesn't UX-distinguish local OAuth from API-key
 * providers. Idempotent — safe to call on every providers list. */
const migrateLocalAnthropic = async () => {
  const rows = await prisma.provider.findMany({});
  for (const p of rows) {
    if (p.kind === "anthropic" && !p.baseUrl && !p.apiKey) {
      await prisma.provider.update({
        where: { id: p.id },
        data: { kind: "anthropic-local" },
      });
    }
  }
};

const ensureDefaultProvider = async () => {
  await migrateLocalAnthropic();
  // W16 Slice 7: count *enabled* providers. A user upgrading from a DB where
  // every row was bedrock/vertex/autoManaged ends up with all rows disabled
  // at boot; without this filter they'd be stuck with no usable provider
  // until they hand-roll a new one. Disabled rows still exist for the
  // migrate-from-deprecated UI; default creation just doesn't see them.
  const enabled = await prisma.provider.count({ where: { disabled: false } });
  if (enabled > 0) return;
  await prisma.provider.create({
    data: {
      name: "anthropic-default",
      kind: "anthropic-local",
      baseUrl: null,
      apiKey: null,
      models: DEFAULT_ANTHROPIC_MODELS,
      isDefault: true,
    },
  });
};

async function refreshProviderHealthBestEffort(): Promise<void> {
  const timeoutMs = 2500;
  const healthRefresh = Promise.allSettled([
    refreshClaudeLocalHealth(),
    refreshCodexHealth(),
  ]).then(() => undefined);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([healthRefresh, timeout]);
}

async function refreshClaudeLocalHealth(): Promise<void> {
  const rows = await prisma.provider.findMany({ where: { kind: "anthropic-local" } });
  if (rows.length === 0) return;
  const health = await getCliSettingsHealth();
  const platformKey = currentPlatformKey();
  const authPresent = health.claude.found;
  for (const p of rows) {
    const meta = (p.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>;
    const runtimes = { ...providerRuntimes(meta) };
    const models = Array.from(new Set([...DEFAULT_ANTHROPIC_MODELS, ...p.models]));
    runtimes[platformKey] = {
      platformKey,
      cliPath: health.claude.path,
      cliVersion: null,
      cliMinSupportedVersion: null,
      authPath: null,
      authPresent,
      models,
      lastHealthAt: new Date().toISOString(),
      lastError: health.claude.error ?? null,
    };
    await prisma.provider.update({ where: { id: p.id }, data: { models, metadata: { ...meta, runtimes } } });
  }
}

/** W20: refresh metadata flags on any openai-codex provider rows so the UI
 *  can tell the user whether codex CLI is installed and whether they're
 *  logged in. Called on /providers list to keep the flags current without
 *  a daemon. */
async function refreshCodexHealth(): Promise<void> {
  const rows = await prisma.provider.findMany({ where: { kind: "openai-codex" } });
  if (rows.length === 0) return;
  const health = await getCliSettingsHealth();
  const platformKey = currentPlatformKey();
  const cliFound = health.codex.found;
  const authPresent = cliFound && health.codex.authPresent === true;

  // Re-discover the codex catalog once per startup so providers always
  // reflect the user's current ChatGPT tier. Also self-heals rows that an
  // earlier release accidentally filled with Anthropic defaults.
  const discoveredModels = cliFound && authPresent ? await discoverCodexModels() : null;

  for (const p of rows) {
    const meta = (p.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...meta };
    const runtimes = { ...providerRuntimes(meta) };
    if (
      next.defaultSandbox !== "read-only" &&
      next.defaultSandbox !== "workspace-write" &&
      next.defaultSandbox !== "danger-full-access"
    ) {
      next.defaultSandbox = CODEX_DEFAULT_SANDBOX;
    }
    const runtimeDefaultSandbox =
      runtimes[platformKey]?.defaultSandbox ??
      (typeof next.defaultSandbox === "string" ? next.defaultSandbox : CODEX_DEFAULT_SANDBOX);
    const runtime: ProviderRuntimeMetadata = {
      platformKey,
      cliPath: health.codex.path,
      cliVersion: health.codex.version ?? null,
      cliMinSupportedVersion: health.codex.minSupportedVersion ?? null,
      authPath: health.codex.authPath ?? null,
      authPresent,
      models: discoveredModels && discoveredModels.length > 0
        ? discoveredModels
        : (runtimes[platformKey]?.models ?? p.models),
      defaultSandbox: runtimeDefaultSandbox,
      lastHealthAt: new Date().toISOString(),
      lastError: health.codex.error ?? null,
    };
    if (health.codex.versionTooOld === true) runtime.cliVersionTooOld = true;
    runtimes[platformKey] = runtime;
    next.runtimes = runtimes;
    if (!cliFound) {
      next.codexCliMissing = true;
      next.authMissing = true;
    } else {
      delete next.codexCliMissing;
      if (!authPresent) next.authMissing = true;
      else delete next.authMissing;
    }
    const data: { metadata: Record<string, unknown>; models?: string[] } = { metadata: next };
    if (discoveredModels && discoveredModels.length > 0) {
      data.models = discoveredModels;
    }
    await prisma.provider.update({ where: { id: p.id }, data });
  }
}

fastify.get("/providers", async () => {
  await ensureDefaultProvider();
  await refreshProviderHealthBestEffort();
  const rows = await prisma.provider.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(sanitizeProvider);
});

fastify.post("/providers", async (req, reply) => {
  const parsed = ProviderInputSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const data = parsed.data;
  // W16: autoManaged (musistudio gateway) is no longer accepted for new providers.
  // Existing rows are auto-disabled at startup; UI surfaces a one-click migration.
  if (data.autoManaged) {
    reply.code(400);
    return {
      error: "autoManaged_deprecated",
      message: "autoManaged (musistudio gateway) providers are no longer supported. Use kind=openai-compat with the upstream's OpenAI-compatible baseUrl directly.",
    };
  }
  const autoManaged = false;
  if (data.kind === "anthropic-local") {
    if (data.baseUrl || data.apiKey) {
      reply.code(400);
      return {
        error: "invalid_for_local_oauth",
        message: "anthropic-local providers must not specify baseUrl or apiKey — they use the local `claude login` OAuth credentials.",
      };
    }
    const dup = await prisma.provider.findFirst({ where: { kind: "anthropic-local" } });
    if (dup) {
      reply.code(409);
      return {
        error: "local_oauth_exists",
        message: `a local OAuth provider already exists ("${dup.name}"). Only one is allowed per database.`,
      };
    }
  }
  // W19: openai-local = the OpenAI official endpoint (api.openai.com/v1). It
  // still needs a platform.openai.com API key — OpenAI doesn't expose its
  // ChatGPT/codex OAuth to the public Chat Completions API. The naming
  // mirrors anthropic-local semantically ("the canonical official upstream")
  // but the auth requirement is different from Claude's CLI OAuth.
  if (data.kind === "openai-local") {
    if (!data.baseUrl) {
      reply.code(400);
      return {
        error: "baseUrl_required",
        message: `${data.kind} providers must specify a baseUrl (default https://api.openai.com/v1).`,
      };
    }
    if (!data.apiKey) {
      reply.code(400);
      return {
        error: "apiKey_required",
        message:
          `${data.kind} needs an API key from https://platform.openai.com/api-keys. ` +
          "The local `codex login` ChatGPT OAuth is not usable for the public OpenAI API.",
      };
    }
  }
  // W20: openai-codex = drive OpenAI Responses API through user's locally-
  // installed `codex` CLI using their ChatGPT-account OAuth (~/.codex/auth.json).
  // The codex SDK handles auth/refresh internally; we never touch the JSON.
  // Constraints mirror anthropic-local: no baseUrl, no apiKey, only one such
  // provider per database (codex CLI has one auth file per machine).
  if (data.kind === "openai-codex") {
    if (data.baseUrl || data.apiKey) {
      reply.code(400);
      return {
        error: "invalid_for_codex",
        message: "openai-codex providers must not specify baseUrl or apiKey — they use the local `codex login` OAuth credentials.",
      };
    }
    const dup = await prisma.provider.findFirst({ where: { kind: "openai-codex" } });
    if (dup) {
      reply.code(409);
      return {
        error: "codex_provider_exists",
        message: `a codex provider already exists ("${dup.name}"). Only one is allowed per database — codex CLI keeps a single auth.json per machine.`,
      };
    }
  }
  // Explicit models[] in request wins (preset-applied or hand-typed) over the
  // implicit defaults below. Lets users seed a usable model list at create
  // time without a follow-up PATCH.
  const initialModels =
    data.models && data.models.length > 0
      ? data.models
      : autoManaged
        ? [data.name]
        : data.kind === "openai-codex"
          ? (await discoverCodexModels() ?? [])
          : data.kind === "anthropic-local" || (data.kind === "anthropic" && !data.baseUrl)
            ? DEFAULT_ANTHROPIC_MODELS
            : [];
  // Codex provider default is intentionally permissive: current Codex CLI
  // builds can cancel MCP tool execution under stricter sandboxes even when
  // peer_send is visible. Users can still choose read-only/workspace-write
  // at provider or agent level.
  const initialMetadata: Record<string, unknown> =
    data.kind === "openai-codex"
      ? { defaultSandbox: data.defaultSandbox ?? CODEX_DEFAULT_SANDBOX }
      : {};
  const codexNoBaseUrlNoApiKey =
    data.kind === "openai-codex"
      ? { baseUrl: null, apiKey: null }
      : {
          baseUrl: autoManaged || data.kind === "anthropic-local" ? null : (data.baseUrl ?? null),
          apiKey: data.kind === "anthropic-local" ? null : (data.apiKey ?? null),
        };
  const created = await prisma.provider.create({
    data: {
      name: data.name,
      kind: data.kind,
      ...codexNoBaseUrlNoApiKey,
      autoManaged,
      upstreamProvider: data.upstreamProvider ?? null,
      upstreamModel: data.upstreamModel ?? null,
      isDefault: data.isDefault ?? false,
      models: initialModels,
      ...(Object.keys(initialMetadata).length > 0 ? { metadata: initialMetadata } : {}),
    },
  });
  return sanitizeProvider(created);
});

fastify.patch<{ Params: { id: string } }>("/providers/:id", async (req, reply) => {
  const parsed = ProviderPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  // W16: PATCH cannot re-enable autoManaged. Existing autoManaged rows are
  // disabled at startup; the only legal mutation is via the migration endpoint.
  if (parsed.data.autoManaged === true) {
    reply.code(400);
    return {
      error: "autoManaged_deprecated",
      message: "autoManaged is no longer supported. Use the migration endpoint to convert this provider to openai-compat.",
    };
  }
  const data: {
    name?: string;
    baseUrl?: string | null;
    apiKey?: string;
    isDefault?: boolean;
    upstreamProvider?: string | null;
    upstreamModel?: string | null;
    models?: string[];
  } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.baseUrl !== undefined) data.baseUrl = parsed.data.baseUrl;
  if (parsed.data.isDefault !== undefined) data.isDefault = parsed.data.isDefault;
  if (parsed.data.upstreamProvider !== undefined) {
    data.upstreamProvider = parsed.data.upstreamProvider;
  }
  if (parsed.data.upstreamModel !== undefined) data.upstreamModel = parsed.data.upstreamModel;
  if (parsed.data.apiKey !== undefined && parsed.data.apiKey !== "") {
    data.apiKey = parsed.data.apiKey;
  }
  if (parsed.data.models !== undefined) data.models = parsed.data.models;
  // W20: defaultSandbox lives in metadata; preserve other keys (deprecated,
  // codexCliMissing, authMissing) when merging.
  let mergedMetadata: Record<string, unknown> | undefined;
  let providerDefaultSandboxChanged = false;
  if (parsed.data.defaultSandbox !== undefined) {
    const cur = await prisma.provider.findUnique({ where: { id: req.params.id } });
    if (!cur) {
      reply.code(404);
      return { error: "not found" };
    }
    if (cur.kind !== "openai-codex") {
      reply.code(400);
      return {
        error: "invalid_for_kind",
        message: "defaultSandbox is only valid for openai-codex providers.",
      };
    }
    const meta = (cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}) as Record<string, unknown>;
    const previousDefaultSandbox = meta.defaultSandbox;
    if (parsed.data.defaultSandbox === null) {
      const next = { ...meta, defaultSandbox: CODEX_DEFAULT_SANDBOX };
      mergedMetadata = next;
    } else {
      mergedMetadata = { ...meta, defaultSandbox: parsed.data.defaultSandbox };
    }
    providerDefaultSandboxChanged = mergedMetadata.defaultSandbox !== previousDefaultSandbox;
  }
  const updated = await prisma.provider.update({
    where: { id: req.params.id },
    data: { ...data, ...(mergedMetadata ? { metadata: mergedMetadata } : {}) },
  });
  if (providerDefaultSandboxChanged) {
    await sessions.clearResumeForProviderSandboxChange(req.params.id);
  }
  return sanitizeProvider(updated);
});

fastify.delete<{ Params: { id: string } }>("/providers/:id", async (req, reply) => {
  const cur = await prisma.provider.findUnique({ where: { id: req.params.id } });
  if (!cur) {
    reply.code(404);
    return { error: "not found" };
  }
  try {
    await prisma.provider.delete({ where: { id: req.params.id } });
    return { ok: true };
  } catch (err) {
    // Foreign-key violation: agents still reference this provider.
    reply.code(409);
    return {
      error: "in use",
      message: "agents are still bound to this provider; rebind or delete them first",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
});

fastify.post<{ Params: { id: string } }>("/providers/:id/refresh-models", async (req, reply) => {
  const provider = await prisma.provider.findUnique({ where: { id: req.params.id } });
  if (!provider) {
    reply.code(404);
    return { error: "not found" };
  }
  // W20: codex has no HTTP /v1/models — its catalog comes from the local
  // `codex debug models` JSON. Route this BEFORE the !baseUrl fallback
  // (codex always has null baseUrl) so the user doesn't get Anthropic
  // defaults stuffed into a codex provider.
  if (provider.kind === "openai-codex") {
    const codexModels = await discoverCodexModels();
    if (!codexModels) {
      reply.code(502);
      return {
        error: "codex_models_unavailable",
        message:
          "could not discover codex models — verify `codex` CLI is installed and you've run `codex login`.",
      };
    }
    const meta = (provider.metadata && typeof provider.metadata === "object" ? provider.metadata : {}) as Record<string, unknown>;
    const platformKey = currentPlatformKey();
    const runtimes = { ...providerRuntimes(meta) };
    if (runtimes[platformKey]) {
      runtimes[platformKey] = { ...runtimes[platformKey]!, models: codexModels, lastHealthAt: new Date().toISOString() };
    }
    const updated = await prisma.provider.update({
      where: { id: provider.id },
      data: { models: codexModels, metadata: { ...meta, runtimes } },
    });
    return {
      ...sanitizeProvider(updated),
      discovered: { count: codexModels.length, source: "codex debug models" },
    };
  }
  // anthropic-local (or anthropic without baseUrl, the legacy default) — fall
  // back to hardcoded list. There's no remote endpoint to introspect.
  if (provider.kind === "anthropic-local" || (provider.kind === "anthropic" && !provider.baseUrl && !provider.apiKey)) {
    const updated = await prisma.provider.update({
      where: { id: provider.id },
      data: { models: DEFAULT_ANTHROPIC_MODELS },
    });
    return {
      ...sanitizeProvider(updated),
      discovered: { count: DEFAULT_ANTHROPIC_MODELS.length, source: "local-oauth" },
    };
  }

  const flavor: ProbeFlavor =
    provider.kind === "openai-local" || provider.kind === "openai-compat" ? "openai" : "anthropic";
  const probeBaseUrl =
    provider.baseUrl ?? (provider.kind === "anthropic" ? ANTHROPIC_DEFAULT_BASE_URL : null);
  if (!probeBaseUrl) {
    reply.code(400);
    return {
      error: "baseUrl_required",
      message: "this provider type needs a baseUrl for model discovery.",
    };
  }
  const deepSeekFallback = deepSeekOfficialModelsFallback(probeBaseUrl, flavor);

  if (deepSeekFallback) {
    const updated = await prisma.provider.update({
      where: { id: provider.id },
      data: { models: deepSeekFallback.models },
    });
    return {
      ...sanitizeProvider(updated),
      discovered: {
        count: deepSeekFallback.models.length,
        source:
          flavor === "openai" && !provider.apiKey
            ? `${deepSeekFallback.sourceUrl}; API key required for requests`
            : deepSeekFallback.sourceUrl,
      },
    };
  }

  if (flavor === "openai" && !provider.apiKey) {
    // OpenAI's /v1/models requires `Authorization: Bearer sk-...`. There is
    // no OAuth-for-API path; codex CLI's ChatGPT login lives on a separate
    // chatgpt.com backend that @openai/agents doesn't speak. Explicit error
    // beats the cryptic 401 the user sees otherwise.
    reply.code(400);
    return {
      error: "openai_api_key_required",
      message:
        "OpenAI endpoints (including the official api.openai.com) require an API key — " +
        "get one at https://platform.openai.com/api-keys. The local `codex login` " +
        "OAuth token isn't usable here because OpenAI doesn't expose ChatGPT auth to " +
        "the public Chat Completions API.",
    };
  }

  const result = await probeModels(probeBaseUrl, provider.apiKey, flavor);
  if ("models" in result) {
    const updated = await prisma.provider.update({
      where: { id: provider.id },
      data: { models: result.models },
    });
    return {
      ...sanitizeProvider(updated),
      discovered: { count: result.models.length, source: result.sourceUrl },
    };
  }

  // No URL returned models. Surface every URL we tried so the user can debug.
  reply.code(502);
  const hint =
    flavor === "openai"
      ? "verify the baseUrl points at an OpenAI-compatible endpoint " +
        "(e.g. https://api.openai.com/v1, https://api.deepseek.com/v1) and that the API key is valid."
      : "verify the baseUrl points at an Anthropic-compatible endpoint " +
        "(e.g. https://open.bigmodel.cn/api/anthropic, https://api.deepseek.com/anthropic).";
  return {
    error: "no_models_discovered",
    message: `could not auto-discover models from the configured baseUrl. ${hint}`,
    tried: result.tried,
  };
});

// W16: convert a deprecated provider (bedrock/vertex/autoManaged) into a fresh
// openai-compat row using the original baseUrl + apiKey, then delete the old row.
// User must supply a new name to avoid the UNIQUE collision; if omitted, we
// suffix the original name with "-migrated".
fastify.post<{ Params: { id: string } }>("/providers/:id/migrate-from-deprecated", async (req, reply) => {
  const cur = await prisma.provider.findUnique({ where: { id: req.params.id } });
  if (!cur) {
    reply.code(404);
    return { error: "not found" };
  }
  if (!cur.disabled) {
    reply.code(400);
    return { error: "not_deprecated", message: "this provider is active; nothing to migrate" };
  }
  const body = (req.body as { name?: string; baseUrl?: string; apiKey?: string } | undefined) ?? {};
  const newName = body.name ?? `${cur.name}-migrated`;
  const newBaseUrl = body.baseUrl ?? cur.baseUrl;
  if (!newBaseUrl) {
    reply.code(400);
    return {
      error: "baseUrl_required",
      message: "the deprecated provider had no baseUrl on file; supply one in the request body",
    };
  }
  const newApiKey = body.apiKey ?? cur.apiKey;
  const created = await prisma.provider.create({
    data: {
      name: newName,
      kind: "openai-compat",
      baseUrl: newBaseUrl,
      apiKey: newApiKey,
      autoManaged: false,
      models: cur.models, // user can refresh via /refresh-models
      isDefault: cur.isDefault,
    },
  });
  await prisma.provider.delete({ where: { id: cur.id } });
  return sanitizeProvider(created);
});

// ----- MCP servers (W5.1) — global only per CLAUDE.md 3.1 -----

const McpStdioConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const McpHttpLikeConfigSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpServerInputSchema = z.discriminatedUnion("transport", [
  z.object({ name: z.string().min(1), transport: z.literal("stdio"), config: McpStdioConfigSchema, enabled: z.boolean().optional() }),
  z.object({ name: z.string().min(1), transport: z.literal("http"), config: McpHttpLikeConfigSchema, enabled: z.boolean().optional() }),
  z.object({ name: z.string().min(1), transport: z.literal("sse"), config: McpHttpLikeConfigSchema, enabled: z.boolean().optional() }),
]);

const McpServerPatchSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

fastify.get("/mcp-servers", async () => {
  const rows = await prisma.mcpServer.findMany({
    where: { agentId: null },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    transport: r.transport,
    config: r.config,
    enabled: r.enabled,
  }));
});

fastify.post("/mcp-servers", async (req, reply) => {
  const parsed = McpServerInputSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const data = parsed.data;
  const created = await prisma.mcpServer.create({
    data: {
      name: data.name,
      transport: data.transport,
      config: data.config as object,
      enabled: data.enabled ?? true,
      agentId: null,
    },
  });
  return {
    id: created.id,
    name: created.name,
    transport: created.transport,
    config: created.config,
    enabled: created.enabled,
  };
});

fastify.patch<{ Params: { id: string } }>("/mcp-servers/:id", async (req, reply) => {
  const parsed = McpServerPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const updated = await prisma.mcpServer.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  return { id: updated.id, name: updated.name, enabled: updated.enabled };
});

fastify.delete<{ Params: { id: string } }>("/mcp-servers/:id", async (req) => {
  await prisma.mcpServer.delete({ where: { id: req.params.id } });
  return { ok: true };
});

fastify.get("/agents", async () => {
  const rows = await prisma.agent.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(agentRowToSummary);
});

fastify.get<{ Params: { id: string }; Querystring: { limit?: string; afterSeq?: string } }>(
  "/agents/:id/messages",
  async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200) || 200));
    const afterSeq = Number(req.query.afterSeq);
    if (Number.isFinite(afterSeq)) {
      const rows = sqliteDb
        .prepare(
          `SELECT seq, payload
           FROM Message
           WHERE agentId = ? AND seq > ?
           ORDER BY seq ASC
           LIMIT ?`,
        )
        .all(req.params.id, afterSeq, limit) as Array<{ seq: number; payload: string }>;
      return rows.map((r) => {
        let msg: unknown = null;
        try {
          msg = JSON.parse(r.payload);
        } catch {
          msg = null;
        }
        return { seq: r.seq, msg };
      });
    }
    const rows = await prisma.message.findMany({
      where: { agentId: req.params.id },
      orderBy: { seq: "desc" },
      take: limit,
    });
    return rows.reverse().map((r) => ({ seq: r.seq, msg: r.payload }));
  },
);

// W21: Team CRUD ───────────────────────────────────────────────────

const TeamCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const TeamPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
});

fastify.get("/teams", async () => {
  return sessions.listTeams();
});

fastify.post("/teams", async (req, reply) => {
  const parsed = TeamCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const id = await sessions.createTeam(parsed.data);
  return { id };
});

fastify.patch<{ Params: { id: string } }>("/teams/:id", async (req, reply) => {
  const parsed = TeamPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const ok = await sessions.patchTeam(req.params.id, parsed.data);
  if (!ok) {
    reply.code(404);
    return { error: "not found" };
  }
  return { ok: true };
});

fastify.delete<{ Params: { id: string } }>("/teams/:id", async (req, reply) => {
  const ok = await sessions.deleteTeam(req.params.id);
  if (!ok) {
    reply.code(404);
    return { error: "not found" };
  }
  return { ok: true };
});

// ────────────────────────────────────────────────────────────────────

const AgentPatchSchema = z.object({
  model: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  providerId: z.string().uuid().optional().nullable(),
  codexWorkspace: z.string().optional().nullable(),
  permissionMode: z
    .enum(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"])
    .optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .nullable()
    .optional(),
  reasoningEffort: z
    .enum(REASONING_EFFORTS)
    .nullable()
    .optional(),
  systemPrompt: z.string().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
});

fastify.patch<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
  const parsed = AgentPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const updated = await sessions.patchAgent(req.params.id, parsed.data);
  if (!updated) {
    reply.code(404);
    return { error: "not found" };
  }
  return updated;
});

fastify.post<{ Params: { id: string } }>("/agents/:id/close", async (req, reply) => {
  const updated = await sessions.closeAgent(req.params.id);
  if (!updated) {
    reply.code(404);
    return { error: "not found" };
  }
  return updated;
});

fastify.post<{ Params: { id: string } }>("/agents/:id/restart", async (req, reply) => {
  const updated = await sessions.restartAgent(req.params.id);
  if (!updated) {
    reply.code(404);
    return { error: "not found" };
  }
  return updated;
});

fastify.delete<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
  const ok = await sessions.deleteAgent(req.params.id);
  if (!ok) {
    reply.code(404);
    return { error: "not found" };
  }
  return { ok: true };
});

// ----- /clear /compact /status (slash command backends) -----

fastify.post<{ Params: { id: string } }>("/agents/:id/clear", async (req, reply) => {
  const ok = await sessions.clearAgentContext(req.params.id);
  if (!ok) {
    reply.code(404);
    return { error: "not found" };
  }
  return { ok: true };
});

fastify.post<{ Params: { id: string } }>("/agents/:id/compact", async (req, reply) => {
  try {
    const out = await sessions.compactAgent(req.params.id);
    if (!out) {
      reply.code(404);
      return { error: "not found" };
    }
    return out;
  } catch (err) {
    reply.code(500);
    return { error: (err as Error).message };
  }
});

const SkillToggleSchema = z.object({
  name: z.string().min(1),
  action: z.enum(["enable", "disable", "auto"]),
});

fastify.post<{ Params: { id: string } }>("/agents/:id/skill-toggle", async (req, reply) => {
  const parsed = SkillToggleSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const updated = await sessions.toggleAgentSkill(req.params.id, parsed.data.name, parsed.data.action);
  if (!updated) {
    reply.code(404);
    return { error: "not found" };
  }
  return updated;
});

fastify.get<{ Params: { id: string } }>("/agents/:id/status", async (req, reply) => {
  const s = await sessions.getStatusReport(req.params.id);
  if (!s) {
    reply.code(404);
    return { error: "not found" };
  }
  return s;
});

// ----- Skills (v2) -----

fastify.get("/skills", async () => {
  const { loadSkills } = await import("./skills/index.js");
  const list = loadSkills();
  return list.map((s) => ({
    name: s.name,
    description: s.description,
    tools: s.tools ?? null,
    model: s.model ?? null,
    source: s.source,
    path: s.path,
    body: s.body,
  }));
});

fastify.post("/skills/reload", async () => {
  const { reloadSkills, loadSkills } = await import("./skills/index.js");
  reloadSkills();
  const list = loadSkills();
  return { ok: true, count: list.length };
});

const SkillUpsertSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "name must be slug-style (letters / digits / _ / -)"),
  description: z.string().min(1),
  body: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
});

fastify.post("/skills", async (req, reply) => {
  const parsed = SkillUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const { name, description, body, tools, model } = parsed.data;
  const fs = await import("node:fs");
  const pathModule = await import("node:path");
  const { ensureDataDir } = await import("./paths.js");
  const skillsRoot = pathModule.join(ensureDataDir(), "skills", name);
  if (fs.existsSync(skillsRoot)) {
    reply.code(409);
    return { error: "skill already exists; use PATCH" };
  }
  fs.mkdirSync(skillsRoot, { recursive: true });
  const fmLines = [`name: ${name}`, `description: ${description}`];
  if (tools && tools.length > 0) fmLines.push(`tools: [${tools.join(", ")}]`);
  if (model) fmLines.push(`model: ${model}`);
  const md = `---\n${fmLines.join("\n")}\n---\n${body.trim()}\n`;
  fs.writeFileSync(pathModule.join(skillsRoot, "SKILL.md"), md, "utf8");
  const { reloadSkills, findSkill } = await import("./skills/index.js");
  reloadSkills();
  return findSkill(name) ?? { name };
});

fastify.patch<{ Params: { name: string } }>("/skills/:name", async (req, reply) => {
  const parsed = SkillUpsertSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid", detail: parsed.error.issues };
  }
  const { findSkill, reloadSkills } = await import("./skills/index.js");
  const cur = findSkill(req.params.name);
  if (!cur) {
    reply.code(404);
    return { error: "not found" };
  }
  if (cur.source !== "ensemble") {
    reply.code(403);
    return { error: `cannot edit ${cur.source}-sourced skill via API; edit on disk` };
  }
  const fs = await import("node:fs");
  const merged = {
    name: cur.name,
    description: parsed.data.description ?? cur.description,
    body: parsed.data.body ?? cur.body,
    tools: parsed.data.tools ?? cur.tools,
    model: parsed.data.model ?? cur.model,
  };
  const fmLines = [`name: ${merged.name}`, `description: ${merged.description}`];
  if (merged.tools && merged.tools.length > 0) fmLines.push(`tools: [${merged.tools.join(", ")}]`);
  if (merged.model) fmLines.push(`model: ${merged.model}`);
  const md = `---\n${fmLines.join("\n")}\n---\n${merged.body.trim()}\n`;
  fs.writeFileSync(cur.path, md, "utf8");
  reloadSkills();
  return findSkill(cur.name) ?? cur;
});

fastify.delete<{ Params: { name: string } }>("/skills/:name", async (req, reply) => {
  const { findSkill, reloadSkills } = await import("./skills/index.js");
  const cur = findSkill(req.params.name);
  if (!cur) {
    reply.code(404);
    return { error: "not found" };
  }
  if (cur.source !== "ensemble") {
    reply.code(403);
    return { error: `cannot delete ${cur.source}-sourced skill via API; remove on disk` };
  }
  const fs = await import("node:fs");
  const pathModule = await import("node:path");
  const skillDir = pathModule.dirname(cur.path);
  fs.rmSync(skillDir, { recursive: true, force: true });
  reloadSkills();
  return { ok: true };
});

// ----- Subagent suggestions (W14) -----

interface SuggestionItem {
  key: string;
  displayName: string;
  systemPrompt: string;
}

interface CachedSuggestions {
  expires: number;
  items: SuggestionItem[];
}

const SUGGEST_CACHE = new Map<string, CachedSuggestions>();
const SUGGEST_CACHE_TTL_MS = 30_000;

function suggestionFromPicks(picks: { key: string; hint?: string }[]): SuggestionItem[] {
  const seen = new Set<string>();
  const out: SuggestionItem[] = [];
  for (const pick of picks) {
    if (seen.has(pick.key)) continue;
    const entry = getCatalogEntry(pick.key);
    if (!entry) continue;
    seen.add(pick.key);
    out.push({
      key: entry.key,
      displayName: entry.displayName,
      systemPrompt: inflateSystemPrompt(entry, pick.hint),
    });
    if (out.length === 3) break;
  }
  // Pad from the static fallback if the model returned fewer than 3 valid picks.
  if (out.length < 3) {
    for (const fallback of staticFallbackPicks()) {
      if (seen.has(fallback.key)) continue;
      const entry = getCatalogEntry(fallback.key)!;
      seen.add(fallback.key);
      out.push({
        key: entry.key,
        displayName: entry.displayName,
        systemPrompt: inflateSystemPrompt(entry, ""),
      });
      if (out.length === 3) break;
    }
  }
  return out;
}

fastify.post<{ Params: { id: string } }>("/agents/:id/suggest-children", async (req, reply) => {
  const agentId = req.params.id;
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    reply.code(404);
    return { error: "not found" };
  }

  // History: last 10 user/assistant text messages, each head-truncated to 200.
  // tool_use / tool_result blobs are excluded as design §1 requires.
  const recentRows = await prisma.message.findMany({
    where: { agentId },
    orderBy: { seq: "desc" },
    take: 40, // over-fetch so we have enough user/assistant after filtering
  });
  const chunks: string[] = [];
  for (const r of recentRows) {
    if (chunks.length >= 10) break;
    if (r.type !== "user" && r.type !== "assistant") continue;
    const payload = r.payload as { message?: { content?: unknown } } | null;
    let text = "";
    const content = payload?.message?.content;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && "type" in b)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("");
    }
    if (!text) continue;
    const truncated = text.length > 200 ? text.slice(0, 200) + "…" : text;
    chunks.unshift(`[${r.type}] ${truncated}`);
  }

  // Empty history → static catalog, skip model entirely.
  if (chunks.length === 0) {
    return { suggestions: suggestionFromPicks(staticFallbackPicks()) };
  }

  // Cache by content hash of the history chunks.
  const hashKey = createHash("sha256").update(chunks.join("\n")).digest("hex").slice(0, 16);
  const cacheKey = `${agentId}:${hashKey}`;
  const now = Date.now();
  const cached = SUGGEST_CACHE.get(cacheKey);
  if (cached && cached.expires > now) {
    return { suggestions: cached.items };
  }

  // Call the parent agent's runtime through the SessionManager side-channel.
  const prompt = buildSuggestPrompt(chunks);
  let raw = "";
  try {
    raw = await sessions.quickQuery(agentId, prompt, 15_000);
  } catch (err) {
    fastify.log.warn({ err: String(err) }, "[suggest-children] model query failed; falling back");
  }
  let picks = extractJsonPicks(raw);
  if (!picks || picks.length === 0) {
    // One retry with an explicit "JSON only" reminder.
    const retryPrompt = prompt + "\n\nReminder: output ONLY the JSON object above, no surrounding text.";
    try {
      raw = await sessions.quickQuery(agentId, retryPrompt, 15_000);
      picks = extractJsonPicks(raw);
    } catch (err) {
      fastify.log.warn({ err: String(err) }, "[suggest-children] retry failed");
    }
  }
  if (!picks || picks.length === 0) {
    // Final fallback: static catalog top 3. Per design §1 we don't error out.
    picks = staticFallbackPicks();
  }

  const items = suggestionFromPicks(picks);
  SUGGEST_CACHE.set(cacheKey, { expires: now + SUGGEST_CACHE_TTL_MS, items });
  // Best-effort cache size cap (don't bother with LRU).
  if (SUGGEST_CACHE.size > 200) {
    for (const [k, v] of SUGGEST_CACHE) {
      if (v.expires <= now) SUGGEST_CACHE.delete(k);
    }
  }
  return { suggestions: items };
});

// Expose the static catalog so the frontend can render the empty-history /
// fallback path without a server round-trip if it wants to.
fastify.get("/subagent-catalog", async () => {
  return {
    entries: SUBAGENT_CATALOG.map((e) => ({
      key: e.key,
      displayName: e.displayName,
      description: e.description,
    })),
  };
});

// ----- Usage stats (W17) -----

const ModelPricingSchema = z.object({
  model: z.string().min(1),
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0).optional().nullable(),
  cacheWrite: z.number().min(0).optional().nullable(),
  source: z.string().optional().nullable(),
});

function pricingToWire(model: string, price: ModelPricing, overridden: boolean, builtIn: boolean) {
  return {
    model,
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead ?? null,
    cacheWrite: price.cacheWrite ?? null,
    source: price._source ?? null,
    overridden,
    builtIn,
  };
}

async function recomputeUsageCostsForModel(model: string): Promise<number> {
  const rows = await prisma.usageEvent.findMany({ where: { model, billingModel: "usage" } });
  for (const row of rows) {
    const cost = computeCost(model, {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadTokens,
      cacheCreationInputTokens: row.cacheCreationTokens,
    });
    await prisma.usageEvent.update({
      where: { id: row.id },
      data: {
        costUSD: cost.costUSD,
        costKnown: cost.costKnown,
      },
    });
  }
  return rows.length;
}

fastify.get("/pricing", async () => {
  const merged = loadPricingTable();
  const builtIn = loadBuiltInPricingTable();
  const overrides = loadPricingOverrides();
  const overrideModels = overrides.models ?? {};
  const modelIds = new Set([
    ...Object.keys(builtIn.models),
    ...Object.keys(overrideModels),
  ]);
  const models = [...modelIds]
    .sort((a, b) => a.localeCompare(b))
    .map((model) =>
      pricingToWire(
        model,
        merged.models[model]!,
        Object.prototype.hasOwnProperty.call(overrideModels, model),
        Object.prototype.hasOwnProperty.call(builtIn.models, model),
      ),
    );

  return {
    version: merged.version,
    note: merged.note ?? null,
    overridesPath: pricingOverridesPath(),
    models,
  };
});

fastify.post("/pricing/models", async (req, reply) => {
  const parsed = ModelPricingSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid_pricing", issues: parsed.error.issues };
  }
  const body = parsed.data;
  const price: ModelPricing = {
    input: body.input,
    output: body.output,
    ...(body.cacheRead != null ? { cacheRead: body.cacheRead } : {}),
    ...(body.cacheWrite != null ? { cacheWrite: body.cacheWrite } : {}),
    ...(body.source?.trim() ? { _source: body.source.trim() } : {}),
  };
  savePricingOverride(body.model.trim(), price);
  const recomputed = await recomputeUsageCostsForModel(body.model.trim());
  return { ok: true, recomputed };
});

fastify.delete<{ Querystring: { model?: string } }>("/pricing/models", async (req, reply) => {
  const model = req.query.model?.trim();
  if (!model) {
    reply.code(400);
    return { error: "model_required" };
  }
  deletePricingOverride(model);
  const recomputed = await recomputeUsageCostsForModel(model);
  return { ok: true, recomputed };
});

fastify.get<{
  Querystring: { since?: string; until?: string; tz?: string; includeDescendants?: string };
}>("/usage/summary", async (req, reply) => {
  const q = req.query;
  // Parse window. Defaults: until=now, since=epoch (i.e. range='All').
  let untilMs = Date.now();
  if (q.until) {
    const u = Date.parse(q.until);
    if (!Number.isNaN(u)) untilMs = u;
  }
  let sinceMs = 0;
  if (q.since) {
    const s = Date.parse(q.since);
    if (!Number.isNaN(s)) sinceMs = s;
  } else {
    // range='All' shortcut: take the earliest UsageEvent.
    const earliest = await prisma.usageEvent.findFirst({
      orderBy: { createdAt: "asc" },
    });
    if (earliest) sinceMs = earliest.createdAt.getTime();
  }
  if (sinceMs >= untilMs) {
    reply.code(400);
    return { error: "invalid_range", message: "since must be < until" };
  }

  // Half-open [since, until). SQLite stores createdAt as unixepoch seconds.
  const sinceUnix = Math.floor(sinceMs / 1000);
  const untilUnix = Math.ceil(untilMs / 1000);
  // The current makeRepo WHERE builder doesn't support range operators, so
  // filter after-fetch. Volumes are small (one row per assistant turn);
  // the index `usage_time_idx` will help once we wire a proper range query
  // builder, but for now this is fine.
  const rows = await prisma.usageEvent.findMany({});
  const inRange = rows.filter((r) => {
    const t = Math.floor(r.createdAt.getTime() / 1000);
    return t >= sinceUnix && t < untilUnix;
  });

  const tz = q.tz || "UTC";
  const includeDescendants = q.includeDescendants === "true";
  const agg = aggregateUsage(inRange, { tz, includeDescendants });

  return {
    range: {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      tz,
    },
    ...agg,
  };
});

fastify.register(async (instance) => {
  instance.get("/ws", { websocket: true }, (socket) => {
    hub.add(socket);
    const hello: ServerMsg = { type: "hello", serverTime: new Date().toISOString() };
    socket.send(JSON.stringify(hello));

    socket.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.from(raw as ArrayBuffer).toString("utf8");
      let parsed: ClientMsg;
      try {
        const json = JSON.parse(text);
        parsed = ClientMsgSchema.parse(json) as ClientMsg;
      } catch (err) {
        const msg: ServerMsg = {
          type: "error",
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : "invalid message",
        };
        socket.send(JSON.stringify(msg));
        return;
      }

      try {
        switch (parsed.type) {
          case "create_agent":
            await sessions.createAgent({
              name: parsed.name,
              systemPrompt: parsed.systemPrompt,
              model: parsed.model,
              parentId: parsed.parentId,
              providerId: parsed.providerId,
              codexWorkspace: parsed.codexWorkspace,
              teamId: parsed.teamId,
            });
            break;
          case "send_message":
            void sessions.sendMessage(parsed.sessionId, parsed.text);
            break;
          case "peer_send":
            void sessions
              .sendPeerMessage(parsed.fromSessionId, parsed.targetSessionId, parsed.text, parsed.mode, {
                includeSource: parsed.includeSource,
                interrupt: parsed.interrupt,
                interruptReason: parsed.interruptReason,
              })
              .then((result) => {
                if (result.startsWith("error")) {
                  socket.send(
                    JSON.stringify({
                      type: "error",
                      sessionId: parsed.fromSessionId,
                      code: "PEER_SEND_FAILED",
                      message: result,
                    }),
                  );
                }
              });
            break;
          case "cancel":
            void sessions.cancel(parsed.sessionId);
            break;
          case "permission_response":
            void sessions.resolvePermission(parsed.sessionId, parsed.reqId, parsed.decision);
            break;
          case "user_answer":
            sessions.resolveUserQuestion(parsed.sessionId, parsed.reqId, parsed.choice);
            break;
          case "subscribe":
            hub.subscribe(socket, parsed.sessionId);
            sessions.replayPendingFor(parsed.sessionId, socket);
            break;
          case "unsubscribe":
            hub.unsubscribe(socket, parsed.sessionId);
            break;
        }
      } catch (err) {
        const msg: ServerMsg = {
          type: "error",
          code: "HANDLER_ERROR",
          message: err instanceof Error ? err.message : String(err),
        };
        socket.send(JSON.stringify(msg));
      }
    });

    socket.on("close", () => hub.remove(socket));
  });
});

// Reset agents stuck in non-terminal status from a prior crash/kill. Without
// this, the frontend hydrates them as RUNNING and disables send / shows a
// cancel button that goes nowhere (no actual run exists in the new process).
// prisma is sync over node:sqlite so no await needed.
{
  const staleStatuses = ["RUNNING", "AWAITING_PERMISSION", "AWAITING_USER_INPUT"];
  const allAgents = prisma.agent.findMany({});
  for (const a of allAgents) {
    if (staleStatuses.includes(a.status)) {
      prisma.agent.update({ where: { id: a.id }, data: { status: "IDLE" } });
      fastify.log.info(`reset stale agent ${a.id.slice(0, 8)} (${a.status} → IDLE)`);
    }
  }
}

// Static frontend (only when the export build exists at the expected path).
// Dev mode uses `next dev` on :3000 with rewrites — server stays API/WS only.
// Packaged EXE / `pnpm build:export` users get same-origin static + API/WS here.
if (webRootExists()) {
  fastify.register(fastifyStatic, {
    root: WEB_ROOT,
    prefix: "/",
    wildcard: false,
  });
  fastify.setNotFoundHandler((req, reply) => {
    // The prependListener hook may have stripped `/api/`; check the marker.
    const wasApi = (req.raw as { _wasApi?: boolean })._wasApi === true;
    if (wasApi || req.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "not_found", path: req.url });
    }
    // /tutorial.html is a sibling static page, NOT an SPA route. If the file
    // is genuinely missing (old install without the tutorial bundled), do NOT
    // fall back to index.html — that would load the entire Ensemble app
    // inside the dialog's iframe, spawning a duplicate React tree + a second
    // WebSocket + a parallel Zustand store. Cross-talk between the two
    // breaks the outer app's WS subscriptions and panel data. Return a clean
    // 404 instead; TutorialDialog's HEAD probe surfaces a friendly message.
    if (req.url.startsWith("/tutorial.html")) {
      return reply.code(404).send({ error: "tutorial_not_bundled" });
    }
    // Any other path-shaped URL gets the SPA shell so Next.js client-side
    // routing keeps working. CSS / JS / image 404s still fall through here —
    // that's pre-existing behavior and was working before the tutorial work.
    return reply.sendFile("index.html");
  });
  fastify.log.info(`serving static frontend from ${WEB_ROOT}`);
} else {
  fastify.log.info(`no static frontend at ${WEB_ROOT} — API/WS only mode`);
}

// IIFE wrap so the bundle has zero top-level await — required for SEA's CJS
// loader. (Fastify.register calls above queue plugins; listen() flushes them.)
void (async () => {
  try {
    // Auto-port mode binds 127.0.0.1 only (Tauri sidecar context). Standalone
    // mode binds 0.0.0.0 so LAN access still works.
    const host = AUTO_PORT ? "127.0.0.1" : "0.0.0.0";
    const address = await fastify.listen({ port: PORT, host });
    // address is like "http://127.0.0.1:51234" — extract the actual bound port.
    const boundPort = Number(new URL(address).port);
    // W20: codex MCP bridge needs the bound port to construct loopback URLs.
    setBridgePort(boundPort);

    // Stale-session recovery — if the previous core process crashed mid-turn
    // or a codex CLI wedged in a way that outlived its sendMessage, the
    // Agent row was left in RUNNING / AWAITING_* state. Flip those back to
    // IDLE so the user sees a usable agent and can send a new message.
    try {
      await sessions.recoverStaleSessions();
    } catch (err) {
      console.warn("[recover] startup hook threw:", err);
    }

    // Anonymous telemetry — device count + session duration + daily token
    // totals. Fully no-op if ENSEMBLE_DEVICE_ID isn't set (dev runs). Never
    // blocks startup, never throws into this path.
    try {
      startTelemetry();
    } catch (err) {
      console.warn("[telemetry] startup hook threw:", err);
    }

    if (AUTO_PORT) {
      // CRITICAL: this MUST reach Tauri's stdout reader, AND it MUST land
      // on disk under DATA_DIR/.port. Both channels exist because either
      // can silently fail in production:
      //
      // 1) `process.stdout.write` on a non-TTY pipe is asynchronous in
      //    Node — the bytes can sit in the stream's internal buffer with
      //    no follow-up data to push them through. On macOS, where the
      //    Tauri shell plugin's stdout reader needs a line-terminated
      //    chunk, this manifests as "ENSEMBLE_LISTENING never reaches
      //    Rust, on_sidecar_ready never fires, the window stays hidden
      //    forever — only the tray icon appears" (the original macOS
      //    bug). fs.writeSync(1, ...) goes straight to the file
      //    descriptor, bypassing Node's stream layer and guaranteeing
      //    the bytes hit the pipe before we return.
      //
      // 2) On signed-but-mismatched macOS bundles, the SEA child can
      //    print to a stdout that's been re-piped by Gatekeeper to a
      //    log surface Tauri doesn't read. The sentinel file gives Rust
      //    a side-channel that doesn't depend on stdio plumbing.
      const announce = `ENSEMBLE_LISTENING ${boundPort}\n`;
      try {
        // Synchronous, unbuffered write to fd 1.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = await import("node:fs");
        fs.writeSync(1, announce);
      } catch {
        // Fall through to the stream API if the sync write fails for any
        // reason (extremely unlikely on a real pipe).
        process.stdout.write(announce);
      }
      // Belt-and-suspenders: a sentinel file Rust can poll. Survives any
      // stdout weirdness; deleted on next startup so a stale value can't
      // mislead a future launch.
      try {
        const { writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { DATA_DIR } = await import("./paths.js");
        writeFileSync(join(DATA_DIR, ".port"), `${boundPort}\n`, "utf8");
      } catch (err) {
        console.error(`[sidecar] failed to write .port sentinel: ${(err as Error).message}`);
      }
    } else if (PACKAGED) {
      // Standalone packaged path (no Tauri shell, double-click EXE).
      const padded = String(boundPort).padEnd(5);
      console.log("");
      console.log("  ╔════════════════════════════════════════════════════╗");
      console.log(`  ║   ensemble-core ready — open  http://127.0.0.1:${padded} ║`);
      console.log("  ║   close this window to stop the server             ║");
      console.log("  ╚════════════════════════════════════════════════════╝");
      console.log("");
    }
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "EADDRINUSE") {
      console.error("");
      console.error(`  ✗ port ${PORT} is already in use.`);
      console.error("    another ensemble-core instance is probably already running,");
      console.error("    or another app has bound this port. close it and retry.");
      console.error("");
    } else {
      fastify.log.error(err);
    }
    if (PACKAGED) {
      console.error("  (this window will close in 10 seconds)");
      await new Promise((r) => setTimeout(r, 10_000));
    }
    process.exit(1);
  }
})();

const shutdown = async (sig: string) => {
  fastify.log.info(`received ${sig}, shutting down...`);
  await fastify.close();
  closeDb();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
}
