# peer_send 三模式方案（cxsm-inspired）

> **状态**：✅ 已实施（W13）—— 实际方案为 4 模式（含兼容用的 `raw`）
> **创建**：基于对 [cxsm](https://github.com/ChristopheZhao/cxsm) 项目的分析
> **目标**：把 `peer_send` 从"消息广播"升级为"任务交接协议"，引入 cxsm 的
>          `continue` / `review` / `fork` 三模式语义，提升 multi-agent
>          协作的可控性与可调试性。
>
> **实施偏离记录**：
> - `PeerMode` 定义在 `shared/src/protocol.ts`（不是 server/peer-mcp.ts）以避免 shared→server 反向依赖
> - WS handler 内联在 `server/src/index.ts:600+`（无独立 `ws/handler.ts`）
> - `ChatTurn` 加结构化字段 `peerOrigin`（不通过 `payload` 字段透传）；`ingestSdkMessage` 在解析 user 消息时提取 `_peerOrigin`
> - peer_send 失败时通过 `ServerMsg type:"error"` channel 回报源 socket（code=`PEER_SEND_FAILED`）
> - §4.7 自定义 instruction UI **未实施**：后端 `readPeerInstruction` 已支持读 `Agent.metadata.peerInstructions[mode]`，UI 待加
> - 单元测试**未实施**：项目无测试基建

---

## 一、背景与动机

### 1.1 当前 peer_send 的局限

当前 `peer_send`（`server/src/peer-mcp.ts`）实现是一种"扁平"的消息转发：
A 发给 B 的消息只是被前缀化为 `[from ${name}] ${body}`，B 收到后**没有
"角色定位"**——不知道这是让我审阅、还是让我接着做、还是让我换个思路重做。

### 1.2 cxsm 的洞察

cxsm 是一个 Rust CLI 工具，用于在 Claude Code 与 Codex CLI 之间交接本地
session。它定义了三种**互斥**的交接语义：

| Mode | 对前任路径的态度 | 任务来源 | 典型场景 |
|---|---|---|---|
| **review** | 唯一事实来源；逐字引述不诠释 | "审计这个 session" | 让另一个 agent 帮你 cross-check |
| **continue** | 承接路径——前任工作=当前基础 | 项目脉络下的下一步 | 前任搭好框架，你来加新功能 |
| **fork** | 断开路径——前任=反面教材 | 同任务，新方法 | 前任死循环，换路重做 |

cxsm 的关键设计：**三模式共用同一份 context 块（框架拥有，不可改），
只在 instruction 块上文案不同**——保证下游 agent 永远拿到 ground-truth
引用，用户可以调"语气/风格"但不能砍掉关键事实链。

### 1.3 借鉴范围

本方案借鉴 cxsm 的 **4 个核心思想**：

1. **三模式语义**作为 peer_send 顶层动作类型
2. **两段式 prompt**（context 不可改 + instruction 可定制）
3. **血缘标记**（receiver 侧能识别消息来自哪个 peer agent + 哪种模式）
4. **后向兼容**：`mode` 缺省 = `"raw"`，等价现状

不借鉴：cxsm 的 discovery/扫描机制、TUI、子进程 spawn、Rust 强类型只读
保证（这些与 AgentUI 形态不匹配）。

---

## 二、设计原则

1. **后向兼容**：`mode` 缺省 = `"raw"`，行为与现状完全一致；旧消息仍能正确渲染
2. **不动 DB schema**：所有新字段塞 `Message.payload` 与 `Agent.metadata`，零迁移
3. **格式化集中化**：抽 `formatPeerHandoff()` 单一函数，测试友好
4. **Context 框架拥有 / Instruction 用户可改**：借鉴 cxsm 两段式

---

## 三、改动总览

| 文件 | 改动类型 | 摘要 |
|---|---|---|
| `server/src/peer-mcp.ts` | 改 | tool schema 加 `mode` 参数 + 文档 |
| `server/src/sessions/peerHandoff.ts` | **新增** | 集中模板与格式化（~80 行）|
| `server/src/sessions/SessionManager.ts` | 改 | `sendPeerMessage` 加 mode；`sendMessage` 加 opts.peerOrigin |
| `server/src/ws/handler.ts`（或对应位置） | 改 | 加 `peer_send` ClientMsg 分支 |
| `shared/src/protocol.ts` | 改 | ClientMsg 增 `peer_send` 类型 + 导出 PeerMode |
| `web/components/ChatPane.tsx` | 改 | 解析 `_peerOrigin`，按 mode 渲染徽章 |
| `web/components/PeerSendPopover.tsx` | 改 | mode radio + 走新 WS 消息 |
| `web/store/agents.ts` | 改 | turn 模型透传 `_peerOrigin` |
| `web/i18n/dict.ts` | 改 | 4 个 mode 文案 × 2 语言 |
| `web/components/AgentSettings.tsx`（可选 P0.5） | 改 | 自定义 instruction UI |

---

## 四、详细实施

### 4.1 协议层：peer-mcp.ts

**文件**：`server/src/peer-mcp.ts`

```typescript
import { z } from "zod";

export const PEER_MCP_SERVER_NAME = "agentorch-peer";
export const PEER_SEND_TOOL_NAME = `mcp__${PEER_MCP_SERVER_NAME}__peer_send`;

export const PEER_MODES = ["continue", "review", "fork", "raw"] as const;
export type PeerMode = (typeof PEER_MODES)[number];

export function makePeerMcpServer(
  sessions: SessionManager,
  fromAgentId: string,
): McpSdkServerConfigWithInstance {
  const peerSend = tool(
    "peer_send",
    [
      "Send a chat message to another agent in this workspace.",
      "The recipient processes it as a user input.",
      "",
      "Modes (cxsm-style handoff semantics):",
      "  - continue: hand off your work-in-progress; recipient continues from your trajectory.",
      "  - review:   ask recipient for a second-opinion audit of your work; quote verbatim.",
      "  - fork:     same task, different approach; recipient should NOT replicate your path.",
      "  - raw:      plain message forwarding (default, legacy behavior).",
      "",
      "Use the target agent's name (preferred) or its UUID.",
      "Returns delivery status; does NOT wait for the recipient to reply.",
    ].join("\n"),
    {
      target: z.string().min(1).describe("Name (preferred) or UUID of the recipient agent."),
      message: z.string().min(1).describe("Body of the message to send."),
      mode: z
        .enum(PEER_MODES)
        .optional()
        .describe(
          "Handoff semantics: continue|review|fork|raw. Default 'raw' (plain forwarding).",
        ),
    },
    async (args) => {
      const result = await sessions.sendPeerMessage(
        fromAgentId,
        args.target,
        args.message,
        args.mode ?? "raw",
      );
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  return createSdkMcpServer({
    name: PEER_MCP_SERVER_NAME,
    version: "0.2.0",
    tools: [peerSend],
  });
}
```

---

### 4.2 新增格式化模块：peerHandoff.ts

**新建**：`server/src/sessions/peerHandoff.ts`

集中所有 prompt 模板与格式化逻辑。Context 块写死，Instruction 块从
`Agent.metadata.peerInstructions` 读（允许覆盖）。

```typescript
import type { PeerMode } from "../peer-mcp.js";

/** Cxsm-borrowed instructions. Context block is framework-owned (immutable);
 *  instruction block is per-mode and overridable via Agent.metadata.peerInstructions. */

export const CONTEXT_TEMPLATE = (vars: {
  fromName: string;
  fromId: string;
  mode: PeerMode;
  body: string;
}) =>
  [
    `<peer-handoff mode="${vars.mode}" from="${vars.fromName}" fromId="${vars.fromId.slice(0, 8)}">`,
    `Source agent: ${vars.fromName} (id=${vars.fromId.slice(0, 8)})`,
    `Mode: ${vars.mode}`,
    `Message body (verbatim from sender):`,
    `---`,
    vars.body,
    `---`,
    `</peer-handoff>`,
  ].join("\n");

const REVIEW_INSTRUCTION = [
  "你正在以 **review（审阅）** 模式收到来自 peer agent 的工作交接。",
  "- 上方消息体是来自源 agent 的 ground truth，逐字可读，请勿 paraphrase。",
  "- 请提供独立的第二意见审查：先用 3-5 句复述你对其任务/方案的理解，",
  "  再列出值得肯定的地方、潜在风险、明确的改进建议。",
  "- 引用源 agent 的判断时一律用原话，不要重述成你自己的语言。",
  "- 你不需要承接其工作，只做审计。",
].join("\n");

const CONTINUE_INSTRUCTION = [
  "你正在以 **continue（承接）** 模式收到来自 peer agent 的工作交接。",
  "- 上方消息体是源 agent 提供的工作脉络，把它视为当前基础。",
  "- **磁盘/数据库的真实状态优先于消息描述**——冲突时以实际状态为准。",
  "  开工前先用必要的工具（git status / Read / 查询等）核对当前状态。",
  "- 在确认状态后，沿源 agent 的轨迹继续推进下一步工作。",
].join("\n");

const FORK_INSTRUCTION = [
  "你正在以 **fork（换路）** 模式收到来自 peer agent 的工作交接。",
  "- 上方消息体描述了源 agent **已经尝试过**的方案——这是反面参考，不是基础。",
  "- 你要解决的问题是消息中的**任务本身**，请用**不同的思路**重做。",
  "- ⚠ fork 模式典型失败是不自觉地复刻前任路径——",
  "  发现自己在做源 agent 做过的事就停下来重新审视方案。",
].join("\n");

export const DEFAULT_INSTRUCTIONS: Record<PeerMode, string> = {
  review: REVIEW_INSTRUCTION,
  continue: CONTINUE_INSTRUCTION,
  fork: FORK_INSTRUCTION,
  raw: "", // raw 模式不注入 instruction，等价于现状
};

/** Read user-customized instruction from receiver agent's metadata (optional override). */
export function readPeerInstruction(
  receiverMetadata: unknown,
  mode: PeerMode,
): string {
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
  return DEFAULT_INSTRUCTIONS[mode];
}

/**
 * Build the formatted message body delivered to the receiver agent.
 *
 * raw mode  → "[from {name}] {body}"   (legacy, unchanged)
 * other     → "<peer-handoff>...</peer-handoff>\n\n{instruction}"
 */
export function formatPeerHandoff(args: {
  fromName: string;
  fromId: string;
  receiverMetadata: unknown;
  mode: PeerMode;
  body: string;
}): string {
  if (args.mode === "raw") {
    return `[from ${args.fromName}] ${args.body}`;
  }
  const context = CONTEXT_TEMPLATE({
    fromName: args.fromName,
    fromId: args.fromId,
    mode: args.mode,
    body: args.body,
  });
  const instruction = readPeerInstruction(args.receiverMetadata, args.mode);
  return `${context}\n\n${instruction}`;
}
```

---

### 4.3 SessionManager 改造

**文件**：`server/src/sessions/SessionManager.ts`

#### 改动 A：`sendPeerMessage` 签名 + 调用 formatter

```typescript
import { formatPeerHandoff } from "./peerHandoff.js";
import type { PeerMode } from "../peer-mcp.js";

async sendPeerMessage(
  fromAgentId: string,
  target: string,
  body: string,
  mode: PeerMode = "raw",
): Promise<string> {
  const fromAgent = await prisma.agent.findUnique({ where: { id: fromAgentId } });
  if (!fromAgent) return `error: source agent ${fromAgentId} not found`;

  const targetId = await this.resolvePeerTarget(fromAgentId, target);
  if (!targetId) return `error: no peer agent matches "${target}" (excluding self)`;
  const targetAgent = await prisma.agent.findUnique({ where: { id: targetId } });
  if (!targetAgent) return `error: peer agent ${targetId} not found`;
  if (readMetaBool(targetAgent.metadata, "closed")) {
    return `error: peer agent "${targetAgent.name}" is closed; user must restart it before it can receive messages`;
  }
  if (this.running.has(targetId)) {
    return `error: peer agent "${targetAgent.name}" is busy (mid-run); try again after it finishes`;
  }

  const formatted = formatPeerHandoff({
    fromName: fromAgent.name,
    fromId: fromAgent.id,
    receiverMetadata: targetAgent.metadata,
    mode,
    body,
  });

  // 携带血缘元数据，sendMessage 内部塞进 payload
  void this.sendMessage(targetId, formatted, {
    peerOrigin: {
      fromAgentId: fromAgent.id,
      fromAgentName: fromAgent.name,
      mode,
    },
  }).catch((err) => {
    console.error(`[peer_send] sendMessage to ${targetId} failed:`, err);
  });

  return `delivered to "${targetAgent.name}" (id=${targetId.slice(0, 8)}, mode=${mode})`;
}
```

#### 改动 B：`sendMessage` 增加 opts 参数

```typescript
async sendMessage(
  sessionId: string,
  userInput: string,
  opts?: {
    peerOrigin?: { fromAgentId: string; fromAgentName: string; mode: PeerMode };
  },
): Promise<void> {
  // ... 原有逻辑 ...

  // 用户消息持久化时，把 peerOrigin 塞进 payload
  const userMsgPayload = {
    type: "user" as const,
    message: { role: "user", content: userInput },
    ...(opts?.peerOrigin ? { _peerOrigin: opts.peerOrigin } : {}),
  };

  // 其余持久化代码不变
}
```

> `_peerOrigin` 下划线前缀避免与 SDK 字段冲突。前端读这个字段做血缘标记。

---

### 4.4 WS 协议扩展

**文件**：`shared/src/protocol.ts`

```typescript
import type { PeerMode } from "../../server/src/peer-mcp.js"; // 或重新导出

export type ClientMsg =
  | { type: "send_message"; sessionId: string; text: string }
  | {
      type: "peer_send";
      fromSessionId: string;
      targetSessionId: string;
      text: string;
      mode: PeerMode;
    }
  // ... 其它现有类型
  ;
```

**服务端 WS handler**：

```typescript
case "peer_send": {
  await sessions.sendPeerMessage(
    msg.fromSessionId,
    msg.targetSessionId,
    msg.text,
    msg.mode,
  );
  break;
}
```

> 这样**前端走的也是 sendPeerMessage 同一条管道**，格式化逻辑只此一份。

---

### 4.5 前端：血缘解析与渲染

#### 改动 A：扩展 ChatPane 解析逻辑

**文件**：`web/components/ChatPane.tsx`

```typescript
// 旧的 PEER_INCOMING_RE 保留作 raw 模式 fallback
const PEER_INCOMING_RE = /^\[(?:from|来自) ([^\]]+)\]\s*([\s\S]*)$/;
const PEER_OUTGOING_RE = /^→\s*(?:to|发往)\s+([^:]+):\s*([\s\S]*)$/;

// 新：解析结构化 handoff
const PEER_HANDOFF_RE =
  /^<peer-handoff mode="(continue|review|fork)" from="([^"]+)" fromId="[^"]*">\n([\s\S]*?)\n<\/peer-handoff>(?:\n\n([\s\S]*))?$/;

interface PeerInfo {
  direction: "in" | "out";
  fromName: string;
  mode: "continue" | "review" | "fork" | "raw";
  body: string;
}

function parsePeerInfo(text: string, payload: unknown): PeerInfo | null {
  // 优先读结构化 _peerOrigin（最可靠）
  if (
    payload &&
    typeof payload === "object" &&
    "_peerOrigin" in payload
  ) {
    const o = (payload as { _peerOrigin: { fromAgentName: string; mode: PeerInfo["mode"] } })._peerOrigin;
    // 从 context block 中拆出 body
    const m = PEER_HANDOFF_RE.exec(text);
    const ctxBody = m ? m[3]?.replace(/^---\n([\s\S]*)\n---$/, "$1") : text;
    return { direction: "in", fromName: o.fromAgentName, mode: o.mode, body: ctxBody ?? text };
  }
  // 兼容 raw 模式（含历史数据）
  const inc = PEER_INCOMING_RE.exec(text);
  if (inc) return { direction: "in", fromName: inc[1] ?? "", mode: "raw", body: inc[2] ?? "" };
  const out = PEER_OUTGOING_RE.exec(text);
  if (out) return { direction: "out", fromName: out[1]?.trim() ?? "", mode: "raw", body: out[2] ?? "" };
  return null;
}
```

#### 改动 B：Turn 渲染按 mode 上不同徽章

```typescript
function modeColor(mode: PeerInfo["mode"]): string {
  switch (mode) {
    case "review":   return "text-purple-500";
    case "continue": return "text-blue-500";
    case "fork":     return "text-orange-500";
    case "raw":      return "text-[var(--warn)]";
  }
}

function modeIcon(mode: PeerInfo["mode"]): string {
  switch (mode) {
    case "review":   return "🔍";
    case "continue": return "↪";
    case "fork":     return "⑂";
    case "raw":      return "←";
  }
}

// Turn 内
const peer = t.kind === "user" ? parsePeerInfo(t.text, t.payload) : null;
if (peer) {
  return (
    <div className={`whitespace-pre-wrap break-words ${tagColor}`}>
      <span className={`text-[10px] tracking-wider mr-2 ${modeColor(peer.mode)}`}>
        {modeIcon(peer.mode)} {peer.direction === "in" ? "from" : "to"} {peer.fromName} · {peer.mode}
      </span>
      {peer.body}
    </div>
  );
}
```

> 需要 `ChatTurn` 透传原始 `payload`（用于读 `_peerOrigin`）。如果当前
> turn 模型只有 text，可以在 `agents.ts` 的 `ingestSdkMessage` 里把
> `_peerOrigin` 提出来挂在 turn 上。

#### 改动 C：PeerSendPopover 增加 mode 选择

**文件**：`web/components/PeerSendPopover.tsx`

```typescript
const [mode, setMode] = useState<"continue" | "review" | "fork" | "raw">("raw");

// 在 textarea 上方加一组 radio
<div className="flex gap-2 text-xs mb-2">
  {(["raw", "continue", "review", "fork"] as const).map((m) => (
    <label key={m} className="flex items-center gap-1 cursor-pointer">
      <input
        type="radio"
        name="peer-mode"
        value={m}
        checked={mode === m}
        onChange={() => setMode(m)}
      />
      <span>{t(`peer.mode.${m}`)}</span>
    </label>
  ))}
</div>

// onSend：通过新的 WS 消息类型携带 mode
const onSend = () => {
  const trimmed = text.trim();
  if (!trimmed || !targetId) return;
  setBusy(true);
  getWS().send({
    type: "peer_send",
    fromSessionId: fromAgentId,
    targetSessionId: targetId,
    text: trimmed,
    mode,
  });
  // 出向本地日志（暂仍用旧格式，未来可统一）
  appendUserTurn(fromAgentId, t("peer.outgoingFormat", { name: targetName, text: trimmed }));
  onClose();
};
```

---

### 4.6 i18n 新增 key

**文件**：`web/i18n/dict.ts`

```typescript
// 英文
"peer.mode.raw": "Raw",
"peer.mode.continue": "Continue",
"peer.mode.review": "Review",
"peer.mode.fork": "Fork",

// 中文
"peer.mode.raw": "普通转发",
"peer.mode.continue": "承接（continue）",
"peer.mode.review": "审阅（review）",
"peer.mode.fork": "换路（fork）",
```

---

### 4.7 自定义 instruction（P0.5，可选）

如果要支持用户改 instruction，在 AgentSettings 增加一个折叠区：

```tsx
<details className="mt-4">
  <summary>Peer handoff instructions (advanced)</summary>
  {(["continue", "review", "fork"] as const).map((m) => (
    <div key={m}>
      <label>{t(`peer.mode.${m}`)}</label>
      <textarea
        value={metadata.peerInstructions?.[m] ?? DEFAULT_INSTRUCTIONS[m]}
        placeholder={DEFAULT_INSTRUCTIONS[m]}
        onChange={(e) =>
          updateMeta({
            peerInstructions: { ...metadata.peerInstructions, [m]: e.target.value },
          })
        }
      />
    </div>
  ))}
</details>
```

落到 `Agent.metadata.peerInstructions = { continue: "...", review: "...", fork: "..." }`，
已被 `readPeerInstruction()` 读取。

---

## 五、实施顺序建议

推荐 **A → B**，先后端跑通核心链路再做前端美化：

### 阶段 A：Server-only（半天）
1. 新建 `peerHandoff.ts`
2. 改 `peer-mcp.ts`（加 mode 参数）
3. 改 `SessionManager.sendPeerMessage` + `sendMessage`
4. 写单元测试覆盖三模式 + raw 兼容

**验证**：让 Claude 通过工具调用 `peer_send({mode: "review", ...})`，
检查接收方 SDK 入参确实是 context+instruction 格式，且 `Message.payload`
里有 `_peerOrigin`。前端此时仍显示原文（带 `<peer-handoff>` 标签），
功能可用，只是未美化。

### 阶段 B：前端体验（半天）
5. 改 `protocol.ts` 加 ClientMsg
6. 改 WS handler 加 `peer_send` 分支
7. 改 `agents.ts` 透传 `_peerOrigin`
8. 改 `ChatPane.tsx` 解析 + 徽章渲染
9. 改 `PeerSendPopover.tsx` mode radio
10. 加 i18n key

### 阶段 C：可选增强（按需）
11. AgentSettings 自定义 instruction UI

---

## 六、测试清单

```
□ raw 模式：现有测试全部通过（前缀、解析、渲染未变）
□ continue/review/fork：sendPeerMessage 返回 "delivered ... mode=xxx"
□ 接收方 user message payload 包含 _peerOrigin = { fromAgentId, fromAgentName, mode }
□ 接收方 SDK prompt 内容 = context block + instruction block
□ ChatPane 渲染：3 种模式各显示正确徽章颜色与图标
□ Agent.metadata.peerInstructions.review = "自定义文案" → 实际注入自定义文案
□ Agent.metadata.peerInstructions.review = "" 或不存在 → 用默认文案
□ closed / busy 状态下三模式都正确返回 error
□ 历史消息（无 _peerOrigin 的旧 [from xxx] 格式）仍能解析显示为 raw
```

---

## 七、关键文件位置速查

基于 2024 年现状（实施前请重新核对）：

| 关注点 | 文件 | 关键行 |
|---|---|---|
| `PEER_SEND_TOOL_NAME` 定义 | `server/src/peer-mcp.ts` | 5-6 |
| tool schema | `server/src/peer-mcp.ts` | 15-29 |
| `sendPeerMessage` | `server/src/sessions/SessionManager.ts` | 458-481 |
| `resolvePeerTarget` | `server/src/sessions/SessionManager.ts` | 432-456 |
| 用户消息持久化 | `server/src/sessions/SessionManager.ts` | 241-260 |
| SDK 消息持久化 | `server/src/sessions/SessionManager.ts` | 338-358 |
| query() 调用 | `server/src/sessions/SessionManager.ts` | 294-312 |
| Message Prisma schema | `server/prisma/schema.prisma` | 61-72 |
| Agent Prisma schema | `server/prisma/schema.prisma` | 10-34 |
| WS hub 推送 | `server/src/ws/hub.ts` | 46-53 |
| ChatPane 解析 | `web/components/ChatPane.tsx` | 12-13, 234-273 |
| PeerSendPopover 发送 | `web/components/PeerSendPopover.tsx` | 93-104 |
| ingestSdkMessage | `web/store/agents.ts` | 377-451 |
| i18n peer 文案 | `web/i18n/dict.ts` | 161-164, 387-390 |

---

## 八、参考资料

- cxsm 项目主页：https://github.com/ChristopheZhao/cxsm
- cxsm 架构契约：https://github.com/ChristopheZhao/cxsm/blob/main/docs/architecture/pipeline.md
- cxsm 三模式 instruction 源码：
  https://github.com/ChristopheZhao/cxsm/blob/main/crates/sm-cli/src/cmd/interop.rs
  （`REVIEW_INSTRUCTION` / `CONTINUE_INSTRUCTION` / `FORK_INSTRUCTION` 常量）
- cxsm interop renderer：
  https://github.com/ChristopheZhao/cxsm/blob/main/crates/sm-core/src/render/interop.rs

### cxsm 借鉴对照表

| cxsm 概念 | 本方案对应 |
|---|---|
| `Mode { Review, Continue, Fork }` | `PeerMode = "continue" \| "review" \| "fork" \| "raw"` |
| `CONTEXT_TEMPLATE` 常量（不可改） | `CONTEXT_TEMPLATE()` 函数（写死在 peerHandoff.ts） |
| `~/.config/cxsm/instructions/{mode}.md` | `Agent.metadata.peerInstructions[mode]` |
| `InstructionSource::DefaultFile / CustomizedFile` | `readPeerInstruction()` 内部判断 |
| `is_imported_by_cxsm` 紫色 ↰ 标记 | ChatPane 的 `_peerOrigin` 解析 + 三色徽章 |
| `substantive_first_user_message`（boilerplate 跳过） | （未纳入 P0，未来可加 `firstSubstantiveUserMessage()` 工具） |
| handoff packet 显式 truncate 标注 | （未纳入 P0，未来可加按需 lossy 渲染层） |

---

## 九、未来扩展（不属于本方案）

下面是当时分析中识别但未纳入 P0 的借鉴点，留作后续迭代参考：

1. **`systemPrompt` 拆分为 core/user 两段**：保护框架注入的能力声明
   不被用户误删。
2. **`firstSubstantiveUserMessage()` 工具**：穿透 boilerplate / `[from]`
   前缀，让 AgentTree 摘要更准。
3. **按需 lossy 渲染层**：`MessageRenderer.render(messages, { toolOutputMaxBytes: 3000 })`，
   长会话场景前端可选启用，DB 原始数据不动。
4. **`SchemaFingerprint` 容错精神**：`ingestSdkMessage` 遇未知 SDK 类型
   走 fallback 而不是 throw。
