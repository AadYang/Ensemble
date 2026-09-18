import { displayToolName } from "./tool-display";

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
  "message",
  "question",
  "options",
]);

const PATH_KEYS = ["file_path", "path", "filePath", "file", "target_file", "target"];
const CMD_KEYS = ["command", "cmd"];
const PATTERN_KEYS = ["pattern", "glob", "query", "regex"];
const PEER_BODY_KEYS = ["message", "text", "content", "body"];
const ASK_BODY_KEYS = ["question", "text", "content"];
const WRITE_BODY_KEYS = ["contents", "content", "text", "body"];
const EDIT_NEW_KEYS = ["new_string", "new_text"];
const EDIT_OLD_KEYS = ["old_string", "old_text"];

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

/** Body text for cards that should show payload. HTML files stay path-only. */
export function toolCardContent(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const name = displayToolName(toolName);
  const o = input as Record<string, unknown>;
  if (name === "peer_send") {
    return firstString(o, PEER_BODY_KEYS);
  }
  if (name === "ask_user") {
    const question = firstString(o, ASK_BODY_KEYS);
    const options = Array.isArray(o.options)
      ? o.options.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    const optionBlock = options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    const body = [question, optionBlock].filter((s) => s && s.length > 0).join("\n\n");
    return body.length > 0 ? body : undefined;
  }
  if (name === "Write" || name === "Edit") {
    if (isHtmlFilePath(toolPathFromInput(input))) return undefined;
    if (name === "Write") return firstString(o, WRITE_BODY_KEYS);
    const next = firstString(o, EDIT_NEW_KEYS);
    const prev = firstString(o, EDIT_OLD_KEYS);
    if (prev && next) return `${prev}\n\n→\n\n${next}`;
    return next ?? prev;
  }
  return undefined;
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
