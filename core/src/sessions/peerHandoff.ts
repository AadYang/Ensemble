import type { PeerIncludeSource } from "@agentorch/shared";

/** Format a peer_send as a plain message. continue/review/fork templates are
 *  gone: say what you want in the body. includeSource=true is the only way to
 *  attach the sender's latest output. */
export function formatPeerHandoff(args: {
  fromName: string;
  fromId: string;
  body: string;
  sourceLastOutput?: string;
  sourceState?: "running" | "interrupted" | "completed" | "empty";
  includeSource?: PeerIncludeSource;
  interruptReason?: string;
}): string {
  const includeSource = args.includeSource === true;
  const sourceLastOutput = includeSource ? args.sourceLastOutput : undefined;
  const header = args.interruptReason
    ? [
        `[from ${args.fromName} (id=${args.fromId.slice(0, 8)})]`,
        `Urgent interrupt reason: ${args.interruptReason}`,
      ]
    : [`[from ${args.fromName}]`];
  if (sourceLastOutput) {
    return [
      ...header,
      `Source state: ${args.sourceState ?? "completed"}`,
      `<<<source-output`,
      sourceLastOutput,
      `source-output>>>`,
      ``,
      args.body,
    ].join("\n");
  }
  if (args.interruptReason) {
    return [...header, "", args.body].join("\n");
  }
  return `[from ${args.fromName}] ${args.body}`;
}
