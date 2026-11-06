import { isReasoningToken } from "./reasoning";

/** One row from a provider's live model catalog (Claude CLI, Codex
 *  `debug models`, or an HTTP `/models` body). `id` is what Ensemble stores
 *  and sends; the rest is what the CLI/TUI shows so a user can tell `opus`
 *  from `default`. */
export interface ProviderModelInfo {
  id: string;
  displayName?: string;
  description?: string;
  /** Canonical id an alias currently points at (`opus` → `claude-opus-4-8`). */
  resolvedId?: string;
  supportsEffort?: boolean;
  reasoningLevels?: string[];
  defaultReasoningLevel?: string;
  /** CLI `context_window` — Codex's default serving size, often far below the
   *  backend cap. Display/history only; never declared when `maxContextWindow`
   *  is present (that is the 272k trap). */
  contextWindow?: number;
  /** CLI `max_context_window` — the backend cap Codex will clamp a declaration
   *  against. Prefer this when asking the runtime for a window. */
  maxContextWindow?: number;
  /** CLI `effective_context_window_percent`, when the catalog reports one. */
  effectiveContextWindowPercent?: number;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function levelTokenOf(value: unknown): string | undefined {
  if (typeof value === "string") return isReasoningToken(value) ? value : undefined;
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const effort = row.effort ?? row.level ?? row.value;
  return typeof effort === "string" && isReasoningToken(effort) ? effort : undefined;
}

function levelsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const token = levelTokenOf(item);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    levels.push(token);
  }
  return levels.length > 0 ? levels : undefined;
}

function positiveIntOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n > 0 ? n : undefined;
  }
  return undefined;
}

function percentOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
    return undefined;
  }
  return value;
}

/** Parse one catalog row. A bare string is an id with no extra metadata. */
export function parseProviderModelInfo(row: unknown): ProviderModelInfo | null {
  if (typeof row === "string") {
    const id = row.trim();
    return id ? { id } : null;
  }
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = textOf(r.id) ?? textOf(r.value) ?? textOf(r.slug) ?? textOf(r.model);
  if (!id) return null;
  const displayName = textOf(r.displayName) ?? textOf(r.display_name);
  const description = textOf(r.description);
  const resolvedId = textOf(r.resolvedId) ?? textOf(r.resolvedModel) ?? textOf(r.resolved_model);
  const reasoningLevels =
    levelsOf(r.reasoningLevels) ?? levelsOf(r.supportedEffortLevels) ?? levelsOf(r.supported_reasoning_levels);
  const defaultReasoningLevel =
    textOf(r.defaultReasoningLevel) ?? textOf(r.default_reasoning_level);
  const supportsEffort = boolOf(r.supportsEffort) ?? boolOf(r.supports_effort);
  const contextWindow = positiveIntOf(r.contextWindow) ?? positiveIntOf(r.context_window);
  const maxContextWindow = positiveIntOf(r.maxContextWindow) ?? positiveIntOf(r.max_context_window);
  const effectiveContextWindowPercent =
    percentOf(r.effectiveContextWindowPercent) ?? percentOf(r.effective_context_window_percent);
  const info: ProviderModelInfo = { id };
  if (displayName) info.displayName = displayName;
  if (description) info.description = description;
  if (resolvedId) info.resolvedId = resolvedId;
  if (supportsEffort !== undefined) info.supportsEffort = supportsEffort;
  if (reasoningLevels) info.reasoningLevels = reasoningLevels;
  if (defaultReasoningLevel && isReasoningToken(defaultReasoningLevel)) {
    info.defaultReasoningLevel = defaultReasoningLevel;
  }
  if (contextWindow) info.contextWindow = contextWindow;
  if (maxContextWindow) info.maxContextWindow = maxContextWindow;
  if (effectiveContextWindowPercent) info.effectiveContextWindowPercent = effectiveContextWindowPercent;
  return info;
}

export function parseProviderModelCatalog(raw: unknown): ProviderModelInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ProviderModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const parsed = parseProviderModelInfo(row);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out.length > 0 ? out : null;
}

export function readProviderModelCatalog(metadata: unknown): ProviderModelInfo[] {
  if (!metadata || typeof metadata !== "object") return [];
  return parseProviderModelCatalog((metadata as Record<string, unknown>).modelCatalog) ?? [];
}

export function findProviderModel(
  catalog: readonly ProviderModelInfo[] | null | undefined,
  id: string,
): ProviderModelInfo | null {
  if (!catalog || !id) return null;
  return catalog.find((m) => m.id === id) ?? null;
}

export function providerModelIds(catalog: readonly ProviderModelInfo[]): string[] {
  return catalog.map((m) => m.id);
}

/** CLI-style one-liner: display name plus the id it actually is. */
export function providerModelLabel(m: ProviderModelInfo): string {
  const name = m.displayName?.trim();
  const resolved = m.resolvedId?.trim();
  if (name && resolved && resolved !== m.id) return `${name} · ${resolved}`;
  if (name && name !== m.id) return `${name} (${m.id})`;
  if (resolved && resolved !== m.id) return `${m.id} · ${resolved}`;
  return m.id;
}

export function catalogHasDescriptions(catalog: readonly ProviderModelInfo[]): boolean {
  return catalog.some(
    (m) =>
      Boolean(m.displayName) ||
      Boolean(m.description) ||
      Boolean(m.resolvedId) ||
      Boolean(m.reasoningLevels) ||
      m.supportsEffort !== undefined ||
      m.contextWindow !== undefined ||
      m.maxContextWindow !== undefined,
  );
}

/** The window a live CLI/HTTP catalog may DECLARE for this model id.
 *
 *  Codex lists a small default `context_window` and a larger backend
 *  `max_context_window`. Declaring the small one re-creates the 272k trap.
 *  Prefer max; fall back to a single `contextWindow` (Claude-style). */
export function discoveredDeclareWindow(
  info: ProviderModelInfo | null | undefined,
  model: string,
): number | null {
  if (!info || info.id !== model) return null;
  const n = info.maxContextWindow ?? info.contextWindow;
  return typeof n === "number" && n > 0 ? n : null;
}
