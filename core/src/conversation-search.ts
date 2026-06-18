import type { Agent, Message } from "./db.js";
import { prisma } from "./db.js";

export const CONVERSATION_SEARCH_TOOL_NAME = "conversation_search";

export const CONVERSATION_SEARCH_SCOPES = ["team", "self", "agent"] as const;
export type ConversationSearchScope = typeof CONVERSATION_SEARCH_SCOPES[number];

const DEFAULT_SCOPE: ConversationSearchScope = "team";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const MAX_AGENT_SCAN_ROWS = 500;
const SNIPPET_CHARS = 260;
const MAX_OUTPUT_CHARS = 12_000;

export interface ConversationSearchArgs {
  query: string;
  scope?: ConversationSearchScope;
  target?: string;
  limit?: number;
}

interface SearchTarget {
  agent: Agent;
}

interface SearchHit {
  agent: Agent;
  row: Message;
  role: "user" | "assistant";
  snippet: string;
}

export async function conversationSearch(fromAgentId: string, args: ConversationSearchArgs): Promise<string> {
  const query = normalizeQuery(args.query);
  if (!query) return "error: conversation_search query is required";

  const scope = sanitizeScope(args.scope);
  const limit = sanitizeLimit(args.limit);
  const source = await prisma.agent.findUnique({ where: { id: fromAgentId } });
  if (!source) return `error: source agent ${fromAgentId} not found`;

  const resolved = await resolveSearchTargets(source, scope, args.target);
  if ("error" in resolved) return resolved.error;

  const hits: SearchHit[] = [];
  for (const target of resolved.targets) {
    const rows = await prisma.message.findMany({
      where: { agentId: target.agent.id },
      orderBy: { seq: "desc" },
      take: MAX_AGENT_SCAN_ROWS,
    });
    for (const row of rows) {
      const extracted = searchableMessageText(row);
      if (!extracted) continue;
      if (!matchesQuery(extracted.text, query)) continue;
      hits.push({
        agent: target.agent,
        row,
        role: extracted.role,
        snippet: buildSnippet(extracted.text, query, SNIPPET_CHARS),
      });
    }
  }

  hits.sort((a, b) => {
    const timeDiff = b.row.createdAt.getTime() - a.row.createdAt.getTime();
    if (timeDiff !== 0) return timeDiff;
    return b.row.seq - a.row.seq;
  });
  const selected = hits.slice(0, limit);
  const searchedAgents = resolved.targets.map((target) => target.agent.name).join(", ");
  const header = [
    `conversation_search query="${query}" scope=${resolved.scope} agents=${resolved.targets.length} limit=${limit}`,
    resolved.note ? `note: ${resolved.note}` : null,
    `searched: ${searchedAgents || "(none)"}`,
    selected.length === 0 ? "matches: 0" : `matches: ${selected.length}${hits.length > selected.length ? ` of ${hits.length}` : ""}`,
  ].filter((line): line is string => Boolean(line));

  if (selected.length === 0) {
    return header.join("\n");
  }

  const lines = selected.flatMap((hit, index) => [
    "",
    `${index + 1}. agent="${hit.agent.name}" agentId=${hit.agent.id} seq=${hit.row.seq} role=${hit.role} createdAt=${hit.row.createdAt.toISOString()}`,
    `   snippet: ${hit.snippet}`,
  ]);
  return truncateOutput([...header, ...lines].join("\n"), MAX_OUTPUT_CHARS);
}

async function resolveSearchTargets(
  source: Agent,
  scope: ConversationSearchScope,
  target?: string,
): Promise<{ scope: ConversationSearchScope; targets: SearchTarget[]; note?: string } | { error: string }> {
  if (scope === "self") {
    return { scope, targets: [{ agent: source }] };
  }

  if (scope === "agent") {
    const resolved = await resolveAgentTarget(source, target);
    if (!resolved) return { error: `error: no agent matches "${target ?? ""}"` };
    return { scope, targets: [{ agent: resolved }] };
  }

  if (!source.teamId) {
    return {
      scope: "self",
      targets: [{ agent: source }],
      note: "default scope=team requested, but source agent has no team; fell back to self",
    };
  }

  const teamAgents = await prisma.agent.findMany({
    where: { teamId: source.teamId },
    orderBy: { createdAt: "asc" },
  });
  if (teamAgents.length === 0) {
    return {
      scope: "self",
      targets: [{ agent: source }],
      note: `team ${source.teamId} has no visible members; fell back to self`,
    };
  }
  return { scope, targets: teamAgents.map((agent) => ({ agent })) };
}

async function resolveAgentTarget(source: Agent, target?: string): Promise<Agent | null> {
  const needle = target?.trim();
  if (!needle) return null;
  const byId = await prisma.agent.findUnique({ where: { id: needle } });
  if (byId) return byId;

  const candidates = source.teamId
    ? await prisma.agent.findMany({ where: { teamId: source.teamId }, orderBy: { createdAt: "asc" } })
    : await prisma.agent.findMany({ orderBy: { createdAt: "asc" } });
  const lower = needle.toLowerCase();
  return candidates.find((agent) => agent.name.toLowerCase() === lower) ?? null;
}

function searchableMessageText(row: Message): { role: "user" | "assistant"; text: string } | null {
  if (row.type === "user") {
    const content = (row.payload as { message?: { content?: unknown } })?.message?.content;
    const text = typeof content === "string" ? normalizeWhitespace(content) : "";
    return text ? { role: "user", text } : null;
  }

  if (row.type === "assistant") {
    const blocks =
      (row.payload as { message?: { content?: Array<{ type?: unknown; text?: unknown }> } })
        ?.message?.content ?? [];
    const text = normalizeWhitespace(
      blocks
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join(" "),
    );
    return text ? { role: "assistant", text } : null;
  }

  return null;
}

function normalizeQuery(query: string): string {
  return normalizeWhitespace(String(query ?? "")).trim();
}

function sanitizeScope(scope: ConversationSearchScope | undefined): ConversationSearchScope {
  return scope && CONVERSATION_SEARCH_SCOPES.includes(scope) ? scope : DEFAULT_SCOPE;
}

function sanitizeLimit(limit: number | undefined): number {
  const n = Math.floor(Number(limit ?? DEFAULT_LIMIT));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function buildSnippet(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const hit = lowerText.indexOf(lowerQuery);
  const center = hit >= 0 ? hit + Math.floor(query.length / 2) : Math.floor(text.length / 2);
  const start = Math.max(0, center - Math.floor(maxChars / 2));
  const end = Math.min(text.length, start + maxChars);
  const slice = text.slice(start, end);
  return `${start > 0 ? "... " : ""}${slice}${end < text.length ? " ..." : ""}`;
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head - 80;
  return `${text.slice(0, head)}\n\n[... conversation_search output truncated ${text.length - head - tail} chars ...]\n\n${text.slice(-tail)}`;
}
