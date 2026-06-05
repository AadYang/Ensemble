// Local tokenizer for billing audit. js-tiktoken's "lite" entry point ships
// ~9 KB of pure-JS BPE decoder code — no vocab tables. The vocab files
// (cl100k_base.json / o200k_base.json) live OUTSIDE the SEA EXE as Tauri
// resource files. This is deliberate: embedding ~3 MB of high-entropy
// vocab bytes inside a signature-stripped SEA EXE triggers ransomware
// heuristics (HEUR:Ransom/LockFile.g on Kaspersky etc.). Loading them
// from plain JSON on disk lets the executable stay small and benign.
//
// IMPORTANT CAVEATS — keep in sync with the README/Tutorial:
//
//  1. These encodings are CORRECT for OpenAI's own models. For openai-compat
//     providers using their own tokenizer (DeepSeek's BPE, GLM, MiniMax, etc.)
//     the count is an APPROXIMATION — vocabulary differences alone can produce
//     ±10-30% drift. That drift is NOT a billing irregularity.
//  2. We count only the user-visible text we send (system + history + prompt)
//     and the text we receive back. Upstream tokenizers also count tool/
//     function-call schemas, hidden system instructions, image tile overheads
//     etc., which we don't see → upstream count will typically run higher.
//  3. Use the local count as a SANITY CHECK, not a contract. Flag wild
//     deviations (>2x), not steady-state offsets.
//  4. If the vocab JSON files are missing (e.g., user deleted the
//     tokenizer-data dir, or it never shipped in dev mode), countTokens
//     silently returns 0. The audit column then shows "—" rather than
//     misleading numbers.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Tiktoken, type TiktokenBPE } from "js-tiktoken/lite";
import { TOKENIZER_DATA_DIR } from "./paths.js";

type EncodingName = "cl100k_base" | "o200k_base";

const O200K_MODEL_PREFIXES = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.5",
  "gpt-5",
  "o1",
  "o3",
  "o4",
];

function pickEncodingName(model: string): EncodingName {
  const m = (model ?? "").toLowerCase();
  if (O200K_MODEL_PREFIXES.some((p) => m.startsWith(p))) return "o200k_base";
  return "cl100k_base";
}

// Cache per-encoding so we only pay the JSON-parse + Tiktoken-construct cost
// once per process. null means "we tried and the file isn't available".
const cache = new Map<EncodingName, Tiktoken | null>();

function getEncoder(name: EncodingName): Tiktoken | null {
  if (cache.has(name)) return cache.get(name) ?? null;
  const path = join(TOKENIZER_DATA_DIR, `${name}.json`);
  if (!existsSync(path)) {
    console.warn(
      `[tokenizer] vocab file missing: ${path} — local token audit disabled for this encoding`,
    );
    cache.set(name, null);
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as TiktokenBPE;
    const enc = new Tiktoken(data);
    cache.set(name, enc);
    return enc;
  } catch (err) {
    console.warn(
      `[tokenizer] failed to load ${name}.json: ${(err as Error).message} — local token audit disabled`,
    );
    cache.set(name, null);
    return null;
  }
}

/** Count tokens for arbitrary text under the best-fit encoding. Returns 0
 *  on empty input, missing vocab file, or encoder failure — local audit
 *  is best-effort, never the critical path. */
export function countTokens(model: string, text: string): number {
  if (!text) return 0;
  const enc = getEncoder(pickEncodingName(model));
  if (!enc) return 0;
  try {
    return enc.encode(text).length;
  } catch {
    return 0;
  }
}

/** Sum token counts across many strings. */
export function countTokensMany(model: string, texts: readonly string[]): number {
  if (texts.length === 0) return 0;
  const enc = getEncoder(pickEncodingName(model));
  if (!enc) return 0;
  let total = 0;
  for (const t of texts) {
    if (!t) continue;
    try {
      total += enc.encode(t).length;
    } catch {
      /* skip individual failures */
    }
  }
  return total;
}

/** Test-only seam to clear the cache between tests. */
export function __resetTokenizerCacheForTest(): void {
  cache.clear();
}
