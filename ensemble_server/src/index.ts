// ensemble_server entrypoint.
//
// Single responsibility (v1): serve the version manifest. Binds loopback by
// default; nginx terminates TLS and reverse-proxies from :443. Run under
// systemd; restart on failure; reload manifest from disk without restart.

import { resolve } from "node:path";
import Fastify from "fastify";
import { ManifestStore } from "./manifest.js";
import { TelemetryDb, readDbConfig } from "./telemetry/db.js";
import { registerTelemetryRoutes } from "./telemetry/routes.js";

const HOST = process.env.ENSEMBLE_SERVER_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ENSEMBLE_SERVER_PORT ?? 8787);
const MANIFEST_PATH = resolve(process.env.ENSEMBLE_MANIFEST_PATH ?? "./manifest.json");

const store = new ManifestStore(MANIFEST_PATH);
store.start();

// Telemetry DB: optional — when env vars are unset (dev runs / first deploy
// before MySQL is provisioned), we skip the route registration entirely so
// the manifest endpoint still works.
const dbCfg = readDbConfig();
let telemetryDb: TelemetryDb | null = null;
if (dbCfg) {
  telemetryDb = new TelemetryDb(dbCfg);
}

const app = Fastify({
  // nginx logs the access line; here we only want app-level events.
  logger: { level: "info" },
  // Trust X-Forwarded-* from nginx so request.ip reflects the client.
  trustProxy: true,
});

app.get("/healthz", async () => ({ ok: true }));

app.get("/v1/version/latest", async (req, reply) => {
  const snap = store.get();
  if (!snap) {
    reply.code(503);
    return { error: "manifest_not_loaded" };
  }
  // Honor If-None-Match / If-Modified-Since so a polling client (every few
  // hours) doesn't pay for the response body when nothing changed.
  const ifNone = req.headers["if-none-match"];
  if (ifNone && ifNone === snap.etag) {
    reply.code(304);
    return null;
  }
  reply.header("ETag", snap.etag);
  reply.header("Last-Modified", snap.lastModified);
  // 5-minute browser/proxy cache. The desktop client polls less often than
  // this; this header mainly helps if a CDN gets put in front later.
  reply.header("Cache-Control", "public, max-age=300, must-revalidate");
  return snap.manifest;
});

// Telemetry routes — only when MySQL is configured. Migrate-on-boot so the
// schema lives in sync with the deployed code; failures here surface
// loudly so deploys don't silently degrade.
if (telemetryDb) {
  try {
    await telemetryDb.migrate();
    registerTelemetryRoutes(app, telemetryDb);
    app.log.info("telemetry routes enabled");
  } catch (err) {
    app.log.error({ err }, "telemetry migrate failed — routes NOT registered");
  }
} else {
  app.log.warn("telemetry DB not configured — endpoints disabled");
}

// Always return JSON for unmatched paths, never an HTML 404 page.
app.setNotFoundHandler((_req, reply) => {
  reply.code(404).send({ error: "not_found" });
});

const shutdown = async (signal: string) => {
  app.log.info(`received ${signal}, shutting down`);
  store.stop();
  await app.close();
  if (telemetryDb) await telemetryDb.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

app
  .listen({ host: HOST, port: PORT })
  .then(() => {
    app.log.info(`ensemble_server listening on http://${HOST}:${PORT}`);
    app.log.info(`manifest source: ${MANIFEST_PATH}`);
  })
  .catch((err) => {
    app.log.error({ err }, "listen failed");
    process.exit(1);
  });
