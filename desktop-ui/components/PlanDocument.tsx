"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { planAsChatText } from "@/lib/plan-document";
import { useT } from "@/i18n/useT";

export function PlanDocument({ plan }: { plan: string; title?: string }) {
  const t = useT();
  const text = planAsChatText(plan);
  if (!text) {
    return <p className="markdown-plan markdown-chat text-[var(--text-dim)]">{t("chat.plan.empty")}</p>;
  }
  return (
    <div className="markdown-plan markdown-chat text-[var(--text)] break-words leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
