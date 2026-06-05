# Ensemble

> **Many minds. One workspace.** — 群智，一席。
>
> 一台机器，几位「同事」：把 Claude / OpenAI / Codex 装进同一个 tmux 风格的工作台，让它们各干各的、互相递话、互相 review，并把每一次推理的 token 与开销都看得见。

---

## 一句话定位

**Ensemble 是一个跨 SDK 的多 Agent 协作桌面应用**。你在同一个窗口里同时开 N 个 AI agent，每个 agent 可以来自不同的供应商（Anthropic / OpenAI / OpenAI Codex / 任何兼容端点），它们可以彼此发消息、相互 review、自动推荐子 agent 来分担工作，所有 token 消耗都被实时记录、按模型 / 供应商 / agent / 日期四维度汇总。

新手能在 5 分钟内创建第一个 agent 并对话；老手能用 `Ctrl+B` 前缀键在 9 个窗口、N 个 pane 间切换布局，把权限模式细调到「只对边界 case 弹窗、其它放行」，并把单次会话花了多少钱精确到分。

---

## 设计理念

Ensemble 的设计围绕四根支柱展开：

### 1. 多 Runtime 抽象 — 一个接口，三种 SDK

业界 AI Agent 框架往往锁死一家供应商。Ensemble 把 LLM 调用层抽象成 `AgentRuntime` 接口（`core/src/sessions/runtimes/types.ts`），三种实现共存：

| Runtime | SDK 包 | 用途 |
|---|---|---|
| `ClaudeAgentRuntime` | `@anthropic-ai/claude-agent-sdk` | Claude 全功能（tool_use / MCP / streaming） |
| `OpenAIAgentRuntime` | `@openai/agents` | OpenAI Responses API + function calling |
| `CodexCliRuntime` | `@openai/codex-sdk` | OpenAI Codex CLI（本地代码执行、沙箱隔离） |

`chooseRuntime(kind)` 工厂（`core/src/sessions/runtimes/index.ts:16`）根据供应商 kind 路由到对应 runtime。**对上层 SessionManager 来说，三种 SDK 是同一种东西**。这意味着：
- 用户切换供应商，agent 代码 / UI 行为不变
- 加新 runtime 是「新建一个文件 + 在 chooseRuntime 加一行」
- token 抽取、消息存储、权限审批、peer 消息这些上层逻辑 100% 复用

### 2. Agent 是一等公民，不是无状态请求

每个 agent 在 SQLite 里是一行（`core/src/db.ts:30-43` `Agent` 表）：有自己的 id、名字、parentId、当前 model、permission mode、metadata。Agent 之间可以形成树（父子关系），并且能**互相发消息**——这是 Ensemble 和单 agent UI 最关键的不同。

### 3. 可观测、可控制

每一次 LLM 调用结束都会落一行 `UsageEvent`（`core/src/db.ts:95-112`），含 inputTokens / outputTokens / cacheRead / cacheCreation / 模型名 / 供应商 / agent / 计费模式 / 美元成本。Agent 的每一次 tool 调用都走 5 档权限审批流程，可记录、可审计、可回放。

### 4. 键盘优先，tmux 风格

界面整体 `JetBrains Mono` 等宽 + 青色 (#00d9ff) on 深灰 (#0a0e14) 配色，所有布局操作走 `Ctrl+B` 前缀键（`desktop-ui/hooks/useTmuxKeys.ts`）：`%` 横分，`"` 竖分，`x` 关闭 pane，`o` 切下一个，`H/J/K/L` resize，`1-9` 切窗口。鼠标可用，键盘永远更快。

---

## 技术亮点

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Tauri 2 (Rust shell) — borderless                   │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Next.js 16 + React 19 + Tailwind 4 + Zustand                  │  │
│  │  static-export → 内嵌进 Tauri webview                          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│              ↕ WebSocket (Fastify) + REST API                        │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ensemble-core.exe (Node SEA 单文件，~93 MB)                   │  │
│  │  Fastify 5 + node:sqlite + 三个 LLM SDK + MCP server          │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

- **后端**：Node.js 22 + TypeScript strict + Fastify 5 + `node:sqlite`（WAL 模式 + foreign keys 强制）
- **前端**：Next.js 16 + React 19 + Tailwind 4 + Zustand + react-resizable-panels（递归二叉树渲染）
- **桌面壳**：Tauri 2.x（Rust），自定义无边框窗口，原生标题栏被替换为应用内 ⨯/▢/− 控件
- **打包**：Node Single Executable Application（SEA）把 server 烤成单文件 EXE；Tauri 把 webview + sidecar 打成 NSIS / MSI 安装包
- **跨语言**：协议在 `shared/src/protocol.ts`，被 core 和 desktop-ui 同时 import；任何字段变化编译期就报错

---

## 核心功能详解

### 🎯 多供应商 / 多模型

#### 5 种 Provider Kind（`core/src/index.ts:245`）

```ts
PROVIDER_KINDS = ["anthropic-local", "anthropic", "openai-local", "openai-codex", "openai-compat"]
```

| Kind | 含义 | 认证 | Runtime |
|---|---|---|---|
| `anthropic-local` | 本机 Claude OAuth（claude.ai 订阅） | OAuth 文件 | Claude SDK |
| `anthropic` | Anthropic 官方或 anthropic-compat 第三方 | sk-ant-... | Claude SDK |
| `openai-local` | OpenAI 官方 (api.openai.com) | sk-... | OpenAI Agents SDK |
| `openai-codex` | 本机 Codex CLI（ChatGPT 订阅） | `codex login` | Codex SDK |
| `openai-compat` | OpenAI 兼容第三方（DeepSeek/智谱/vLLM 等） | sk-... 或自定义 | OpenAI Agents SDK |

#### 模型自动发现

不需要手填模型名。三种发现机制：

1. **HTTP `/v1/models` 探测**（OpenAI 系 + Anthropic 系第三方）：`probeModels(baseUrl, apiKey, flavor)` 函数尝试候选 URL，解析 OpenAI 或 Anthropic 形状的 JSON，返回模型列表
2. **本地 codex catalog**（codex 专用）：调用 `codex debug models` 拿到 JSON catalog，按 `visibility === "list"` && `supported_in_api === true` 过滤，按 `priority` 排序
3. **预置 preset**（`desktop-ui/lib/provider-presets.ts:23-74`）：内置 MiniMax / DeepSeek / 智谱 GLM 的 Anthropic 与 OpenAI 两种端点 preset，一键填好 baseUrl + 模型列表

新建供应商后**自动触发**一次模型刷新（`ProviderPanel.tsx` `onSubmitNew`），用户看到的新行直接带模型列表。

#### 切供应商不串模型

`desktop-ui/components/AgentSettings.tsx` 和 `NewAgentDialog.tsx` 都有一个共同的 effect：当 `providerId` 变化、且当前 model 不在新供应商的模型列表里时，自动重置为新供应商的第一个可用模型。这样不会出现「openai-codex 供应商的下拉框里混进 `claude-opus-4-7`」的尴尬。

---

### 🤝 多 Agent 协作

这是 Ensemble 最有意思的部分。每个 agent 都被注入一个**私有 MCP server**，暴露两个工具：`peer_send` 和 `ask_user`。

#### peer_send：Agent 之间互递消息（`core/src/peer-mcp.ts`）

构造时机：每次 `sendMessage` 进入流前都新建一个 MCP server 实例（`makePeerMcpServer(sessions, fromAgentId)`），把 `fromAgentId` 闭包在工具实现里——保证身份不串号。

4 种语义模式（`shared/src/protocol.ts` `PeerMode`）：

| 模式 | 含义 | 接收侧上下文标记 |
|---|---|---|
| `raw` | 原样转发（默认） | `[from X] {text}` |
| `continue` | "接手吧" | `↪ 继续 X 的工作：{text}` |
| `review` | "你审一下" | `🔍 X 请你 review：{text}` |
| `fork` | "你也试试" | `⑂ 同一个任务，换思路：{text}` |

发送是 fire-and-forget（不阻塞发送方）。UI 上接收方的消息流里会以专门的样式渲染（紫色 review / 蓝色 continue / 橙色 fork），让用户一眼看出这是 agent 间消息还是用户输入。

#### ask_user：Agent 向用户提问（`core/src/ask-user-mcp.ts`）

Agent 在不确定时主动调用 `ask_user(question, options)`，SessionManager 暂停 agent 流，发 `user_question` WebSocket 消息到 UI（`AskUserDialog.tsx`），用户点选项后选择项作为工具返回值喂回 agent。

这条路径让 agent 可以**自适应地把决策权交还给人**——比如代码 reviewer 不确定是按 PR1 还是 PR2 的风格修改时，弹给用户选。

#### 跨 Runtime 的 MCP Bridge（codex 专用，W20 新增）

Codex CLI 不接受 in-process MCP server（它只认 stdio/http/sse）。Ensemble 为 codex 起了一个**本地 HTTP MCP server**（`core/src/mcp-bridge.ts`），用 boot-time 随机 token 鉴权，把 `peer_send` / `ask_user` / `Task` 三个工具通过 TOML `mcp_servers.<name>.url` 注入到 codex 的 config 里。codex agent 用起来和 Claude agent 完全一致。

#### Agent 树渲染（`desktop-ui/components/AgentTree.tsx`）

Agent 在侧边栏按 `parentId` 递归渲染成树，可折叠 / 可悬浮设置按钮。绑定到当前 pane 的 agent 用青色高亮。

---

### 🪄 Subagent 自动推荐（`core/src/subagent-suggest.ts`）

新手最大的痛点：「我应该让谁干这件事？」Ensemble 用 LLM 帮你想。

流程：
1. 用户在 `AgentSettings` 点「Suggest child」
2. 后端拉父 agent 最近 N 轮对话历史
3. 把历史 + 内置角色 catalog（code-reviewer / user-researcher / api-tester / debugger 等）喂给 LLM，让它出 JSON 形式的 top-3 推荐
4. UI 展示 4 张卡：3 张模型推荐 + 1 张「从零开始」（永远保留，避免推荐质量差时无处可选）
5. 15 秒超时静默 fallback 到静态推荐，不会卡死

点其中一张卡 → 弹出新建 agent 对话框，预填名字 + system prompt，用户改名后提交。

代码组织上 `buildSuggestPrompt(historyChunks)` 和 `extractJsonPicks(raw)` 是纯函数，可独立单测。

---

### 📊 Token & 成本可观测

这是给认真用 AI 的人准备的：每次推理花了多少钱，全部清楚。

#### 采集（`core/src/usage-extract.ts`）

Agent 每次流结束都会带一个 `result` 消息，里面有 `modelUsage: { [模型名]: { inputTokens, outputTokens, cacheRead, cacheCreation } }`。`extractUsageEvents` 把它拆成多行 `UsageEvent`（一模型一行），并查 `core/src/pricing.json` 算出美元成本。

**关键设计**：codex（`providerKind === "openai-codex"`）的 `billingModel` 标为 `"subscription"`、`costUSD = 0`。理由：ChatGPT 订阅是固定费率，**不该把 codex 的 token 算进按量计费的统计里**——否则会假装多花了钱。已知模型按 pricing.json 算；未知模型 `costKnown: false`，UI 里单独提示。

#### 聚合（`core/src/usage-aggregate.ts`）

`aggregateUsage(rows, opts)` 对 `UsageEvent` 行做 4 维聚合：

- **按日**：用户 IANA 时区分桶，每天的 provider 拆分
- **按 Agent**：可选包含子 agent（父 agent 视角下「这个项目花了多少」）
- **按模型**：每个模型的 token / cost
- **按供应商**：每个供应商的 token / cost

聚合器是纯函数，可独立单测。

#### 仪表盘（`desktop-ui/components/UsageStatsDialog.tsx`）

主界面 ◔ 按钮打开。功能：
- 时间范围选择器（7d / 30d / 90d / all）
- 分组切换（day / agent / model / provider）
- 双图模式（area / line）
- 总成本卡 / Top agent 卡 / turn count 卡
- 时区自动用浏览器 `Intl.DateTimeFormat().resolvedOptions().timeZone`
- CSV 导出（方便老板报销）

#### 计费模式表 (`billingModel`)

| 值 | 含义 | 谁会被标这个 |
|---|---|---|
| `usage` | 按量计费 | Claude / OpenAI sk-key / 第三方 |
| `subscription` | 订阅 / 固定费率 | codex (ChatGPT Plus/Pro/Teams) |

这一栏让聚合器能正确处理「订阅用户用 codex 不重复计费」的边界。

---

### 🛡 五档权限模式 + Codex 沙箱

#### 5 种 Permission Mode（`shared/src/protocol.ts:15`）

每个 agent 都有自己的 mode 设置：

| 模式 | 行为 | 适合场景 |
|---|---|---|
| `default` | 每个 tool 调用都弹窗审批 | 第一次跑陌生 agent / 高风险任务 |
| `plan` | 仅 plan 模式工具弹窗（写文件 / 删除等敏感操作） | 日常代码开发 |
| `acceptEdits` | Edit 类工具自动放行，其它弹窗 | 信任 agent 的编辑能力时 |
| `bypassPermissions` | 全部自动放行 | 受控沙箱 + 老练用户 |
| `dontAsk` | 全部静默拒绝 | 锁定 agent（只读对话） |

UI 上有 hotkey：**Enter** 同意，**Shift+Enter** 同意 + 自动切到 `acceptEdits`（连续编辑一气呵成），**Esc** 拒绝。多个并发权限请求会排队显示「N pending」。

#### Codex Sandbox（W20 新增，`core/src/sessions/runtimes/codex.ts`）

Codex 的特殊性：它没有传统的 per-tool 审批（SDK 限制），改用 OS 级沙箱。三档：

| Sandbox | 含义 |
|---|---|
| `read-only` | 只读，连 tmp 都不让写 |
| `workspace-write` | 可写工作目录内（**默认**，平衡安全和生产力） |
| `danger-full-access` | 完全放开（自担风险） |

ChatPane 顶部 codex agent 会显示一条警示横幅：`⌘ codex · sandbox = workspace-write · no per-tool approval — sandbox is the only safety gate`，避免用户忘了这个特性。

#### ExitPlanMode 的特殊渲染

Plan 模式下 agent 调用 `ExitPlanMode` 工具时，PermissionDialog 会把 `plan` 参数渲染成富 markdown（标题 / 列表 / 代码块），而不是干巴 JSON——读 plan 的体验和读普通文档一样。

---

### 🪟 tmux 风格布局

`Workspace → Window → LayoutNode（递归二叉树：split / pane）` 三层。

#### 关键操作（`Ctrl+B` 前缀模式，1.5 秒超时）

| 键 | 动作 |
|---|---|
| `%` | 横向 split 当前 pane |
| `"` | 纵向 split 当前 pane |
| `x` | 关闭当前 pane |
| `o` / `Tab` | 切下一个 pane |
| `↑↓←→` | 按方向切焦点 |
| `H/J/K/L` | resize 当前 pane |
| `1`–`9` | 切窗口 N |
| `c` | 新建窗口 |
| `n/p` | 下一个 / 上一个窗口 |
| `,` | 打开当前 agent 设置 |
| `?` | 显示快捷键帮助 |

布局结构持久化到 `Workspace.layout` 字段，关闭重开恢复。每个 pane 可以绑定也可以不绑定 agent（不绑就显示一个 attach 提示）。一个 agent 可以同时绑到多个 pane（同步聊天界面）。

#### 多 Workspace

支持多 workspace 切换（侧边栏顶部下拉），便于「工作项目」「副项目」「实验」分离。Workspace 之间 agent 独立。

---

### 🧰 周边 UX 细节

| 功能 | 文件 | 备注 |
|---|---|---|
| **i18n（中英双语）** | `desktop-ui/i18n/dict.ts` | 默认中文，用户切换后存 localStorage，升级不丢 |
| **Command Palette** | `desktop-ui/components/CommandPalette.tsx` | `Ctrl+K` 打开，cmdk 驱动 |
| **自定义窗口控件** | `desktop-ui/components/WindowControls.tsx` | header 整合 `─ ▢ ✕`，header 整条可拖动 |
| **新建 Agent 对话框** | `desktop-ui/components/NewAgentDialog.tsx` | 一站式选名 + provider + model，Enter 提交 |
| **快捷键帮助** | `desktop-ui/components/KeyHelpDialog.tsx` | `Ctrl+B ?` 打开 |
| **Slash 命令** | `desktop-ui/components/ChatPane.tsx` | `/model gpt-5.5`、`/provider DeepSeek`、`/close`、`/restart` 直接在聊天框切 |
| **Tool Card 富渲染** | `desktop-ui/components/ToolCard.tsx` | tool_use 不显示丑陋 JSON，按工具类型可视化 |

---

## 新手入门：5 分钟跑起来

1. **下载安装包** `Ensemble_x.x.x_x64-setup.exe`（NSIS，~27 MB）→ 双击安装到 `%LOCALAPPDATA%\Ensemble\`
2. **首次启动**自动建一个 anthropic-local provider（用本机 `claude login` 的 OAuth）
3. **创建 agent**：左侧栏点 `+ 新建 agent` → 输入名字 → 选 provider → 选 model → Enter
4. **对话**：右侧 ChatPane 输入框打字，回车发送；输出会流式显示，tool_use 渲染成卡片
5. **遇到权限弹窗**：按 Enter 允许 / 按 Esc 拒绝；信任了就按 Shift+Enter 切 `acceptEdits` 连续工作

不需要装 Node、不需要 Python、不需要 docker。EXE 自包含。

---

## 进阶玩法

### 给老手的把控点

#### 1. 多 agent 协作流水线

```
研究员 (Claude Opus)  → review → 实现者 (Codex)  → review → 测试员 (gpt-5.4-mini)
```

每个角色一个 agent，用 `@→` 按钮（或 chat 里 `/peer-send`）把上一个的输出 review 给下一个。Plan / Spec / Implementation / Review / Test 五段流水线，每段一个 agent，每段用不同模型 / 不同供应商。

#### 2. 成本闸门

- 每周打开 Usage Stats 看上周花在哪个 agent / 哪个模型上最多
- 把烧钱 agent 的模型从 opus 降到 sonnet 或 haiku
- 把高频小任务路由到 codex（订阅，0 边际成本）
- 把不需要工具调用的对话路由到 DeepSeek（便宜）

#### 3. Permission Mode 精细化

- 信任 agent A（写代码靠谱）→ A 切 `acceptEdits`
- 不信任 agent B（新角色）→ B 留 `default`
- 跑长任务时 → 临时切 `bypassPermissions`，跑完切回来

#### 4. Subagent 树

不要把所有工作压到一个 agent。让主 agent 用 `Task` 工具 spawn 子 agent 干细活：
- 主 agent：协调 / 规划
- 子 agent 1：搜代码
- 子 agent 2：写测试
- 子 agent 3：跑测试 + 报错回来

主 agent 视图里子 agent 的工作以 ToolCard 形式嵌入，可点开看详情，也可点 agent 名跳到子 agent 的独立 pane。

#### 5. 跨 Runtime peer_send

Claude agent 可以 `peer_send` 给 Codex agent。Ensemble 自动适配两端协议差异，对用户透明。让最适合的模型干最适合的活：Claude 想方案、Codex 执行命令、GPT-5.4 写文档。

---

## 路线图

最近交付（W20，2026-05）：
- Codex CLI Runtime（v0.130.0 SDK 接入）
- 跨 Runtime MCP Bridge（HTTP server + 鉴权 token）
- billingModel 列（区分按量 / 订阅）
- Codex sandbox 三档
- NSIS installer hooks（升级时干净杀 sidecar + codex.exe）
- 自定义无边框窗口
- 默认中文 + 设置持久化（升级保留）

接下来：
- macOS / Linux 包验证（当前仅 Windows 验过）
- 应用图标替换（目前 Tauri 默认）
- 代码签名 / SmartScreen 白名单
- 自动更新机制
- 多 SQLite 项目切换
- W14 subagent 推荐 UI 完整对齐设计稿

---

## 一些关键文件速查

| 想看什么 | 去哪 |
|---|---|
| WebSocket 协议形状 | `shared/src/protocol.ts` |
| 数据库 schema | `core/src/db.ts:12-116` |
| 三种 Runtime 入口 | `core/src/sessions/runtimes/` |
| 模型定价表 | `core/src/pricing.json` |
| Codex MCP Bridge | `core/src/mcp-bridge.ts` |
| Peer Send 工具 | `core/src/peer-mcp.ts` |
| Token 抽取 | `core/src/usage-extract.ts` |
| Token 聚合 | `core/src/usage-aggregate.ts` |
| 五档权限定义 | `shared/src/protocol.ts:15` |
| 主界面 | `desktop-ui/app/page.tsx` |
| 布局引擎 | `desktop-ui/components/LayoutRenderer.tsx` |
| tmux 快捷键 | `desktop-ui/hooks/useTmuxKeys.ts` |
| Tauri 配置 | `src-tauri/tauri.conf.json` |
| NSIS 安装钩子 | `src-tauri/installer-hooks.nsh` |
| Node SEA 打包 | `core/scripts/bundle.mjs` + `make-exe.mjs` |

---

## License & 项目状态

Ensemble v0.0.1，Windows-first（macOS / Linux 仅源码级支持）。

代码量约 30k 行 TypeScript + 少量 Rust，由 Claude Code 协作完成；项目准则与协作规约写在仓库根的 `CLAUDE.md`。

---

> 想用一个 agent 改一行代码 → 5 分钟。  
> 想用一个 agent 团队周期性输出代码 → Ensemble 是为这个准备的。
