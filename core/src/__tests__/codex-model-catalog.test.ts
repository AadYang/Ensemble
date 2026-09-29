import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCodexModelCatalog, readCodexModelCache } from "../codex-model-catalog.js";

describe("parseCodexModelCatalog", () => {
  it("keeps list+api models in Codex priority order", () => {
    expect(
      parseCodexModelCatalog(JSON.stringify({
        models: [
          { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, priority: 2 },
          { slug: "hidden", visibility: "hide", supported_in_api: true, priority: 0 },
          { slug: "gpt-6-astra", visibility: "list", supported_in_api: true, priority: 1 },
          { slug: "internal", visibility: "list", supported_in_api: false, priority: 3 },
        ],
      })),
    ).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
  });

  it("skips leading log noise before the JSON object", () => {
    expect(
      parseCodexModelCatalog(`warning: slow catalog\n{"models":[{"slug":"gpt-5.6-sol","visibility":"list","supported_in_api":true}]}`),
    ).toEqual(["gpt-5.6-sol"]);
  });

  it("does not treat an empty or all-hidden catalog as success", () => {
    expect(parseCodexModelCatalog("{}")).toBeNull();
    expect(parseCodexModelCatalog('{"models":[]}')).toBeNull();
    expect(parseCodexModelCatalog('{"models":[{"slug":"x","visibility":"hide","supported_in_api":true}]}')).toBeNull();
  });

  it("falls back to non-hidden slugs when visibility/list fields are missing", () => {
    expect(
      parseCodexModelCatalog(JSON.stringify({
        data: [{ slug: "gpt-5.5" }, { id: "hidden-row", visibility: "hide" }],
      })),
    ).toEqual(["gpt-5.5"]);
  });
});

describe("readCodexModelCache", () => {
  it("reads models_cache.json from a Codex home", () => {
    const home = mkdtempSync(join(tmpdir(), "ensemble-codex-cache-"));
    writeFileSync(
      join(home, "models_cache.json"),
      JSON.stringify({
        models: [{ slug: "gpt-6-astra", visibility: "list", supported_in_api: true, priority: 1 }],
      }),
    );
    expect(readCodexModelCache(home)).toEqual(["gpt-6-astra"]);
  });

  it("returns null when the cache file is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "ensemble-codex-cache-missing-"));
    mkdirSync(home, { recursive: true });
    expect(readCodexModelCache(home)).toBeNull();
  });
});
