// Build ensemble-core SEA executable and stage it at
// src-tauri/binaries/ensemble-core-<rust-target-triple>(.exe) so Tauri can find
// it as a sidecar binary (per `bundle.externalBin` in tauri.conf.json).

import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT, "src-tauri", "binaries");
const srcExt = process.platform === "win32" ? ".exe" : "";
const SRC_EXE = path.join(ROOT, "core", "dist", `ensemble-core${srcExt}`);

// Tauri requires the sidecar binary to be named with the rustc host target
// triple as suffix. Derive from Node platform/arch to avoid depending on rustc
// being on PATH (PowerShell-installed rustup may not propagate to bash).
const PLATFORM_MAP = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};
const key = `${process.platform}-${process.arch}`;
const targetTriple = process.env.TAURI_TARGET_TRIPLE ?? PLATFORM_MAP[key];
if (!targetTriple) {
  console.error(`[prep-sidecar] no target triple known for ${key}; set TAURI_TARGET_TRIPLE`);
  process.exit(1);
}
if (targetTriple === "universal-apple-darwin") {
  console.error(
    [
      "[prep-sidecar] universal macOS sidecars are not produced by this script.",
      "Build aarch64-apple-darwin and x86_64-apple-darwin separately, then combine them with lipo in a dedicated release workflow.",
    ].join("\n"),
  );
  process.exit(1);
}
const targetPlatform = targetTriple.includes("apple-darwin")
  ? "darwin"
  : targetTriple.includes("windows")
    ? "win32"
    : targetTriple.includes("linux")
      ? "linux"
      : null;
const targetArch = targetTriple.startsWith("aarch64")
  ? "arm64"
  : targetTriple.startsWith("x86_64")
    ? "x64"
    : null;
if (targetPlatform && targetPlatform !== process.platform) {
  console.error(
    [
      `[prep-sidecar] cannot build ${targetTriple} sidecar on ${key}.`,
      "Run this on the matching OS so the Node SEA binary matches the Tauri target.",
    ].join("\n"),
  );
  process.exit(1);
}
if (targetArch && targetArch !== process.arch && !process.env.ENSEMBLE_NODE_BIN) {
  console.error(
    [
      `[prep-sidecar] ${targetTriple} needs a ${targetArch} Node SEA binary, current Node is ${process.arch}.`,
      "Set ENSEMBLE_NODE_BIN to an official Node binary for that architecture.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`[prep-sidecar] target: ${targetTriple}`);

// Always rebuild — checking existsSync silently shipped a stale sidecar last
// time when only core/ source changed but the .exe was still on disk.
console.log("[prep-sidecar] (re)building ensemble-core ...");
execSync("pnpm -F @ensemble/core package", { cwd: ROOT, stdio: "inherit" });

if (!existsSync(SRC_EXE)) {
  console.error(`[prep-sidecar] expected ${SRC_EXE} after build, missing`);
  process.exit(1);
}

mkdirSync(BIN_DIR, { recursive: true });
const dstExt = targetTriple.includes("windows") ? ".exe" : "";
const dstExe = path.join(BIN_DIR, `ensemble-core-${targetTriple}${dstExt}`);
copyFileSync(SRC_EXE, dstExe);
chmodSync(dstExe, 0o755);
console.log(`[prep-sidecar] copied → ${dstExe}`);
