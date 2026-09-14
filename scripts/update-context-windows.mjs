// W22 Slice 7.2: refresh core/src/context-windows.json from LiteLLM's
// model_prices_and_context_window.json snapshot.
//
// We deliberately do NOT ship the whole LiteLLM catalog (2.3MB). Instead we
// keep a filtered snapshot covering the providers Ensemble actually talks to:
//   - official anthropic / openai (Claude / GPT)
//   - the openai-compat providers users commonly wire up: deepseek, glm
//     (z.ai / zhipu), qwen (dashscope), kimi/moonshot, minimax
//
// Key normalization: LiteLLM keys look like `deepseek/deepseek-chat`; we strip
// the provider prefix to the bare model id (`deepseek-chat`). On prefix
// collision we keep the first entry and warn, so `resolveContextWindow` can do
// exact bare-id lookups without knowing which provider the user selected.
//
// Usage: `node scripts/update-context-windows.mjs`

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "core", "src", "context-windows.json");

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Provider prefixes we keep. Matching is case-insensitive on the segment
// before the first `/`.
const PROVIDER_PREFIXES = new Set([
  "anthropic",
  "openai",
  // DeepSeek
  "deepseek",
  // GLM / Zhipu (z.ai)
  "zai",
  "zhipuai",
  "zhipu",
  "bigmodel",
  // Qwen / Alibaba
  "qwen",
  "dashscope",
  "alibaba",
  // Kimi / Moonshot
  "moonshot",
  "moonshotai",
  "kimi",
  // MiniMax
  "minimax",
  "minimaxai",
]);

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Split a LiteLLM key into [prefix, bareModelId]. Keys without a `/` are
 *  already bare (rare) and get a null prefix. */
function splitKey(key) {
  const idx = key.indexOf("/");
  if (idx < 0) return { prefix: null, bare: key };
  return { prefix: key.slice(0, idx), bare: key.slice(idx + 1) };
}

async function main() {
  const res = await fetch(LITELLM_URL, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  }
  const catalog = await res.json();

  const models = {};
  const collisions = [];
  let kept = 0;

  for (const [key, entry] of Object.entries(catalog)) {
    if (!entry || typeof entry !== "object") continue;
    const { prefix, bare } = splitKey(key);
    if (prefix !== null && !PROVIDER_PREFIXES.has(prefix.toLowerCase())) continue;

    const maxInputTokens = num(entry.max_input_tokens);
    if (maxInputTokens === null || maxInputTokens <= 0) continue;
    const maxOutputTokens = num(entry.max_output_tokens) ?? num(entry.max_tokens);

    const record = { maxInputTokens };
    if (maxOutputTokens !== null && maxOutputTokens > 0) record.maxOutputTokens = maxOutputTokens;

    if (Object.prototype.hasOwnProperty.call(models, bare)) {
      collisions.push(bare);
      continue; // keep the first occurrence
    }
    models[bare] = record;
    kept += 1;
  }

  const version = new Date().toISOString().slice(0, 10);
  const table = {
    version,
    note: `maxInputTokens/maxOutputTokens per model. Source: LiteLLM model_prices_and_context_window.json snapshot (${version}). Refresh: node scripts/update-context-windows.mjs.`,
    models,
  };

  writeFileSync(OUT, JSON.stringify(table, null, 2) + "\n", "utf8");

  // eslint-disable-next-line no-console
  console.log(`[context-windows] wrote ${kept} models → ${OUT}`);
  if (collisions.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[context-windows] ${collisions.length} prefix collisions kept-first: ${collisions.slice(0, 20).join(", ")}${collisions.length > 20 ? ", …" : ""}`);
  }
}

main().catch((err) => {
  console.error(`[context-windows] failed: ${err.message}`);
  process.exit(1);
});
