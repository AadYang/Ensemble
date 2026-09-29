"use client";

import type { Components } from "react-markdown";
import { openInOs } from "@/lib/open-in-os";

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
