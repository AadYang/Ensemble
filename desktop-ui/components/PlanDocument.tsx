"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isHtmlPlanDocument, htmlDocumentSrcDoc } from "@/lib/plan-document";
import { useT } from "@/i18n/useT";

export function PlanDocument({ plan, title }: { plan: string; title: string }) {
  const t = useT();
  const body = plan.trim();
  return (
    <article className="plan-document">
      <div className="plan-document-kicker">{title}</div>
      {!body ? (
        <p className="plan-document-empty">{t("chat.plan.empty")}</p>
      ) : isHtmlPlanDocument(body) ? (
        <iframe
          className="plan-document-frame"
          sandbox=""
          srcDoc={htmlDocumentSrcDoc(body)}
          title={title}
        />
      ) : (
        <div className="plan-document-body markdown-plan">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
        </div>
      )}
    </article>
  );
}
