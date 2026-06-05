// Manifest validation tests.
//
// The validate() routine in ManifestStore is the gate that decides whether
// a deployed manifest.json is served to the desktop fleet. Two principles
// it has to enforce simultaneously:
//
//   1. Backward compatibility — every previously-shipped manifest shape
//      must still load. The legacy top-level downloadUrl/sha256/sizeBytes
//      triple was the only download surface before 0.0.18, and the desktop
//      clients pinned to <= 0.0.17 still read it directly.
//
//   2. Per-platform asset map (introduced 0.0.18) — if `platforms` is
//      present, every entry must look like a valid installer descriptor.
//      A typo'd hash or non-https URL on production would silently ship
//      a 404 to all desktop users until ops noticed.
//
// These tests pin both behaviors so future schema work can't regress
// either side.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestStore } from "../manifest.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function stagedManifest(body: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-manifest-test-"));
  tempDirs.push(dir);
  const file = join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(body), "utf8");
  return file;
}

const VALID_LEGACY = {
  version: "0.0.17",
  publishedAt: "2026-05-18T00:00:00Z",
  downloadUrl: "https://ensemble-ai.cn/download/releases/Ensemble_0.0.17_x64-setup.exe",
  sha256: "0".repeat(64),
  sizeBytes: 42139041,
  releaseNotes: "legacy single-asset release",
  mandatory: false,
  minSupportedVersion: "0.0.1",
};

describe("ManifestStore validation", () => {
  it("accepts the pre-0.0.18 single-asset shape (no platforms key)", () => {
    const path = stagedManifest(VALID_LEGACY);
    const store = new ManifestStore(path);
    store.start();
    try {
      const snap = store.get();
      expect(snap?.manifest.version).toBe("0.0.17");
      expect(snap?.manifest.platforms).toBeUndefined();
    } finally {
      store.stop();
    }
  });

  it("accepts a 0.0.18-shape manifest with a populated platforms map", () => {
    const path = stagedManifest({
      ...VALID_LEGACY,
      version: "0.0.18",
      platforms: {
        "windows-x64": {
          downloadUrl: "https://ensemble-ai.cn/download/releases/Ensemble_0.0.18_x64-setup.exe",
          sha256: "a".repeat(64),
          sizeBytes: 42000000,
        },
        "macos-arm64": {
          downloadUrl: "https://ensemble-ai.cn/download/releases/Ensemble_0.0.18_aarch64.dmg",
          sha256: "b".repeat(64),
          sizeBytes: 38000000,
        },
      },
    });
    const store = new ManifestStore(path);
    store.start();
    try {
      const snap = store.get();
      expect(snap?.manifest.version).toBe("0.0.18");
      expect(snap?.manifest.platforms?.["windows-x64"]?.sha256).toBe("a".repeat(64));
      expect(snap?.manifest.platforms?.["macos-arm64"]?.downloadUrl).toContain("aarch64");
    } finally {
      store.stop();
    }
  });

  it("accepts a v2 manifest with independent per-platform versions", () => {
    const path = stagedManifest({
      ...VALID_LEGACY,
      schemaVersion: 2,
      compatVersion: "0.0.18",
      version: "0.0.21",
      platforms: {
        "windows-x64": {
          version: "0.0.21",
          publishedAt: "2026-05-26T01:00:00Z",
          downloadUrl: "https://ensemble-ai.cn/download/releases/Ensemble_0.0.21_x64-setup.exe",
          sha256: "a".repeat(64),
          sizeBytes: 42000000,
          releaseNotes: "Windows installer fix",
          mandatory: false,
          minSupportedVersion: "0.0.18",
        },
        "macos-arm64": {
          version: "0.0.19",
          publishedAt: "2026-05-26T02:00:00Z",
          downloadUrl: "https://ensemble-ai.cn/download/releases/Ensemble_0.0.19_aarch64.dmg",
          sha256: "b".repeat(64),
          sizeBytes: 59000000,
          releaseNotes: "macOS Codex provider fix",
          mandatory: true,
          minSupportedVersion: "0.0.19",
        },
      },
    });
    const store = new ManifestStore(path);
    store.start();
    try {
      const snap = store.get();
      expect(snap?.manifest.schemaVersion).toBe(2);
      expect(snap?.manifest.compatVersion).toBe("0.0.18");
      expect(snap?.manifest.platforms?.["windows-x64"]?.version).toBe("0.0.21");
      expect(snap?.manifest.platforms?.["macos-arm64"]?.mandatory).toBe(true);
    } finally {
      store.stop();
    }
  });

  it("rejects a non-https platform asset URL — would 404 the fleet", () => {
    const path = stagedManifest({
      ...VALID_LEGACY,
      platforms: {
        "windows-x64": {
          downloadUrl: "http://ensemble-ai.cn/download/insecure.exe",
          sha256: "a".repeat(64),
          sizeBytes: 1,
        },
      },
    });
    const store = new ManifestStore(path);
    store.start();
    try {
      // Validation failed → no snapshot served, /v1/version/latest will 503.
      expect(store.get()).toBeNull();
    } finally {
      store.stop();
    }
  });

  it("rejects a platform asset with a malformed sha256", () => {
    const path = stagedManifest({
      ...VALID_LEGACY,
      platforms: {
        "windows-x64": {
          downloadUrl: "https://ensemble-ai.cn/download/x.exe",
          sha256: "tooshort",
          sizeBytes: 1,
        },
      },
    });
    const store = new ManifestStore(path);
    store.start();
    try {
      expect(store.get()).toBeNull();
    } finally {
      store.stop();
    }
  });

  it("rejects a platform asset with zero or missing sizeBytes", () => {
    const path = stagedManifest({
      ...VALID_LEGACY,
      platforms: {
        "windows-x64": {
          downloadUrl: "https://ensemble-ai.cn/download/x.exe",
          sha256: "a".repeat(64),
          sizeBytes: 0,
        },
      },
    });
    const store = new ManifestStore(path);
    store.start();
    try {
      expect(store.get()).toBeNull();
    } finally {
      store.stop();
    }
  });
});
