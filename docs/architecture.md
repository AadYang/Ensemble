# Ensemble Architecture

> 实现态文档，对齐 0.0.18（2026-05-18）的实际代码：W16 多 SDK + W20 Codex 已落地；macOS 桌面通路自 0.0.18 起与 Windows 并行维护。设计原始动机见 [`./plans/ensemble-spinoff.md`](./plans/ensemble-spinoff.md)；W16 多 SDK 集成的 Slice 落地见 [`./plans/development-log.md`](./plans/development-log.md) 与 [`./plans/multi-sdk-integration.md`](./plans/multi-sdk-integration.md)；macOS 平台细节见 [`./MAC_DESKTOP_PARITY_GUIDE.md`](./MAC_DESKTOP_PARITY_GUIDE.md)。

---

## 1. 三进程架构

```
┌─ Ensemble.exe (Tauri shell, ~11 MB Rust binary)
│   ├─ WebView2 主窗口 ── HTTP/WS ──▶ ┐
│   │                                    │
│   ├─ spawn ──▶ ensemble-core.exe ◀─────┘   (Node SEA, ~93 MB)
│   │            ├─ Fastify :auto-port  →  /api/* + /ws + 静态前端
│   │            ├─ node:sqlite          →  agentorch.db
│   │            ├─ chooseRuntime(provider.kind)
│   │            │   ├─ anthropic-local / anthropic → ClaudeAgentRuntime → spawn claude CLI
│   │            │   └─ openai-compat             → OpenAIAgentRuntime → @openai/agents in-process
│   │
│   └─ 系统托盘 (Show / Quit)
```

最终安装包：

| 平台 | 格式 | 文件名 | 大小 | 安装位置 |
|---|---|---|---|---|
| Windows x64 | **NSIS** | `Ensemble_<v>_x64-setup.exe` | ~40 MB | `%LOCALAPPDATA%\Ensemble\`（per-user，无 UAC）**← 推荐** |
| Windows x64 | MSI | `Ensemble_<v>_x64_en-US.msi` | ~40 MB | Program Files（system-wide，需 admin） |
| macOS aarch64 | DMG | `Ensemble_<v>_aarch64.dmg` | ~40 MB | 用户拖拽 → `/Applications/Ensemble.app` |
| macOS x64 | DMG | `Ensemble_<v>_x64.dmg` | ~40 MB | 同上（Intel Mac） |

Windows 装完目录含 `ensemble.exe` + `ensemble-core.exe` + `web/` 静态资源 + `uninstall.exe`。macOS `.app` bundle 把 `ensemble-core`（无 `.exe` 后缀）放在 `Contents/MacOS/`，资源在 `Contents/Resources/`。数据目录走 Tauri `appDataDir()`（见 §3）。

---

## 2. Sidecar 启动协议

Tauri shell 拉起 sidecar 时通过环境变量传递配置，并按行从 stdout 读协议 token。

### 2.1 Tauri → sidecar 注入的 env

| Env | 值 | 作用 |
|---|---|---|
| `ENSEMBLE_AUTO_PORT` | `"1"` | sidecar 自选可用端口（fastify listen `port: 0`） |
| `AGENTORCH_DATA_DIR` | Tauri `appDataDir()` 字符串 | 覆盖 sidecar 默认数据目录，让 SQLite / 缓存写到 OS 标准路径 |
| `AGENTORCH_WEB_ROOT` | dev: `<workspace>/desktop-ui/static-out`；prod: `app.path().resource_dir()/web` | sidecar 找静态前端的位置 |

变量名前缀混用 `ENSEMBLE_*` 和 `AGENTORCH_*`：前者是 Ensemble 新增（端口分配协议），后者是历史前身 AgentUI 时代沿用（数据目录、web root）—— 保留是为了能直接读老用户从 AgentUI 拷过来的 db 文件。

### 2.2 sidecar → Tauri readiness 协议（双通道 + 看门狗）

> 0.0.17 之前是单通道（stdout）。0.0.18 起改为**双通道**因为 macOS 上 Node pipe stdout 的异步缓冲会把 ENSEMBLE_LISTENING 声明吞掉——symptom 是「点图标只出现 tray，窗口永不出现」。

#### 通道 1：stdout（fast path）

Sidecar 监听成功后用 **`fs.writeSync(1, ...)` 同步写 fd 1**（不是 `console.log` / `process.stdout.write`，这两个在非 TTY pipe 上是异步缓冲的）：

```ts
const announce = `ENSEMBLE_LISTENING ${boundPort}\n`;
const fs = await import("node:fs");
fs.writeSync(1, announce);  // 同步绕开 Node 流缓冲，直达内核 pipe
```

**约束**：在 `AUTO_PORT=1` 模式下，sidecar 必须把所有日志输出（包括 fastify pino logger）重定向到 **stderr**，stdout 在协议 token 之前不能有任何字节。否则 Tauri 端 `strip_prefix("ENSEMBLE_LISTENING ")` 会失配。

```ts
const fastify = Fastify({
  logger: PRETTY
    ? { transport: { target: "pino-pretty", options: { destination: 2 /* stderr */ } } }
    : { level: "info", stream: AUTO_PORT ? process.stderr : process.stdout },
});
```

#### 通道 2：文件哨兵（backup path）

sidecar listen 成功后**同时**写一个哨兵文件：

```ts
writeFileSync(join(DATA_DIR, ".port"), `${boundPort}\n`, "utf8");
```

Rust 端 setup 时**先**清掉旧哨兵（避免上次崩溃留下的端口被误读），然后起一个 100ms 轮询的 `tokio::spawn` task：

```rust
// setup() 开头
let port_sentinel_path = data_dir.join(".port");
let _ = std::fs::remove_file(&port_sentinel_path);
```

#### Race + shared CAS

两个通道独立工作；任一个先到，shared `AtomicBool::swap(true, AcqRel)` 抢占——返回 false 的赢，调用 `on_sidecar_ready(port)`；返回 true 的（另一通道）静默丢弃。

#### 通道 3：看门狗（fallback）

12 秒看门狗：如果两条通道都没声明，强制 `window.show()` + emit `sidecar-startup-timeout` 事件给前端，至少给用户反馈而不是 ghost app。常见触发原因：macOS Gatekeeper 拦了未签名 sidecar、SEA blob key 注入失败、`ensemble-core` 二进制损坏。

#### `on_sidecar_ready` 做什么

把（一直 `visible: false` 的）主窗口 navigate 到 `http://127.0.0.1:<port>/`，然后 `show()` + `set_focus()`。**在 macOS 上额外**：

```rust
#[cfg(target_os = "macos")]
{
    let _ = window.unminimize();
    let win = window.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = win.show();
        let _ = win.set_focus();
    });
}
```

理由：Tauri 2 在窗口绑 TrayIcon 时有时推断 `ActivationPolicy::Accessory`，单次 `set_focus()` 不足以把 app 拉到前台。`setup()` 里显式 `app.set_activation_policy(ActivationPolicy::Regular)` + 主线程二次 `show()/set_focus()` 是稳定组合。

### 2.3 双形态：sidecar 也可独立运行

`AUTO_PORT` 没设时，sidecar 走原 server-only 路径：监听固定 `WS_PORT ?? 3001`，pino logger 走 stdout，PACKAGED 模式打 banner 提示用户开浏览器。这样 `ensemble-core.exe` 可以脱离 Tauri 单跑（远程访问 / headless server）。

---

## 3. 数据目录

| OS | 路径 |
|---|---|
| Windows | `%APPDATA%\dev.ensemble.app\` |
| macOS | `~/Library/Application Support/dev.ensemble.app/` |
| Linux | `~/.config/dev.ensemble.app/` |

**目录名是 Tauri 的 `identifier`（`dev.ensemble.app`），不是 `productName`** —— 这是 Tauri 默认行为，跟 OS 桌面 app 惯例一致（避免显示名跟存储路径耦合）。

内容：

- `agentorch.db` + `-shm` + `-wal` — SQLite 主库（文件名沿用 AgentUI，不重命名以保兼容）
- 后续可能加：缓存、用户设置、日志等

**不要**改成 `Ensemble/` 这种基于 productName 的路径——那样如果以后改名/重 brand 会丢用户数据。

---

## 4. 构建管线

构建入口：

```
pnpm desktop:build
   ↓
scripts/desktop-build.mjs   ←  按 process.platform 路由
   ├── win32/linux → pnpm desktop:build:tauri → desktop:prep + tauri build
   └── darwin     → tauri build --bundles app   ＋   scripts/macos-dmg.mjs
                    （Tauri 出 .app；DMG 由我们自己两阶段构建以便摆 Finder 图标位）
```

公共 prep（两平台一致）：

```
pnpm desktop:prep
   ├─ pnpm -F @ensemble/desktop-ui build:export   →  desktop-ui/static-out/
   └─ node scripts/prep-sidecar.mjs
        ├─ pnpm -F @ensemble/core package           →  core/dist/ensemble-core(.exe) (SEA)
        └─ copy → src-tauri/binaries/ensemble-core-<target-triple>(.exe)
```

Windows 出包：

```
desktop:build:tauri → cargo build --release
                       ├─ src-tauri/target/release/ensemble.exe
                       └─ Tauri bundler:
                          ├─ /bundle/msi/Ensemble_<v>_x64_en-US.msi
                          └─ /bundle/nsis/Ensemble_<v>_x64-setup.exe
```

macOS 出包（per-arch，不构 universal）：

```
tauri build --bundles app [--target <triple>]
   ├─ src-tauri/target/[<triple>/]release/bundle/macos/Ensemble.app
   │   （含 sidecar 已 codesign，见 §4.5）
   ↓
scripts/macos-dmg.mjs
   ├─ ditto Ensemble.app → 临时 staging 目录
   ├─ symlinkSync('/Applications', stagingDir/Applications)
   ├─ hdiutil create -format UDRW    （读写镜像 → 挂载）
   ├─ osascript                       （Finder 图标视图 + 摆位置 + 设置窗口 bounds）
   ├─ hdiutil detach
   └─ hdiutil convert -format UDZO   （最终压缩 DMG）
       └─ /bundle/dmg/Ensemble_<v>_<arch>.dmg
```

### 4.1 prep-sidecar 必须强制重打

历史教训：旧版 prep-sidecar 用 `existsSync(SRC_EXE)` 检测，存在就跳过 `pnpm package`。结果改了 core 源码后 sidecar 不重打、shell 是新的 → installer 里 shell 新、sidecar 旧，用户看到诡异错误。**已固化为始终 rebuild**，不要再加 `existsSync` 短路。

### 4.2 跨平台 target triple

`prep-sidecar.mjs` 不依赖 rustc 在 PATH 上（PowerShell 装的 rustup 不一定传到 bash），用 Node 的 `process.platform + process.arch` 映射 target triple：

```js
const PLATFORM_MAP = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};
```

可被 `TAURI_TARGET_TRIPLE` env 覆盖，应付特殊场景（如 Apple Silicon 上 cross-build Intel：`TAURI_TARGET_TRIPLE=x86_64-apple-darwin pnpm desktop:build:mac` + `ENSEMBLE_NODE_BIN=<official intel node>`）。

**Cross-build SEA 不可行**：`make-exe.mjs` 拷的是 `process.execPath`（当前平台的 Node 二进制），所以 SEA sidecar 必须在目标平台上构建。`scripts/prep-sidecar.mjs` 在 target arch ≠ process.arch 时会拒绝 build（除非 `ENSEMBLE_NODE_BIN` 指向匹配架构的 Node）。

### 4.3 Tauri bundle.externalBin + bundle.resources

`tauri.conf.json`:

```json
{
  "bundle": {
    "externalBin": ["binaries/ensemble-core"],
    "resources": { "../desktop-ui/static-out": "./web" }
  }
}
```

- `externalBin`：Tauri 把 sidecar binary 打进安装包并放在 main exe 同目录
- `resources`：把 desktop-ui 的 static export 拷成 `<install>/web/`，Rust 通过 `app.path().resource_dir()` 解析

### 4.4 SEA 构建注意

详见 `core/scripts/{bundle,make-exe}.mjs`。两个易踩坑点（已修）：

1. **CJS-only**：SEA 的 V8 code cache 仅 CJS 支持。esbuild output `format: "cjs"`；源码不能有 top-level await（fastify.listen 包在 IIFE 里）
2. **不能用 pino-pretty 的 worker transport**：worker 进程依赖文件路径解析，SEA 包里跑不通。PACKAGED 模式只用 `level: "info"`
3. **macOS 上必须 codesign**：postject 注入 SEA blob 会失活原签名，`make-exe.mjs` 在 darwin 上立刻 `codesign --force --sign $ENSEMBLE_CODESIGN_IDENTITY exe`（无 identity 时退到 `-` ad-hoc）。`macos-dmg.mjs` 再次 deep-sign 整个 `.app`

### 4.5 macOS 签名 + 公证（release-only）

`macos-dmg.mjs` 流程：

1. `sign(Contents/MacOS/ensemble-core, [--options runtime])`
2. `sign(Contents/MacOS/ensemble, [--options runtime])`
3. `sign(Ensemble.app, [--deep, --options runtime])`
4. `codesign --verify --deep --strict --verbose=2 Ensemble.app`
5. （仅 Developer ID identity 时）DMG 本身也 `codesign`

Notarization 在 CI 上手动跑：`xcrun notarytool submit ... --wait && xcrun stapler staple`。详见 [`MAC_DESKTOP_PARITY_GUIDE.md`](./MAC_DESKTOP_PARITY_GUIDE.md) §Signing。

---

## 5. Provider 模型自动发现

### 5.1 链路

```
用户填 baseUrl + apiKey → POST /api/providers (kind=anthropic)
   ↓
点 ↻ → POST /api/providers/:id/refresh-models
   ↓
core 调 probeModels(baseUrl, apiKey)
   ↓
candidateModelsUrls 生成多个候选 URL（按 baseUrl 末尾推断）
   ↓
对每个 URL：fetch GET，带 Anthropic 和 OpenAI 双套 auth header + anthropic-version
   ↓
extractModelIds 容错解析多种 envelope 形状
   ↓
首个非空命中 → 入库 + 返回 {discovered: {count, sourceUrl}}
否则 → 502 + {error, message, tried: [{url, status, bodyHead}]}
```

### 5.2 candidateModelsUrls

```ts
function candidateModelsUrls(base: string): string[] {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return [`${trimmed}/models`];
  if (trimmed.endsWith("/models")) return [trimmed];
  return [`${trimmed}/v1/models`, `${trimmed}/models`];
}
```

例：
- `https://api.minimaxi.com/anthropic` → 试 `/anthropic/v1/models` 和 `/anthropic/models`
- `https://open.bigmodel.cn/api/anthropic` → 同上
- `https://api.example.com/v1` → 只试 `/v1/models`（已经在 `/v1` 下，不重复加）

### 5.3 auth header

同时发 Anthropic 和 OpenAI 两套，无害且覆盖更多上游：

```ts
const headers = {
  "anthropic-version": "2023-06-01",
  "Authorization": `Bearer ${apiKey}`,
  "x-api-key": apiKey,
};
```

### 5.4 extractModelIds 容错

支持 envelope：`data` / `models` / `results` / 裸数组
支持 id 字段：`id` / `name` / `model` / `model_id` / `model_name`
支持元素直接是字符串

新发现的上游形状直接加进 `extractModelIds` 即可，不要在 probeModels 里堆 if-else。

### 5.5 错误诊断

刷新失败时返回的 `tried[]` 数组每项含：
- `url`：试过的 URL
- `status`：HTTP code（0 表示网络错误）
- `bodyHead`：上游响应前 200 字节（200 OK 但解析失败时尤其有用）

前端 `ProviderPanel` 把整个 message + tried 字符串显示在该供应商行下方红色文字。

---

## 6. AgentSettings 模型选择

历史问题：第三方 provider 的 `models[]` 为空时，UI fallback 显示 hardcoded opus/sonnet 列表，用户选了发请求时上游 404，错得莫名其妙。

现规则：

```ts
const isDefaultAnthropic =
  selectedProvider?.kind === "anthropic" && !selectedProvider.baseUrl;

const availableModels =
  selectedProvider?.models.length
    ? selectedProvider.models
    : isDefaultAnthropic
      ? FALLBACK_MODELS  // 只有官方 anthropic-default 才回落
      : [];              // 其他显示「无模型，去刷新」黄色提示
```

---

## 7. 进程生命周期

### 7.1 启动

1. 用户双击 `ensemble.exe` / `Ensemble.app`（或快捷方式 / Launchpad）
2. Tauri Builder.setup hook 跑：
   - macOS 上首先 `app.set_activation_policy(ActivationPolicy::Regular)`
   - `app_data_dir()` 解析路径，`mkdir -p`
   - 清理上一次的 `.port` 哨兵（防止陈旧端口被误读）
   - 决定 `web_root`（dev / prod 分支）
   - spawn sidecar，设 `ENSEMBLE_AUTO_PORT=1` + 上述 env
   - 启 3 个 async task：(a) sidecar stdout/stderr/error/terminated 事件 reader，(b) `.port` 哨兵 100ms 轮询 poller，(c) 12s 看门狗
   - 创建系统托盘
3. Sidecar 启动 → fastify listen 0 → 拿到端口 → `fs.writeSync(1, "ENSEMBLE_LISTENING <port>\n")` **AND** 写 `DATA_DIR/.port`
4. 两条 task 中任一先到的，shared `AtomicBool::swap` 抢占胜方调 `on_sidecar_ready(port)`
5. `on_sidecar_ready` navigate 主窗口（之前 `visible: false`）→ `show()` + `set_focus()` → macOS 再 `run_on_main_thread` 重复一次
6. WebView 加载 `http://127.0.0.1:<port>/` → 静态前端 + WS 连接

### 7.2 关闭

两条路：

- **用户关主窗口**：`on_window_event` 拦 `WindowEvent::CloseRequested` → 找到 `SidecarHandle.0` → `child.kill()`
- **Tauri app 退出**（包括托盘 Quit）：`RunEvent::Exit` 兜底重新尝试 kill

两条路都做的原因：windows close 不一定走 RunEvent::Exit（依平台），双保险防止 sidecar 孤儿。

### 7.3 Sidecar 崩溃

`CommandEvent::Terminated` payload 含 `code` 和 `signal`：

```rust
let _ = app_handle.emit("sidecar-terminated", payload.code);
```

前端可以监听 `sidecar-terminated` 事件做"重启 sidecar"按钮（v1 未做 UI，仅 emit 让 console 看见）。

---

## 8. 与历史前身 AgentUI 的兼容性（仅作迁移参考）

> AgentUI 已于 2026-05-11 停止维护。这一节保留是为了让从 AgentUI 迁过来的用户能直接拷数据库 / 不被命名差异困扰。

| 项 | 状态 |
|---|---|
| WS 协议 (`shared/src/protocol.ts`) | 字字相同，shared 包未改包名 |
| SQLite Schema (`core/src/db.ts`) | 字字相同 |
| API 路径（`/agents`, `/providers`, `/workspaces` 等） | 字字相同 |
| `agentorch.db` 文件 | 二进制兼容，可以手动从 `~/.agentorch/agentorch.db` 拷到 `%APPDATA%\dev.ensemble.app\agentorch.db` |
| `@agentorch/shared` package name | 未改（避免 import 大改） |

**有意识的偏离**（Ensemble 比 AgentUI 改的部分）：

- 数据目录默认值：AgentUI `~/.agentorch/` → Ensemble OS 标准 `%APPDATA%\dev.ensemble.app\`
- 默认端口：AgentUI 固定 3001 → Ensemble sidecar auto-port
- LiteLLM 网关：AgentUI 走 docker → Ensemble 内嵌 `@musistudio/llms` 库 → **W16 Slice 6 整段删除**（双 SDK 原生集成，不再需要翻译层）
- 前端 next dev / `allowedDevOrigins` / rewrites：Ensemble 全去掉（仅 export 模式）
- 品牌字符串、localStorage key 前缀：Ensemble 化

---

## 9. 自动更新（manifest schema + 客户端逻辑）

### 9.1 服务器侧

`ensemble_server` 提供 `GET https://ensemble-ai.cn/v1/version/latest`，返回 `UpdateManifest`（schema 在 `shared/src/update-manifest.ts`）：

```jsonc
{
  "version": "0.0.18",
  "publishedAt": "2026-05-18T06:33:57Z",

  // 0.0.18 起新增：per-platform asset map，新客户端按本平台 key 取
  "platforms": {
    "windows-x64":   { "downloadUrl": "...", "sha256": "...", "sizeBytes": ... },
    "macos-arm64":   { "downloadUrl": "...", "sha256": "...", "sizeBytes": ... },
    "macos-x64":     { "downloadUrl": "...", "sha256": "...", "sizeBytes": ... }
  },

  // 顶级字段保留，给 ≤ 0.0.17 老客户端（永远指向 Windows EXE，那是它们能装的唯一格式）
  "downloadUrl": "https://ensemble-ai.cn/download/releases/Ensemble_0.0.18_x64-setup.exe",
  "sha256": "...",
  "sizeBytes": ...,

  "releaseNotes": "...",
  "mandatory": false,
  "minSupportedVersion": "0.0.1"
}
```

服务器 `ManifestStore.validate()` 校验：
- 顶级字段是 release blockers，缺一个或不合 https / 64-hex / 正整数就拒收整个 manifest
- `platforms` 是可选 map，但**任何**已存在的条目都按同样严格度校验，避免某个 key 拼错给桌面集群发 404
- 加载失败时保持上一次的好 manifest，让 `/v1/version/latest` 仍可用

### 9.2 客户端侧（`desktop-ui/lib/update-check.ts`）

1. `detectPlatformKey()` 用 `navigator.platform` + UA 推断 `${platform}-${arch}` 键
2. `resolveAssetForThisPlatform(manifest)`：
   - 若 `manifest.platforms` 存在且命中本平台 → 用该条目
   - 若 `platforms` 存在但**没有**本平台条目 → 返回 `null`，UI **完全不弹**更新框（这是修「Mac 用户看到 Windows EXE」的关键）
   - 若 `platforms` 不存在（≤ 0.0.17 的 manifest 形状）→ 回退到顶级 `downloadUrl/sha256/sizeBytes`（一律视作 Windows asset）
3. UI 层：`UpdateDialog` 显示 release notes 和 platform-correct URL；若 `openUpgradeUrl()` 抛 Tauri scope 错误，自动复制 URL 到剪贴板 + 渲染 selectable code block 兜底

### 9.3 nginx CORS

桌面端在 webview 里调 `fetch("https://ensemble-ai.cn/v1/version/latest")`，origin 是 `tauri://localhost`（macOS/Linux）或 `http://tauri.localhost`（Windows）——跨域。`ensemble_server/deploy/nginx.conf` 给 `/v1/` 显式返：

```nginx
add_header Access-Control-Allow-Origin "*" always;
add_header Access-Control-Expose-Headers "ETag, Last-Modified" always;
# OPTIONS preflight 直接 nginx 短路 204
if ($request_method = OPTIONS) {
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Content-Type, If-None-Match, If-Modified-Since" always;
    add_header Access-Control-Max-Age 86400 always;
    return 204;
}
```

公开只读 manifest + 零 cookie，`*` 安全。这是服务器侧 fix，**不需要发新客户端**——0.0.14 起的所有版本都因为这条 CORS 改动而能正常拉 manifest。
