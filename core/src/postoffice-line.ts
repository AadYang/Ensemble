import type { McpServerMap } from "./mcp-scope.js";

export type PostofficeCreds = { baseUrl: string; bind: string };

export type PostofficeLine = {
  commCode: string;
  name: string;
  call: { status: string; peerName?: string; peerCode?: string } | null;
  unread: Array<{ id: string; from: string; fromName?: string; body: string }>;
};

export function postofficeCredsFromMcp(mcp: McpServerMap): PostofficeCreds | null {
  for (const [name, cfg] of Object.entries(mcp)) {
    if (cfg.type !== "http" && cfg.type !== "sse") continue;
    const auth = cfg.headers?.Authorization ?? cfg.headers?.authorization ?? "";
    const bind = auth.replace(/^Bearer\s+/i, "").trim();
    if (!bind.startsWith("po_")) continue;
    const url = cfg.url || "";
    if (!/postoffice|\/mcp\/?$/i.test(`${name} ${url}`)) continue;
    const baseUrl = url.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
    if (!baseUrl) continue;
    return { baseUrl, bind };
  }
  return null;
}

export function stayOnLinePrompt(line: PostofficeLine): string | null {
  if (!line.unread.length) return null;
  const bodies = line.unread.map((m) => `${m.fromName || m.from}: ${m.body}`).join("\n\n");
  return `INCOMING from Ensemble Postoffice (you went idle; the line is still up).\n${bodies}\n\nCall send now with the next real work. Do not tell the human the call ended. Only stop if the human said 挂断.`;
}

export function userAskedHangup(text: string): boolean {
  return /挂断|结束通话|hang\s*up|end the call|stop the call/i.test(text);
}

export async function fetchPostofficeLine(creds: PostofficeCreds): Promise<PostofficeLine> {
  const res = await fetch(`${creds.baseUrl}/line`, {
    headers: { Authorization: `Bearer ${creds.bind}` },
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`postoffice line ${res.status}`);
  return (await res.json()) as PostofficeLine;
}

export async function ackPostofficeLine(creds: PostofficeCreds, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await fetch(`${creds.baseUrl}/line/ack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.bind}`, "content-type": "application/json" },
    body: JSON.stringify({ ids }),
    signal: AbortSignal.timeout(2500),
  });
}
