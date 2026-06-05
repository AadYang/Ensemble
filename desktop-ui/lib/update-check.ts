// Talks to ensemble_server's version-manifest endpoint and decides whether
// the desktop app should prompt the user to upgrade.
//
// The manifest shape is defined in @agentorch/shared/update-manifest.ts —
// imported here so client and server agree at compile time.

import type { PlatformAsset, PlatformKey, UpdateManifest } from "@agentorch/shared";

const MANIFEST_URL = "https://ensemble-ai.cn/v1/version/latest";
const FETCH_TIMEOUT_MS = 6_000;

export interface ResolvedAsset {
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
}

export interface ResolvedRelease {
  version: string;
  publishedAt: string;
  releaseNotes: string;
  mandatory: boolean;
  minSupportedVersion: string;
}

export interface UpdateState {
  currentVersion: string;
  latest: UpdateManifest;
  release: ResolvedRelease;
  /** The installer URL + hash that applies to THIS client's platform/arch.
   *  Picked from `latest.platforms[<key>]` when present, falling back to the
   *  legacy top-level `downloadUrl/sha256/sizeBytes` triple. `null` means
   *  the release has no asset for this platform — the UI MUST suppress the
   *  upgrade prompt (better than handing a Windows EXE link to a Mac user). */
  asset: ResolvedAsset | null;
  /** True when the current platform release is strictly newer than currentVersion. */
  hasNewer: boolean;
  /** True when currentVersion is below latest.minSupportedVersion OR
   *  the current platform release is mandatory. UI should block dismiss in
   *  this case. */
  mustUpgrade: boolean;
}

/** Compare two dotted semver strings (e.g. "0.1.2" vs "0.1.10"). Numeric
 *  segment-by-segment. Pre-release suffixes ("-rc1") sort before the bare
 *  release. Returns -1 / 0 / +1 like a typical comparator. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const split = (v: string) => {
    const [main, pre] = v.split("-", 2);
    const segs = main.split(".").map((s) => parseInt(s, 10));
    return { segs, pre: pre ?? null };
  };
  const A = split(a);
  const B = split(b);
  const len = Math.max(A.segs.length, B.segs.length);
  for (let i = 0; i < len; i++) {
    const ai = A.segs[i] ?? 0;
    const bi = B.segs[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) continue;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  // Pre-release sorts before its bare release.
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  if (A.pre && B.pre) {
    if (A.pre < B.pre) return -1;
    if (A.pre > B.pre) return 1;
  }
  return 0;
}

/** Read this app instance's version. Falls back to a hardcoded sentinel
 *  when running outside Tauri (next dev in a regular browser tab) so the
 *  comparator still has something to chew on for diagnostics. */
export async function getCurrentVersion(): Promise<string> {
  try {
    // Dynamic import: keeps the @tauri-apps/api dependency out of the
    // bundle's initial chunk and avoids a build-time error if the package
    // ever moves to a sub-export.
    const mod = await import("@tauri-apps/api/app");
    return await mod.getVersion();
  } catch {
    return "0.0.0";
  }
}

/** Hit the manifest endpoint with a hard timeout. Throws on non-2xx or
 *  network failure — callers should decide whether to surface the error
 *  (manual check) or swallow it silently (launch auto-check). */
export async function fetchLatestManifest(): Promise<UpdateManifest> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MANIFEST_URL, {
      signal: ctrl.signal,
      // We don't send any cookies/credentials — the API is public.
      credentials: "omit",
      // Pull a fresh copy on manual checks; auto-check tolerates a stale
      // cached body since the server-side Cache-Control is 5 minutes.
      cache: "no-cache",
    });
    if (!res.ok) {
      throw new Error(`manifest ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as UpdateManifest;
  } finally {
    clearTimeout(timer);
  }
}

/** Detect this client's platform/arch in the shape used by the manifest's
 *  `platforms` keys (e.g. "macos-arm64"). Returns null when we can't infer
 *  one — in that case the caller falls back to the legacy single URL. */
export function detectPlatformKey(): PlatformKey | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent.toLowerCase();
  // navigator.platform is deprecated but still the most reliable signal we
  // have inside the webview without a Tauri IPC round-trip. The Tauri-side
  // `platform` env var was already plumbed to ENSEMBLE_PLATFORM but the
  // webview can't read it directly; UA sniff is good enough for picking
  // between windows / macos / linux + arm64 / x64.
  const platform = ((navigator as { platform?: string }).platform ?? "").toLowerCase();
  const isMac = platform.includes("mac") || ua.includes("mac os x") || ua.includes("macintosh");
  const isWin = platform.includes("win") || ua.includes("windows");
  const isLinux = platform.includes("linux") || ua.includes("linux");
  // "arm64" is what Apple Silicon UAs include. Intel Macs and most Windows
  // builds report x86/x64. We don't try to be cute about i686 — Ensemble's
  // installer matrix is 64-bit only.
  const isArm64 = ua.includes("arm64") || ua.includes("aarch64") ||
    (isMac && ua.includes("mac os x") && /apple silicon|m[1-4]/i.test(ua));
  const arch = isArm64 ? "arm64" : "x64";
  if (isMac) return `macos-${arch}` as PlatformKey;
  if (isWin) return `windows-${arch}` as PlatformKey;
  if (isLinux) return `linux-${arch}` as PlatformKey;
  return null;
}

/** Pick the per-platform asset from the manifest, falling back to the
 *  legacy top-level fields ONLY when no `platforms` map is present.
 *
 *  If `platforms` IS present and contains no entry for this client's key,
 *  return null — the release explicitly does not ship for this platform
 *  and we MUST NOT show a download URL meant for some other OS. */
export function resolveAssetForThisPlatform(manifest: UpdateManifest): ResolvedAsset | null {
  const key = detectPlatformKey();
  const entry = key ? manifest.platforms?.[key] : undefined;
  if (entry) {
    return {
      downloadUrl: entry.downloadUrl,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
    };
  }
  if (manifest.platforms && key) {
    // platforms is present but has no entry for us → no installer published
    // for this platform in this release. Suppress the prompt instead of
    // falling back to the legacy field (which historically was Windows-only).
    return null;
  }
  // Legacy / pre-`platforms` manifest. Treat the top-level fields as a
  // single Windows asset, since that's all `downloadUrl` ever meant. On
  // non-Windows clients we still return it — the dialog's clipboard fallback
  // lets the user salvage the URL even if it's wrong for their OS.
  return {
    downloadUrl: manifest.downloadUrl,
    sha256: manifest.sha256,
    sizeBytes: manifest.sizeBytes,
  };
}

export function resolveReleaseForThisPlatform(manifest: UpdateManifest): ResolvedRelease | null {
  const key = detectPlatformKey();
  const entry: PlatformAsset | undefined = key ? manifest.platforms?.[key] : undefined;
  if (manifest.platforms && key && !entry) return null;
  return {
    version: entry?.version ?? manifest.version,
    publishedAt: entry?.publishedAt ?? manifest.publishedAt,
    releaseNotes: entry?.releaseNotes ?? manifest.releaseNotes,
    mandatory: entry?.mandatory ?? manifest.mandatory,
    minSupportedVersion: entry?.minSupportedVersion ?? manifest.minSupportedVersion,
  };
}

/** One-shot evaluation. Returns null when the manifest endpoint is
 *  unreachable, so callers can decide between silent-no-op (auto-check)
 *  and explicit error toast (manual). */
export async function checkForUpdates(): Promise<UpdateState | null> {
  let manifest: UpdateManifest;
  try {
    manifest = await fetchLatestManifest();
  } catch (err) {
    console.warn("[update] manifest fetch failed", err);
    return null;
  }
  const currentVersion = await getCurrentVersion();
  const release = resolveReleaseForThisPlatform(manifest);
  if (!release) return null;
  const hasNewer = compareSemver(currentVersion, release.version) < 0;
  const belowFloor = compareSemver(currentVersion, release.minSupportedVersion) < 0;
  const asset = resolveAssetForThisPlatform(manifest);
  return {
    currentVersion,
    latest: manifest,
    release,
    asset,
    hasNewer,
    mustUpgrade: hasNewer && (release.mandatory || belowFloor),
  };
}

/** Hand the upgrade URL off to the system default browser. The Tauri
 *  capabilities.json only permits opening URLs that match our domain — so
 *  this can't be coerced into opening arbitrary hosts even if a future
 *  manifest were tampered with. */
export async function openUpgradeUrl(url: string): Promise<void> {
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(url);
}
