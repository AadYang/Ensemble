// Slice 5.2: ExitPlanMode tool. Mirror of Claude SDK's built-in.
//
// Semantics: the model presents a plan; the user approves or rejects via
// the permission_request dialog before any code is written. The tool's
// `execute` just echoes the plan — the actual gating happens via the SDK's
// needsApproval flag (true only in plan mode, see tools/index.ts).
//
// In non-plan modes this tool degrades to "model writes a plan paragraph"
// — harmless, no approval prompt, just returns the plan text to the model
// which usually treats it as a thinking step.

import { z } from "zod";
import type { NormalizedTool } from "./types.js";

const EXIT_PLAN_MODE_SCHEMA = z.object({
  plan: z
    .string()
    .min(1)
    .describe(
      "Markdown-formatted plan to present to the user. Use headings, bullet lists, and code " +
        "blocks where appropriate — the frontend renders this as rich text.",
    ),
});

export const exitPlanModeTool: NormalizedTool<typeof EXIT_PLAN_MODE_SCHEMA> = {
  name: "ExitPlanMode",
  description:
    "Exit plan mode after presenting your plan. The user will be asked to approve the plan " +
    "before any code is written. Use this when you've finished reasoning through how to " +
    "tackle a problem and want to confirm the approach before doing real work.",
  parameters: EXIT_PLAN_MODE_SCHEMA,
  async execute({ plan }) {
    // No-op execute: returning the plan as the tool result means the model
    // sees its own plan back, which usually triggers it to continue normally
    // after user approval. The needsApproval pause does the real work.
    return plan;
  },
};
