// Layer 2 of source protection: javascript-obfuscator pass over the
// minified CJS bundle from bundle.mjs. Produces an equivalent but
// dramatically harder-to-read variant.
//
// Settings are tuned for Node sidecar (target: 'node') with conservative
// options that don't break semantics our code depends on:
//   - renameGlobals OFF: would break CJS require()/module.exports plumbing
//   - transformObjectKeys OFF: too aggressive for esbuild's runtime helpers
//   - selfDefending ON: code refuses to run if its formatting is altered
//     (a beautifier pass breaks it on purpose)
//   - debugProtection ON: traps inside Chrome DevTools / Node --inspect
//     by detecting attached debuggers via timing & breakpoint loops
//   - stringArrayEncoding: rc4 — strings appear as opaque indices into an
//     encrypted lookup table; reversing requires running the table builder
//
// Compromise: ~2-5x slower for hot paths. Ensemble is I/O-bound (HTTP,
// child_process, WebSocket), so the wall-clock impact is negligible.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = path.resolve(__dirname, "..");
const INPUT = path.join(CORE_ROOT, "dist", "ensemble-core.cjs");
const OUTPUT = INPUT; // in-place replace; bundle.mjs already wrote it

console.log(`[obfuscate] reading ${INPUT}`);
const src = readFileSync(INPUT, "utf8");
const inputBytes = Buffer.byteLength(src, "utf8");

const t0 = Date.now();
const result = JavaScriptObfuscator.obfuscate(src, {
  target: "node",
  compact: true,
  // controlFlowFlattening + deadCodeInjection inject AST-randomized constructs
  // that occasionally produce JS that V8 rejects with cryptic SyntaxErrors at
  // runtime (one 0.0.2 build hit "Unexpected token '[' " inside the resulting
  // bundle). Both are disabled here. The remaining string-array + RC4 +
  // selfDefending + AES wrapper layer is the bulk of the protection anyway —
  // an attacker still needs to dump the in-memory decrypted bundle, traverse
  // the encrypted string table, and bypass self-defending.
  controlFlowFlattening: false,
  deadCodeInjection: false,
  // Identifier name strategy: hexadecimal yields _0x12ab style names that
  // are visually noisy but unambiguous to V8.
  identifierNamesGenerator: "hexadecimal",
  // Globals stay readable so CJS module plumbing keeps working.
  renameGlobals: false,
  // String array: every literal hidden behind a function lookup against an
  // encrypted (RC4) array. Reversing requires running the unpacker, which
  // hits selfDefending + debugProtection along the way.
  stringArray: true,
  stringArrayThreshold: 0.8,
  stringArrayEncoding: ["rc4"],
  stringArrayWrappersCount: 4,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: "function",
  stringArrayRotate: true,
  stringArrayShuffle: true,
  // Numbers split into algebraic expressions: `1234` becomes `0x123 + 0x4d2`.
  numbersToExpressions: true,
  // Splits long strings into concatenated chunks to thwart string-search
  // recovery.
  splitStrings: true,
  splitStringsChunkLength: 8,
  // Self-defending refuses to run if its bytes have been beautified, which
  // is the first step in any manual reverse-engineering attempt.
  selfDefending: true,
  // Trap debuggers attached via DevTools / --inspect. Detection is based on
  // execution timing + the `debugger` statement; raises the cost of dynamic
  // analysis substantially.
  debugProtection: true,
  debugProtectionInterval: 2000,
  // Transformations that have proven unsafe with esbuild's CJS helpers in
  // testing; keep OFF.
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  // No source maps in production. (esbuild already doesn't emit any.)
  sourceMap: false,
  // Reserved keywords we never want renamed (none today but slot is here
  // for future expansion).
  reservedNames: [],
});

const obfuscated = result.getObfuscatedCode();
writeFileSync(OUTPUT, obfuscated);
const outputBytes = Buffer.byteLength(obfuscated, "utf8");
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `[obfuscate] ${(inputBytes / 1024 / 1024).toFixed(2)} MB → ${(
    outputBytes / 1024 / 1024
  ).toFixed(2)} MB  (${elapsed}s)`,
);
console.log(`[obfuscate] → ${OUTPUT}`);
