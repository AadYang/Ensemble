import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEEPSEEK_OFFICIAL_MODELS,
  candidateModelsUrls,
  deepSeekOfficialModelsFallback,
  extractModelIds,
  probeModels,
} from "./model-discovery.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider model discovery", () => {
  it("keeps generic candidate URL behavior for non-DeepSeek providers", () => {
    expect(candidateModelsUrls("https://example.test/api")).toEqual([
      "https://example.test/api/v1/models",
      "https://example.test/api/models",
    ]);
    expect(candidateModelsUrls("https://example.test/v1")).toEqual([
      "https://example.test/v1/models",
    ]);
  });

  it("extracts model ids from common response shapes", () => {
    expect(extractModelIds({ data: [{ id: "b" }, { name: "a" }] })).toEqual(["a", "b"]);
    expect(extractModelIds({ models: ["m2", "m1"] })).toEqual(["m1", "m2"]);
    expect(extractModelIds({ results: [{ model_id: "x" }] })).toEqual(["x"]);
  });

  it("recognizes DeepSeek official Anthropic baseUrl as fixed-catalog fallback", () => {
    const fallback = deepSeekOfficialModelsFallback("https://api.deepseek.com/anthropic", "anthropic");
    expect(fallback?.models).toEqual(DEEPSEEK_OFFICIAL_MODELS);
    expect(fallback?.models[0]).toBe("deepseek-v4-flash");
  });

  it("recognizes DeepSeek official OpenAI baseUrl with or without /v1", () => {
    expect(deepSeekOfficialModelsFallback("https://api.deepseek.com", "openai")?.models).toEqual(
      DEEPSEEK_OFFICIAL_MODELS,
    );
    expect(deepSeekOfficialModelsFallback("https://api.deepseek.com/v1", "openai")?.models).toEqual(
      DEEPSEEK_OFFICIAL_MODELS,
    );
  });

  it("still reports generic probe failures instead of fallback for other hosts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
    } as Response);

    const result = await probeModels("https://example.test/api", "sk-test", "openai");
    expect("tried" in result).toBe(true);
    if ("tried" in result) {
      expect(result.tried.map((t) => t.url)).toEqual([
        "https://example.test/api/v1/models",
        "https://example.test/api/models",
      ]);
    }
  });
});
