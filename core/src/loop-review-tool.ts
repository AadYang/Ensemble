import type { ReviewToolAction } from "@agentorch/shared";

export const LOOP_REVIEW_ACTIONS = ["read", "post", "reply", "resolve", "lgtm"] as const;

export type LoopReviewArgs = {
  action: ReviewToolAction;
  itemId?: string;
  title?: string;
  text?: string;
  runner?: string;
};

export const LOOP_REVIEW_DESCRIPTION = [
  "Read or write the current Ensemble LOOP review board. This is the native way",
  "to do LOOP review — do not peer_send findings, replies, or LGTM. The board",
  "belongs to the loop, not to either agent's chat.",
  "",
  "Actions:",
  "- read: show goal, TASKS.md, and current findings",
  "- post: reviewer only. Add a finding (title + text)",
  "- reply: add a note under itemId (R1, R2, …)",
  "- resolve: reviewer only. Close itemId when that finding is done",
  "- lgtm: reviewer only. Finish review when every item is resolved (or there are none)",
  "",
  "If you are reviewing more than one runner, pass runner as their name or UUID.",
].join("\n");
