// Pull js-tiktoken's vocab data out of its bundled .cjs modules and write it
// as plain .json files. Critically these JSON files are NOT bundled into the
// SEA EXE — they ship as separate Tauri resources alongside the executable.
//
// Why: the cl100k_base / o200k_base BPE merge tables are ~1 MB and ~2 MB of
// base64-packed high-entropy bytes. When esbuild inlines them into the CJS
// bundle and postject injects the bundle into a copy of node.exe, the
// resulting EXE has stripped MS signatures + huge high-entropy embedded
// blob — perfect false-positive bait for ransomware heuristics
// (HEUR:Ransom/LockFile.g on Kaspersky etc.). Splitting the vocab into
// stand-alone .json files defangs the heuristic entirely: data files on
// disk are not scanned as executable code.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(CORE_ROOT, "dist", "tokenizer-data");

const req = createRequire(import.meta.url);

const ENCODINGS = ["cl100k_base", "o200k_base"];

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const enc of ENCODINGS) {
  const mod = req(`js-tiktoken/ranks/${enc}`);
  const data = mod.default ?? mod;
  if (!data || !data.pat_str || !data.bpe_ranks) {
    throw new Error(`[extract-tokenizer-data] ${enc}: unexpected module shape`);
  }
  const outPath = path.join(OUT_DIR, `${enc}.json`);
  fs.writeFileSync(outPath, JSON.stringify(data));
  const size = fs.statSync(outPath).size;
  console.log(`[tokenizer-data] ${enc}.json → ${(size / 1024).toFixed(0)} KB`);
}

console.log(`[tokenizer-data] → ${OUT_DIR}`);
