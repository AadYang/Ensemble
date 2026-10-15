import {
  findProviderModel,
  providerModelLabel,
  type ProviderModelInfo,
} from "@agentorch/shared";
import { DEFAULT_ANTHROPIC_MODELS } from "@/lib/default-models";
import type { ProviderDTO } from "@/lib/provider-api";

function isDefaultAnthropic(p: ProviderDTO | undefined): boolean {
  if (!p) return false;
  return p.kind === "anthropic-local" || (p.kind === "anthropic" && !p.baseUrl);
}

export function providerModelIds(p: ProviderDTO | undefined): string[] {
  if (!p) return [];
  if (p.models.length > 0) return p.models;
  return isDefaultAnthropic(p) ? DEFAULT_ANTHROPIC_MODELS : [];
}

export function providerModelInfo(p: ProviderDTO | undefined, id: string): ProviderModelInfo {
  return findProviderModel(p?.modelCatalog, id) ?? { id };
}

export function providerModelSelectItems(
  p: ProviderDTO | undefined,
): Array<{ value: string; label: string; description?: string }> {
  return providerModelIds(p).map((id) => {
    const info = providerModelInfo(p, id);
    return {
      value: id,
      label: providerModelLabel(info),
      description: info.description,
    };
  });
}
