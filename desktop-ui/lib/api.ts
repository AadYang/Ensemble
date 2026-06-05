let sidecarOriginPromise: Promise<string | null> | null = null;
let sidecarOriginCache: string | null = null;

export async function apiUrl(path: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  if (typeof window === "undefined") return path;

  const { protocol, href } = window.location;
  if (protocol === "http:" || protocol === "https:") {
    return new URL(path, href).toString();
  }

  const sidecarOrigin = await getSidecarOrigin();
  if (sidecarOrigin) return new URL(path, sidecarOrigin).toString();

  throw new Error("Ensemble core API is not ready yet. Wait a few seconds, then retry.");
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(await apiUrl(path), init);
  } catch (err) {
    throw normalizeFetchError(err);
  }
}

export async function apiError(res: Response, operation: string): Promise<Error> {
  const text = await res.text().catch(() => "");
  const body = parseJson(text);
  const detail = messageFromBody(body) ?? (text.trim() || `${res.status} ${res.statusText}`.trim());
  return new Error(`${operation}: ${detail}`);
}

async function getSidecarOrigin(): Promise<string | null> {
  if (sidecarOriginCache) return sidecarOriginCache;
  sidecarOriginPromise ??= resolveSidecarOrigin();
  const origin = await sidecarOriginPromise;
  sidecarOriginPromise = null;
  if (origin) sidecarOriginCache = origin;
  return origin;
}

async function resolveSidecarOrigin(): Promise<string | null> {
  const globalPort = (window as Window & { __ENSEMBLE_PORT__?: unknown }).__ENSEMBLE_PORT__;
  if (typeof globalPort === "number" && Number.isInteger(globalPort)) {
    return `http://127.0.0.1:${globalPort}`;
  }
  try {
    const mod = await import("@tauri-apps/api/core");
    const port = await mod.invoke<number | null>("get_sidecar_port");
    if (typeof port === "number" && Number.isInteger(port)) {
      (window as Window & { __ENSEMBLE_PORT__?: number }).__ENSEMBLE_PORT__ = port;
      return `http://127.0.0.1:${port}`;
    }
  } catch {
    // Running outside Tauri, or the sidecar has not written its port yet.
  }
  return null;
}

function normalizeFetchError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("expected pattern")) {
    return new Error(
      "Ensemble core API URL is not available in this WebView yet. Wait for the app to finish loading, then retry.",
    );
  }
  return err instanceof Error ? err : new Error(message);
}

function parseJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function messageFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) return record.message;
  if (Array.isArray(record.detail)) {
    const issues = record.detail.map(formatIssue).filter(Boolean);
    if (issues.length > 0) return issues.join("; ");
  }
  if (typeof record.error === "string" && record.error.trim()) return record.error;
  return null;
}

function formatIssue(issue: unknown): string | null {
  if (!issue || typeof issue !== "object") return null;
  const record = issue as Record<string, unknown>;
  const path = Array.isArray(record.path) && record.path.length > 0
    ? record.path.map(String).join(".")
    : "request";
  const message = typeof record.message === "string" ? record.message : "";
  if (record.format === "url" || path === "baseUrl" || /url/i.test(message)) {
    return `${path} must be a valid http(s) URL, e.g. https://api.example.com/v1`;
  }
  return `${path}: ${message || String(record.code ?? "invalid value")}`;
}
