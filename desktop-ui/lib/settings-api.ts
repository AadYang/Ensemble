import { apiError, apiFetch } from "@/lib/api";
import type { PlatformKey } from "@agentorch/shared";

export interface CliHealth {
  platformKey: PlatformKey;
  kind: "claude" | "codex";
  displayName: string;
  executableName: string;
  found: boolean;
  path: string | null;
  source: "manual" | "env" | "path" | "common-location" | "vendor" | "missing";
  manualPath: string | null;
  version?: string;
  versionTooOld?: boolean;
  minSupportedVersion?: string;
  configPath?: string | null;
  configPresent?: boolean;
  authStatus?: "present" | "missing" | "unknown";
  authPresent?: boolean;
  authPath?: string | null;
  recommendedInstallCommand: string;
  installCommands: Array<{ label: string; command: string }>;
  recommendedUpgradeCommand?: string | null;
  loginCommand?: string | null;
  docsUrl: string;
  error?: string;
}

export interface CliSettingsHealth {
  claude: CliHealth;
  codex: CliHealth;
}

export async function getCliSettings(): Promise<CliSettingsHealth> {
  const res = await apiFetch("/api/settings/cli");
  if (!res.ok) throw await apiError(res, "getCliSettings");
  return (await res.json()) as CliSettingsHealth;
}

export async function patchCliSettings(patch: {
  claudePath?: string | null;
  codexPath?: string | null;
}): Promise<CliSettingsHealth> {
  const res = await apiFetch("/api/settings/cli", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await apiError(res, "patchCliSettings");
  return (await res.json()) as CliSettingsHealth;
}
