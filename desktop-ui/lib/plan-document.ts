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
  return /^<(h[1-6]|p|div|section|article|ul|ol|table|header|main|blockquote|pre)[\s>]/i.test(t);
}

const PLAN_DOC_CSS =
  "body{margin:0;padding:20px 24px;background:#f7f4ec;color:#1c1917;" +
  "font:15px/1.7 ui-sans-serif,system-ui,sans-serif}" +
  "h1,h2,h3{color:#1c1917;line-height:1.3}" +
  "h1{font-size:1.45em}h2{font-size:1.22em;margin-top:1.15em}h3{font-size:1.08em}" +
  "p,li{color:#1c1917}a{color:#0f766e}" +
  "code{background:#efe8d8;padding:0 4px}pre{background:#efe8d8;padding:12px;overflow:auto}";

export function htmlDocumentSrcDoc(body: string): string {
  const t = body.trim();
  if (/^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)) return t;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PLAN_DOC_CSS}</style></head><body>${t}</body></html>`;
}
