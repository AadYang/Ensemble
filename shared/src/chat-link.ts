/** Turn a chat-message href into something the OS can open.
 *
 *  Agents write three shapes: https URLs, local files (`D:\\…html`,
 *  `/D:/…dart:96` Codex/VS Code links), and `file://` URLs. A webview `<a>`
 *  cannot open any of those — loopback treats `/D:/…` as a site path, and the
 *  nav-guard blocks leaving 127.0.0.1. */
export type ChatLink =
  | { kind: "url"; href: string }
  | { kind: "path"; path: string };

const BLOCKED_SCHEME = /^(javascript|data|vbscript|tauri|blob|about):/i;
const HTTP_SCHEME = /^(https?:|mailto:)/i;
const FILE_SCHEME = /^file:/i;
const DRIVE = /^\/?([A-Za-z]):/;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|tauri\.localhost)$/i;

export function parseChatLink(raw: string): ChatLink | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (BLOCKED_SCHEME.test(trimmed)) return null;

  const loopbackPath = loopbackFilePath(trimmed);
  if (loopbackPath) return parseChatLink(loopbackPath);

  if (HTTP_SCHEME.test(trimmed)) {
    if (isBareLoopbackOrigin(trimmed)) return null;
    return { kind: "url", href: trimmed };
  }

  let path = decodeHref(trimmed);
  if (FILE_SCHEME.test(path)) {
    path = path.replace(/^file:\/\//i, "");
    if (path.startsWith("/") && DRIVE.test(path)) path = path.slice(1);
  }

  if (path.startsWith("/") && DRIVE.test(path)) path = path.slice(1);
  path = stripLineColumn(path);
  if (!path) return null;

  if (DRIVE.test(path) || path.startsWith("\\\\")) {
    return { kind: "path", path };
  }
  if (path.startsWith("/") && isUnixFilePath(path)) {
    return { kind: "path", path };
  }
  return null;
}

/** react-markdown's defaultUrlTransform treats `D:/…` as scheme `D:` and
 *  `file:` as unsafe, so the `<a href>` becomes empty and copy/click resolve
 *  to the sidecar origin (`http://127.0.0.1:port/`). Keep OS-openable hrefs. */
export function chatUrlTransform(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || BLOCKED_SCHEME.test(trimmed)) return "";
  const link = parseChatLink(trimmed);
  if (link?.kind === "url") return link.href;
  if (link?.kind === "path") return pathToFileUrl(link.path);
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed;
  return trimmed;
}

const UNIX_ROOT = /^\/(Users|home|opt|tmp|var|Volumes|private|mnt|Library)\b/;
const FILE_EXT = /\.[A-Za-z0-9]{1,8}$/;

function isUnixFilePath(path: string): boolean {
  return UNIX_ROOT.test(path) || FILE_EXT.test(path);
}

function decodeHref(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

function isBareLoopbackOrigin(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!LOOPBACK_HOST.test(url.hostname)) return false;
  const path = url.pathname || "/";
  return path === "/" && !url.search && (!url.hash || url.hash === "#");
}

function loopbackFilePath(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!LOOPBACK_HOST.test(url.hostname)) return null;
  const path = decodeHref(url.pathname || "");
  if (path.startsWith("/") && DRIVE.test(path)) return path;
  if (path.startsWith("/") && isUnixFilePath(path)) return path;
  return null;
}

function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized)) return `file:///${normalized}`;
  if (normalized.startsWith("/")) return `file://${normalized}`;
  return path;
}

/** `file.ts:12` / `file.ts:12:4`, but never the `D:` drive colon. */
function stripLineColumn(path: string): string {
  const m = path.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (!m) return path;
  const base = m[1]!;
  if (/^[A-Za-z]$/.test(base)) return path;
  return base;
}
