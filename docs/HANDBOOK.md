# Ensemble 操作手册（迁移自 AgentUI，部分内容仍是 AgentUI 形态）

> 📋 **兼容性提示**：本手册迁自 AgentUI，绝大多数概念（agent / pane / window / workspace、operation flow、键位、peer_send 模式等）在 Ensemble 完全适用。
>
> **不再适用的部分**（仅 AgentUI 形态相关，懒得逐字改，看的时候自行换算）：
> - "Postgres" → Ensemble 用 node:sqlite；行为一致，存储引擎不同
> - "Docker" / docker-compose 启动 → Ensemble 是 Tauri 桌面 app，无 docker 依赖
> - "WebSocket :3001" 端口 → Ensemble 是 sidecar 动态端口，用户感知不到
> - "浏览器访问 localhost:3000" → Ensemble 直接装包打开，无浏览器步骤
>
> 全 Ensemble 视角的快速入门看 [`../README.md`](../README.md)，架构看 [`./architecture.md`](./architecture.md)。

---

## 0. 概念地图（先理清"啥是啥"）

| 概念 | 是什么 | 储存在哪 |
|---|---|---|
| **agent** | 一个独立的 Claude session，有自己的对话历史、消息流、工具调用记录 | Postgres `Agent` 行（含 messages） |
| **provider** | 模型供应商配置（Anthropic 直连 / OpenAI-compat / LiteLLM 转发等）。每个 agent 绑定一个 provider | Postgres `Provider` 行 |
| **pane** | 屏幕上一个矩形区域，**可以**挂 0 或 1 个 agent | 仅 client 状态（写到 workspace.layout JSON） |
| **window** | 一组 pane 的二叉树布局（tmux 的 tab） | workspace.layout 里 |
| **workspace** | 一组 window（一个"工作桌面"） | Postgres `Workspace` 行 |

**关键心智**：agent 和 pane 是**多对多解耦**的——agent 是数据，pane 是视图框。一个 agent 可以不在任何 pane 上（在 sidebar 列表里待着），一个 pane 可以是空的。

---

## 1. Agent 操作

### 1.1 创建 agent
1. 左侧栏顶部 → 输入名字（**留空时使用自增默认名 `agent-1` / `agent-2` / ...**）→ 点 `+ create_agent` 或按 Enter
2. **自动行为**：如果当前 active pane 是空的，新 agent 自动绑到那个 pane
3. **provider**：默认绑到 `anthropic-default`（首启自动建）。可在创建后用设置弹窗改

### 1.2 "选择" agent ＝ **把它绑到当前 active pane**（唯一绑定）
- 点左侧栏 agent 行 → 该 agent 绑到当前 active pane
- **唯一绑定约束**：一个 agent 同一时刻**只能在一个 pane 显示**。把 A 从 pane1 切到 pane2 时，pane1 自动变空
- sidebar 行右侧的 **● 青色圆点**表示该 agent 当前正绑在某个 pane 上；无圆点则未在屏

### 1.3 Agent 设置弹窗（改名 / 切模型 / 关闭 / 重启 / 删除 / 派生子 agent）

active pane 标题栏 hover 显示 `⚙` 齿轮按钮 → 弹 popover：

| 区块 | 操作 |
|---|---|
| **name** | 直接编辑 → apply 重命名 |
| **provider** | 下拉选 provider；切了后 model 列表自动联动 |
| **model** | 下拉来自该 provider 的 cached `models`；缓存空时显示 hint 提示去 ProviderPanel `↻` 刷新 |
| **permission mode** | default / plan / acceptEdits / bypassPermissions / dontAsk（含每个 mode 的描述提示） |
| **lifecycle / ◼ close** | 中止当前 query + 锁定输入；**保留 SDK session_id 到 metadata.lastSessionId**，下次重启可续接对话 |
| **lifecycle / ▶ restart** | 解锁输入；下次发消息时 SDK 用 `options.resume = lastSessionId` 续接上次上下文 |
| **lifecycle / × delete** | 永久删除（confirm 弹窗）；级联清掉 messages / permissions / paneState |
| **lifecycle / + child** | 派生子 agent（弹 prompt 输入名字）：自动设 parentId，子 agent 在 sidebar 树里嵌套显示 |

> close vs delete：close = 暂停（resume 信息保留可重启），delete = 物理删除。

### 1.4 怎么分辨"当前屏幕"绑的是哪个 agent

按可见度排序：
1. **active pane 视觉**：唯一一个有**青色呼吸边框**的 pane
2. **active pane 顶部 ChatPane 标题栏**：状态点 + name + model + status（含 `[CLOSED]` / `[PLAN]` 黄色角标）
3. **PaneShell 标题栏**：`name model · status · plan · N msg · K tool · paneId`
4. **底栏**：`pane:xxxxxx` + 当前 agent 状态点 + name + status
5. **左侧栏**：agent 行右侧 `●` 表示已绑

### 1.5 状态点颜色

| 颜色 | 状态 | 含义 |
|---|---|---|
| 灰 | idle | 等待用户输入 |
| 青色脉动 | running | 模型正在生成 |
| 黄色脉动 | awaiting_permission | 卡在权限审批弹窗 |
| 紫色脉动 | awaiting_user_input | 卡在 `ask_user` 选项弹窗（永不超时） |
| 绿色 | done | 上轮成功完成 |
| 红色 | error | 上轮报错 |

---

## 2. Subagent（子 agent）

**当前实现**：用户驱动的 child-agent 派生。SDK 内置 `Task` 工具 0.1.x 版本**不经过 `canUseTool` 回调**（Claude Code CLI 内部直接处理），所以原 plan §6 方案 B 的"自动拦截 Task"路径**不可达**。

### 2.1 派生子 agent
- 在父 agent 设置弹窗里点 `+ child` → prompt 输入子 agent 名字 → 自动创建带 `parentId` 的新 agent
- 子 agent 在左侧栏 AgentTree 缩进显示在父下面
- 删父 agent 时子级联删（`onDelete: Cascade`）

### 2.2 SDK 内置 Task 工具的行为
- 模型调 `Task` 工具时，SDK CLI 内部 spawn 一个临时 subagent 跑完返回 summary
- UI 上显示为父 agent 的一张 `⌬ Task` ToolCard，内部 subagent 不入数据库
- 这是"透明嵌套"模式（plan §6 方案 A），父用户看到的是工具调用结果

### 2.3 让模型主动协作 → 用 `peer_send` 工具（见 §13）
模型可以通过 MCP 工具 `peer_send` 直接给其他 agent 发消息——不是 subagent 关系，是**同级 peer**。

---

## 3. Pane 操作

### 3.1 鼠标
| 想做的 | 怎么做 |
|---|---|
| 切焦点到某 pane | 点该 pane 任意位置 |
| split 横向（左右） | active pane 标题栏 `⇿` |
| split 纵向（上下） | active pane 标题栏 `⇕` |
| 关闭 pane | active pane 标题栏 `×`（最后一个 pane 拒绝关） |
| 调整 pane 大小 | 拖 pane 之间的灰色细条 |

### 3.2 键盘（tmux 键位，prefix = `Ctrl+B`）

按一次 `Ctrl+B`，顶栏出现脉动 `--PREFIX--` 标记，**1.5 秒内**按下面任意键：

| 键 | 动作 |
|---|---|
| `%` | 横向 split |
| `"` | 纵向 split |
| `x` | 关闭 active pane |
| `o` / `Tab` | 焦点循环到下一个 pane |
| `↑↓←→` | 焦点向方向移动（中心重叠几何法） |
| `H` `J` `K` `L` | resize：变窄 / 变高 / 变矮 / 变宽（vim 风） |
| `c` | 新建 window |
| `n` / `p` | 下一/上一 window |
| `1`–`9` | 跳到第 N 个 window |
| `,` | 重命名当前 window |
| `&` | 关闭当前 window |
| `:` | 命令面板 |
| `?` | **键位帮助 modal** |
| `Esc` | 取消 prefix |

> 在 chat 输入框里打字时 `Ctrl+B` 不进入 prefix（防止吞输入）。要用 prefix 先点 pane 空白处取消输入框焦点。

---

## 4. Window（窗口/tab）

底栏标签条：`[1:main]* [2:reviewer]+ [3:scratch]`

| 标记 | 含义 |
|---|---|
| `*` | 当前 active window |
| `+` | 该 window 内有 running / awaiting_permission 的 agent |
| 无 | 安静 window |

| 操作 | 鼠标 | 键盘 |
|---|---|---|
| 切到 window | 点标签 | `Ctrl+B 1-9` 或 `n`/`p` |
| 重命名 | 右键标签 | `Ctrl+B ,` |
| 新建 | 末尾 `+` | `Ctrl+B c` |
| 关闭 | 中键标签 | `Ctrl+B &` |

每个 window 有自己**独立**的 pane 树、active pane、agent-pane 绑定。切 window 时各保各的（tmux 行为）。

---

## 5. Workspace（工作区）

### 5.1 含义
一个 workspace = 一组完整的"工作桌面"，包含若干 window。换 workspace 就像把整个桌面替换。

### 5.2 跨 workspace 共享 vs 隔离

| | 共享 | 隔离 |
|---|---|---|
| Agent 列表 | ✅ 全局 | |
| Provider 列表 | ✅ 全局 | |
| MCP 配置 | ✅ 全局 | |
| windows 树 | | ✅ 每 workspace |
| pane → agent 绑定 | | ✅ 每 workspace |
| active window / pane | | ✅ 每 workspace |

### 5.3 操作
左侧栏顶部 `ws` 行：

| 元素 | 用途 |
|---|---|
| dropdown | 切换 workspace |
| `✎` | 重命名当前 workspace |
| `+` | 新建 workspace |

> 上次用过的 workspace 存 `localStorage["agentorch:last-workspace"]`，刷新后自动回到那个。
> 不能从 UI 删 workspace（防误删；server 有 `DELETE /workspaces/:id` REST 但拒绝删最后一个）。

---

## 6. 工具审批

### 6.1 哪些工具弹审批
- **会弹**：`Edit`、`Write`、`Bash`（有副作用的 `rm`/`mkdir`/`>` 等）、`ExitPlanMode`（plan 模式专用）
- **不弹**：`Read`、`Glob`、`Grep`、只读 `Bash`（`echo`/`ls`/`git status`）、SDK 内置 `Task`、`peer_send` / `ask_user`（系统级 MCP，`allowedTools` 自动批）

> 这是 SDK CLI 内置 sandbox 行为。peer_send / ask_user 在 server 端 `allowedTools` 自动批准，避免每次跨 agent 通信 / 用户问询都额外弹一遍工具审批。

### 6.2 弹窗 UI / 操作

| 键 / 按钮 | 动作 |
|---|---|
| `Enter` / **Allow** | 仅放行当前一次调用 |
| `Shift+Enter` / **Allow + 自动模式** | 放行本次 + 把 agent 切到 `acceptEdits` 模式（之后 Edit/Write 自动批；Bash 等仍弹框） |
| `Esc` / **Deny** | 拒绝（agent 收到 "Denied by user." 反馈） |

> 多个 pending 排 FIFO，标题栏显示 `+N pending`。一次裁定一个。
> 等待审批时 agent 状态切到 `awaiting_permission`（黄色脉动）；裁完回 `running`。
> "Allow + 自动模式"对应 `permissionMode = acceptEdits`。要彻底全自动改去 AgentSettings 选 `bypassPermissions`（**危险**）。

### 6.3 ExitPlanMode 工具

permissionMode 设成 `plan` 时模型可以调 `ExitPlanMode({plan: string})` 把 plan 文本提交给用户审批。`plan` 内容显示在权限弹窗的 input 区——
- 点 Allow → SDK 退出 plan 模式继续执行
- 点 Allow + 自动模式 → 同时切 `acceptEdits`，后续 Edit/Write 不再弹框
- 点 Deny → 留在 plan 模式，模型可以继续完善方案再提交

---

## 7. 命令面板（cmdk）

`Ctrl+B` 然后 `:` → 模糊搜索 / `↑↓` 选 / `Enter` 执行 / `Esc` 关。

当前 9 条命令分两组：**pane**（split-h / split-v / close / focus-next）+ **window**（new / next / prev / rename / close）。

---

## 8. 键位帮助（`Ctrl+B ?`）

prefix + `?` 弹出全屏键位帮助 modal，三列分组（pane / window / mode）。Esc 关。

---

## 9. MCP 配置

左侧栏底部 `▸ MCP` 折叠区。

### 9.1 增加 MCP server
1. `+ add server`
2. 填名字 + 选 transport（stdio / http / sse）+ 编辑 JSON 配置
3. `add` 提交

### 9.2 启用/禁用
每行 `○`/`●` 切换。**改了立即生效**——下一次 send_message 时被注入到 SDK options.mcpServers。

### 9.3 删除
每行 `×`，confirm。

> MCP 是**全局共享**（所有 agent 用同一组）。

---

## 10. 全局设置（语言切换）

顶栏右侧 `⚙` 按钮 → popover：

- **language**：English / 中文 单选；切换立即生效，写入 `localStorage["agentorch:locale"]` 持久化

---

## 11. Provider（模型供应商）

左侧栏 `▸ PROVIDERS` 折叠区。

### 11.1 默认 provider
首次启动自动建 `anthropic-default`：kind=`anthropic-local`，无 baseUrl/apiKey，走本机 `claude login` 凭证；models 硬编码 `[claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001]`。

### 11.2 添加 provider 的两种 runtime × 两种接入方式

W16 之后形态完整 4 态决策树（form 里的两组 radio）：

| Runtime | 接入方式 | kind | 说明 |
|---|---|---|---|
| Claude | 官方 | `anthropic-local` | 走本机 `claude login` OAuth |
| Claude | 第三方兼容 | `anthropic` | 填 Anthropic-compatible baseUrl + apiKey（DeepSeek/GLM/MiniMax 的 anthropic 端点） |
| OpenAI | 官方 | `openai-compat`（baseUrl 锁死 `https://api.openai.com/v1`） | 填 platform.openai.com 的 API key |
| OpenAI | 第三方兼容 | `openai-compat` | 自填 baseUrl（DeepSeek/GLM 的 OpenAI 端点 / timicc / etc.） + apiKey |

每 runtime 都走对应的 SDK 原生集成——Claude → `@anthropic-ai/claude-agent-sdk`（CLI sidecar），OpenAI → `@openai/agents`（in-process）。**不存在协议翻译层**——W15 时代的 musistudio gateway 在 Slice 6 (W16) 整段删除。

### 11.3 已停用的 kind / 模式（v0.0.2 + 之后）

`bedrock` / `vertex` / `autoManaged` 三种历史 kind 在启动时被自动 disable，UI 顶部 banner 显示数量 + 一键 `⇪` 迁移按钮——把原 baseUrl + apiKey 重新组合成 `openai-compat` 新 provider，旧 row 删除。

### 11.4 baseUrl 写法

- Anthropic-compat：DeepSeek `https://api.deepseek.com/anthropic`，智谱 GLM `https://open.bigmodel.cn/api/anthropic`，MiniMax `https://api.minimaxi.com/anthropic`
- OpenAI 官方：`https://api.openai.com/v1`（preset 自动填）
- OpenAI-compat 第三方：DeepSeek `https://api.deepseek.com/v1`，timicc `https://timicc.com/v1`，等等
- 本机 OAuth：留空（Claude 官方 entry）

### 11.5 刷新模型列表
provider 行的 `↻` 按钮：server 调候选 URL 拉模型 ID 写入 `Provider.models`，AgentSettings 下拉读这个 cache。对 `anthropic-local` 直接 fallback hardcoded list；对 `openai-compat` / `anthropic` 第三方走 `probeModels` 多 URL + 双套 auth header。

### 11.6 删除 provider
- 默认 provider 没有删除按钮
- 有 agent 绑着的 provider DELETE 返 409；先用 AgentSettings 把 agent 切到别的 provider 再删

### 11.7 已知限制
- Claude side 和 OpenAI side 用相同 systemPrompt 时**行为不完全一致**——Claude CLI 会再注入 hooks / settingSources / CLAUDE.md，OpenAI side 直接把 instructions 当 system message。切 runtime 时模型回应风格可能漂移
- OpenAI side v1 还没接外部 stdio/http MCP server（Slice 5 只做了内置 peer_send / ask_user / Task / ExitPlanMode）
- Codex CLI 的 ChatGPT-OAuth 形式 token **不能直接用**（@openai/agents 只懂 API key）；想跑 OpenAI 官方必须有 platform.openai.com 的 sk-... key

---

## 12. Peer-talk（agent 间消息）

### 12.1 四种交接模式（cxsm-inspired）

借鉴 [cxsm](https://github.com/ChristopheZhao/cxsm) 设计，peer_send 不是简单的"消息广播"而是**任务交接协议**——4 种模式让接收方明确"该用什么角色处理这条消息"。

| 模式 | 颜色 | 图标 | 接收方应该 |
|---|---|---|---|
| `raw` | 黄 | ← | 把消息当普通用户输入处理（向后兼容旧行为） |
| `continue` | 蓝 | ↪ | 承接源 agent 的工作脉络，作为当前基础继续推进；磁盘真实状态 > 消息描述 |
| `review` | 紫 | 🔍 | 独立审计源 agent 的方案；逐字引用，给独立第二意见，**不承接** |
| `fork` | 橙 | ⑂ | 同一任务**换个思路**重做；源消息是反面参考，避免复刻其路径 |

**实现细节**：
- `raw` 走旧 `[from X] body` 文本格式；其它 3 种用 `<peer-handoff>` 结构化块 + 模式专属 instruction（写在 `server/src/sessions/peerHandoff.ts`）
- 接收方的 user message payload 携带 `_peerOrigin = {fromAgentName, fromAgentId, mode}`，前端按这个字段渲染角标
- 接收方收到的 prompt = context block（不可改 ground truth）+ instruction（每模式默认；可被 `Agent.metadata.peerInstructions[mode]` 覆盖——后端已支持，UI 待加）

### 12.2 用户手动转发
任何 ChatPane 标题栏右侧 `@→` 按钮 → popover：
- **mode radio**：raw / continue / review / fork 4 选 1
- 选目标 agent + 填消息 + 选模式 + send
- 发送方 chat 出现 outgoing log，带 mode 图标和颜色
- 目标 agent chat 出现对应模式的 incoming 角标

### 12.3 模型主动调（peer_send 工具）
模型可以主动给其他 agent 发消息。**工具名因 runtime 不同**：
- Claude side：`mcp__agentorch-peer__peer_send({target, message, mode?})`（SDK MCP namespace）
- OpenAI side：`peer_send({target, message, mode?})`（plain function tool，W16 Slice 5.1 注册）

前端 ToolCard 通过 `displayToolName` 工具把两种名字都 strip 成 `peer_send` 显示，跨 runtime 一致。SessionManager 端处理消息送达不区分 runtime——target agent 的 runtime 是 Claude 还是 OpenAI 由其 providerId 决定，sendMessage 路径自适应。已实测双向工作（Claude → OpenAI 和反向，见 W16 Slice 7 E2E）。
- 工具自动批准（`allowedTools` 白名单），不弹用户审批
- `mode` 可选；省略 = `"raw"`（兼容旧行为）；模型可以根据语义自己选 continue / review / fork
- target 可以是 agent name（推荐）或 UUID；同名取最新创建（`createdAt desc`）
- target 已 closed / 正在 running 时返 error 字符串给主 agent，主 agent 决定下一步
- fire-and-forget：发送方立即收到 `delivered to "X" (id=..., mode=...)`，**不等接收方回复**

### 12.4 适用场景
- **continue**："研究员 agent 整理好了 Prisma schema 思路，让写作者 agent 接着写代码"
- **review**："优化器 agent 提了一个改 SessionManager 的方案，找审阅 agent 帮我 cross-check 风险"
- **fork**："实现 agent 卡在死循环了，让另一个 agent 完全不看它的尝试，从头独立解题"
- **raw**：单纯传话，不带角色暗示

---

## 13. 当前限制（诚实告知）

| 限制 | 解决方法 / 变通 |
|---|---|
| SDK 内置 `Task` 工具不经过 canUseTool | 模型自动派生的 subagent 看不到独立 chat。要"独立 child"用设置弹窗 `+ child` 手动派生 |
| 同名 agent peer_send 取最新 | 命名时加唯一后缀避歧义 |
| chat 输入框 focused 时 `Ctrl+B` 不进 prefix | 先点 pane 空白处 |
| 跨实例 LISTEN/NOTIFY 30s TTL 自我去重 | 单 server 部署不影响；多 server 部署生产需加 server-id tag |
| `z` zoom pane 没做 | 关掉其他 pane 替代 |
| 删 workspace 没 UI | server 有 REST，UI 故意保守 |
| 跑非 Claude 模型时 systemPrompt 行为漂移 | OpenAI runtime 直传 instructions；Claude side 会二次拼装。文档显式说明 |
| Provider apiKey 明文存 SQLite | 开发期接受；后续可加列级加密 |

---

## 14. 故障排查

| 现象 | 排查 |
|---|---|
| `ws disconnected` 红点常驻 | server 没起来；`curl http://localhost:3001/health` 探测 |
| 发消息没反应 | F12 console 看 WS 错；常见是 `claude login` 凭证过期 |
| 工具调用后没弹审批弹窗 | 那个工具属"自动批"类（Read/Glob/Grep/echo Bash/peer_send） |
| 刷新后布局丢了 | server 日志看 `PUT /api/workspaces/:id` 错误；workspace.layout 受 zod 严格校验 |
| autoManaged provider 创建后模型仍走 Claude | 检查 LiteLLM 是否 running（顶部 service bar）+ agent 是否真的绑到该 provider |
| LiteLLM start 后立即发消息失败 | 容器需要几秒初始化；service bar 显示 running 后再等 5s 试 |
| 切了 provider 但 model 下拉空 | 在 ProviderPanel 该行点 `↻` 刷新模型；或上游 endpoint 不可达 |
| peer_send 报"no peer matches" | target 名拼错，或目标 agent 已删；检查 sidebar |
| peer_send 报 BUSY | 目标正在跑别的 query，等它完成再试 |
| 删 provider 报 409 in use | 有 agent 还绑着；先 AgentSettings 切到别的 provider |
| `D:/tmp/...` 文件类操作失败 | 路径用正斜杠或转义反斜杠；Bash 在 Windows SDK 子进程跑 |
| 触发了工具调用但状态卡 `awaiting_permission` 不弹框 | 通常是 store 里 agents 没 hydrate（旧版 bug），现在 mount 时自动 GET `/agents` 并 subscribe；如仍出现，刷一下页面 |
| 重启 server 后看不到老 agent | 检查 server 日志是否真起来（`curl http://localhost:3001/health`）；agent 在 Postgres `Agent` 表里，server 起来后页面 mount 会拉回 |

---

## 15. 持久化 / 跨重启 / 跨刷新

| 维度 | 存哪 | 重启 server 后 | 刷新 / 重开浏览器后 |
|---|---|---|---|
| Agent 元数据（id / name / model / provider / permissionMode / status / closed） | Postgres `Agent` | ✅ | ✅（`GET /agents` 在 mount 时拉） |
| 对话消息（user / assistant / tool / system / result） | Postgres `Message`（每条带 `agentId+seq`） | ✅ | ✅（`GET /agents/:id/messages?limit=200` 在 mount 时拉，逐条 `ingestSdkMessage`） |
| pending 工具审批 / `ask_user` 问询 | server 内存 `Map<sessionId, ...>` | ❌（重启即丢） | ✅ 同一 server 重连时 `replayPendingFor` 重发 |
| 布局（windows / panes / 绑定） | Postgres `Workspace.layout` JSON | ✅ | ✅（debounce 500ms 写回） |
| Provider / MCP servers | Postgres `Provider` / `McpServer` | ✅ | ✅ |
| 上次用过的 workspace | `localStorage["agentorch:last-workspace"]` | — | ✅ |
| 语言（en/zh） | `localStorage["agentorch:locale"]` | — | ✅ |
| SDK session_id（用于 resume 续接对话上下文） | `Agent.metadata.lastSessionId` | ✅（close 时写入，restart / 下次 sendMessage 自动 resume） | ✅ |

### 15.1 重启 agent

`AgentSettings → ▶ restart`（或 chat 框 `/restart`）：解锁 `closed` 标志；下次 sendMessage 时 SDK options 注入 `resume: lastSessionId`，模型能看到完整上下文。

### 15.2 端到端"我啥都不丢"流程
1. 创 agent → 发 N 条消息 → close（`◼` 或 `/close`）
2. 关浏览器、关电脑、重启 server、过夜
3. 第二天 `pnpm db:up && pnpm dev` → 浏览器开 :3000
4. agent 列表 / 历史消息 / 上次的 layout 全回来
5. AgentSettings `▶ restart` → 接着发消息，模型记得之前聊过什么

> 注意：浏览器历史最近 200 条消息，更早的留在 DB 里但 UI 不展示（避免开屏卡）。

---

## 16. ChatPane 斜杠命令

在 chat 输入框首字符是 `/` 时识别为命令（不发给模型）。回车后本地执行：

| 命令 | 作用 |
|---|---|
| `/help` | 在 chat 里打印命令清单 |
| `/model <name>` | PATCH 当前 agent 的 model（要在 provider 的 cached models 里能查到） |
| `/provider <name>` | PATCH 当前 agent 的 provider（按 provider name 匹配） |
| `/close` | 同 `◼ close`：中止当前 query + 锁输入，保留 lastSessionId |
| `/restart` | 同 `▶ restart`：解锁、下次 sendMessage 用 resume |

> 命令执行结果以 system 风格回显在 chat 里（不入 DB，刷新会丢）。要把指令记入会话历史用普通消息。
> 命令在 `closed` 状态下也可用——这是 chat 框 close 时仍允许 `/` 起头的输入的原因。

---

## 17. ask_user MCP 工具（模型主动问用户）

模型可在思考过程中调 `mcp__agentorch-ask-user__ask_user({question, options})` 显式向用户提问。
- agent 状态切到 `awaiting_user_input`（紫色脉动）；**永不超时**
- 浏览器弹"AskUserDialog"（可拖拽 modal，每个 option 一个按钮）
- 用户点选 → 选项字符串作为 tool_result 返回模型，agent 状态回 `running`
- 多个排 FIFO；右上角显示 `+N pending`
- `cancel`（用户主动 stop） / agent 被 close → pending 问询用 `[cancelled by user]` 解开

何时用：模型需要"多选一裁定"时（澄清需求 / 选实现路径 / 跨方向二选一）。比 peer_send 更轻量，不需要另起 agent。

