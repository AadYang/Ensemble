import { describe, expect, it } from "vitest";
import {
  catalogHasDescriptions,
  discoveredDeclareWindow,
  findProviderModel,
  parseProviderModelCatalog,
  parseProviderModelInfo,
  providerModelLabel,
  readProviderModelCatalog,
} from "./provider-model.js";

describe("parseProviderModelInfo", () => {
  it("keeps Claude CLI alias rows with resolved id, description and effort ladder", () => {
    expect(
      parseProviderModelInfo({
        value: "opus",
        displayName: "Opus",
        description: "Most capable Claude model",
        resolvedModel: "claude-opus-4-8",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      }),
    ).toEqual({
      id: "opus",
      displayName: "Opus",
      description: "Most capable Claude model",
      resolvedId: "claude-opus-4-8",
      supportsEffort: true,
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("keeps Codex catalog display_name and supported_reasoning_levels", () => {
    expect(
      parseProviderModelInfo({
        slug: "gpt-6-astra",
        display_name: "GPT-6-Astra",
        description: "Frontier Codex model",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default_reasoning_level: "high",
      }),
    ).toEqual({
      id: "gpt-6-astra",
      displayName: "GPT-6-Astra",
      description: "Frontier Codex model",
      reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningLevel: "high",
    });
  });

  it("keeps Codex object-shaped supported_reasoning_levels", () => {
    expect(
      parseProviderModelInfo({
        slug: "gpt-6.1-sol",
        display_name: "GPT-6.1-Sol",
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
          { effort: "high", description: "Greater reasoning depth for complex problems" },
          { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
          { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
          { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
        ],
      }),
    ).toEqual({
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningLevel: "low",
    });
  });

  it("keeps Codex context_window, max_context_window and percent", () => {
    expect(
      parseProviderModelInfo({
        slug: "gpt-6.1-sol",
        context_window: 272_000,
        max_context_window: 872_000,
        effective_context_window_percent: 95,
      }),
    ).toEqual({
      id: "gpt-6.1-sol",
      contextWindow: 272_000,
      maxContextWindow: 872_000,
      effectiveContextWindowPercent: 95,
    });
  });

  it("keeps a Claude-style single contextWindow", () => {
    expect(
      parseProviderModelInfo({
        value: "opus",
        contextWindow: 1_000_000,
      }),
    ).toEqual({ id: "opus", contextWindow: 1_000_000 });
  });

  it("drops non-positive window numbers", () => {
    expect(
      parseProviderModelInfo({ id: "m", context_window: 0, max_context_window: -1 }),
    ).toEqual({ id: "m" });
  });

  it("drops illegal reasoning tokens instead of storing a broken ladder", () => {
    expect(
      parseProviderModelInfo({
        id: "m",
        reasoningLevels: ["high", "not a level", "low"],
      }),
    ).toEqual({ id: "m", reasoningLevels: ["high", "low"] });
  });
});

describe("providerModelLabel", () => {
  it("shows the resolved full id next to an alias display name", () => {
    expect(
      providerModelLabel({
        id: "opus",
        displayName: "Opus",
        resolvedId: "claude-opus-4-8",
      }),
    ).toBe("Opus · claude-opus-4-8");
  });

  it("falls back to the raw id when the catalog has no extra fields", () => {
    expect(providerModelLabel({ id: "deepseek-flash" })).toBe("deepseek-flash");
  });
});

describe("parseProviderModelCatalog", () => {
  it("dedupes by id and ignores unusable rows", () => {
    expect(
      parseProviderModelCatalog([{ id: "a", displayName: "A" }, { id: "a" }, "b", null, ""]),
    ).toEqual([
      { id: "a", displayName: "A" },
      { id: "b" },
    ]);
  });

  it("returns null for an empty catalog so callers can keep the previous list", () => {
    expect(parseProviderModelCatalog([])).toBeNull();
    expect(parseProviderModelCatalog("nope")).toBeNull();
  });
});

describe("discoveredDeclareWindow", () => {
  it("prefers max_context_window over the small Codex default", () => {
    expect(
      discoveredDeclareWindow(
        { id: "gpt-6.1-sol", contextWindow: 272_000, maxContextWindow: 872_000 },
        "gpt-6.1-sol",
      ),
    ).toBe(872_000);
  });

  it("falls back to a single contextWindow when max is absent", () => {
    expect(discoveredDeclareWindow({ id: "opus", contextWindow: 1_000_000 }, "opus")).toBe(1_000_000);
  });

  it("ignores a row for a different model id", () => {
    expect(
      discoveredDeclareWindow({ id: "other", maxContextWindow: 872_000 }, "gpt-6.1-sol"),
    ).toBeNull();
  });
});

describe("readProviderModelCatalog", () => {
  it("reads metadata.modelCatalog and finds a row by id", () => {
    const catalog = readProviderModelCatalog({
      modelCatalog: [{ id: "default", displayName: "Default", resolvedId: "claude-sonnet-4-6" }],
    });
    expect(findProviderModel(catalog, "default")?.resolvedId).toBe("claude-sonnet-4-6");
    expect(catalogHasDescriptions(catalog)).toBe(true);
  });
});
