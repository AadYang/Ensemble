// Bundle ensemble-core (ESM TS) → single CJS file for Node SEA.
// Output: core/dist/ensemble-core.cjs

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(CORE_ROOT, "src", "index.ts");
const OUT = path.join(CORE_ROOT, "dist", "ensemble-core.cjs");

// CJS output: SEA's V8 code cache only works for CJS. Source has no top-level
// await (listen() is wrapped in an IIFE) and only one createRequire site
// (llm-gateway.ts) — esbuild rewrites both correctly into CJS.
await build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: [
    // Node built-ins are kept as require() at runtime
    "node:sqlite",
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:os",
    "node:url",
    "node:module",
    "node:net",
    "node:http",
    "node:https",
    "node:stream",
    "node:events",
    "node:util",
    "node:buffer",
    "node:zlib",
    "node:child_process",
    "node:tty",
  ],
  // W20: @openai/codex-sdk does `createRequire(import.meta.url)` to load its
  // platform-specific native binary. In CJS bundles esbuild emits empty
  // `import_meta.url` shims (undefined) and createRequire blows up at startup.
  // Banner injects a CJS-valid URL; define rewrites every `import.meta.url`
  // reference to that identifier.
  define: {
    "import.meta.url": "__ensembleImportMetaUrl",
  },
  banner: {
    js: "// ensemble-core bundled (CJS)\nvar __ensembleImportMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  legalComments: "none",
  // Layer 1 of the protection stack: strip whitespace, mangle local identifiers,
  // drop comments. Cuts the bundle ~3x and stops casual "open in editor and
  // read it" reverse engineering. Tier 2 (javascript-obfuscator) and Tier 3
  // (SEA blob encryption) run on top of this in scripts/make-exe.mjs.
  //
  // NOTE: keepNames stays default (false) — none of our code relies on
  // Error.name / Function.name lookups. If a future dependency does, we'll
  // see a runtime crash and can flip it on.
  minify: true,
  drop: ["debugger"],
  logLevel: "info",
});

console.log(`[bundle] → ${OUT}`);
