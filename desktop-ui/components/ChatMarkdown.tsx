"use client";

import type { Components } from "react-markdown";
import { chatUrlTransform } from "@agentorch/shared";
import { openInOs } from "@/lib/open-in-os";

export { chatUrlTransform };

export const chatMarkdownComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (href) void openInOs(href);
      }}
    >
      {children}
    </a>
  ),
};
