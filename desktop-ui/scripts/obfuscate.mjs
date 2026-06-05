// Post-Next-build obfuscator for the static-out chunks. Layer 4 of the
// source-protection stack (the prior three are on the backend bundle).
//
// Browser performance matters here more than for the Node sidecar, so the
// settings are deliberately lighter than core/scripts/obfuscate.mjs:
//   - controlFlowFlattening: OFF — rewriting switch-case ladders breaks
//     React's hook ordering invariants and zustand's selector closures in
//     subtle ways that only show up in production. Symptom in 0.0.10:
//     pane split clicks update state but the LayoutRenderer never sees the
//     new tree. Disabling restores correctness; the only loss is one of
//     several anti-RE layers and the rest of the obfuscation pipeline
//     (identifier renaming, string-array encoding, splitStrings) is intact.
//   - deadCodeInjection: OFF (doubles chunk size — bandwidth penalty for
//     no security benefit in a packaged single-user app)
//   - selfDefending: OFF — wraps every transformed function with anti-
//     tamper guards that throw on certain re-formatting; React's strict-mode
//     double-invocation and zustand's set() can occasionally trip these in
//     production-only paths.
//   - debugProtection: OFF (would brick Chrome DevTools for support users)
//   - stringArrayEncoding: base64 instead of rc4 (cheaper to decode in a
//     browser's main thread)
//
// Net cost on this codebase: ~1.4-1.6x chunk size, ~5-10ms extra parse
// time per chunk on cold load. Negligible for desktop deployment.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(__dirname, "..");
const CHUNKS_DIR = path.join(UI_ROOT, "static-out", "_next", "static", "chunks");

if (!statSync(CHUNKS_DIR, { throwIfNoEntry: false })) {
  console.error(`[obfuscate-ui] chunks dir missing: ${CHUNKS_DIR}`);
  console.error("[obfuscate-ui] run `next build` first (NEXT_OUTPUT_EXPORT=1)");
  process.exit(1);
}

const files = walk(CHUNKS_DIR).filter((p) => p.endsWith(".js"));
console.log(`[obfuscate-ui] processing ${files.length} chunk(s)`);

let totalIn = 0;
let totalOut = 0;
const t0 = Date.now();
for (const file of files) {
  const src = readFileSync(file, "utf8");
  totalIn += Buffer.byteLength(src, "utf8");
  let obfuscated;
  try {
    obfuscated = JavaScriptObfuscator.obfuscate(src, {
      target: "browser",
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      identifierNamesGenerator: "hexadecimal",
      renameGlobals: false,
      stringArray: true,
      stringArrayThreshold: 0.7,
      stringArrayEncoding: ["base64"],
      stringArrayWrappersCount: 2,
      stringArrayWrappersChainedCalls: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      splitStrings: true,
      splitStringsChunkLength: 10,
      selfDefending: false,
      debugProtection: false,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
      sourceMap: false,
    }).getObfuscatedCode();
  } catch (err) {
    // Some Next chunks (e.g. polyfills) contain edge syntax that trips the
    // obfuscator's AST. Skip those; the unobfuscated chunk is no worse than
    // the pre-hardening baseline.
    console.warn(`[obfuscate-ui] SKIP ${path.relative(CHUNKS_DIR, file)}: ${(err && err.message) || err}`);
    continue;
  }
  writeFileSync(file, obfuscated);
  totalOut += Buffer.byteLength(obfuscated, "utf8");
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `[obfuscate-ui] ${(totalIn / 1024 / 1024).toFixed(2)} MB → ${(
    totalOut / 1024 / 1024
  ).toFixed(2)} MB  (${elapsed}s)`,
);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
