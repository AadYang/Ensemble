# Ensemble

<p align="left">
  <img src="ensemble_web/public/assets/wordmark-transparent-v1.png" alt="Ensemble" width="420">
</p>

> **Many minds. One workspace.** / **群智，一席。**

Ensemble 是一个跨平台桌面级 multi-agent AI 工作台。它把多个 Claude、OpenAI、OpenAI-compatible 和 Codex agent 放进同一个原生桌面工作区，让复杂任务可以由多位 AI agent 协作完成。

Ensemble is a cross-platform desktop multi-agent AI workbench. It brings Claude, OpenAI, OpenAI-compatible, and Codex agents into one native desktop workspace so complex work can be coordinated across multiple AI agents.

语言 / Language: [中文](#中文) | [English](#english)

---

## 中文

### 项目定位

Ensemble 面向需要长期、并行、可追踪 AI 协作的桌面工作流。它不是单个聊天窗口，而是一个由本地 sidecar 驱动的 agent 编排工作台：

- 多 agent 并行会话：在同一工作区创建、切换和管理多个 agent。
- 多 runtime 支持：Claude Code CLI、OpenAI Agents、OpenAI-compatible provider、Codex CLI。
- 本地优先：桌面壳、本地 HTTP/WS sidecar、本地 SQLite 数据库。
- 双平台维护：Windows 与 macOS 按平台隔离构建、发布和更新。
- 原生安装体验：Windows 提供 NSIS/MSI，macOS 提供 Apple Silicon 和 Intel DMG。

### 当前状态

Ensemble 自 `0.0.18` 起进入 Windows + macOS 双平台并行维护。当前桌面应用版本在 `src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 中维护。

| 平台 | 架构 | 安装包 | 安装位置 |
|---|---|---|---|
| Windows | x64 | `Ensemble_<version>_x64-setup.exe`，NSIS，per-user，无 UAC | `%LOCALAPPDATA%\Ensemble\` |
| Windows | x64 | `Ensemble_<version>_x64_en-US.msi`，system-wide，需管理员权限 | Program Files |
| macOS | arm64 | `Ensemble_<version>_aarch64.dmg`，Apple Silicon | 用户拖拽到 `/Applications/` |
| macOS | x64 | `Ensemble_<version>_x64.dmg`，Intel Mac | 用户拖拽到 `/Applications/` |

更新接口使用平台隔离 manifest。客户端请求 `https://ensemble-ai.cn/v1/version/latest` 后，根据系统与架构选择 `platforms` 中对应的安装包；旧客户端仍可读取顶级 `downloadUrl` 字段以保持兼容。

### 核心能力

- Agent 工作区：围绕任务创建多个 agent，保持会话状态、上下文和输出记录。
- Provider 系统：支持官方 OAuth、本地 CLI、OpenAI API key 与第三方 OpenAI-compatible endpoint。
- Codex CLI 集成：通过独立子进程调用 `codex`，适配 ChatGPT 订阅 OAuth 场景。
- Claude Code CLI 集成：通过独立子进程调用 `claude`，保留 CLI 原生能力。
- OpenAI Agents runtime：在 sidecar 内直接运行 `@openai/agents`。
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

Claude Code CLI 请按 Anthropic 官方方式安装并完成登录。

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
- Provider 与 CLI runtime 需要按系统处理可执行文件路径、权限和配置目录。
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

TBD

---

## English

### Overview

Ensemble is built for long-running, parallel, traceable AI collaboration on the desktop. It is not a single chat window. It is a local sidecar-powered agent orchestration workspace:

- Multi-agent sessions: create, switch, and manage multiple agents in one workspace.
- Multi-runtime support: Claude Code CLI, OpenAI Agents, OpenAI-compatible providers, and Codex CLI.
- Local-first runtime: native shell, local HTTP/WS sidecar, and local SQLite storage.
- Dual-platform maintenance: Windows and macOS builds, releases, and updates are isolated by platform.
- Native installers: NSIS/MSI on Windows, Apple Silicon and Intel DMG on macOS.

### Status

Ensemble has maintained Windows and macOS in parallel since `0.0.18`. The desktop app version is maintained in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.

| Platform | Architecture | Installer | Install location |
|---|---|---|---|
| Windows | x64 | `Ensemble_<version>_x64-setup.exe`, NSIS, per-user, no UAC | `%LOCALAPPDATA%\Ensemble\` |
| Windows | x64 | `Ensemble_<version>_x64_en-US.msi`, system-wide, requires admin | Program Files |
| macOS | arm64 | `Ensemble_<version>_aarch64.dmg`, Apple Silicon | Drag to `/Applications/` |
| macOS | x64 | `Ensemble_<version>_x64.dmg`, Intel Mac | Drag to `/Applications/` |

The updater uses a platform-isolated manifest. Clients request `https://ensemble-ai.cn/v1/version/latest` and select the correct installer from `platforms` according to OS and architecture. Legacy clients can still read the top-level `downloadUrl` field for compatibility.

### Features

- Agent workspace: create multiple agents around a task while preserving session state, context, and output history.
- Provider system: supports official OAuth, local CLI providers, OpenAI API keys, and third-party OpenAI-compatible endpoints.
- Codex CLI integration: runs `codex` as a subprocess for ChatGPT subscription OAuth workflows.
- Claude Code CLI integration: runs `claude` as a subprocess while preserving native CLI capabilities.
- OpenAI Agents runtime: runs `@openai/agents` in-process inside the sidecar.
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

Install Claude Code CLI through Anthropic's official instructions and complete login before using Claude local providers.

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
- Provider and CLI runtimes must handle executable paths, permissions, and config directories per OS.
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

TBD
