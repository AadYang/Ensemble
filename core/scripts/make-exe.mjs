// Node SEA → single ensemble-core executable (sidecar binary for Tauri shell, also
// runnable standalone).
//
// Pipeline:
//   1. node --experimental-sea-config sea-config.json   → dist/sea-prep.blob
//   2. cp <node binary> dist/ensemble-core(.exe)
//   3. npx postject inject blob into the executable

import { execFileSync, execSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = path.resolve(__dirname, "..");
const DIST = path.join(CORE_ROOT, "dist");
const SEA_CONFIG = path.join(CORE_ROOT, "sea-config.json");
const BLOB = path.join(DIST, "sea-prep.blob");
const EXE_NAME = process.platform === "win32" ? "ensemble-core.exe" : "ensemble-core";
const EXE = path.join(DIST, EXE_NAME);
const SEA_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const TARGET_NODE_BIN = findNodeSeaBinary();
const BUILD_NODE_BIN = process.env.ENSEMBLE_SEA_BUILD_NODE_BIN
  ? path.resolve(process.env.ENSEMBLE_SEA_BUILD_NODE_BIN)
  : process.execPath;

function hasSeaSentinel(nodeBin) {
  if (!fs.existsSync(nodeBin)) return false;
  const bytes = fs.readFileSync(nodeBin);
  return bytes.includes(Buffer.from(SEA_SENTINEL, "utf8"));
}

function findNodeSeaBinary() {
  const configured = process.env.ENSEMBLE_NODE_BIN
    ? path.resolve(process.env.ENSEMBLE_NODE_BIN)
    : null;
  if (configured) {
    validateNodeSeaBinary(configured);
    return configured;
  }
  if (hasSeaSentinel(process.execPath)) return process.execPath;

  const home = homedir();
  const candidates = [
    path.join(
      home,
      ".local",
      `node-${process.version}-${process.platform}-${process.arch}`,
      "bin",
      "node",
    ),
  ];
  const globRoots = [
    path.join(home, ".local"),
    path.join(home, ".nvm", "versions", "node"),
    path.join(home, ".fnm", "node-versions"),
    path.join(home, ".volta", "tools", "image", "node"),
  ];
  for (const root of globRoots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(path.join(root, entry.name, "bin", "node"));
      candidates.push(path.join(root, entry.name, "installation", "bin", "node"));
    }
  }

  for (const candidate of candidates) {
    if (hasSeaSentinel(candidate)) {
      console.warn(`[sea] using Node SEA binary: ${candidate}`);
      return candidate;
    }
  }

  console.error(
    [
      `[sea] Node binary does not contain the SEA sentinel: ${process.execPath}`,
      "Use an official Node.js binary, or set ENSEMBLE_NODE_BIN to one.",
    ].join("\n"),
  );
  process.exit(1);
}

function validateNodeSeaBinary(nodeBin) {
  if (!fs.existsSync(nodeBin)) {
    console.error(`[sea] Node binary not found: ${nodeBin}`);
    process.exit(1);
  }
  if (hasSeaSentinel(nodeBin)) return;
  console.error(
    [
      `[sea] Node binary does not contain the SEA sentinel: ${nodeBin}`,
      "Use an official Node.js binary, or set ENSEMBLE_NODE_BIN to one.",
    ].join("\n"),
  );
  process.exit(1);
}

function findPostjectBin() {
  if (process.env.POSTJECT_BIN && fs.existsSync(process.env.POSTJECT_BIN)) {
    return { command: process.env.POSTJECT_BIN, prefixArgs: [] };
  }

  const pathExts =
    process.platform === "win32" ? [".cmd", ".exe", ".ps1", ""] : ["", ".cmd"];
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of pathExts) {
      const candidate = path.join(dir, `postject${ext}`);
      if (fs.existsSync(candidate)) {
        return { command: candidate, prefixArgs: [] };
      }
    }
  }

  const localBin = path.resolve(
    CORE_ROOT,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "postject.cmd" : "postject",
  );
  if (fs.existsSync(localBin)) {
    return { command: localBin, prefixArgs: [] };
  }

  const npmCaches = [
    process.env.npm_config_cache,
    process.platform === "win32" ? null : path.join(homedir(), ".npm"),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "npm-cache")
      : null,
  ].filter(Boolean);
  for (const npmCache of npmCaches) {
    const npxRoot = path.join(npmCache, "_npx");
    if (!fs.existsSync(npxRoot)) continue;
    const entries = fs.readdirSync(npxRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(
        npxRoot,
        entry.name,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "postject.cmd" : "postject",
      );
      if (fs.existsSync(candidate)) {
        return { command: candidate, prefixArgs: [] };
      }
    }
  }

  return { command: "npx", prefixArgs: ["--yes", "postject"] };
}

function signDarwinExecutable(exe) {
  if (process.platform !== "darwin") return;
  const identity = process.env.ENSEMBLE_CODESIGN_IDENTITY ?? "-";
  console.log(`[sea] signing ${exe} with ${identity === "-" ? "ad-hoc identity" : identity} ...`);
  const r = spawnSync("codesign", ["--force", "--sign", identity, exe], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error("[sea] codesign failed");
    process.exit(r.status ?? 1);
  }
}

function verifyDarwinSeaSegment(exe) {
  if (process.platform !== "darwin") return;
  const out = execFileSync("otool", ["-l", exe], { encoding: "utf8" });
  if (!out.includes("segname NODE_SEA") || !out.includes("sectname __NODE_SEA_BLOB")) {
    console.error("[sea] macOS SEA blob must be injected into Mach-O segment NODE_SEA");
    process.exit(1);
  }
}

// step 1: blob
console.log("[sea] generating blob ...");
execSync(`"${BUILD_NODE_BIN}" --experimental-sea-config "${SEA_CONFIG}"`, {
  cwd: CORE_ROOT,
  stdio: "inherit",
});
const blobBytes = fs.statSync(BLOB).size;
console.log(`[sea] blob: ${(blobBytes / 1024 / 1024).toFixed(2)} MB`);

// step 2: copy node binary
console.log(`[sea] copying ${TARGET_NODE_BIN} → ${EXE} ...`);
fs.copyFileSync(TARGET_NODE_BIN, EXE);
fs.chmodSync(EXE, 0o755);

// step 3: postject inject
console.log("[sea] injecting blob via postject ...");
const postject = findPostjectBin();
const r = spawnSync(
  postject.command,
  [
    ...postject.prefixArgs,
    EXE,
    "NODE_SEA_BLOB",
    BLOB,
    "--sentinel-fuse",
    SEA_SENTINEL,
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ],
  { stdio: "inherit", shell: true },
);
if (r.status !== 0) {
  console.error("[sea] postject failed");
  process.exit(r.status ?? 1);
}
verifyDarwinSeaSegment(EXE);
signDarwinExecutable(EXE);

const exeBytes = fs.statSync(EXE).size;
console.log(
  `[sea] EXE: ${EXE}  (${(exeBytes / 1024 / 1024).toFixed(2)} MB)`,
);

// step 4: stage the static frontend next to the exe so the packaged binary
// finds it via `<exe-dir>/web/`. Source is desktop-ui/static-out (next export).
const WEB_SRC = path.resolve(CORE_ROOT, "..", "desktop-ui", "static-out");
const WEB_DST = path.join(DIST, "web");
if (fs.existsSync(WEB_SRC)) {
  fs.rmSync(WEB_DST, { recursive: true, force: true });
  fs.cpSync(WEB_SRC, WEB_DST, { recursive: true });
  console.log(`[sea] web → ${WEB_DST}`);
} else {
  console.warn(`[sea] WARN: ${WEB_SRC} missing — exe will start API/WS only mode`);
}

// step 5: extract tokenizer vocab JSON to dist/tokenizer-data. KEPT OUT of
// the SEA blob on purpose — embedding ~3 MB of high-entropy BPE bytes inside
// a signature-stripped node.exe triggers HEUR:Ransom/LockFile.g and friends.
// Plain .json files on disk are scanned as data, not code, and don't flag.
// Tauri's bundle.resources picks dist/tokenizer-data → install dir, where
// our paths.ts resolves it via AGENTORCH_TOKENIZER_DIR.
console.log("[sea] extracting tokenizer vocab data ...");
execSync(`"${BUILD_NODE_BIN}" "${path.join(__dirname, "extract-tokenizer-data.mjs")}"`, {
  cwd: CORE_ROOT,
  stdio: "inherit",
});
