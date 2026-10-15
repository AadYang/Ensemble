import { parseProviderModelInfo, type ProviderModelInfo } from "@agentorch/shared";

/** Map Claude Code `supportedModels()` rows into the shared catalog shape.
 *  The SDK's `value` is the alias the CLI accepts (`opus`, `default`);
 *  `resolvedModel` / `displayName` / `description` / `supportedEffortLevels`
 *  are what the TUI `/model` picker shows. */
export function claudeSupportedModelsToCatalog(infos: unknown): ProviderModelInfo[] | null {
  if (!Array.isArray(infos)) return null;
  const out: ProviderModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of infos) {
    const parsed = parseProviderModelInfo(row);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out.length > 0 ? out : null;
}
