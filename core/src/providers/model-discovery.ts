export type ProbeFlavor = "anthropic" | "openai";

export interface ModelsProbeResult {
  models: string[];
  sourceUrl: string;
}

export interface ModelsProbeFailure {
  tried: Array<{ url: string; status: number; bodyHead: string }>;
}

const MODEL_PROBE_TIMEOUT_MS = 8000;

export const DEEPSEEK_OFFICIAL_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  // Kept for existing agents; new/default selection should prefer the v4 rows above.
  "deepseek-chat",
  "deepseek-reasoner",
];

/** Compute the candidate URLs to probe for model listing.
 *
 * Both Anthropic's `/v1/models` and OpenAI's `/v1/models` return the same
 * shape (`{data: [{id}, ...]}`), so the same parser handles either. We just
 * need to try a couple URL variants because users paste baseUrls in different
 * shapes: sometimes ending in `/v1`, sometimes not, sometimes with a custom
 * prefix like `/anthropic` for proxied compat endpoints.
 */
export const candidateModelsUrls = (base: string): string[] => {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return [`${trimmed}/models`];
  if (trimmed.endsWith("/models")) return [trimmed];
  return [`${trimmed}/v1/models`, `${trimmed}/models`];
};

/** DeepSeek documents fixed model ids but its official Anthropic-compatible
 * baseUrl does not expose the `/models` paths Ensemble probes for generic
 * compat providers. Treat the official DeepSeek baseUrls as a known catalog
 * source instead of telling the user their baseUrl is wrong.
 */
export function deepSeekOfficialModelsFallback(
  baseUrl: string,
  flavor: ProbeFlavor,
): ModelsProbeResult | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "api.deepseek.com") return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  const isOfficialAnthropic = flavor === "anthropic" && path === "/anthropic";
  const isOfficialOpenAI = flavor === "openai" && (path === "" || path === "/v1");
  if (!isOfficialAnthropic && !isOfficialOpenAI) return null;

  return {
    models: DEEPSEEK_OFFICIAL_MODELS,
    sourceUrl: "DeepSeek official model list (models endpoint not discoverable)",
  };
}

/** Try every candidate URL with auth headers tailored to the provider flavor.
 *  Anthropic-compat upstreams want `x-api-key` + `anthropic-version`; OpenAI-
 *  compat want `Authorization: Bearer`. v1 sent both unconditionally; that
 *  worked for most providers but masked errors on stricter ones. Flavor-aware
 *  probing also lets us emit a kind-appropriate hint when nothing comes back. */
export const probeModels = async (
  baseUrl: string,
  apiKey: string | null,
  flavor: ProbeFlavor,
): Promise<ModelsProbeResult | ModelsProbeFailure> => {
  const tried: ModelsProbeFailure["tried"] = [];
  const headers: Record<string, string> = {};
  if (flavor === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) {
      headers["x-api-key"] = apiKey;
      // Some Anthropic-compat proxies also accept Bearer; harmless when the
      // upstream prefers x-api-key.
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  } else {
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  }

  for (const url of candidateModelsUrls(baseUrl)) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MODEL_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: abort.signal });
      const rawText = await res.text();
      if (!res.ok) {
        tried.push({ url, status: res.status, bodyHead: rawText.slice(0, 200) });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        tried.push({ url, status: 200, bodyHead: `non-JSON: ${rawText.slice(0, 200)}` });
        continue;
      }
      const models = extractModelIds(parsed);
      if (models.length > 0) return { models, sourceUrl: url };
      tried.push({
        url,
        status: 200,
        bodyHead: `parsed 0 models from response: ${rawText.slice(0, 200)}`,
      });
    } catch (err) {
      tried.push({ url, status: 0, bodyHead: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(timer);
    }
  }
  return { tried };
};

/** Extract model identifiers from the upstream response. Handles the common
 * shapes seen in the wild:
 *   - OpenAI / Anthropic standard: { data: [{id}, ...] }
 *   - bare array: [{id}, ...]
 *   - alt key: { models: [{id|name}, ...] } (some providers)
 *   - flat string array: ["m1", "m2"] or { data: ["m1", "m2"] }
 */
export function extractModelIds(body: unknown): string[] {
  const pickArray = (obj: unknown): unknown[] | null => {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === "object") {
      const r = obj as Record<string, unknown>;
      if (Array.isArray(r.data)) return r.data;
      if (Array.isArray(r.models)) return r.models;
      if (Array.isArray(r.results)) return r.results;
    }
    return null;
  };
  const arr = pickArray(body);
  if (!arr) return [];
  return arr
    .map((m): string | undefined => {
      if (typeof m === "string") return m;
      if (m && typeof m === "object") {
        const r = m as Record<string, unknown>;
        const candidates = [r.id, r.name, r.model, r.model_id, r.model_name];
        for (const c of candidates) if (typeof c === "string" && c.length > 0) return c;
      }
      return undefined;
    })
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .sort();
}
