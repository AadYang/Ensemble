// Curated presets for known runtime-compatible upstreams.
// When the user picks a preset, the form fills baseUrl + models — saving
// them from hunting docs and protects against typos in model ids.
//
// `runtime` tags which runtime side the preset belongs to so the form can
// hide presets that don't match the user's current Claude/OpenAI selection.
//
// Models lists are best-effort snapshots; the manual textarea always wins,
// so a stale preset just means user has to delete a row, not "broken".

export interface ProviderPreset {
  id: string;
  label: string;
  /** Which runtime this preset is meant for. */
  runtime: "claude" | "openai";
  baseUrl: string;
  models: string[];
  /** Source URL where the model list was looked up (for verification when
   *  the upstream rotates models). */
  docsUrl?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── Claude (Anthropic-compat) endpoints ─────────────────────────────
  {
    id: "minimax",
    label: "MiniMax 海螺",
    runtime: "claude",
    baseUrl: "https://api.minimaxi.com/anthropic",
    models: [
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ],
    docsUrl: "https://platform.minimaxi.com/docs/api-reference/text-anthropic-api",
  },
  {
    id: "deepseek-anthropic",
    label: "DeepSeek (Anthropic)",
    runtime: "claude",
    baseUrl: "https://api.deepseek.com/anthropic",
    models: ["deepseek-chat", "deepseek-reasoner"],
    docsUrl: "https://api-docs.deepseek.com/guides/anthropic_api",
  },
  {
    id: "zhipu-anthropic",
    label: "智谱 GLM (Anthropic)",
    runtime: "claude",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    models: ["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5-x"],
    docsUrl: "https://open.bigmodel.cn/dev/howuse/claude",
  },
  // ── OpenAI-compat endpoints (Slice 2 onwards) ───────────────────────
  {
    id: "deepseek-openai",
    label: "DeepSeek (OpenAI)",
    runtime: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    docsUrl: "https://api-docs.deepseek.com/",
  },
  {
    id: "zhipu-openai",
    label: "智谱 GLM (OpenAI)",
    runtime: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5-x"],
    docsUrl: "https://open.bigmodel.cn/dev/api",
  },
];
