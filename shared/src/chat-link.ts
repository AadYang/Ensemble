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

export function parseChatLink(raw: string): ChatLink | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (BLOCKED_SCHEME.test(trimmed)) return null;
  if (HTTP_SCHEME.test(trimmed)) return { kind: "url", href: trimmed };

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

/** `file.ts:12` / `file.ts:12:4`, but never the `D:` drive colon. */
function stripLineColumn(path: string): string {
  const m = path.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (!m) return path;
  const base = m[1]!;
  if (/^[A-Za-z]$/.test(base)) return path;
  return base;
}
