import type { PeerMode } from "@agentorch/shared";

const CONTEXT_TEMPLATE = (vars: {
  fromName: string;
  fromId: string;
  mode: PeerMode;
  body: string;
  sourceLastOutput?: string;
}) => {
  const lines = [
    `<peer-handoff mode="${vars.mode}" from="${vars.fromName}" fromId="${vars.fromId.slice(0, 8)}">`,
    `Source agent: ${vars.fromName} (id=${vars.fromId.slice(0, 8)})`,
    `Mode: ${vars.mode}`,
  ];
  if (vars.sourceLastOutput) {
    lines.push(
      `Source agent's most recent output (this is the artifact under review):`,
      `<<<source-output`,
      vars.sourceLastOutput,
      `source-output>>>`,
    );
  }
  lines.push(
    `Operator's accompanying note (verbatim):`,
    `---`,
    vars.body,
    `---`,
    `</peer-handoff>`,
  );
  return lines.join("\n");
};

const REVIEW_INSTRUCTION = [
  "你正在以 **review（审阅）** 模式收到来自 peer agent 的工作交接。",
  "- `<<<source-output ... source-output>>>` 区块是源 agent 最近一轮的产出，这是你要审阅的对象，逐字可读，请勿 paraphrase。",
  "- `Operator's accompanying note` 区块是操作者发来的附注（通常是问句或聚焦指引），用于指导你审阅的方向。",
  "- 请提供独立的第二意见审查：先用 3-5 句复述你对源 agent 任务/方案的理解（基于 source-output），",
  "  再列出值得肯定的地方、潜在风险、明确的改进建议。",
  "- 引用源 agent 的判断时一律用原话，不要重述成你自己的语言。",
  "- 你不需要承接其工作，只做审计。",
  "- 如果没有 source-output（源 agent 尚未产出可审阅内容），明确告知操作者并停下，不要凭空臆造。",
].join("\n");

const CONTINUE_INSTRUCTION = [
  "你正在以 **continue（承接）** 模式收到来自 peer agent 的工作交接。",
  "- `<<<source-output ... source-output>>>` 区块是源 agent 最近一轮的产出（轨迹/结论/已做的事），这是你要承接的基础。",
  "- `Operator's accompanying note` 区块是操作者的承接指令（指明继续的方向或边界）。",
  "- **磁盘/数据库的真实状态优先于 source-output 描述**——冲突时以实际状态为准。",
  "  开工前先用必要的工具（git status / Read / 查询等）核对当前状态。",
  "- 在确认状态后，沿源 agent 的轨迹按操作者指令继续推进下一步工作。",
  "- 如果没有 source-output（源 agent 没有产出可承接的内容），先向操作者澄清要承接什么，不要凭空开工。",
].join("\n");

const FORK_INSTRUCTION = [
  "你正在以 **fork（换路）** 模式收到来自 peer agent 的工作交接。",
  "- `<<<source-output ... source-output>>>` 区块是源 agent **已经尝试过**的方案 / 走过的路——这是**反面参考**，不是基础。",
  "- `Operator's accompanying note` 区块是操作者要你重做的任务描述。",
  "- 你要解决的问题是 note 中的**任务本身**，请用**不同的思路**重做。",
  "- ⚠ fork 模式典型失败是不自觉地复刻前任路径——",
  "  发现自己在做 source-output 已经做过的事就停下来重新审视方案。",
  "- 如果没有 source-output（源 agent 还没尝试），就按 note 当作新任务开做即可，无需强行求异。",
].join("\n");

export const DEFAULT_PEER_INSTRUCTIONS: Record<PeerMode, string> = {
  review: REVIEW_INSTRUCTION,
  continue: CONTINUE_INSTRUCTION,
  fork: FORK_INSTRUCTION,
  raw: "",
};

export function readPeerInstruction(receiverMetadata: unknown, mode: PeerMode): string {
  if (mode === "raw") return "";
  if (
    receiverMetadata &&
    typeof receiverMetadata === "object" &&
    "peerInstructions" in receiverMetadata
  ) {
    const overrides = (receiverMetadata as { peerInstructions?: Record<string, unknown> })
      .peerInstructions;
    if (overrides && typeof overrides[mode] === "string") {
      const custom = (overrides[mode] as string).trim();
      if (custom) return custom;
    }
  }
  return DEFAULT_PEER_INSTRUCTIONS[mode];
}

export function formatPeerHandoff(args: {
  fromName: string;
  fromId: string;
  receiverMetadata: unknown;
  mode: PeerMode;
  body: string;
  /** Source agent's most recent assistant output. Embedded for non-raw modes
   *  as a `<<<source-output ... source-output>>>` block so the recipient has
   *  the actual artifact (review/continue/fork all need source context).
   *  Raw mode bypasses this and the rest of the template. */
  sourceLastOutput?: string;
}): string {
  if (args.mode === "raw") {
    if (args.sourceLastOutput) {
      return [
        `[from ${args.fromName} (id=${args.fromId.slice(0, 8)})]`,
        `<<<source-output`,
        args.sourceLastOutput,
        `source-output>>>`,
        ``,
        args.body,
      ].join("\n");
    }
    return `[from ${args.fromName}] ${args.body}`;
  }
  const context = CONTEXT_TEMPLATE({
    fromName: args.fromName,
    fromId: args.fromId,
    mode: args.mode,
    body: args.body,
    sourceLastOutput: args.sourceLastOutput,
  });
  const instruction = readPeerInstruction(args.receiverMetadata, args.mode);
  return `${context}\n\n${instruction}`;
}
