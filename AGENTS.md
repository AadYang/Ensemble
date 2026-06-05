# AGENTS.md — Ensemble

> 本文件是 Ensemble 项目对协作 AI 的工作准则。每次进入本目录或被本仓库引用时都会自动加载，请认真遵守。

---

## 0. 项目速览

- **目标**：跨平台桌面级 multi-agent AI 工作台。Tauri 2.x + sidecar binary（Node SEA）+ Next.js 静态前端。
- **Slogan**：Many minds. One workspace. / 群智，一席。
- **当前阶段**：✅ Windows 与 macOS **双平台并行维护**（自 0.0.18 起）。每个发版都要同时跑 Windows + macOS 两条构建路径；任何只在一侧验证过的修复都视为半成品。
- **平台分工实践**：Windows 构建在本仓库的 Windows 工作机上完成，macOS 构建在配备 Xcode + Developer ID 的 Mac 上完成。两侧共用同一份 git 分支；platform-specific 产物（Cargo.lock、`src-tauri/binaries/ensemble-core-<triple>(.exe)`）保持「工作树脏 + 不提交」约定，否则两侧来回 push 会无意义地相互覆盖。详见 §3.6。

---
## 1. 行为准则

整体偏向**谨慎优先**而非**速度优先**。对显然的一行修改、拼写修正等微操，可灵活省略部分流程；对涉及 Schema、协议、布局引擎、安全权限等核心面的改动，必须严格遵循。

### 准则 1 · 编码前先思考（Think Before Coding）

**先澄清，再实现。先暴露不确定性，再进入编码。**

- 明确说出假设。不确定就先问，不要默默选一种。
- 需求若有多种合理解读，列出所有解读并请用户裁定。
- 如果存在更简单的方案，主动指出权衡。
- 用户要求、上下文、现有代码三者出现明显矛盾时，**质疑并停下**。
- 任何不清楚的地方，停下来说明困惑点并提问。

**反例**：用户说"加个 agent 重启"，你不问就开写，结果做成了"杀进程重建" vs 用户其实想要"resume 旧 session"——白做。

### 准则 2 · 简单优先（Simplicity First）

**只写解决当前问题所需的最少代码。不要做猜测性设计。**

- 不添加用户未要求的功能。
- 不为只用一次的代码做抽象。
- 不加未被要求的"灵活性 / 可配置性"。
- 不为不可能发生的场景写错误处理。
- 写完审视：资深工程师看会不会嫌过度复杂？会就继续简化。

**项目里的具体应用**：
- 布局引擎只支持二叉树 split，不要提前做"网格 grid"或"自由拖拽"。
- 权限审批先做"允许 / 拒绝"两态，不要一上来就做"按工具名规则引擎"。
- MCP 服务先做"全局共享"，不要一上来就做"按 agent 隔离 + 配额"。

### 准则 3 · 外科手术式修改（Surgical Changes）

**只改必须改的地方。只清理你自己造成的问题。**

- 不顺手"优化"相邻代码 / 注释 / 格式。
- 不重构本来没坏的东西。
- 即使个人写法不同，也保持现有项目风格一致。
- 发现与当前任务无关的死代码，**指出**但不擅自删除。
- 你的改动制造了孤儿（未使用的 import / var / 函数）才需清理它们。

**判断标准**：每一行变更都能直接追溯到用户当前的请求。

**项目里的具体应用**：
- 改 `SessionManager.sendMessage` 时，不要顺手把同文件里的 `createAgent` 也"美化"。
- 修一个 WebSocket bug 时，不要顺手重命名协议字段。
- 改前端某个组件样式时，不要顺手把全局 CSS Token 调一遍。

### 准则 4 · 以目标驱动执行（Goal-Driven Execution）

**先定义成功标准，再循环执行直到验证通过。**

把"要做什么"翻译成"如何判断已经做成"：

| 模糊指令 | 翻译后 |
|---|---|
| "加上校验" | "为非法输入写测试，再让测试通过" |
| "修这个 bug" | "先写一个能复现的测试，再让它通过" |
| "重构模块 X" | "重构前后行为一致，原测试全通过" |

多步骤任务先给短计划：

```
[步骤 1] → 验证方式：[检查什么]
[步骤 2] → 验证方式：[检查什么]
```

每完成一步立即验证，**不要等全部写完再赌一把**。

---


## 2. 项目规范
### 2.1 提交规范

- 单次提交不跨多个 plan 主题（Schema / 协议 / 布局 / UI 不混在同一 commit）。
- commit message 写"为什么"，还要写"什么"。


### 2.2 双平台维护（Windows + macOS，强制）

Ensemble 自 0.0.18 起两条平台线并行维护。每个改动必须考虑两边都能正确构建 + 运行；任何只在一侧验证过的修复**不算 done**。

### 2.3 多 runtime 兼容（强制）

**每一个新功能 / bug 修复都必须同时考虑三条 runtime 路径，维护用户体验一致**。Ensemble 是单一前端跨三套 runtime 的产品，缺一条就是 silent fallback bug。

| Runtime | Provider kind | 工具/MCP 注入点 |
|---|---|---|
| Claude SDK（CLI subprocess） | `anthropic-local`（官方 OAuth）/ `anthropic`（compat） | `core/src/sessions/runtimes/claude.ts` + `peer-mcp.ts` / `ask-user-mcp.ts` 的 `createSdkMcpServer` |
| OpenAI Agents（in-process） | `openai-local`（官方 sk-key）/ `openai-compat`（第三方 OpenAI 协议） | `core/src/sessions/runtimes/openai.ts` + `sessions/tools/session-aware.ts` 的 NormalizedTool |
| Codex CLI subprocess | `openai-codex`（ChatGPT 订阅 OAuth） | `core/src/sessions/runtimes/codex.ts` + `mcp-bridge.ts` 的 HTTP MCP server |

具体要求：

- **新增能力必须三路同步落地**。例：`peer_send` 必须同时出现在 `peer-mcp.ts` / `session-aware.ts` / `mcp-bridge.ts` 三处；少一处就有一组用户用不了。
- **协议字段 / handoff 模板 / 权限模式 / sandbox 语义** 在三 runtime 表现应一致。模板字符串、tool name、enum 取值不要在某条路径上偷偷魔改。
- **闸门设计要明确各 runtime 的安全模型**：Claude 走 `canUseTool` 弹审批；OpenAI 走 `needsApproval`；Codex 没有 per-call 审批，闸门是 `sandboxMode`。不要假设 Claude 那套 UX 自动适用于 Codex。
- **可用性闸门一律以"capability 存在"为准**，不要靠 `opts.tools` 这种为 builtin 设计的白名单二次过滤 session-aware 工具（参见 `openai.ts` 2026-05-13 修订）。`opts.tools` 只 gate 内置工具（Read/Edit/Write/Bash/Grep/Glob/...）。
- **共享类型放 `shared/`**（沿用 §3.2）。三 runtime 共用的 union（`PeerMode`、`SandboxMode`、`PermissionMode` 等）禁止在 runtime 内本地重复定义。
- **自查清单**：改完一处问自己——"Claude 用户、OpenAI(-compat) 用户、Codex 用户分别按现在的描述跑一遍，行为/UX 一致吗？" 否则在 [`docs/plans/development-log.md`](docs/plans/development-log.md) 里记清楚为什么有意拆开。

---

