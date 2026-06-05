export interface PricingModelRow {
  model: string;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  source: string | null;
  overridden: boolean;
  builtIn: boolean;
}

export interface PricingTableDTO {
  version: string;
  note: string | null;
  overridesPath: string;
  models: PricingModelRow[];
}

export interface SavePricingInput {
  model: string;
  input: number;
  output: number;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  source?: string | null;
}

export async function fetchPricing(): Promise<PricingTableDTO> {
  const res = await fetch("/api/pricing");
  if (!res.ok) throw new Error(`fetchPricing: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as PricingTableDTO;
}

export async function savePricingModel(input: SavePricingInput): Promise<{ ok: true; recomputed: number }> {
  const res = await fetch("/api/pricing/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`savePricingModel: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as { ok: true; recomputed: number };
}

export async function deletePricingOverride(model: string): Promise<{ ok: true; recomputed: number }> {
  const qs = new URLSearchParams({ model });
  const res = await fetch(`/api/pricing/models?${qs}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deletePricingOverride: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as { ok: true; recomputed: number };
}
