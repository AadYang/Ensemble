// Wire format for the ensemble_server `GET /v1/version/latest` response.
// Both the server and the desktop client import this type so the contract
// is enforced at compile time on both sides.

/** Per-platform installer metadata. We keep this open-ended so a future
 *  asset (DEB / MSIX / linux-arm64) can be added without bumping a major
 *  schema version. Clients that don't recognize a key MUST ignore it. */
export interface PlatformAsset {
  /** Latest version for this platform asset. Manifest v2 clients compare this
   *  field instead of the legacy top-level `version`. */
  version?: string;
  /** ISO 8601 publish timestamp for this platform release. Falls back to the
   *  top-level `publishedAt` when omitted. */
  publishedAt?: string;
  /** Direct download URL for this platform's installer asset. nginx serves
   *  these as static byte-range files. */
  downloadUrl: string;
  /** SHA-256 of the asset, hex-encoded. Client SHOULD verify after download
   *  and refuse to launch on mismatch. */
  sha256: string;
  /** Asset size in bytes. UI uses this for progress bars / size hint. */
  sizeBytes: number;
  /** Platform-specific release notes. Falls back to top-level releaseNotes. */
  releaseNotes?: string;
  /** Platform-specific mandatory update flag. Falls back to top-level
   *  mandatory. */
  mandatory?: boolean;
  /** Versions of THIS platform strictly older than this MUST update. Falls
   *  back to top-level minSupportedVersion. */
  minSupportedVersion?: string;
}

/** Map key = `${platform}-${arch}` where platform ∈ {windows, macos, linux}
 *  and arch ∈ {x64, arm64}. Clients pick the entry that matches their own
 *  build. A version that has no asset for the client's platform/arch SHOULD
 *  be treated as "no update available" — the update prompt is suppressed
 *  rather than handing the user a download URL for the wrong OS. */
export type PlatformKey =
  | "windows-x64"
  | "windows-arm64"
  | "macos-x64"
  | "macos-arm64"
  | "linux-x64"
  | "linux-arm64";

export interface UpdateManifest {
  /** Manifest schema version. Undefined/1 = legacy top-level release. 2 =
   *  platform assets may carry independent version/policy fields. */
  schemaVersion?: number;
  /** Shared compatibility floor for database/protocol/core constraints. This
   *  is distinct from per-platform installer versions. */
  compatVersion?: string;
  /** Latest publicly released version, semver. */
  version: string;
  /** ISO 8601 publish timestamp. */
  publishedAt: string;
  /** LEGACY single download URL — the Windows NSIS installer. Kept on the
   *  wire so pre-`platforms` clients (≤ 0.0.17) keep working. Newer clients
   *  prefer `platforms[<their-key>].downloadUrl` and fall back to this only
   *  when no platform-specific asset is published. */
  downloadUrl: string;
  /** Legacy companion to `downloadUrl`. Same fallback semantics. */
  sha256: string;
  /** Legacy companion to `downloadUrl`. Same fallback semantics. */
  sizeBytes: number;
  /** New (≥ 0.0.18): per-platform asset map. When present, clients running
   *  a new-enough build pick the entry matching their platform/arch. Absent
   *  entries mean "no installer for this platform in this release" and the
   *  client SHOULD NOT prompt the user — better than showing the Windows
   *  EXE link to a macOS user (the pre-fix bug). */
  platforms?: Partial<Record<PlatformKey, PlatformAsset>>;
  /** Short markdown summary shown in the in-app update dialog. */
  releaseNotes: string;
  /** When true, client should refuse to keep running without updating
   *  (e.g., security-critical patch, breaking protocol change). */
  mandatory: boolean;
  /** Versions strictly older than this MUST update. Independent of
   *  `mandatory`: a non-mandatory release can still raise the floor by
   *  bumping minSupportedVersion. */
  minSupportedVersion: string;
}
