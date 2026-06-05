# @ensemble/desktop-ui

Ensemble 桌面前端。Next.js 静态导出，由 Tauri WebView 加载（生产）或由 ensemble-core 的 fastify-static 服务（standalone 调试）。

## Build

```bash
pnpm -F @ensemble/desktop-ui build:export
# 产物：desktop-ui/static-out/
```

## 没有 dev 模式

桌面项目的 dev workflow 是 `pnpm desktop:dev`（在仓库根），它会同时拉起：
- ensemble-core sidecar（auto-port）
- Tauri 窗口加载 sidecar 的 `http://127.0.0.1:<port>/`

如果要单独调试前端，可以临时把 `pnpm -F @ensemble/desktop-ui build:export` 之后让 ensemble-core standalone 服务这份 static-out（默认配置就是这样）。

## 架构注意

- WS / API 客户端通过 `window.location.host` 自动解析端口——不需要硬编码也不需要 `__ENSEMBLE_PORT__` 注入，因为 Tauri 把窗口加载到了同源 sidecar URL
- 不再有 next dev rewrites（生产环境前后端同源）
- 不再有 `allowedDevOrigins`（无远程访问）
