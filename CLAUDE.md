# CLAUDE.md — Ensemble

> 本文件是 Ensemble 项目对协作 AI 的工作准则。每次进入本目录或被本仓库引用时都会自动加载，请认真遵守。

---

## 0. 项目速览

- **目标**：跨平台桌面级 multi-agent AI 工作台。Tauri 2.x + sidecar binary（Node SEA）+ Next.js 静态前端。
- **Slogan**：Many minds. One workspace. / 群智，一席。
- **设计源头**：[`docs/plans/agent-orchestrator-plan.md`](docs/plans/agent-orchestrator-plan.md)（W1–W15 完整架构、Schema、协议、UI Token，AgentUI 时期落定）+ [`docs/architecture.md`](docs/architecture.md)（Ensemble 实现态）+ [`docs/plans/development-log.md`](docs/plans/development-log.md)（每次改动的根因 + 教训）。
- **历史前身**：AgentUI（`D:\WorkSpace\AgentUI\`）—— 已于 2026-05-11 停止维护。Ensemble fork 自该项目，协议 / Schema / API 路径全部保持兼容。
- **当前阶段**：✅ Windows 与 macOS **双平台并行维护**（自 0.0.18 起）。每个发版都要同时跑 Windows + macOS 两条构建路径；任何只在一侧验证过的修复都视为半成品。
- **平台分工实践**：Windows 构建在本仓库的 Windows 工作机上完成，macOS 构建在配备 Xcode + Developer ID 的 Mac 上完成。两侧共用同一份 git 分支；platform-specific 产物（Cargo.lock、`src-tauri/binaries/ensemble-core-<triple>(.exe)`）保持「工作树脏 + 不提交」约定，否则两侧来回 push 会无意义地相互覆盖。详见 §3.6。

涉及架构 / 品牌 / 协议任何决策时，**先读 plan + dev-log + architecture**，不要从零重新提案。

---

## 1. 已锁定的技术决策（不再重新论证）

| 主题 | 已定方案 | 不再考虑 |
|---|---|---|
| 后端语言 | Node.js 22 + TypeScript | Python（SDK 完整度不够） |
| Agent 内核 | `@anthropic-ai/claude-agent-sdk`（库方式嵌入） | `claude -p` 子进程包装 |
| Web 框架 | Fastify | Express / Koa / NestJS |
| 实时通信 | WebSocket（双向） | SSE（无法承载权限审批回路） |
| 数据库 | **node:sqlite**（Node 22+ 内置） | PostgreSQL / Prisma（v1 评估后切到 sqlite） |
| 前端框架 | Next.js 16 (App Router, static export) + Zustand | Vue / Svelte / Redux |
| 桌面框架 | **Tauri 2.x**（WebView2/WebKit）+ sidecar | Electron（体积大 40 倍） |
| 后端集成 | **Sidecar binary**（SEA exe 作为子进程） | Tauri commands IPC 桥 |
| 端口分配 | sidecar 启动时自选；双通道宣告：(1) `fs.writeSync(1, "ENSEMBLE_LISTENING <port>\n")` 同步写 fd 1 + (2) `DATA_DIR/.port` 哨兵文件；Rust 端 stdout reader 与文件 poller race，先到先 win | 固定 3001；纯 `console.log`（在 macOS 上 Node pipe 缓冲会把声明吞掉） |
| 数据目录 | Tauri `appDataDir()`：Win `%APPDATA%\dev.ensemble.app\` / macOS `~/Library/Application Support/dev.ensemble.app/` / Linux `~/.config/dev.ensemble.app/` | `~/.agentorch/` |
| 打包平台矩阵 | **Windows**（x64 NSIS / MSI）+ **macOS**（aarch64 / x64 DMG，build per-arch、不构 universal）；构建从 `pnpm desktop:build` 经 `scripts/desktop-build.mjs` 路由：darwin 走 `tauri build --bundles app` + `scripts/macos-dmg.mjs`，其他走 `desktop:build:tauri`（沿用 NSIS/MSI 旧链路） | universal macOS dmg；CI 跨平台编译（cross-build SEA 不可行） |
| macOS 激活策略 | `ActivationPolicy::Regular` 显式设置；`on_sidecar_ready` 在 macOS 上 `unminimize()` + 主线程 tick `show()/set_focus()` 重复一次；12s 看门狗兜底 | 默认让 Tauri 推断（带 TrayIcon 时会推断成 `Accessory`，导致窗口不抢前台） |
| 更新清单 schema | `UpdateManifest.platforms?: Record<PlatformKey, PlatformAsset>` 可选 map（0.0.18+），同时保留旧的顶级 `downloadUrl/sha256/sizeBytes` 给 ≤ 0.0.17 客户端；新客户端命中本平台 asset 才弹更新，否则**完全压制提示**（不要再让 Mac 用户看到 Windows EXE 链接） | 单一全局 downloadUrl |
| 布局库 | `react-resizable-panels`（递归二叉树渲染） | react-mosaic / dockview |
| 键位 | `react-hotkeys-hook`，prefix = `Ctrl+B` | 自实现键盘事件 |
| UI 基础 | shadcn/ui 风格 + Tailwind | MUI / Ant Design |
| 字体 / 配色 | JetBrains Mono；青 `#00d9ff` on `#0a0e14` | 浅色主题 / 非等宽字体 |
| Subagent 编排 | 默认方案 A（透明嵌套，Claude CLI 内置）；用户驱动方案 B (`+ child` 按钮)；OpenAI side 走 `SessionManager.spawnTaskSubagent`（W16 Slice 5） | 默认拦截 Task 工具 |
| 多 runtime | Claude 体系走 `@anthropic-ai/claude-agent-sdk` (CLI subprocess)；OpenAI / openai-compat 体系走 `@openai/agents` (in-process)；按 `provider.kind` 在 `chooseRuntime` 路由（W16） | musistudio 翻译层（已删尽） |
| Provider 协议 | `anthropic-local` (本地 OAuth) / `anthropic` (第三方 anthropic-compat) / `openai-compat`（W16）；bedrock / vertex / autoManaged 老数据自动 disable + migrate banner | LLM 网关 / `autoManaged` |
| 双形态保留 | sidecar core 单跑仍是 server-only 模式 | 强制只在 Tauri 里跑 |

如果用户提出与上述冲突的新方向，**先暴露冲突**，再行动。

---

## 2. 行为准则

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

## 3. 项目特定规则

### 3.1 不要做这些

- 不要建议把 SDK 换成 `claude -p` 子进程，已被否决。
- 不要建议增加未在 plan 里的 ORM / 缓存 / 消息队列组件（Redis、Kafka、RabbitMQ、TypeORM 等）。
- 不要写多 paragraph docstring 或大块注释——准则 2 + 项目偏好。
- 不要在权限审批 / Schema 变更 / 协议变更上跳过澄清，这些是高代价的回头路。

### 3.2 写代码时的硬约束

- **注释最少化**：默认不写注释。只在 WHY 非显然时写一行（隐含约束、反直觉决策、特定 bug 的 workaround）。
- **不写"用于 X 流程"这种解释性注释**——这种内容属于 commit message 或 PR 描述。
- **TypeScript strict 模式**：所有新代码必须 strict 通过。
- **共享类型放 `shared/`**：前后端都要用的（如 `LayoutNode`、`ClientMsg`、`ServerMsg`）放 `shared/` 而不是各自定义。
- **WebSocket 协议改动**必须同步更新 `shared/src/protocol.ts` 和 [`docs/plans/agent-orchestrator-plan.md`](docs/plans/agent-orchestrator-plan.md) §4.2。
- **Schema 改动**：node:sqlite 直接写迁移 SQL 到 `core/src/db.ts` 的 `SCHEMA` 常量；改完手动测一次"删 db → 启动 → 自动建表 + 跑一轮基础 CRUD"。

### 3.3 测试要求

- 布局引擎纯函数：100% 单测覆盖（这是核心，回归代价高）。
- WebSocket 协议：写至少一个集成测试覆盖"创建 agent → 发消息 → 收到 permission_request → 回 permission_response → 拿到 tool_result"完整链路。
- 其余代码：合理覆盖关键路径，不强求百分比。

### 3.4 提交规范

- 单次提交不跨多个 plan 主题（Schema / 协议 / 布局 / UI 不混在同一 commit）。
- commit message 写"为什么"，不写"什么"（什么看 diff 就够）。

### 3.5 易踩坑（实践积累，必读）

| 坑 | 现象 | 解 |
|---|---|---|
| **prep-sidecar 不强制重打** | 改了 `core/src/*` 后跑 `desktop:build`，shell 是新的、sidecar 还是旧的 → 用户看到「✗ 0 models · default」这种用旧前端 fallback 拼出来的诡异错 | `scripts/prep-sidecar.mjs` 已改成**每次都重打**，不要再加 `existsSync` 跳过逻辑 |
| **sidecar stdout 不能漏字** | Tauri shell 按行 `recv` stdout 解析 `ENSEMBLE_LISTENING <port>`。任何在它之前的 stdout 字节都会让协议失效 | core 在 `AUTO_PORT` 模式下把 fastify pino logger 强制写 `stderr`，stdout 只留协议 token |
| **Provider models 解析不能太严格** | MiniMax / GLM 等的 `/v1/models` 不一定是 OpenAI 标准 `{data:[{id}]}` 形状 | `probeModels` + `extractModelIds` 已支持多种 envelope（`data` / `models` / `results` / 裸数组）+ 多种 id 字段（`id` / `name` / `model` / `model_id` / `model_name`）；新增形状直接加进 `extractModelIds` |
| **Provider 0 模型不能假回落** | AgentSettings 历史代码：第三方 provider 的 `models[]` 为空时 fallback 到 hardcoded opus/sonnet — 用户选了模型发请求时上游 404，错得莫名其妙 | 只有 `kind=anthropic-local` 才回落；其他显示「无模型，去刷新」黄色提示 |
| **WEB_ROOT 在 sidecar 模式下要 Tauri 注入** | `make-exe.mjs` 把 `web/` 拷到 `<exe-dir>/web/`，但 Tauri 把 sidecar 复制到 `target/debug/` 时不会带 `web/` | Tauri Rust 在 spawn sidecar 时注入 `AGENTORCH_WEB_ROOT` env，dev 用 `CARGO_MANIFEST_DIR/../desktop-ui/static-out`，prod 用 `app.path().resource_dir()/web` |
| **Tauri tray 是 feature-gated** | Cargo build 报 `unresolved import tauri::tray` | `Cargo.toml` 给 `tauri = { version = "2.11.1", features = ["tray-icon"] }` |
| **Windows MSI 默认要 admin** | `msiexec /i ... /quiet` 退 1603 | 优先派发 NSIS（`Ensemble_0.0.1_x64-setup.exe`），per-user 装到 `%LOCALAPPDATA%\Ensemble\`，无 UAC |
| **Windows 上 MSVC linker 缺失** | `cargo build` 报 `linker 'link.exe' not found` | 用户装 Visual Studio 2022 Build Tools + VCTools workload；Rustup 不带 |
| **SDK 在 SEA bundle 中找不到 cli.js** | esbuild CJS bundle 里 `import.meta.url` = undefined → SDK 的 `fileURLToPath(undefined)` 抛 "path must be string" | SessionManager 显式传 `pathToClaudeCodeExecutable: <user 本机 claude.exe>`，跳过 SDK 的 cli.js 解析 |
| **claude CLI session 按 cwd 分桶存** | sidecar 不同 cwd 下找不到上一次存的 session → exit 1 "No conversation found" | query 显式传 `cwd: homedir()`；同时 stderr 监测到 "No conversation found" 时自动清 lastSessionId 自愈 |
| **CLI 模型白名单卡死非 Claude 名字** | 用 `gpt-5.4` / 国产模型名 → CLI 立刻拒 "may not exist or you may not have access" | 走 musistudio 翻译救不了（model 名原样转发，上游也 404）。**真正的解是 W16：双 SDK 集成**（OpenAI 体系用 `@openai/agents`） |
| **Zustand selector 里用字面量 fallback 触发无限渲染** | 启动后整窗口变白底 + "This page couldn't load. Reload to try again, or go back." 文案（实际是 Next.js 的 `<html id="__next_error__">` fallback，body 没 Tailwind 所以白底）；面板全空；服务端日志却显示所有请求 200 —— **React error #185 "Maximum update depth exceeded"** 把整个 app 切到 error boundary | 不要写 `useStore((s) => s.something[key] ?? [])` —— 每次调用返回新数组引用，Zustand 严格按引用比较，等于"每渲染一次就声明值变了"，永久循环。用 module-level 常量做 fallback：`const EMPTY: readonly string[] = Object.freeze([]); useStore((s) => s.x[k] ?? EMPTY);`。同理 `?? {}` 也禁止 |
| **macOS sidecar ENSEMBLE_LISTENING 丢声明** | 装上 0.0.17 mac 包后点图标，**只出现菜单栏 tray，主窗口永不出现**；右键 tray → Show Ensemble 才把窗口拉出来；之后 codex provider 创建报 WebKit 特有的 `The string did not match the expected pattern.` | Node 在非 TTY pipe 上的 stdout 是异步缓冲的——`process.stdout.write(...)` 那行可能就坐在 Node 流缓冲里没刷出去，Tauri 永远收不到，`on_sidecar_ready` 不触发 → 窗口不 navigate → 留在 `tauri://localhost` origin，相对 fetch 在 WebKit 上挂掉。**永远用 `fs.writeSync(1, ...)`** 同步绕开流层，**同时**写 `DATA_DIR/.port` 哨兵作为第二通道，Rust 端 poller 兜底 |
| **macOS DMG 用户拖错位置** | 用户挂载 DMG 之后把 `Ensemble.app` 拖到 `~/Documents` / `文稿`，而不是 `/Applications` | `hdiutil create -srcfolder ... -format UDZO` 一步出图没有 Finder 视图布局，挂载后看到的就是列表视图。**必须**两阶段：先生成 R/W UDRW → 挂载 → AppleScript 摆图标位 → 卸载 → `hdiutil convert -format UDZO` 压缩。脚本：`scripts/macos-dmg.mjs` |
| **macOS Tauri TrayIcon 默认推断 Accessory** | 跟上面那条不同：即使 sidecar 起来了，窗口也是 `show()` 完后在其他 app 后面、tray 在前 | `setup()` 里**显式** `app.set_activation_policy(ActivationPolicy::Regular)`；`on_sidecar_ready` 在 macOS 上再走一次 `run_on_main_thread` 里的 `show()/set_focus()` |
| **Tauri shell:allow-open scope 会自动加锚点** | 点「一键升级」报 `Scoped command argument at position 0 was found, but failed regex validation ^^https://...\.cn/$`，URL 永远过不了 | Tauri 把 `{ url: <pattern> }` 包成 `^<pattern>$`。我们的 `^https://...\.cn/` 被包成 `^^https://...\.cn/$`，尾部 `$` 紧跟 `/` 强制 URL 终止于 `/`，任何路径都失配。**不要给自己加 `^/$` 锚点**，写成 `https://(www\\.)?ensemble-ai\\.cn/.*` 让 Tauri 自己加 |
| **Tauri webview 跨域 fetch 默认被 CORS 拦** | 桌面端调 `https://ensemble-ai.cn/v1/version/latest` 的更新检查，curl 200 但 webview 拿不到响应；用户看到「检查更新失败」 | webview 的 origin 在 macOS/Linux 是 `tauri://localhost`，Windows 是 `http://tauri.localhost`，对 `ensemble-ai.cn` 都跨域。nginx 必须显式返 `Access-Control-Allow-Origin: *`（公开只读 manifest，`*` 安全），OPTIONS 预检直接 nginx 短路 204；这是服务器侧 fix，不需要发新客户端 |
| **macOS 桌面 GUI app 的 PATH 不继承 shell** | Finder/Dock 拉起来的 .app 看不到 `~/.zshrc` / `~/.bash_profile` 里 export 的 PATH；`which codex` 用户终端找得到，sidecar 找不到 | `core/src/cli-config.ts` 的 `commonCliRoots()` 在 darwin 上显式加 `/opt/homebrew/bin` `/usr/local/bin` `~/.local/bin` `~/.npm-global/bin` 等。**不要**靠 `process.env.PATH`，那个值在 GUI 启动时被裁过 |

### 3.6 双平台维护（Windows + macOS，强制）

Ensemble 自 0.0.18 起两条平台线并行维护。每个改动必须考虑两边都能正确构建 + 运行；任何只在一侧验证过的修复**不算 done**。

**构建路径**（`pnpm desktop:build` 入口）：

| 平台 | 路径 | 产物 |
|---|---|---|
| Windows (x64) | `scripts/desktop-build.mjs` → `desktop:build:tauri` → `pnpm dlx @tauri-apps/cli build` | `src-tauri/target/release/bundle/nsis/Ensemble_<v>_x64-setup.exe` + `.../msi/Ensemble_<v>_x64_en-US.msi` |
| macOS (aarch64) | `scripts/desktop-build.mjs` → `tauri build --bundles app` → `scripts/macos-dmg.mjs` | `src-tauri/target/release/bundle/dmg/Ensemble_<v>_aarch64.dmg`（先 `.app`，再两阶段 R/W → UDZO + AppleScript 摆位） |
| macOS (x64) | 同上，`TAURI_TARGET_TRIPLE=x86_64-apple-darwin pnpm desktop:build:mac` | `bundle/dmg/Ensemble_<v>_x64.dmg`（Intel Mac 用） |

**Cross-build SEA 不可行** —— Node SEA 是把当前平台的 `node` 二进制 + blob 注入，跨平台需要在目标平台上准备 Node 二进制；只在原生平台上跑构建。

**工作树脏状态约定**（核心）：每次发版构建后会留下两个 modified 文件：

```
M src-tauri/Cargo.lock
M src-tauri/binaries/ensemble-core-<triple>(.exe)
```

这两个**不要每次发版都 commit**。原因：
- 这俩是各自平台的产物（Windows 出 `-x86_64-pc-windows-msvc.exe`，Mac 出 `-aarch64-apple-darwin`），互相不重叠
- 两边来回 push 会出现「Win 这次把 Mac 上次的 binary 文件覆盖、下次 Mac 同事 build 完又反过来」的无意义振荡
- `Cargo.lock` 里实际只是 `version = "0.0.X"` 那一行级联，下次 build 必然刷新

**真正提交的时机**：版本号触发的 `release(0.0.X): bump version` commit 里**只** include `Cargo.toml` 和 `tauri.conf.json`；产物文件靠下一次构建在各自平台自然刷新。

**macOS DMG 发布到 manifest 的流程**（Mac 同事的份）：

1. 拉最新分支 → `pnpm desktop:build`（自动走 macOS 路径）
2. 取 sha256 + 字节数
3. SCP 上传到 `/var/www/ensemble-dl/download/releases/`
4. 改 `/opt/ensemble-server/app/manifest.json` 的 `platforms` 字段，加 `macos-arm64` / `macos-x64` 条目（**不要**碰顶级 `downloadUrl`，那个保留为 Windows 的）
5. `sudo systemctl restart ensemble-server`（manifest watcher 在 atomic replace 时会丢 inode，restart 是简单可靠的兜底）

**测试要求**：

- `pnpm vitest run`（core / server）必须两侧都过（macOS 上目前 174 + 35 tests）
- WS 协议、SQLite schema、provider 创建、`peer_send`、update check 这些跨 runtime 的能力**必须**在两个平台都手动跑一遍
- Codex provider 创建在 macOS 上是历史易碎点（依赖 `commonCliRoots()` 找到 `codex` + GUI PATH 限制），改 cli-config 时优先在 Mac 上验

### 3.7 多 runtime 兼容（强制）

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

## 4. 协作流程速记

进入一个具体任务时按这个顺序：

1. **读 [`docs/architecture.md`](docs/architecture.md) + [`docs/plans/development-log.md`](docs/plans/development-log.md)** 看现状
2. **明确假设和疑问**（准则 1）
3. **写一句话目标 + 验收标准**（准则 4）
4. **若需多步骤，先给计划再动手**
5. **实现，只改必要处**（准则 3）
6. **每步即时验证**（准则 4）
7. **审视是否过度复杂**，是则重写更简（准则 2）
8. **报告结果时**：一句话说做了什么 + 一句话说下一步建议，不要长结尾总结

---

## 5. 当前 stage 状态

W15 v1 全部 11 stages 已实施完成（commit `599d7bc`，2026-05-10）。**自 0.0.18 起进入 Windows + macOS 双平台并行维护阶段**。后续增量见 [`docs/plans/development-log.md`](docs/plans/development-log.md)。

- ✅ stage 5.1–5.11 桌面化（Tauri shell + sidecar 集成 + 打包链路）
- ✅ Windows NSIS / MSI 发布（0.0.1 → 0.0.18）
- ✅ macOS DMG 发布通路（commit `30bd3b3` + 0.0.18 系列修复）：
  - DMG 两阶段构建（R/W → 摆位 → UDZO 压缩）
  - macOS 激活策略 + sidecar readiness 双通道（stdout + `.port` 哨兵）+ 12s 看门狗
  - per-platform manifest schema（`UpdateManifest.platforms`）
  - 客户端按平台过滤更新提示
- ⏳ macOS DMG 资产首次发布到 `manifest.platforms.macos-*` —— 待 Mac 同事在 Mac 上跑一遍 `pnpm desktop:build:mac` 后上传
- ⏳ stage 5.12 (可选) 原生文件对话框替换 portal modal —— 未做，优先级低

## 6. backlog（已设计未实施）

| 编号 | 主题 | 设计文档 | 状态 |
|---|---|---|---|
| ~~W16~~ | ~~多 SDK 原生集成（OpenAI Agents SDK 与 Claude SDK 并行）~~ | [`docs/plans/multi-sdk-integration.md`](docs/plans/multi-sdk-integration.md) | ✅ 已实施 2026-05-11 (Slice 1–8) |
| ~~W14~~ | ~~Subagent 推荐（点 + 子 agent 时智能推荐）~~ | [`docs/plans/subagent-suggestions.md`](docs/plans/subagent-suggestions.md) v2 | ✅ 已实施 2026-05-11 (commit `43a8542`) |
| ~~W17~~ | ~~Token 消耗统计（顶部工具栏 ◔ 按钮 → 统计页面，含趋势图 + 详细列表 + CSV 导出）~~ | [`docs/plans/token-usage-stats.md`](docs/plans/token-usage-stats.md) v3 | ✅ 已实施 2026-05-11 (commit `d76e240`) |
| ~~W20~~ | ~~Codex CLI runtime（ChatGPT 订阅 OAuth）~~ | [`docs/plans/codex-cli-runtime.md`](docs/plans/codex-cli-runtime.md) | ✅ 已实施（merged via `efb2cd9`） |
| - | macOS 桌面发版通路（DMG + 激活策略 + per-platform manifest） | [`docs/MAC_DESKTOP_PARITY_GUIDE.md`](docs/MAC_DESKTOP_PARITY_GUIDE.md) | ✅ 已实施 2026-05-18（merged via `30bd3b3` + 0.0.18 修 commit `efed9c8`） |
| - | macOS DMG 首发布（manifest.platforms.macos-arm64 / macos-x64） | 同上 | ⏳ 待 Mac 同事完成首次 build + 上传 |

新需求落到这张表里前先开 plan 文档落盘设计。

W17 的关键架构选择是新增 `UsageEvent` 表（agentId / providerId nullable + ON DELETE SET NULL + snapshot 字段冻结上下文），把 token / cost 数据从 Message 表解耦。删 agent / provider 不再丢账单数据——这条决议起因是用户对 v2「接受丢失 + 警告」方案的回怼「历史 cost 是数据，为何会和 agent 强绑定」。原则已记到 memory：FK CASCADE 不该吞业务/审计数据。
