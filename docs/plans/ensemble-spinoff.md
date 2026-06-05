# Ensemble — 派生独立桌面端项目（W15 提案）

> **状态**：✅ **v1 已实施**（2026-05-10）。本文档保留作设计溯源；实施现状去看 `D:\WorkSpace\Ensemble\docs\architecture.md` + `D:\WorkSpace\Ensemble\docs\plans\development-log.md`。
> **目标**：在 `D:\WorkSpace\Ensemble` 新建一个**完全独立的桌面端项目**，从一开始就按桌面 app 思路设计，不沿用「EXE 起 server + 浏览器访问」过渡形态。
> **AgentUI 不动**：当前仓库继续作为 web-first / 自托管 / EXE 形态存在；两个项目并行演进，目标用户群不同。
>
> **品牌**：
>   - **名称**：Ensemble
>   - **Slogan**：**Many minds. One workspace.**（中文：**群智，一席。**）
>   - **定位**：跨平台桌面级 multi-agent AI 工作台。专为「指挥多个 AI 协作完成复杂任务」而生。
>
> **实施偏离记录**（与原设计不同的地方）：
> - **autoManaged + LiteLLM gateway UI 保留**：原计划 v1 砍掉 OpenAI-compat 相关 UI，实际只是隐藏 OpenAI-compat 直连路径（无 musistudio 翻译会让 SDK 协议不匹配），autoManaged 入口保留作以后深度开发
> - **prep-sidecar 强制每次 rebuild**：原 design §5.5 没考虑增量；实际遇到「shell 新 sidecar 旧」混搭包后改成 `pnpm package` 强制
> - **stdout 协议方案修正**：原 design §6 说"sidecar 启动时打印 ENSEMBLE_LISTENING 在 stdout 第一行"，实际还需要 fastify pino logger 强制走 stderr，否则 stdout 第一行被日志占
> - **数据目录用 identifier 不用 productName**：原 design §3 写 `%APPDATA%\Ensemble\`，实际是 Tauri 默认 `%APPDATA%\dev.ensemble.app\`（OS 桌面 app 惯例 + 防止改名/重 brand 丢数据）
> - **provider 模型解析容错**：原 design 没覆盖；实际增加 `extractModelIds` 支持多种 envelope（data / models / results / 裸数组）+ 多种 id 字段
> - **AgentSettings 不假回落**：原 design 没明确；实际把第三方 provider 空 models 列表的 fallback 取消，避免用户选中模型上游 404 的隐蔽错
> - **stage 5.12 原生文件对话框**：未实施，优先级低，留 backlog
> - **跨平台 v1 范围**：仅 Windows（v1 实测）；macOS/Linux build 留待用户授权

---

## 1. 为什么拆而不是改

把现有 AgentUI 直接 Tauri 化的方案有三个问题：

1. **架构包袱**：AgentUI 当前的"server + 浏览器同源"形态在 Tauri 里仍能跑，但很多设计（path/api 前缀剥离、CORS / `allowedDevOrigins`、SPA fallback）是为浏览器形态做的，桌面 app 里是死代码。日后维护负担。
2. **用户群分裂**：AgentUI 的核心用户已经习惯了「跑 EXE → 浏览器开 :3001 → 远程隧道访问」流程，把它替成桌面窗口会割裂老用户体验。
3. **品牌包袱**：「AgentUI」名字偏内部工具感，限制了产品级形态的天花板。

**采纳方案**：保留 AgentUI 当作开源参考实现 / 自托管引擎；Ensemble 作为产品级桌面 app **新仓库**起手。两者通过 **共享 npm 包**（`@agentorch/shared` 已有，未来可再抽 `@agentorch/agent-core`）保持类型与协议一致，但 UI / 应用形态各自独立演进。

| | AgentUI (本仓库) | Ensemble (新仓库) |
|---|---|---|
| 目标用户 | 开发者、自托管爱好者、远程访问场景 | 桌面端最终用户（仍偏开发者，但要求"开箱即用、好看"） |
| 形态 | 单文件 EXE 起 server，浏览器是 UI | 真正桌面 app（Tauri 2.x），无浏览器 chrome |
| 部署 | 单 exe，可远程隧道暴露 | `.msi` / `.dmg` / `.deb` 安装包 |
| 持久化 | `~/.agentorch/` | `%APPDATA%\Ensemble\`（OS 标准路径） |
| 数据隐私 | 本地 SQLite | 本地 SQLite（同样 local-first） |
| 多 workspace | 单实例 + workspace 切换 | 同上，但日后可加「项目库」概念 |

## 2. 新项目目录结构（建议）

```
D:\WorkSpace\Ensemble\
├── package.json                # workspace root (pnpm)
├── pnpm-workspace.yaml
├── README.md
├── CLAUDE.md                   # 项目自己的协作准则
├── docs/
│   ├── architecture.md
│   └── plans/
├── src-tauri/                  # Tauri Rust 外壳
│   ├── tauri.conf.json
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs             # 启动 sidecar、注入端口、托盘
│       └── sidecar.rs          # 子进程生命周期管理
├── desktop-ui/                 # 前端（基于 AgentUI/web 演进）
│   ├── package.json
│   ├── next.config.ts          # 仅 export 模式，无 dev server 需求
│   ├── app/ ... components/ ... lib/ ... hooks/ ...
│   └── tauri/                  # Tauri 专属 hook（IPC、原生菜单、文件对话框）
└── core/                       # 后端服务（基于 AgentUI/server 演进）
    ├── package.json
    ├── src/
    │   ├── index.ts            # Fastify entry，作为 sidecar 跑
    │   ├── sessions/ db/ peer-mcp/ ...  # 大部分代码可直接搬
    │   └── desktop/            # Tauri 集成：appDataDir 路径解析、IPC bridge
    └── scripts/
```

> **是否把 AgentUI 的代码物理拷贝过来？**
> **建议第一步直接 git clone + 改造**，比从 0 写要快 5–10 倍。第二阶段再考虑把通用部分抽到独立 npm 包（`@agentorch/agent-core`）让两个仓库共享。**v1 不做包抽离**——避免过早抽象。

## 3. 关键架构决策

| 维度 | 否决方案 | 采纳方案 | 理由 |
|---|---|---|---|
| 桌面框架 | Electron | **Tauri 2.x** | Tauri shell ~5MB（系统 WebView2）vs Electron ~200MB；启动快、内存低；产品级 polish 体验更好 |
| 后端集成 | Tauri commands 桥接（前后端走 IPC） | **Sidecar binary**：现有 server 几乎不动，作为子进程拉起 | 现有 SDK 集成、SQLite、musistudio、peer_send 全部 0 修改；Rust 侧只是窗口外壳 |
| 静态前端加载 | file:// + Tauri commands | **走 sidecar 的 fastify 静态服务**（同源 http://127.0.0.1:port） | 同源策略 + WS / fetch 路径不变；前端代码 99% 复用 |
| 端口分配 | 固定 3001 | **sidecar 自选可用端口**，stdout 第一行打印给 Tauri 父进程 | 多开 / 与已运行实例不冲突 |
| 数据目录 | 复用 `~/.agentorch/` | **`%APPDATA%\Ensemble\`** via Tauri `appDataDir()` | 符合 OS 桌面 app 惯例；与 AgentUI 数据互不干扰 |
| 与 AgentUI 代码共享 | git submodule | **第一版直接拷贝 + 改造**；v2 再考虑 npm 包抽离 | 避免过早抽象 |
| 系统集成 | 仅窗口 | 系统托盘 + 原生菜单 + 文件对话框 + 启动 splash | 桌面 app 标配 |
| 自动更新 | v1 不做 | v2 用 Tauri `tauri-plugin-updater` | v1 用户手动下载新版 |

## 4. 与 AgentUI 的关系（重要）

- **代码层面**：v1 直接 fork，独立演进。两者**不互相依赖**。
- **协议层面**：保持兼容（同样的 WS protocol、Provider schema）。如果用户在 AgentUI 配过的 SQLite 库手动拷到 Ensemble 数据目录，应该能直接读（除迁移期间的 schema 差异）。
- **品牌层面**：完全分离。Ensemble 不在文档 / UI 里提 AgentUI；Ensemble 在 README 里可以说「inspired by」。
- **维护策略**：AgentUI 修了的 bug，由开发者**有意识地 cherry-pick** 到 Ensemble，不自动同步——避免迁就老形态拖累新形态。
- **演进期望**：3-6 个月后 Ensemble 可能与 AgentUI 出现明显分歧（原生菜单 / 文件系统集成 / 多窗口 / 项目库等）。这是预期的、健康的。

## 5. 实施切片（v1 第一版交付目标）

| 阶段 | 工作 | 关键产出 | 时长 |
|---|---|---|---|
| 5.1 | 项目脚手架 | 创建 `D:\WorkSpace\Ensemble`，pnpm init，加 `desktop-ui/` `core/` `src-tauri/` 三个工作区；CLAUDE.md / README.md 起手稿 | 2 h |
| 5.2 | 拷贝 + 改造 core | 从 AgentUI/server 拷代码；改 `paths.ts` 用 `AGENTORCH_DATA_DIR` env 优先；移除 `/api` prefix strip 钩子（不再需要双兼容）；server 名字从 agentorch-server 改 ensemble-core | 半天 |
| 5.3 | 拷贝 + 改造 desktop-ui | 从 AgentUI/web 拷代码；移除 next dev rewrites（生产 only）；移除 `allowedDevOrigins`；把品牌字符串 i18n key 替为「Ensemble」；调整 favicon / app icon | 半天 |
| 5.4 | Tauri 项目初始化 | `pnpm tauri init`，配置基础 `tauri.conf.json`：window 标题 / icon / 默认尺寸；产品名 = Ensemble | 2 h |
| 5.5 | Sidecar 集成 | 把 core 打 SEA exe → 注册进 `tauri.conf.json` `bundle.externalBin`；Rust 侧 `Command::new(...).env(...).stdout(piped()).spawn()` | 2 h |
| 5.6 | 端口动态分配 | core 启动时 `AGENTORCH_AUTO_PORT=1` → `port: 0`；监听后打印 `ENSEMBLE_LISTENING <port>`；Rust 父进程读 stdout 第一行解析；window create 时 `eval` 注入 `window.__ENSEMBLE_PORT__` | 半天 |
| 5.7 | 主窗口 + 前端连接 | desktop-ui 的 ws.ts / api 客户端读 `__ENSEMBLE_PORT__` 优先 | 2 h |
| 5.8 | 数据目录适配 | core paths.ts 在 PACKAGED 模式优先读 `AGENTORCH_DATA_DIR`（Tauri 注入 `appDataDir()`） | 1 h |
| 5.9 | 生命周期 | Tauri window close → SIGTERM sidecar → wait exit；崩溃时 sidecar 也死 | 半天 |
| 5.10 | 系统托盘 | 托盘图标 + 菜单（显示 / 退出） | 2 h |
| 5.11 | 打包链路 | `pnpm desktop:build` → `tauri build` 出 `.msi`（Windows） | 半天 |
| 5.12 | （可选 v1+） | 原生文件对话框替换 portal modal；macOS / Linux build | 后置 |

**核心 5.1–5.11 大约 2.5–3 个工作日**。

## 6. 端口分配方案细节

> 与原 W15 方案一致，迁到 Ensemble 后 env 变量名前缀改为 `ENSEMBLE_*`，stdout 标记字符串改为 `ENSEMBLE_LISTENING <port>`。

实现：

1. core `index.ts` 读 `process.env.AGENTORCH_AUTO_PORT`（保留兼容）或 `ENSEMBLE_AUTO_PORT`：
   - `=== "1"` → `fastify.listen({ port: 0, host: "127.0.0.1" })`，监听后 `console.log("ENSEMBLE_LISTENING " + port)` 到 stdout 第一行
   - 否则维持现有 `WS_PORT ?? 3001` 行为，打 banner（保留 server-only 单独启动用法）
2. Tauri Rust 侧：
   ```rust
   let mut child = Command::new(sidecar_path)
       .env("ENSEMBLE_AUTO_PORT", "1")
       .env("AGENTORCH_DATA_DIR", app.path().app_data_dir().unwrap())
       .stdout(Stdio::piped())
       .spawn()?;
   let stdout = child.stdout.take().unwrap();
   let mut reader = BufReader::new(stdout);
   let mut line = String::new();
   reader.read_line(&mut line)?;
   let port: u16 = line.trim().strip_prefix("ENSEMBLE_LISTENING ").unwrap().parse()?;
   ```
3. window create 时通过 `WebviewWindowBuilder::initialization_script(format!("window.__ENSEMBLE_PORT__={};", port))` 注入
4. desktop-ui 的 base URL 读取顺序：
   - `window.__ENSEMBLE_PORT__` → `http://127.0.0.1:${port}`
   - 否则 `window.location.host`（容错）

## 7. 显式不做（避免范围蔓延）

- **不做** Rust 重写后端（Tauri 只是窗口外壳，不是新后端）
- **不做** Tauri commands 桥（前端不通过 IPC 调 Rust，全部走现有 HTTP/WS）
- **不做** 自动更新（v1 用户手动下载新版；v2 加 tauri-plugin-updater）
- **不做** 多窗口（一个 app 一个窗口；workspace 切换走现有机制）
- **不做** 卸载时清理用户数据（用户数据归用户所有）
- **不做** 把 AgentUI 与 Ensemble 立刻通过 npm 包关联（先各自演进，v2 再考虑抽离）

## 8. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| Rust toolchain 引入（团队没人熟） | sidecar 模式下 Rust 代码 ~50–100 行，仅胶水层；不写业务逻辑 |
| 前端代码两份维护 | v1 接受；v2 抽 `@ensemble/ui` 共享组件包（如有动力） |
| Windows WebView2 依赖（用户没装 Edge） | Tauri 安装器可勾选自动安装 WebView2 runtime；Win11 默认带 |
| sidecar exit 时主窗口未关 | 监听 sidecar exit → 主窗口报错并提供「重启 sidecar」按钮 |
| 端口动态分配下用户想从外部 curl 测 API | 启动时把 port 写入 `%APPDATA%\Ensemble\port.lock`，用户可读（dev 调试用） |
| Tauri 安装器签名（Windows SmartScreen / macOS Gatekeeper） | v1 出未签名版（接受 SmartScreen 警告）；v2 走签名链 |
| `claude` CLI 不在 PATH 时 | sidecar 启动时探测；缺失则前端弹首屏引导（含 OAuth 登录链路 + 「自动安装 Claude Code」按钮） |
| 命名冲突 | "Ensemble" 在 ML/AI 领域有同名概念（ensemble learning），但用作产品名相对干净；商标查 USPTO + 国内域名 ensemble.app / ensemble.dev / ensemble.ai 实施前确认 |

## 9. 验收标准

- [ ] `D:\WorkSpace\Ensemble` 项目存在，独立 git repo
- [ ] `pnpm desktop:dev` 一键启动 Tauri dev mode，主窗口可见，sidecar 自动起，标题栏 = "Ensemble"
- [ ] 主窗口无浏览器 chrome / 地址栏
- [ ] 创建 agent / 发消息 / 流式响应 / cancel / 持久化 全部与 AgentUI EXE 版一致
- [ ] 关闭主窗口 → sidecar 进程退出（无孤儿）
- [ ] 系统托盘有 Ensemble icon + 菜单
- [ ] `pnpm desktop:build` 产出 `.msi`（Windows）；安装到全新机器后双击可启动
- [ ] 数据写到 `%APPDATA%\Ensemble\agentorch.db`（DB 文件名暂沿用，避免迁移踩坑）
- [ ] 同时启动两个 Ensemble 实例不冲突（端口动态分配证据）
- [ ] AgentUI 仓库本次 zero 改动验证（用 `git status` 确认）
- [ ] `pnpm typecheck` 全 workspace 通过

## 10. 实施前需要再决定的点

1. **品牌确认**：Ensemble 名 + Slogan 是否最终敲定（域名 ensemble.dev / ensemble.app / ensemble.ai 商标查后再定）
2. **macOS / Linux 是否 v1 就出**：v1 仅 Windows 还是同时三平台？同时三平台测试成本翻倍但 Tauri build 命令一致
3. **签名证书**：v1 接受未签名 + SmartScreen 警告；后期是否走 EV 证书（年费 ~3000 RMB）
4. **托盘策略**：关闭主窗口是否最小化到托盘（Slack 风格）还是直接退出（Notepad 风格）。倾向**直接退出**——用户随时启动，sidecar 不该常驻
5. **icon / 视觉**：v1 用临时 icon 占位（Tauri 默认 / 简单生成）；正式版需要请人设计
6. **AgentUI 维护承诺**：派生后 AgentUI 更新到什么程度——继续修 bug 还是冻结？建议「持续修 bug，不主动加新 feature」

## 11. 与 W14 (Subagent 推荐) 的关系

W14 设计目前在 AgentUI 仓库下。派生后：

- W14 实施时可同时落地两边（共用 prompt + 目录数据）
- 或先在 Ensemble 实施，AgentUI 后置（Ensemble 是产品旗舰，先上 feature 合理）
- **建议**：W15 完成后再实施 W14，避免在两个项目并行时增加协调成本

## 12. 演进愿景（不属于 v1，仅记录）

- **v1.5**：原生菜单（File / Edit / View / Window / Help）；macOS 多窗口
- **v2**：项目库——多个 sqlite 数据库，对应不同项目 / 客户 / 沙箱
- **v2**：自动更新
- **v2.5**：插件市场（让社区注册自定义 MCP server / agent 模板）
- **v3**：协作模式——同一个项目库可被多设备同步（基于 git / cloud sync，仍是 local-first）

---

## 附：参考实现资料

- Tauri 2.x sidecar 文档：<https://v2.tauri.app/develop/sidecar/>
- Tauri 2.x window initialization_script：<https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html>
- Node SEA + Tauri sidecar 完整示例：<https://github.com/tauri-apps/awesome-tauri> (sidecar 类目)
- Tauri appDataDir API：<https://v2.tauri.app/reference/javascript/api/namespacepath/#appdatadir>
