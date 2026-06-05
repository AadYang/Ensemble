# Agent Orchestrator WebUI — 落地方案（历史档案）

> 📦 **此文档是 Ensemble 项目的前身 AgentUI 的设计圣经**。从 W1 到 W15 的所有架构决策、Schema、协议、UI Token、布局引擎、tmux 键位都源自这里。
>
> 2026-05-11 起 AgentUI 仓库 (`D:\WorkSpace\AgentUI\`) 不再维护，本文档迁移到 Ensemble 作为权威设计参考。Ensemble 的代码 fork 自 AgentUI，**协议 / Schema / API 路径全部保持兼容**，所以 §3 Schema、§4 协议、§5 布局引擎、§7 UI 设计 这些章节对 Ensemble 仍然完全适用。
>
> 不再适用的部分（仅与 AgentUI 形态绑定的）：
> - §1 关键决策 中的"PostgreSQL + Prisma" → Ensemble 已切到 node:sqlite (W12 之后)
> - §1 关键决策 中的"Fastify on :3001 + Next dev :3000" → Ensemble 是 Tauri sidecar 模式，端口动态分配
> - §11 下一步切入点 中的 (a)–(d) 都已实施完成
> - §12 实施迭代记录 W1-W12 是 AgentUI 时期；W13–W15 已落地到 Ensemble；W16 设计在 [`multi-sdk-integration.md`](multi-sdk-integration.md)
>
> 实现态对照看 Ensemble 的 [`../architecture.md`](../architecture.md)。

---

# Agent Orchestrator WebUI — 落地方案

> 多 Agent / Subagent 管理的 Web UI，基于 Claude Agent SDK，tmux 风格布局，科技感视觉。

---

## 0. 项目目标

构建一个 Web UI，把多个 Claude Code Agent（含其衍生的 subagent）作为可视化对象进行管理：
- 在浏览器里同时运行、查看、操控多个 agent 会话
- 类 tmux 的多窗口 / 多分屏布局，支持键位操作
- 实时流式输出（token + 工具调用 + 工具结果）
- 工具权限审批从后端转发到前端 UI
- 持久化会话与布局（Postgres），重启可恢复
- 可挂载 MCP server 扩展工具

---

## 1. 整体架构

```
┌─────────────────────────────────────────┐
│  WebUI (Next.js + React)                │
│  ├ tmux 布局引擎（windows + panes）     │
│  ├ Agent 树 / MCP 配置侧栏              │
│  ├ 流式对话 + 工具卡片                  │
│  └ 权限审批弹窗 / 命令面板              │
└─────────────┬───────────────────────────┘
              │ WebSocket (双向 JSON 事件)
┌─────────────▼───────────────────────────┐
│  Orchestrator Server (Node.js + TS)     │
│  ├ Session Manager（每 agent 一 session）│
│  ├ Agent SDK query() 池                 │
│  ├ Permission Broker（canUseTool 桥接） │
│  ├ Hook 审计 / 日志                     │
│  └ Postgres + LISTEN/NOTIFY             │
└─────────────┬───────────────────────────┘
              │ Agent SDK
┌─────────────▼───────────────────────────┐
│  Claude Agent SDK                       │
│  ├ 内置 Task tool → 派生 subagent       │
│  └ MCP servers / 自定义工具             │
└─────────────────────────────────────────┘
```

### 关键决策

- **后端 TypeScript Agent SDK**：比 Python 完整（streaming input、canUseTool、hooks 全支持）
- **WebSocket 而非 SSE**：权限审批需双向（服务端→前端要审批，前端→服务端返回结果）
- **Postgres 直接上**：JSONB 强、LISTEN/NOTIFY 替代 Redis、易扩展到分区
- **每个 Agent 一独立 session**：用 SDK 的 `resume` 能力做持久化与跨重启恢复

---

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Node.js 20 + Fastify + ws | SDK 原生 TS，避免跨语言桥接 |
| Agent | `@anthropic-ai/claude-agent-sdk` | 官方核心 |
| ORM | Prisma | TS 友好、迁移工具好 |
| 数据库 | Postgres 16 | JSONB + LISTEN/NOTIFY + 分区 |
| 实时 | WebSocket (`ws` lib) | 双向、低延迟 |
| MCP | stdio + http 都支持 | SDK 原生 |
| 前端框架 | Next.js 14 (App Router) | SSR 不重要，主要看生态 |
| 状态 | Zustand | 多 agent 共享状态简单 |
| UI 基础 | shadcn/ui + Tailwind | 改色容易，骨架快 |
| 布局 | react-resizable-panels | 递归二叉树渲染最贴 tmux |
| 键位 | react-hotkeys-hook | 支持 prefix 状态机 |
| 命令面板 | cmdk | `Ctrl+B :` |
| 树 | react-arborist | 左侧 Agent 树 |
| 字体 | JetBrains Mono / Berkeley Mono | 全等宽科技感 |

---

## 3. Postgres Schema (Prisma)

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Agent {
  id           String   @id @default(uuid()) @db.Uuid
  parentId     String?  @db.Uuid
  parent       Agent?   @relation("Subagents", fields: [parentId], references: [id], onDelete: Cascade)
  children     Agent[]  @relation("Subagents")
  name         String
  systemPrompt String?  @db.Text
  status       AgentStatus @default(IDLE)
  model        String   @default("claude-opus-4-7")
  workspace    String?  // cwd
  metadata     Json     @default("{}")
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  messages     Message[]
  permissions  Permission[]
  mcpServers   McpServer[]
  paneState    PaneState?

  @@index([parentId])
  @@index([status])
}

enum AgentStatus {
  IDLE
  RUNNING
  AWAITING_PERMISSION
  ERROR
  DONE
}

model Message {
  id        BigInt   @id @default(autoincrement())
  agentId   String   @db.Uuid
  agent     Agent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  seq       Int      // 同一 agent 内单调递增
  type      String   // "user" | "assistant" | "tool_use" | "tool_result" | "stream_event" | "result"
  payload   Json     // 完整 SDK message
  createdAt DateTime @default(now())

  @@unique([agentId, seq])
  @@index([agentId, createdAt])
}

model Permission {
  id           String   @id @default(uuid()) @db.Uuid
  agentId      String   @db.Uuid
  agent        Agent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  toolName     String
  input        Json
  decision     String?  // "allow" | "deny" | "modified"
  updatedInput Json?
  decidedBy    String?  // user id / "auto"
  reason       String?
  requestedAt  DateTime @default(now())
  decidedAt    DateTime?

  @@index([agentId, requestedAt])
}

model McpServer {
  id        String   @id @default(uuid()) @db.Uuid
  agentId   String?  @db.Uuid // null = 全局可用
  agent     Agent?   @relation(fields: [agentId], references: [id], onDelete: Cascade)
  name      String
  transport String   // "stdio" | "http" | "sse"
  config    Json     // {command, args, env} or {url, headers}
  enabled   Boolean  @default(true)
}

model Workspace {
  id             String   @id @default(uuid()) @db.Uuid
  name           String
  layout         Json     // 全局布局（哪些 window）
  activeWindowId String?
  windows        Window[]
  createdAt      DateTime @default(now())
}

model Window {
  id          String    @id @default(uuid()) @db.Uuid
  workspaceId String    @db.Uuid
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  name        String
  layout      Json      // 这个 window 内的 split 二叉树
  order       Int
}

model PaneState {
  agentId   String  @id @db.Uuid
  agent     Agent   @relation(fields: [agentId], references: [id], onDelete: Cascade)
  windowId  String  @db.Uuid
  paneId    String  // 布局树叶子节点 id
  scrollTop Int     @default(0)
}
```

### Postgres 加分项（建议启用）

```sql
-- LISTEN/NOTIFY 用于多后端实例同步消息事件，省一个 Redis
CREATE OR REPLACE FUNCTION notify_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('agent_msg', NEW.agent_id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER msg_notify AFTER INSERT ON "Message"
  FOR EACH ROW EXECUTE FUNCTION notify_message();

-- JSONB GIN 索引加速 payload 查询
CREATE INDEX msg_payload_gin ON "Message" USING GIN (payload);

-- 消息量大后按 agentId 哈希分区或按 createdAt range 分区
```

---

## 4. 后端：Session Manager 核心代码

### 4.1 Session Manager

```typescript
// server/sessions/SessionManager.ts
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";

interface AgentSession {
  id: string;
  parentId?: string;
  name: string;
  status: "idle" | "running" | "awaiting_permission" | "done";
  pendingPermissions: Map<string, { resolve: (v: any) => void }>;
  abortController?: AbortController;
  history: any[];
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  constructor(private wsHub: WSHub, private db: PrismaClient) {}

  async createAgent(opts: {
    name: string;
    systemPrompt?: string;
    mcpServers?: Options["mcpServers"];
    parentId?: string;
  }) {
    const row = await this.db.agent.create({
      data: { name: opts.name, parentId: opts.parentId, systemPrompt: opts.systemPrompt },
    });
    const session: AgentSession = {
      id: row.id, name: row.name, parentId: row.parentId ?? undefined,
      status: "idle", pendingPermissions: new Map(), history: [],
    };
    this.sessions.set(row.id, session);
    this.wsHub.broadcast({ type: "agent_created", session });
    return row.id;
  }

  async sendMessage(sessionId: string, userInput: string) {
    const s = this.sessions.get(sessionId)!;
    s.status = "running";
    s.abortController = new AbortController();

    const stream = query({
      prompt: userInput,
      options: {
        resume: s.history.length > 0 ? sessionId : undefined,
        abortController: s.abortController,
        canUseTool: this.makeCanUseTool(sessionId),
        hooks: this.makeHooks(sessionId),
        mcpServers: { /* 来自配置 */ },
        allowedTools: ["Task", "Read", "Edit", "Bash", "Grep", "Glob"],
      },
    });

    let seq = s.history.length;
    for await (const msg of stream) {
      s.history.push(msg);
      await this.db.message.create({
        data: { agentId: sessionId, seq: seq++, type: msg.type, payload: msg as any },
      });
      this.wsHub.sendToSession(sessionId, { type: "message", msg });

      if (msg.type === "tool_use" && msg.name === "Task") {
        this.trackSubagent(sessionId, msg);
      }
    }
    s.status = "done";
  }

  // canUseTool 桥：把权限请求转发到前端，等待审批
  private makeCanUseTool(sessionId: string) {
    return async (toolName: string, input: any) => {
      const reqId = randomUUID();
      const promise = new Promise<any>((resolve) => {
        this.sessions.get(sessionId)!.pendingPermissions.set(reqId, { resolve });
      });
      await this.db.permission.create({
        data: { id: reqId, agentId: sessionId, toolName, input },
      });
      this.wsHub.sendToSession(sessionId, {
        type: "permission_request", reqId, toolName, input,
      });
      return await promise;
    };
  }

  async resolvePermission(sessionId: string, reqId: string, decision: any) {
    const p = this.sessions.get(sessionId)?.pendingPermissions.get(reqId);
    p?.resolve(decision);
    this.sessions.get(sessionId)?.pendingPermissions.delete(reqId);
    await this.db.permission.update({
      where: { id: reqId },
      data: {
        decision: decision.behavior,
        updatedInput: decision.updatedInput,
        decidedAt: new Date(),
      },
    });
  }

  cancel(sessionId: string) {
    this.sessions.get(sessionId)?.abortController?.abort();
  }

  private makeHooks(sessionId: string) {
    return {
      PreToolUse: [{
        hooks: [async (input: any) => {
          this.wsHub.sendToSession(sessionId, { type: "hook_pre", input });
          return { continue: true };
        }],
      }],
    };
  }

  private trackSubagent(parentId: string, msg: any) {
    // 可选：把 Task 工具调用登记为可视化的 subagent 节点
  }
}
```

### 4.2 WebSocket 协议契约

```typescript
// 前端 → 后端
type ClientMsg =
  | { type: "create_agent"; name: string; systemPrompt?: string }
  | { type: "send_message"; sessionId: string; text: string }
  | { type: "permission_response"; sessionId: string; reqId: string;
      decision: { behavior: "allow" | "deny"; updatedInput?: any; message?: string } }
  | { type: "cancel"; sessionId: string }
  | { type: "interrupt_inject"; sessionId: string; text: string };

// 后端 → 前端
type ServerMsg =
  | { type: "agent_created"; session: AgentSession }
  | { type: "message"; sessionId: string; msg: SDKMessage }
  | { type: "permission_request"; sessionId: string; reqId: string; toolName: string; input: any }
  | { type: "subagent_spawned"; parentId: string; childId: string; description: string }
  | { type: "status"; sessionId: string; status: string };
```

---

## 5. tmux 布局引擎

### 5.1 数据结构

```typescript
// shared/layout.ts —— 前后端共用
type LayoutNode =
  | { kind: "pane"; id: string; agentId: string | null }
  | { kind: "split"; id: string; dir: "h" | "v"; ratio: number;
      a: LayoutNode; b: LayoutNode };

interface Window { id: string; name: string; root: LayoutNode; }
interface Workspace { windows: Window[]; activeWindowId: string; activePaneId: string; }
```

### 5.2 布局操作（纯函数）

```typescript
// shared/layout-ops.ts
splitPane(root, paneId, dir): LayoutNode      // ctrl+b %  /  ctrl+b "
closePane(root, paneId): LayoutNode           // ctrl+b x
focusNext(root, current, dir): string         // ctrl+b 方向键
swapPanes(root, a, b): LayoutNode             // ctrl+b {  / }
resize(root, paneId, dir, delta): LayoutNode  // ctrl+b 方向键
```

### 5.3 渲染

```tsx
// components/LayoutRenderer.tsx
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

export function LayoutRenderer({ node }: { node: LayoutNode }) {
  if (node.kind === "pane") {
    return <AgentPane paneId={node.id} agentId={node.agentId} />;
  }
  return (
    <PanelGroup direction={node.dir === "h" ? "horizontal" : "vertical"}>
      <Panel defaultSize={node.ratio * 100} minSize={10}>
        <LayoutRenderer node={node.a} />
      </Panel>
      <PanelResizeHandle className="resize-handle" />
      <Panel defaultSize={(1 - node.ratio) * 100} minSize={10}>
        <LayoutRenderer node={node.b} />
      </Panel>
    </PanelGroup>
  );
}
```

### 5.4 tmux 键位（默认表）

```
Prefix: Ctrl+B   (或 Ctrl+`，避开浏览器冲突)

Prefix +
  %        水平分屏（左右）
  "        垂直分屏（上下）
  x        关闭当前 pane
  z        zoom 当前 pane（全屏切换）
  o / Tab  焦点循环
  ↑↓←→     方向移动焦点
  H/J/K/L  按住时 resize（vim 风）
  c        新建 window（tab）
  n / p    下一/上一 window
  1-9      切到第 N 个 window
  ,        重命名 window
  d        detach（保存布局回工作区列表）
  s        切换工作区
  :        命令面板（cmdk）
  b        切换左侧栏
  ?        键位帮助
```

实现：用 `react-hotkeys-hook` + 全局状态机，prefix 触发后等下一个键，1.5s 超时自动取消。

```tsx
// hooks/useTmuxKeys.ts
const [prefixed, setPrefixed] = useState(false);
useHotkeys("ctrl+b", () => setPrefixed(true), { preventDefault: true });
useHotkeys("%", () => prefixed && doSplit("h"), { enabled: prefixed });
useHotkeys('shift+\'', () => prefixed && doSplit("v"), { enabled: prefixed });
// ... 触发后 setPrefixed(false)
```

### 5.5 布局持久化

前端操作 → 本地立即生效 → 节流 500ms 推后端 → 写 `Workspace.layout` / `Window.layout`。

新增 REST 接口：

```
POST   /workspaces                    新建工作区
GET    /workspaces                    列出
PATCH  /workspaces/:id/layout         持久化布局（debounced）
POST   /workspaces/:id/windows
DELETE /workspaces/:id/windows/:wid
```

新增 WS 事件：

```typescript
{ type: "layout_update";  windowId; root: LayoutNode }
{ type: "pane_attach";    paneId; agentId }
{ type: "pane_detach";    paneId }
```

---

## 6. 多 Agent / Subagent 编排

Claude Code 内建 `Task` 工具会派生 subagent。两种处理方式：

| 方案 | 实现 | 适合 |
|---|---|---|
| **A. 透明嵌套** | 主 agent 调用 Task，subagent 内部跑完只返回总结 | 默认行为，UI 把 Task 当普通工具卡片展示 |
| **B. 显式建模** | 拦截 Task 工具调用，自己起一个新 `query()`，登记为独立 session | 能在 UI 树里看到每个 subagent，独立审批/取消 |

### 方案 B 实现要点

```typescript
canUseTool: async (toolName, input) => {
  if (toolName === "Task") {
    const childId = await sessionManager.createAgent({
      name: input.description,
      parentId: sessionId,
      systemPrompt: input.prompt,
    });
    sessionManager.runChildAndPipeBack(childId, parentId);
    return { behavior: "deny", message: "handed off to managed subagent" };
  }
  return { behavior: "allow", updatedInput: input };
}
```

**建议**：99% 需求方案 A 就够了。只在需要细粒度管控 subagent 时用 B。

---

## 7. 科技感 UI 设计

### 7.1 设计 Token

| 元素 | 规格 |
|---|---|
| 字体 | `JetBrains Mono` / `Berkeley Mono` / `IBM Plex Mono`（全等宽） |
| 主背景 | `#0a0e14`（近黑带蓝调） |
| Pane 背景 | `#0f1620` |
| 边框 | `#1f2937` 默认，激活 `#00d9ff` |
| 主色 | 青 `#00d9ff` |
| 辅色 | 终端绿 `#00ff9c` / 警告橙 `#ff8800` / 危险红 `#ff3860` |
| 文本 | `#c9d1d9` 主，`#7d8590` 次 |
| 网格 | 1px dot grid，`rgba(0,217,255,0.04)` |
| 标题栏 | 24px 高，左侧状态点（脉冲） |
| 工具卡片 | ASCII 角 `┌ ┐ └ ┘`，hover 发光 |

### 7.2 全局 CSS

```css
:root {
  --bg: #0a0e14;
  --bg-pane: #0f1620;
  --border: #1f2937;
  --border-active: #00d9ff;
  --accent: #00d9ff;
  --ok: #00ff9c;
  --warn: #ff8800;
  --err: #ff3860;
}

body {
  font-family: "JetBrains Mono", monospace;
  background: var(--bg);
  background-image:
    radial-gradient(circle at 1px 1px, rgba(0,217,255,0.05) 1px, transparent 0);
  background-size: 24px 24px;
  color: #c9d1d9;
}

/* 激活 pane 的呼吸边框 */
.pane.active {
  border: 1px solid var(--border-active);
  box-shadow:
    0 0 0 1px var(--border-active),
    0 0 24px -4px rgba(0,217,255,0.5),
    inset 0 0 60px -30px rgba(0,217,255,0.15);
  animation: pulse 2.4s ease-in-out infinite;
}
@keyframes pulse {
  50% { box-shadow:
        0 0 0 1px var(--border-active),
        0 0 32px -2px rgba(0,217,255,0.8),
        inset 0 0 80px -30px rgba(0,217,255,0.25); }
}

/* 状态指示点 */
.status-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.status-dot.running {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
  animation: blink 1s steps(2) infinite;
}
.status-dot.idle  { background: #4b5563; }
.status-dot.error {
  background: var(--err);
  box-shadow: 0 0 8px var(--err);
}
@keyframes blink { 50% { opacity: 0.3; } }

/* 流式 token 光标 */
.stream-cursor::after {
  content: "▊"; color: var(--accent);
  animation: cursor 1s steps(2) infinite;
}
@keyframes cursor { 50% { opacity: 0; } }

/* resize handle */
.resize-handle {
  background: var(--border); width: 1px;
  transition: background 0.15s, width 0.15s;
}
.resize-handle[data-panel-resize-handle-active] {
  background: var(--accent); width: 2px;
  box-shadow: 0 0 12px var(--accent);
}

/* ASCII 角装饰 */
.tool-card {
  position: relative;
  border: 1px solid var(--border);
  background: rgba(15,22,32,0.6);
  backdrop-filter: blur(4px);
}
.tool-card::before, .tool-card::after {
  content: ""; position: absolute; width: 8px; height: 8px;
  border-color: var(--accent);
}
.tool-card::before { top:-1px; left:-1px;  border-top:1px solid; border-left:1px solid; }
.tool-card::after  { bottom:-1px; right:-1px; border-bottom:1px solid; border-right:1px solid; }
```

### 7.3 屏幕分区

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ▎AGENT.ORCHESTRATOR                  ◉ 4 active   ◯ 1 idle    01:23:45  │ ← 顶栏
├──────────┬──────────────────────────────────────────────────────────────┤
│          │ ┌─[main · running]────┬─[reviewer · idle]──────────────────┐ │
│  TREE    │ │                     │                                    │ │
│  ▸ main  │ │  > implement auth   │  Waiting for input...              │ │
│  ▸ revw  │ │  ⌬ Bash: pnpm test  │                                    │ │
│  ▸ doc   │ │  ◐ Edit: src/...    │                                    │ │
│          │ │  ▊                  │                                    │ │
│  MCP     │ ├─────────────────────┴────────────────────────────────────┤ │
│  ● fs    │ │ [doc-writer · perm? Bash:rm -rf]                         │ │
│  ● git   │ │                                                          │ │
│  ○ slack │ │                                                          │ │
│          │ └──────────────────────────────────────────────────────────┘ │
├──────────┴──────────────────────────────────────────────────────────────┤
│ [1:main]* [2:reviewer] [3:scratch]+              C-b ?  for help        │ ← tmux 状态栏
└─────────────────────────────────────────────────────────────────────────┘
```

- **顶栏**：品牌名 + 全局状态摘要 + 时钟（运行时长）
- **左侧栏**（可折叠 `Ctrl+B b`）：Agent 树 / MCP 服务 / 工作区列表
- **中央**：tmux 布局区
- **底栏**（tmux 风格状态栏）：window 列表 + 当前工作区 + 提示

### 7.4 Pane 标题栏格式

```
▎ main · claude-opus-4-7 · cwd:/repo · ◉ running · 12 msg · 3 tools   [×]
```

- 左侧 `▎` 竖条颜色 = 状态
- 中段元数据等宽紧凑
- hover 出 `[zoom] [split-h] [split-v] [×]` 工具按钮（透明度过渡）

### 7.5 推荐资源

- shadcn/ui + 圆角统一改 `2px`，配色覆盖到上述变量
- lucide-react 图标，部分换成 ASCII 字符（`◉ ◯ ◐ ⌬ ▊ ▎`）
- xterm.js —— 若要在某 pane 跑真实终端
- Monaco editor —— 文件查看/编辑 pane
- react-arborist —— 左侧 Agent 树
- cmdk —— `Ctrl+B :` 命令面板
- 字体首选 Berkeley Mono（付费），免费用 JetBrains Mono

---

## 8. 落地路线图

| 周 | 目标 | 验收 |
|---|---|---|
| **W1** | Fastify + Postgres + Prisma + Agent SDK；单 pane 跑通 | 一个 agent 完整对话 |
| **W2** | tmux 布局引擎（split / focus / close / resize）+ 键位 + 持久化 | 多 pane 自由切分 |
| **W3** | 科技感主题 + ToolCard + 权限弹窗 + 流式光标 | 视觉成型 |
| **W4** | 多 window（tab）+ 工作区切换 + LISTEN/NOTIFY 跨实例同步 | 多人/多端可用 |
| **W5** | MCP 配置 UI + Subagent 树视图 + 命令面板（cmdk） | 完整功能集 |

---

## 9. 脚手架命令

```bash
# 后端
mkdir orch && cd orch
pnpm init
pnpm add fastify ws @anthropic-ai/claude-agent-sdk @prisma/client zod pino
pnpm add -D prisma typescript tsx @types/ws
npx prisma init --datasource-provider postgresql

# 前端
pnpm create next-app web --ts --tailwind --app
cd web
pnpm add zustand react-resizable-panels react-hotkeys-hook \
  cmdk lucide-react react-arborist @radix-ui/react-dialog
```

环境变量：

```
DATABASE_URL=postgresql://user:pass@localhost:5432/agentorch
ANTHROPIC_API_KEY=sk-ant-...
WS_PORT=3001
```

---

## 10. 容易踩的坑

1. **WebSocket 断线**：要把 `pendingPermissions` 缓存住，重连后重发，否则 agent 会卡在 `canUseTool` 等待
2. **`abortController` 不能复用**——每次 query 新建
3. **`stream_event` vs `message`**：前者是 token 增量，后者是结构化消息，UI 要分别处理
4. **subagent 不共享 `canUseTool`**——SDK 的 Task 内部用自己的权限模式，要拦只能在父级 Task 工具调用层拦（方案 B）
5. **MCP stdio server 是子进程**：服务端要管生命周期，agent 重启时清理
6. **不要用 `claude -p` 子进程方案**：进程隔离会让 `canUseTool` 双向桥变得很难，直接用 SDK 库
7. **`Ctrl+B` 在浏览器是粗体快捷键**，要 `preventDefault`；或换 `Ctrl+\``
8. **Prisma 在 Postgres 上的 `@db.Uuid`** 要确保扩展启用：`CREATE EXTENSION IF NOT EXISTS pgcrypto;`
9. **JSONB 列大消息**：单条消息超 1MB 要考虑拆字段或外存（S3/MinIO）

---

## 11. 下一步可选切入点

落盘后，按需推进：

- (a) tmux 布局引擎（`splitPane / focusNext / resize` 纯函数 + 单测）完整实现
- (b) Pane / TitleBar / StatusBar React 组件（带科技感样式）
- (c) WebSocket 协议 + `canUseTool` 桥的完整可运行后端代码
- (d) Postgres 迁移 + LISTEN/NOTIFY → WS 桥接代码
- (e) **W14 Subagent 推荐**（设计已落盘 [`docs/plans/subagent-suggestions.md`](docs/plans/subagent-suggestions.md)）：点「+ 子 agent」时基于父 agent 对话内容推荐 3 个模板 + 永驻「自己创建」，1.5–2 个工作日
- (f) ✅ **W15 派生独立桌面项目 Ensemble**（已实施，2026-05-10）：仓库在 `D:\WorkSpace\Ensemble`，Tauri 2.x sidecar 包装。设计文档 [`docs/plans/ensemble-spinoff.md`](docs/plans/ensemble-spinoff.md)；实施现状看 `D:\WorkSpace\Ensemble\docs\architecture.md` + `docs/plans/development-log.md`。**AgentUI 本仓库零改动**——继续作为 web-first / 自托管形态维护。产物：`Ensemble_0.0.1_x64-setup.exe` (NSIS, ~26 MB, per-user 装到 `%LOCALAPPDATA%\Ensemble\`)
- (g) **W16 多 SDK 原生集成**（设计已落盘 [`multi-sdk-integration.md`](multi-sdk-integration.md)，未实施）：抽 `AgentRuntime` 接口，按 provider.kind 路由到 `@anthropic-ai/claude-agent-sdk`（现有）或 `@openai/agents`（新）；废弃 musistudio 翻译路径——它做不了完整 agent 语义，且 claude CLI 本地模型白名单卡死了非 Claude 模型名（`gpt-5.4` 这种）。v1 估约 2 周；解锁 OpenAI / DeepSeek / GLM / 国产模型原生使用

---

## 12. 实施迭代记录（W1–W5 之后）

> 本节记录原 §1–§11 落地后的迭代决策、SDK 实测发现、与原方案的偏离。**之前章节保留作历史参考**——以本节为最新事实。

### 12.1 已完成的迭代（W6 起，按时间顺序）

| 迭代 | 主题 | 关键产出 |
|---|---|---|
| W6 | UX & 生命周期完善 | 默认 agent-N 自增名；agent 唯一绑定（一个 agent 一时刻只在一个 pane）；sidebar `●` 已绑标记；Agent 设置弹窗（rename / model / permissionMode / close / restart / delete / + child）；修双重显示 bug（LISTEN/NOTIFY race）；plan 模式标识 |
| W7 | i18n + 键位帮助 | 自实现 i18n（dict + useT，不引大库）；中英全译；`localStorage` 持久化；`?` 键位帮助 modal |
| W8 | Peer-talk | 用户手动 `@→` forward；模型主动通过 in-process MCP 工具 `peer_send`；user input 持久化 + broadcast（顺手修了刷新丢消息的旧 bug） |
| W9 | Provider 多供应商 | `Provider` 表（kind / baseUrl / apiKey / models）；REST CRUD + `refresh-models`；agent 关联 provider；query options 注入 `env: ANTHROPIC_BASE_URL/API_KEY` 路由到不同 endpoint |
| W10 | LiteLLM 一键起 | `docker-compose.yml` 加 `litellm` 服务（profile `litellm`）；server `litellm-control.ts` 模块管 docker compose 生命周期；ProviderPanel 顶部 service bar 启停；autoManaged provider 自动写 `litellm-config.yaml` |
| W11 | ask_user MCP + 斜杠命令 | 新 `awaiting_user_input` 状态（紫色脉动）；in-process MCP `agentorch-ask-user` 提供 `ask_user(question, options)` —— 永不超时、自动批；AskUserDialog（portal + 可拖拽）；ChatPane 拦截 `/` 起头输入处理 `/help /model /provider /close /restart`；slash 命令本地执行不发给模型 |
| W12 | plan 模式 + 自动模式按钮 + 持久化补完 | 把 `ExitPlanMode` 加进 SDK `tools` 白名单（之前漏了模型看不到这工具）；移除 `maxTurns: 8` 上限避免长任务被打断；PermissionDialog 加第三个按钮 "Allow + 自动模式"（Shift+Enter）—— 放行当前调用 + PATCH agent 切到 `acceptEdits`；page mount 时新加 `GET /agents` + `GET /agents/:id/messages?limit=200` 双轨 hydrate（修了"刷新后状态卡 awaiting_permission 不弹框"的 bug + "重开浏览器看不到历史消息"） |
| W13 | peer_send 四模式（cxsm-inspired） | peer_send 从扁平消息广播升级为任务交接协议：`raw / continue / review / fork`；新增 `server/src/sessions/peerHandoff.ts` 集中模板（context 块框架拥有不可改 + 三模式 instruction 默认值，可被 `Agent.metadata.peerInstructions[mode]` 覆盖）；user message payload 加 `_peerOrigin = {fromAgentName, fromAgentId, mode}` 携带血缘；新 ClientMsg `peer_send`（之前 PeerSendPopover 走 `send_message` 自己拼字符串，现在统一由 server 格式化）；前端 ChatPane 按 mode 渲染颜色与图标（紫/蓝/橙/黄）；`raw` 模式保留原 `[from X] body` 字符串路径完全向后兼容历史数据 |

### 12.2 与原方案的关键偏离

#### a) §6 方案 B Subagent 不可达

**plan §6.1 假设**：`canUseTool` 能拦截内置 `Task` 工具，自动派生独立 child session。

**实测发现**：SDK 0.1.x 把 `Task` 工具归入 CLI 内部"安全自动批"白名单（同 Read/Glob/Grep/echo Bash），**根本不调用 `canUseTool`**。debug 日志显示有 `executePreToolHooks called for tool: Task` 但**没有** `can_use_tool` 控制请求。SDK 也没暴露 hook 让我们改这个行为。

**采纳方案**：
- 内置 Task 仍走方案 A（透明嵌套），UI 显示为父 agent 的 ToolCard
- "用户驱动方案 B"：AgentSettings 加 `+ child` 按钮，create_agent 协议加 `parentId?`，AgentTree 自动嵌套渲染
- 模型主动协作改用 `peer_send` MCP 工具（W8）—— 不是 subagent 关系，是 peer 关系

**未来路径**：自定义 MCP 工具 `spawn_managed_agent` 让模型派生我们管控的 child（需要写 in-process MCP server，工作量大但思路清晰；当前未实施）。

#### b) Provider 通过 `Options.env` 实现多供应商

**SDK 不暴露 `baseUrl` / `apiKey` 选项**，但暴露 `Options.env: Record<string, string>` 透传给 CLI 子进程。利用这个：
- 每次 `query()` 前根据 agent.providerId 拉 Provider 行，把 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 注入 env
- kind=bedrock → 加 `CLAUDE_CODE_USE_BEDROCK=1`；kind=vertex → `CLAUDE_CODE_USE_VERTEX=1`
- autoManaged provider 强制 baseUrl=`http://localhost:4000`（本地 LiteLLM）

**LiteLLM 容器**：通过 docker compose `profiles: ["litellm"]` 实现"按需启动"——`pnpm db:up` 不会带起，必须 `docker compose --profile litellm up -d litellm`（UI 按钮调用此命令）。配置文件 `litellm-config.yaml` 由 server 从 autoManaged Providers 自动生成 + 容器 bind-mount + restart 重新加载。

#### c) Subagent 树视图依然有用（虽然方案 B 不通）

`AgentTree` 按 `parentId` 嵌套渲染——用户驱动 spawn-child 时它就发挥作用。`onDelete: Cascade` 让删父级联删子。

#### d) Peer-talk 的"工作区边界"实际上不存在

用户问"同 workspace 不同 agent 能否 teams 风交流"——但当前 `Workspace` 表只装 windows/panes，**不限制 agent 池**。所有 agents 跨 workspace 共享。Peer 实际范围是"全部其他 agents"。要严格按 workspace 限制需给 `Agent` 加 `workspaceId` 字段——本次未做（schema 改动 + 历史数据迁移）。

#### e) 协议变更小记

| 时点 | 变更 | 主题 commit |
|---|---|---|
| W3.3 | `permission_request / permission_response` | 权限审批 |
| W4.1 | `LayoutWindow.activePaneId`；`AgentSummary` 加 `closed / hasResumeInfo / permissionMode` | 多 window |
| W4.2 | `agent_updated / agent_deleted` 事件 | 生命周期 |
| W4.3 | `subscribe / unsubscribe` 真正生效（之前 W1 是 no-op） | hub 路由 |
| W6 | `create_agent` 加 `parentId? + providerId?`；PATCH 接 `name / model / permissionMode / providerId` | provider + child |
| W8 | 新 server msg type `user`（broadcast user input）；`type:"message"` 现在能携带 `user` 类 SDK message | peer-talk |
| W11 | `AgentStatus` 加 `awaiting_user_input`；`ServerMsg user_question{sessionId,reqId,question,options}` + `ClientMsg user_answer{sessionId,reqId,choice}` | ask_user |
| W13 | 新 `ClientMsg peer_send{fromSessionId,targetSessionId,text,mode}`；新共享类型 `PeerMode = "continue"\|"review"\|"fork"\|"raw"`；user message payload 内嵌 `_peerOrigin` | peer-modes |

#### f) 类似 AskUserQuestion 的工具为啥要重做成 MCP（而 ExitPlanMode 一个白名单就够）

经验法则：**返回值能塞进 `canUseTool` 的 `allow / deny` 二态的内置工具，加白名单就够；返回值更复杂的（如多选一字符串），必须自己写 MCP 取代之**。

- `ExitPlanMode({plan})`：语义就是"approve / reject plan"，二态。Allow → SDK 内部退出 plan 模式继续执行；Deny → 留在 plan。canUseTool 流就够。
- `AskUserQuestion({question, options})`：要返回"用户选了哪个 option"，是 N 选一字符串，二态装不下。退一步即使 canUseTool 返回 allow，SDK 还会去执行内置实现（CLI TUI 渲染选项）——library 模式下没 TUI 会挂或报错。所以只能换成自家 MCP `ask_user`，handler 是我们的代码 → 通过 WS 弹 AskUserDialog → 用户选完返回 option 字符串作为 tool_result。

### 12.3 已锁定决策的更新（覆盖 §1）

| 主题 | 旧锁定 | 新锁定 / 实测 |
|---|---|---|
| Subagent 编排 | 默认方案 A | **保留方案 A**；方案 B 因 SDK 限制改为"用户驱动 spawn-child"+ `peer_send` MCP（W13 起 peer_send 升级为四模式任务交接协议） |
| MCP 共享 | 全局 | **不变**；新加 in-process MCP `agentorch-peer` 由系统注入，与用户配置的 MCP 共存 |
| 模型供应商 | (隐式 Anthropic only) | **支持多 provider**：anthropic / openai-compat / bedrock / vertex；可选 LiteLLM 路由 |
| API key 存储 | 未规定 | **明文存 Provider 表**（开发期接受；生产前应加 pgcrypto） |
| 国际化 | 未规定 | 自实现 dict + useT；en/zh；localStorage 持久化 |

### 12.4 §3 Schema 实际形态（覆盖原 §3）

实际数据库 schema 在原 plan §3 基础上演进：

```prisma
model Agent {
  id           String      @id @default(uuid()) @db.Uuid
  parentId     String?     @db.Uuid    // 子 agent 关联父
  name         String
  systemPrompt String?
  status       AgentStatus @default(IDLE)
  model        String      @default("claude-opus-4-7")
  providerId   String?     @db.Uuid    // → Provider (FK Restrict)
  metadata     Json        @default("{}")  // {permissionMode, closed, lastSessionId}
  // ... messages / permissions / mcpServers / paneState relations
}

model Provider {                              // W9 新增
  id               String   @id @default(uuid()) @db.Uuid
  name             String   @unique
  kind             String                    // anthropic / openai-compat / bedrock / vertex
  baseUrl          String?
  apiKey           String?
  autoManaged      Boolean  @default(false)  // W10 新增（LiteLLM 路由开关）
  upstreamProvider String?                    // W10 新增
  upstreamModel    String?                    // W10 新增
  models           String[] @default([])     // refresh-models 缓存的列表
  isDefault        Boolean  @default(false)
}
```

`Workspace.windows`、`Window`、`PaneState` 表保留为 W2 设计但 W4 之后实际把整个布局都存到 `Workspace.layout` JSON（不再用 `Window` 表），这是 plan §3 的"分表 vs 单 JSON"折中——选了单 JSON 简化 read/write，多 window 子树嵌在 JSON 里。

### 12.5 §10 易踩坑增补

| # | 新坑 | 处理 |
|---|---|---|
| 10 | SDK 内置 Task / Read / 部分 Bash 不经 canUseTool | UI 上把这点告诉用户；不要试图在 SDK 端拦截 |
| 11 | `prisma.findUnique({where:{id:"非UUID"}})` 直接抛错 | 查询前 UUID_RE 检查 |
| 12 | LISTEN/NOTIFY 时序 race（Message INSERT 触发 NOTIFY 早于本地 RecentSeqs.add） | 调换顺序：先 noteLocalBroadcast 再 prisma.create |
| 13 | turbopack 不解析 `.js` 后缀指向 `.ts` 文件 | shared 包内部 import 不带后缀 |
| 14 | DB 里历史同名 agent 抢 peer_send 匹配 | resolvePeerTarget 用 `orderBy createdAt desc` |
| 15 | LiteLLM 首次 start 拉镜像超慢 | 用户文档化：手动 `docker pull` 预热 |
| 16 | autoManaged Provider 删除时 yaml 没重生 | DELETE handler 也要 reload() |
| 17 | SDK `tools` 白名单写死却漏了 `ExitPlanMode` 导致 plan 模式没 exit 出口 | 内置工具按需补；当前完整白名单 `[Read, Edit, Write, Bash, Grep, Glob, Task, ExitPlanMode]` |
| 18 | 默认 `maxTurns: 8` 长任务半路被打断 | 直接去掉该选项让 SDK 默认无限；要兜底就调大 |
| 19 | 刷新后 store.agents 为空 → hello 时按 store keys 重新 subscribe 没东西 → 触发的 permission_request `sendToSession` 0 订阅者，弹窗永不出现 | mount 时主动 `GET /agents` hydrate + 立即 subscribe；hello 那条 loop 仍保留作为重连兜底 |
| 20 | Next.js 静态导出 (`output:"export"`) 把 `rewrites()` 静默丢掉 → `/api/*` 全走 Next 自身 router 404 | 不要在 webui 项目用 `output:"export"`（spike 残留）；保留 `rewrites: /api/:path* → server:3001/:path*` |
| 21 | `pnpm dev` 退出时 `tsx` / `next` 子进程不会被 pnpm 父进程信号杀，端口 3000/3001 被孤儿占住 | 重启 dev 前 `taskkill /T /F` 老 pnpm/tsx 树；或 `Stop-Process` 按 PID |

### 12.6 当前架构图

```
┌────────────────────────────────────────────────────────┐
│  WebUI (Next.js)                                       │
│  ├ tmux 布局 + windows + workspaces                    │
│  ├ AgentTree（含 parentId 嵌套）                       │
│  ├ ProviderPanel（含 LiteLLM service bar）             │
│  ├ AgentSettings popover（lifecycle + provider 联动）  │
│  ├ PeerSendPopover（用户手动 forward）                 │
│  ├ PermissionDialog（Allow / Allow+auto / Deny）       │
│  ├ AskUserDialog（多选一，永不超时）                   │
│  ├ ChatPane 斜杠命令 (/help /model /provider /close /restart) │
│  ├ CommandPalette / KeyHelpDialog / GlobalSettings     │
│  ├ mount 时 hydrate /agents + /agents/:id/messages     │
│  └ 30+ i18n 词条 en/zh                                 │
└─────────────┬──────────────────────────────────────────┘
              │ WebSocket (per-session subscribe)
┌─────────────▼──────────────────────────────────────────┐
│  Orchestrator Server (Node + Fastify)                  │
│  ├ SessionManager (canUseTool / resume / lifecycle)    │
│  ├ peer-mcp.ts (in-process MCP, 每 query 一实例)       │
│  ├ litellm-control.ts (docker compose 调度)            │
│  ├ pg-listener.ts (LISTEN/NOTIFY 跨实例同步)           │
│  └ REST: /workspaces /agents /agents/:id/messages      │
│         /providers /mcp-servers                        │
│         /litellm/{status,start,stop}                   │
└─────────────┬──────────────────────────────────────────┘
              │ Agent SDK (env-injected per call)
┌─────────────▼──────────────────────────────────────────┐
│  Claude Agent SDK CLI 子进程                           │
│  ├ ANTHROPIC_BASE_URL / API_KEY 来自 Provider          │
│  ├ MCP servers: 用户配置 + agentorch-peer + agentorch-ask-user │
│  ├ peer_send: continue/review/fork/raw 四模式（cxsm-inspired）│
│  ├ tools 白名单: Read/Edit/Write/Bash/Grep/Glob/Task/ExitPlanMode │
│  └ allowedTools: [peer_send, ask_user] 自动批准        │
└─────────────┬──────────────────────────────────────────┘
              │ 默认 → Anthropic 直连
              │ autoManaged → http://localhost:4000 (LiteLLM)
              │              → 上游 OpenAI/DeepSeek/Groq/...
              ▼
       Postgres + (optional) LiteLLM 容器
```

