import { displayToolName } from "./tool-display";
import { isExitPlanModeTool } from "./plan-document";

const TEXT_KEYS = new Set([
  "plan",
  "contents",
  "content",
  "new_string",
  "old_string",
  "new_text",
  "old_text",
  "text",
  "body",
  "html",
  "markdown",
  "replace_all",
  "replaceAll",
]);

const PATH_KEYS = ["file_path", "path", "filePath", "file", "target_file", "target"];
const CMD_KEYS = ["command", "cmd"];
const PATTERN_KEYS = ["pattern", "glob", "query", "regex"];

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export function toolPathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  return firstString(input as Record<string, unknown>, PATH_KEYS);
}

export function isHtmlFilePath(path: string | undefined): boolean {
  return typeof path === "string" && /\.html?$/i.test(path);
}

/** Operational lines only — never the written/edited body. */
export function toolCardOperationLines(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const lines: string[] = [];
  const path = firstString(o, PATH_KEYS);
  if (path) lines.push(path);
  const cmd = firstString(o, CMD_KEYS);
  if (cmd) lines.push(cmd);
  const pattern = firstString(o, PATTERN_KEYS);
  if (pattern) lines.push(pattern);
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (TEXT_KEYS.has(k) || PATH_KEYS.includes(k) || CMD_KEYS.includes(k) || PATTERN_KEYS.includes(k)) {
      continue;
    }
    if (typeof v === "string" && v.length > 80) continue;
    if (v && typeof v === "object") continue;
    rest[k] = v;
  }
  if (Object.keys(rest).length > 0) lines.push(JSON.stringify(rest));
  return lines;
}

export function documentBodyFromToolInput(name: string | undefined, input: unknown): string {
  if (isExitPlanModeTool(name)) {
    if (typeof input === "string") return input;
    if (input && typeof input === "object" && "plan" in input) {
      const plan = (input as { plan: unknown }).plan;
      if (typeof plan === "string") return plan;
    }
    return "";
  }
  const tool = displayToolName(name).toLowerCase();
  if (tool !== "edit" && tool !== "write" && tool !== "create") return "";
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (!isHtmlFilePath(firstString(o, PATH_KEYS))) return "";
  for (const k of ["new_string", "contents", "content", "body", "html"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

export function documentTitleFromToolInput(input: unknown, fallback: string): string {
  const path = toolPathFromInput(input);
  if (!path) return fallback;
  const base = path.replace(/^.*[/\\]/, "").trim();
  return base || fallback;
}
