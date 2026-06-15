# Ensemble

<p align="left">
  <img src="ensemble_web/public/assets/wordmark-transparent-v1.png" alt="Ensemble" width="420">
</p>

> **Many minds. One workspace.** / **群智，一席。**

Ensemble 是一个跨平台桌面级 multi-agent AI 工作台。它把多个 Claude、OpenAI、OpenAI-compatible 和 Codex agent 放进同一个原生桌面工作区，让复杂任务可以由多位 AI agent 以 team 的形式协作完成；Cloud beta 通过 Ensemble server / cloud infrastructure 提供账号、workspace 同步、网页工作区、远程发送和部分远程设置，桌面在线时可从网页向本地 agent 发送消息并查看结果，执行仍发生在桌面端。

Ensemble is a cross-platform desktop multi-agent AI workbench. It brings Claude, OpenAI, OpenAI-compatible, and Codex agents into one native desktop workspace so complex work can be coordinated across teams of agents; Cloud beta uses Ensemble server / cloud infrastructure for accounts, workspace sync, the web workspace, remote sending, and partial remote settings. When the desktop is online, the web workspace can send messages to local agents and show results while execution still happens on the desktop.

语言 / Language: [中文](#中文) | [English](#english)

---

## 中文

### 项目定位

Ensemble 面向需要长期、并行、可追踪 AI 协作的桌面工作流。它不是单个聊天窗口，而是一个由本地 sidecar 驱动的 agent 编排工作台：

- 多 agent / team 并行会话：在同一工作区创建、切换和管理多个 agent，也可以创建 team、添加成员并让不同模型协作。
- 多 runtime 支持：Claude Code CLI、OpenAI Agents、OpenAI-compatible provider、Codex CLI subprocess。
- 本地优先：桌面壳、本地 HTTP/WS sidecar、本地 SQLite 数据库。
- Cloud beta：Ensemble server / cloud infrastructure 负责账号、workspace 同步、网页工作区、远程发送和部分 agent 设置；桌面在线时，网页可向本地 agent 发送消息并查看结果，执行仍在桌面端。
- 双平台维护：Windows 与 macOS 按平台隔离构建、发布和更新。
- 原生安装体验：Windows 提供 NSIS/MSI，macOS 提供 Apple Silicon 和 Intel DMG。

### 当前状态

Ensemble 自 `0.0.18` 起进入 Windows + macOS 双平台并行维护。当前公开下载按平台分版本：Windows x64 为 `0.0.25`；macOS Apple Silicon / Intel 为 `0.0.26`，由 Mac 组上传维护。源码构建版本在 `src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 中维护，发布 manifest 允许平台条目独立演进。

| 平台 | 架构 | 安装包 | 安装位置 |
|---|---|---|---|
| Windows | x64 | `Ensemble_0.0.25_x64-setup.exe`，NSIS，per-user，无 UAC | `%LOCALAPPDATA%\Ensemble\` |
| Windows | x64 | `Ensemble_<version>_x64_en-US.msi`，system-wide，需管理员权限 | Program Files |
| macOS | arm64 | `Ensemble_0.0.26_aarch64.dmg`，Apple Silicon | 用户拖拽到 `/Applications/` |
| macOS | x64 | `Ensemble_0.0.26_x64.dmg`，Intel Mac | 用户拖拽到 `/Applications/` |

更新接口使用平台隔离 manifest。客户端请求 `https://ensemble-ai.cn/v1/version/latest` 后，根据系统与架构选择 `platforms` 中对应的安装包；缺失某个平台条目时视为该平台暂无更新，不会误推其他系统安装包。旧客户端仍可读取顶级 `downloadUrl` 字段以保持兼容。

### 核心能力

- Agent / Team 工作区：围绕任务创建多个 agent 或 team，保持会话状态、上下文和输出记录。
- Teams：团队创建、成员角色、provider、model 可独立选择；team purpose 注入成员 prompt。编辑团队或成员角色会清理 resume 指针，确保下一轮使用新 prompt，同时保留历史和显式设置。
- Peer messaging：`peer_send` 支持 `raw` / `continue` / `review` / `fork`，`includeSource` 默认 `auto`；目标运行中会排队，批量 queued peer send 会合并。紧急 `interrupt` 必须提供 `interruptReason`，只作为安全阀。
- Cloud beta：桌面登录、workspace copy/sync、web app、remote send、remote agent settings 和 workspace selector 已接入。Ensemble server / cloud infrastructure 承担账号和同步通道；网页工作区可在桌面在线时向本地 agent 发送消息并查看结果，执行仍在桌面端。
- Provider 系统：支持本地 CLI 凭证、OpenAI API key 与第三方 OpenAI-compatible / Anthropic-compatible endpoint。
- Codex CLI 集成：通过独立子进程调用 `codex`，使用隔离 `CODEX_HOME`，适配 ChatGPT 订阅 OAuth 场景。
- Claude Code CLI 集成：通过独立子进程调用 `claude`，只读取认证 / endpoint 环境，保持 system prompt、MCP 和 memory 隔离。
- OpenAI Agents runtime：在 sidecar 内直接运行 `@openai/agents`。
- Skills：系统 skills 已暴露，支持 `skill_list` / `skill_invoke`；UI SkillPanel 可新建、编辑、重扫 ensemble 管理的 skill。Skill 来源包括 project / ensemble / user / system，并支持 auto / forced / disabled 状态。
- MCP：外部工具服务独立于 Skills 管理，支持 `stdio` / `http` / `sse` transport。
- Reasoning / thinking mode：Agent 设置可按 agent 继承或覆盖 `reasoningEffort`；切模型、团队、角色等流程会保护用户显式设置。
- 用量统计：`/cost` 和 Usage Stats 提供 token / cost breakdown、CSV 导出和本地审计明细；订阅型 Codex turn 不按 API 单价重复计费。
- 本地数据存储：使用 SQLite 持久化 workspace、agent、provider 和会话数据。
- 桌面更新：Windows 与 macOS 使用独立安装包、独立 hash、独立 release note。

### 架构

```text
Ensemble desktop app (Tauri 2.x)
  |-- Native shell: window, tray, lifecycle, sidecar startup
  |-- WebView: loads the local Next.js static UI
  `-- Sidecar: ensemble-core, Node SEA binary
        |-- Fastify HTTP API + WebSocket
        |-- SQLite local database
        |-- Claude runtime: claude CLI subprocess
        |-- OpenAI runtime: @openai/agents in-process
        `-- Codex runtime: codex CLI subprocess
```

生产安装包中，Tauri shell 负责启动 `ensemble-core` sidecar，并通过本地自动端口加载前端。sidecar 同时提供静态资源、REST API、WebSocket、数据库访问和 runtime 适配层。

### 工作区结构

| 路径 | 说明 |
|---|---|
| `shared/` | 前后端共享类型与更新 manifest schema |
| `core/` | Node sidecar，包含 Fastify、SQLite、runtime adapters、CLI 配置 |
| `desktop-ui/` | Next.js 16 静态导出前端，由 Tauri WebView 加载 |
| `src-tauri/` | Tauri 2.x Rust 桌面壳、图标、安装包配置 |
| `ensemble_server/` | 更新 manifest 服务与部署辅助脚本 |
| `ensemble_web/` | 官网静态页面与下载入口 |
| `docs/` | 架构、平台、操作手册和开发记录 |
| `scripts/` | 桌面构建、sidecar staging、macOS DMG 生成脚本 |

### 开发环境

基础依赖：

- Node.js 22 或更新版本
- pnpm 9 或更新版本
- Rust stable
- Windows: MSVC Build Tools 2022
- macOS: Xcode Command Line Tools，目标架构对应 Rust target

按需安装 runtime CLI：

```bash
npm i -g @openai/codex
```

支持的本地 CLI 版本：

| Runtime | 支持版本 | 说明 |
|---|---|---|
| Codex CLI | `0.132.0` 或更新版本；当前按 `0.13x` 系列维护，已适配 `0.138.0` 的配置校验行为 | Ensemble 会解析真实平台二进制并使用隔离的 `CODEX_HOME`，不会直接写入 `~/.codex/config.toml`。Codex sandbox 支持 `read-only` / `workspace-write` / `danger-full-access`，peer tools 通过本地 stdio MCP bridge 暴露。 |
| Claude Code CLI | 当前按 `2.1.x` 系列维护；已验证 `2.1.167` | Ensemble 通过 `@anthropic-ai/claude-agent-sdk` 调用本机 `claude`，只复用本机认证 / endpoint 环境，不复用外部 CLI 的 system prompt、MCP 或 memory。 |

Claude Code CLI 请按 Anthropic 官方方式安装并完成登录。Codex CLI 请安装后运行 `codex login`。Ensemble 不自动创建账号、不存本地 CLI token；缺少 `claude` / `codex` CLI 或登录态不可用时会在应用内提醒。

### 常用命令

```bash
# 安装依赖
pnpm install

# 启动桌面开发模式
pnpm desktop:dev

# 构建当前平台安装包
pnpm desktop:build

# macOS 构建 Apple Silicon DMG
pnpm desktop:build:mac

# macOS 构建 Intel DMG，需要匹配 x64 的 Node 二进制
TAURI_TARGET_TRIPLE=x86_64-apple-darwin ENSEMBLE_NODE_BIN=/path/to/node-x64 pnpm desktop:build:mac

# 仅启动 sidecar 进行后端调试
cd core
npx tsx src/index.ts
```

### 平台隔离约定

Windows 与 macOS 共用同一份源码，但构建产物、权限模型、CLI 查找路径、安装包格式和更新记录必须按平台隔离：

- 不把平台专属构建产物提交到 git。
- 不让 Windows 的安装包、hash、release note 覆盖 macOS manifest 字段，反之亦然。
- Provider、CLI runtime、manifest 和 release note 需要按系统处理可执行文件路径、权限、配置目录和安装包版本。
- 新功能必须同时评估 Claude、OpenAI、OpenAI-compatible、Codex 三条 runtime 路径。

### 数据目录

| 系统 | 数据目录 |
|---|---|
| Windows | `%APPDATA%\dev.ensemble.app\` |
| macOS | `~/Library/Application Support/dev.ensemble.app/` |
| Linux | `~/.config/dev.ensemble.app/` |

主要数据文件为 `agentorch.db` 及其 SQLite WAL/SHM 文件。目录名来自 Tauri identifier `dev.ensemble.app`。

### 文档

- [实现态架构](docs/architecture.md)
- [macOS 平台指南](docs/MAC_DESKTOP_PARITY_GUIDE.md)
- [操作手册](docs/HANDBOOK.md)
- [开发日志](docs/plans/development-log.md)
- [项目拆分与桌面化设计](docs/plans/ensemble-spinoff.md)

### 安全说明

- 生产 SSH key、TLS 证书、服务器信息、`.env.production` 等敏感文件已在 `.gitignore` 中排除。
- 本地 provider 凭据、OAuth token、CLI 配置和数据库文件不应提交到仓库。
- 发布安装包前应重新校验平台、版本、hash、下载 URL 和更新文案。

### License

Apache License 2.0. See [LICENSE](LICENSE).

---

## English

### Overview

Ensemble is built for long-running, parallel, traceable AI collaboration on the desktop. It is not a single chat window. It is a local sidecar-powered agent orchestration workspace:

- Multi-agent / team sessions: create, switch, and manage multiple agents in one workspace, or create teams with members on different models.
- Multi-runtime support: Claude Code CLI, OpenAI Agents, OpenAI-compatible providers, and Codex CLI subprocess.
- Local-first runtime: native shell, local HTTP/WS sidecar, and local SQLite storage.
- Cloud beta: Ensemble server / cloud infrastructure handles accounts, workspace sync, the web workspace, remote sending, and partial agent settings. When the desktop is online, the web workspace can send messages to local agents and show results while execution stays on the desktop.
- Dual-platform maintenance: Windows and macOS builds, releases, and updates are isolated by platform.
- Native installers: NSIS/MSI on Windows, Apple Silicon and Intel DMG on macOS.

### Status

Ensemble has maintained Windows and macOS in parallel since `0.0.18`. Current public downloads are platform-versioned: Windows x64 is `0.0.25`; macOS Apple Silicon / Intel is `0.0.26`, uploaded by the Mac team. The source build version is maintained in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, while the release manifest allows platform entries to advance independently.

| Platform | Architecture | Installer | Install location |
|---|---|---|---|
| Windows | x64 | `Ensemble_0.0.25_x64-setup.exe`, NSIS, per-user, no UAC | `%LOCALAPPDATA%\Ensemble\` |
| Windows | x64 | `Ensemble_<version>_x64_en-US.msi`, system-wide, requires admin | Program Files |
| macOS | arm64 | `Ensemble_0.0.26_aarch64.dmg`, Apple Silicon | Drag to `/Applications/` |
| macOS | x64 | `Ensemble_0.0.26_x64.dmg`, Intel Mac | Drag to `/Applications/` |

The updater uses a platform-isolated manifest. Clients request `https://ensemble-ai.cn/v1/version/latest` and select the correct installer from `platforms` according to OS and architecture. Missing platform entries mean "no update for this platform yet", not "download a different OS installer". Legacy clients can still read the top-level `downloadUrl` field for compatibility.

### Features

- Agent / team workspace: create multiple agents or teams around a task while preserving session state, context, and output history.
- Teams: create a team, add members, and choose each member's role, provider, and model independently. The team purpose is injected into member prompts. Editing a team or member role clears resume pointers so the next turn uses the new prompt while preserving history and explicit settings.
- Peer messaging: `peer_send` supports `raw` / `continue` / `review` / `fork`, with `includeSource` defaulting to `auto`. Messages queue while the target is running, batch queued sends are coalesced, and emergency `interrupt` requires `interruptReason`.
- Cloud beta: desktop login, workspace copy/sync, web app, remote send, remote agent settings, and workspace selector integration. Ensemble server / cloud infrastructure provides the account and sync channel; the web workspace can send to local agents and show results when the desktop is online, with execution still on the desktop.
- Provider system: supports local CLI credentials, OpenAI API keys, and third-party OpenAI-compatible / Anthropic-compatible endpoints.
- Codex CLI integration: runs `codex` as a subprocess with isolated `CODEX_HOME` for ChatGPT subscription OAuth workflows.
- Claude Code CLI integration: runs `claude` as a subprocess, reading only auth / endpoint environment while keeping system prompts, MCP, and memory isolated from external CLI sessions.
- OpenAI Agents runtime: runs `@openai/agents` in-process inside the sidecar.
- Skills: system skills are exposed via `skill_list` / `skill_invoke`; the UI SkillPanel can create, edit, and rescan ensemble-managed skills. Skill sources include project / ensemble / user / system and support auto / forced / disabled states.
- MCP: external tool services are managed separately from Skills and support `stdio` / `http` / `sse` transports.
- Reasoning / thinking mode: per-agent `reasoningEffort` can inherit or override runtime defaults. Model, team, and role changes preserve explicit user settings.
- Usage stats: `/cost` and Usage Stats provide token / cost breakdowns, CSV export, and local audit rows. Codex subscription turns do not get double-counted as API spend.
- Local persistence: stores workspace, agent, provider, and session data in SQLite.
- Desktop updates: Windows and macOS use separate installers, hashes, and release notes.

### Architecture

```text
Ensemble desktop app (Tauri 2.x)
  |-- Native shell: window, tray, lifecycle, sidecar startup
  |-- WebView: loads the local Next.js static UI
  `-- Sidecar: ensemble-core, Node SEA binary
        |-- Fastify HTTP API + WebSocket
        |-- SQLite local database
        |-- Claude runtime: claude CLI subprocess
        |-- OpenAI runtime: @openai/agents in-process
        `-- Codex runtime: codex CLI subprocess
```

In production builds, the Tauri shell starts the `ensemble-core` sidecar and loads the frontend through an automatically selected local port. The sidecar serves static assets, REST APIs, WebSocket streams, database access, and runtime adapters.

### Repository Layout

| Path | Description |
|---|---|
| `shared/` | Shared frontend/backend types and update manifest schema |
| `core/` | Node sidecar with Fastify, SQLite, runtime adapters, and CLI configuration |
| `desktop-ui/` | Next.js 16 static UI loaded by the Tauri WebView |
| `src-tauri/` | Tauri 2.x Rust shell, icons, and installer configuration |
| `ensemble_server/` | Update manifest service and deployment helpers |
| `ensemble_web/` | Static website and download entry points |
| `docs/` | Architecture, platform guides, handbook, and development notes |
| `scripts/` | Desktop build, sidecar staging, and macOS DMG scripts |

### Development Requirements

Base requirements:

- Node.js 22 or newer
- pnpm 9 or newer
- Rust stable
- Windows: MSVC Build Tools 2022
- macOS: Xcode Command Line Tools and Rust targets for the target architectures

Optional runtime CLI:

```bash
npm i -g @openai/codex
```

Supported local CLI versions:

| Runtime | Supported versions | Notes |
|---|---|---|
| Codex CLI | `0.132.0` or newer; currently maintained against the `0.13x` series and adapted for the `0.138.0` config validation behavior | Ensemble resolves the real platform binary and uses an isolated `CODEX_HOME`; it does not write directly to `~/.codex/config.toml`. Codex sandbox supports `read-only` / `workspace-write` / `danger-full-access`; peer tools are exposed through a local stdio MCP bridge. |
| Claude Code CLI | Currently maintained against the `2.1.x` series; verified with `2.1.167` | Ensemble invokes the local `claude` through `@anthropic-ai/claude-agent-sdk`, reusing only local auth / endpoint environment and not external CLI system prompts, MCP, or memory. |

Install Claude Code CLI through Anthropic's official instructions and complete login before using Claude local providers. Install Codex CLI and run `codex login` before using Codex providers. Ensemble does not create accounts automatically and does not store local CLI tokens; missing `claude` / `codex` CLI or login state is surfaced in the app.

### Commands

```bash
# Install dependencies
pnpm install

# Start desktop development mode
pnpm desktop:dev

# Build the installer for the current platform
pnpm desktop:build

# Build Apple Silicon DMG on macOS
pnpm desktop:build:mac

# Build Intel DMG on macOS, with a matching x64 Node binary
TAURI_TARGET_TRIPLE=x86_64-apple-darwin ENSEMBLE_NODE_BIN=/path/to/node-x64 pnpm desktop:build:mac

# Run only the sidecar for backend debugging
cd core
npx tsx src/index.ts
```

### Platform Isolation

Windows and macOS share the same source tree, but build outputs, permission behavior, CLI path discovery, installer formats, and update records must stay platform-isolated:

- Do not commit platform-specific build outputs.
- Do not let Windows installer URLs, hashes, or release notes overwrite macOS manifest fields, or the reverse.
- Provider, CLI runtimes, manifests, and release notes must handle executable paths, permissions, config directories, and installer versions per OS.
- Every feature should be evaluated across Claude, OpenAI, OpenAI-compatible, and Codex runtime paths.

### Data Directories

| OS | Data directory |
|---|---|
| Windows | `%APPDATA%\dev.ensemble.app\` |
| macOS | `~/Library/Application Support/dev.ensemble.app/` |
| Linux | `~/.config/dev.ensemble.app/` |

The main data files are `agentorch.db` plus SQLite WAL/SHM files. The directory name comes from the Tauri identifier `dev.ensemble.app`.

### Documentation

- [Architecture](docs/architecture.md)
- [macOS Desktop Parity Guide](docs/MAC_DESKTOP_PARITY_GUIDE.md)
- [Handbook](docs/HANDBOOK.md)
- [Development Log](docs/plans/development-log.md)
- [Desktop Product Plan](docs/plans/ensemble-spinoff.md)

### Security

- Production SSH keys, TLS certificates, server notes, and `.env.production` are excluded by `.gitignore`.
- Local provider credentials, OAuth tokens, CLI config, and database files should never be committed.
- Before publishing installers, re-check platform, version, hash, download URL, and release notes.

### License

Apache License 2.0. See [LICENSE](LICENSE).
