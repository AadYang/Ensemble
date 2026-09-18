import { displayToolName } from "./tool-display";

export function isExitPlanModeTool(name: string | undefined | null): boolean {
  return displayToolName(name) === "ExitPlanMode";
}

export function planBodyFromToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "plan" in input) {
    const plan = (input as { plan: unknown }).plan;
    if (typeof plan === "string") return plan;
  }
  return "";
}

export function isHtmlPlanDocument(body: string): boolean {
  const t = body.trimStart();
  if (/^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)) return true;
  return /^<[a-zA-Z][\s\S]*<\/[a-zA-Z]/.test(t);
}

export function htmlToReadableText(html: string): string {
  let s = html.replace(/\r\n/g, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|tr|blockquote|pre)>/gi, "\n\n");
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<\/li>/gi, "\n");
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");
  s = s.replace(/<\/?h[1-6][^>]*>/gi, "\n");
  s = s.replace(/<\/?code[^>]*>/gi, "`");
  s = s.replace(/<\/?(strong|b)[^>]*>/gi, "**");
  s = s.replace(/<\/?(em|i)[^>]*>/gi, "*");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export function planAsChatText(plan: string): string {
  const body = plan.trim();
  if (!body) return "";
  return isHtmlPlanDocument(body) ? htmlToReadableText(body) : body;
}
