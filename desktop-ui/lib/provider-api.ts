import { apiError, apiFetch } from "@/lib/api";
import type { PlatformKey } from "@agentorch/shared";

export type ProviderKind =
  | "anthropic-local"
  | "anthropic"
  | "openai-local"
  | "openai-codex"
  | "openai-compat";

/** W20: codex sandbox modes (mirrors @openai/codex-sdk's SandboxMode union). */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ProviderDTO {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  hasApiKey: boolean;
  /** Legacy field kept on the DTO so deprecated rows (autoManaged=true,
   *  disabled=true) still round-trip. New code should never set this — POST
   *  /providers rejects autoManaged=true with 400. */
  autoManaged: boolean;
  /** Legacy field; only meaningful on deprecated autoManaged rows. */
  upstreamProvider: string | null;
  /** Legacy field; only meaningful on deprecated autoManaged rows. */
  upstreamModel: string | null;
  models: string[];
  isDefault: boolean;
  disabled: boolean;
  deprecated: string | null;
  deprecatedReason: string | null;
  currentPlatformKey?: PlatformKey;
  currentRuntime?: {
    platformKey: PlatformKey;
    cliPath: string | null;
    cliVersion: string | null;
    cliVersionTooOld?: boolean;
    cliMinSupportedVersion?: string | null;
    authPath: string | null;
    authPresent: boolean;
    models: string[];
    defaultSandbox?: SandboxMode | string | null;
    lastHealthAt: string;
    lastError?: string | null;
  } | null;
  runtimes?: Partial<Record<PlatformKey, ProviderDTO["currentRuntime"]>>;
  /** W20: openai-codex providers expose codex CLI / auth health flags here. */
  codexCliMissing?: boolean;
  authMissing?: boolean;
  codexCliVersion?: string;
  codexCliVersionTooOld?: boolean;
  codexCliMinSupportedVersion?: string;
  /** W20: openai-codex per-provider default sandbox mode. */
  defaultSandbox?: SandboxMode | null;
  createdAt: string;
}

export async function listProviders(): Promise<ProviderDTO[]> {
  const res = await apiFetch("/api/providers");
  if (!res.ok) throw new Error(`listProviders: ${res.status}`);
  return (await res.json()) as ProviderDTO[];
}

export async function createProvider(input: {
  name: string;
  kind: ProviderKind;
  baseUrl?: string | null;
  apiKey?: string | null;
  isDefault?: boolean;
  models?: string[];
  /** W20: openai-codex providers seed defaultSandbox at creation. */
  defaultSandbox?: SandboxMode | null;
}): Promise<ProviderDTO> {
  const res = await apiFetch("/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res, "createProvider");
  return (await res.json()) as ProviderDTO;
}

export async function patchProvider(
  id: string,
  patch: {
    name?: string;
    baseUrl?: string | null;
    apiKey?: string;
    isDefault?: boolean;
    models?: string[];
    /** W20: openai-codex providers can update defaultSandbox. */
    defaultSandbox?: SandboxMode | null;
  },
): Promise<ProviderDTO> {
  const res = await apiFetch(`/api/providers/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await apiError(res, "patchProvider");
  return (await res.json()) as ProviderDTO;
}

export async function deleteProvider(id: string): Promise<void> {
  const res = await apiFetch(`/api/providers/${id}`, { method: "DELETE" });
  if (!res.ok) throw await apiError(res, "deleteProvider");
}

export async function migrateDeprecatedProvider(
  id: string,
  body: { name?: string; baseUrl?: string; apiKey?: string } = {},
): Promise<ProviderDTO> {
  const res = await apiFetch(`/api/providers/${id}/migrate-from-deprecated`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res, "migrateDeprecatedProvider");
  return (await res.json()) as ProviderDTO;
}

export interface RefreshResult extends ProviderDTO {
  discovered?: { count: number; source: string };
}

export async function refreshProviderModels(id: string): Promise<RefreshResult> {
  const res = await apiFetch(`/api/providers/${id}/refresh-models`, { method: "POST" });
  if (!res.ok) {
    // Server returns 502 + {error, message, tried[]} when no URL yielded models.
    // Each tried entry has bodyHead — preserve it so the user can paste back
    // when reporting an upstream that uses a non-standard model-list shape.
    const body = (await res.json().catch(() => null)) as
      | {
          error?: string;
          message?: string;
          tried?: Array<{ url: string; status: number; bodyHead?: string }>;
        }
      | null;
    const detail = body?.message ?? body?.error ?? `${res.status}`;
    const tried =
      body?.tried
        ?.map((t) => `\n  • ${t.url} → ${t.status}${t.bodyHead ? `\n    ${t.bodyHead}` : ""}`)
        .join("") ?? "";
    throw new Error(tried ? `${detail}\ntried:${tried}` : detail);
  }
  return (await res.json()) as RefreshResult;
}
