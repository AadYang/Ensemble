// Loads the version manifest from disk and watches it for changes.
//
// Why hot-reload: ops should be able to push a new release by editing
// /opt/ensemble-server/manifest.json (or atomic-replacing it via scp +
// rename) without restarting the systemd service — restart cycles miss
// concurrent requests and trip nginx health probes.

import { readFileSync, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import type { UpdateManifest } from "@agentorch/shared";

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;

export class ManifestStore {
  private current: UpdateManifest | null = null;
  private etag: string = '"empty"';
  private lastModified: string = new Date(0).toUTCString();
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(private readonly path: string) {}

  start(): void {
    this.load();
    // Debounced re-load: editors save in two steps (truncate + write), and
    // atomic rename triggers multiple fs events. 200ms debounce avoids
    // double-reads + reading mid-write.
    this.watcher = watch(this.path, { persistent: false }, () => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.load(), 200);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
  }

  /** Snapshot of the latest manifest, or null until the first successful load. */
  get(): { manifest: UpdateManifest; etag: string; lastModified: string } | null {
    if (!this.current) return null;
    return { manifest: this.current, etag: this.etag, lastModified: this.lastModified };
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<UpdateManifest>;
      this.validate(parsed);
      this.current = parsed as UpdateManifest;
      // Strong ETag = sha256 of canonical JSON. Two writes producing
      // byte-identical content share the same ETag, so a 304 round-trip
      // saves the manifest bytes for the polling client.
      const canonical = JSON.stringify(this.current);
      this.etag = `"${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}"`;
      this.lastModified = new Date().toUTCString();
      const schema = this.current.schemaVersion ?? 1;
      console.log(
        `[manifest] loaded schema=${schema} version=${this.current.version} mandatory=${this.current.mandatory}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[manifest] load failed (${this.path}): ${msg}`);
      // Keep serving the prior good manifest if we had one — partial
      // writes / typos in the new file shouldn't take the endpoint down.
    }
  }

  private validate(m: Partial<UpdateManifest>): asserts m is UpdateManifest {
    const must = (cond: unknown, label: string): void => {
      if (!cond) throw new Error(`manifest invalid: ${label}`);
    };
    if (m.schemaVersion !== undefined) {
      must(typeof m.schemaVersion === "number" && m.schemaVersion >= 1, "schemaVersion");
    }
    if (m.compatVersion !== undefined) {
      must(typeof m.compatVersion === "string" && VERSION_RE.test(m.compatVersion), "compatVersion");
    }
    must(typeof m.version === "string" && VERSION_RE.test(m.version), "version");
    must(typeof m.publishedAt === "string" && !Number.isNaN(Date.parse(m.publishedAt)), "publishedAt");
    must(typeof m.downloadUrl === "string" && /^https:\/\//.test(m.downloadUrl), "downloadUrl (must be https://)");
    must(typeof m.sha256 === "string" && /^[0-9a-f]{64}$/i.test(m.sha256), "sha256 (64 hex chars)");
    must(typeof m.sizeBytes === "number" && m.sizeBytes > 0, "sizeBytes");
    must(typeof m.releaseNotes === "string", "releaseNotes");
    must(typeof m.mandatory === "boolean", "mandatory");
    must(
      typeof m.minSupportedVersion === "string" && VERSION_RE.test(m.minSupportedVersion),
      "minSupportedVersion",
    );
    // Optional per-platform asset map. Each entry must look like a sensible
    // installer descriptor — bad rows fail the whole manifest load, which
    // is preferable to silently shipping a 404 to the desktop fleet.
    if (m.platforms !== undefined) {
      must(typeof m.platforms === "object" && m.platforms !== null, "platforms (must be an object)");
      for (const [key, asset] of Object.entries(m.platforms as Record<string, unknown>)) {
        must(
          typeof asset === "object" && asset !== null,
          `platforms.${key} (must be an object)`,
        );
        const a = asset as {
          version?: unknown;
          publishedAt?: unknown;
          downloadUrl?: unknown;
          sha256?: unknown;
          sizeBytes?: unknown;
          releaseNotes?: unknown;
          mandatory?: unknown;
          minSupportedVersion?: unknown;
        };
        if (a.version !== undefined) {
          must(typeof a.version === "string" && VERSION_RE.test(a.version), `platforms.${key}.version`);
        }
        if (a.publishedAt !== undefined) {
          must(
            typeof a.publishedAt === "string" && !Number.isNaN(Date.parse(a.publishedAt)),
            `platforms.${key}.publishedAt`,
          );
        }
        must(
          typeof a.downloadUrl === "string" && /^https:\/\//.test(a.downloadUrl),
          `platforms.${key}.downloadUrl (must be https://)`,
        );
        must(
          typeof a.sha256 === "string" && /^[0-9a-f]{64}$/i.test(a.sha256),
          `platforms.${key}.sha256 (64 hex chars)`,
        );
        must(
          typeof a.sizeBytes === "number" && a.sizeBytes > 0,
          `platforms.${key}.sizeBytes`,
        );
        if (a.releaseNotes !== undefined) {
          must(typeof a.releaseNotes === "string", `platforms.${key}.releaseNotes`);
        }
        if (a.mandatory !== undefined) {
          must(typeof a.mandatory === "boolean", `platforms.${key}.mandatory`);
        }
        if (a.minSupportedVersion !== undefined) {
          must(
            typeof a.minSupportedVersion === "string" && VERSION_RE.test(a.minSupportedVersion),
            `platforms.${key}.minSupportedVersion`,
          );
        }
      }
    }
  }
}
