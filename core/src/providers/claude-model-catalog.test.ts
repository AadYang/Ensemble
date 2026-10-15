import { describe, expect, it } from "vitest";
import { claudeSupportedModelsToCatalog } from "./claude-model-catalog.js";

describe("claudeSupportedModelsToCatalog", () => {
  it("keeps alias, resolved id, description and effort ladder from ModelInfo", () => {
    expect(
      claudeSupportedModelsToCatalog([
        {
          value: "opus",
          displayName: "Opus",
          description: "Most capable",
          resolvedModel: "claude-opus-4-8",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          value: "default",
          displayName: "Default",
          description: "Recommended",
          resolvedModel: "claude-sonnet-4-6",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
        },
      ]),
    ).toEqual([
      {
        id: "opus",
        displayName: "Opus",
        description: "Most capable",
        resolvedId: "claude-opus-4-8",
        supportsEffort: true,
        reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "default",
        displayName: "Default",
        description: "Recommended",
        resolvedId: "claude-sonnet-4-6",
        supportsEffort: true,
        reasoningLevels: ["low", "medium", "high", "max"],
      },
    ]);
  });

  it("returns null when the CLI listed nothing usable", () => {
    expect(claudeSupportedModelsToCatalog([])).toBeNull();
    expect(claudeSupportedModelsToCatalog(null)).toBeNull();
  });
});
