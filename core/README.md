# @ensemble/core

Ensemble 的后端 sidecar 服务。

🟡 **待 stage 5.2 从 `D:\WorkSpace\AgentUI\server` fork**。

## 与 AgentUI/server 的差异（计划）

- 移除 `/api` prefix strip 钩子（同源同端口，不需要双兼容）
- 移除 `allowedDevOrigins`（无远程访问场景）
- 启动 banner 改为 Ensemble 品牌
- 端口默认从 stdout 协议读（`ENSEMBLE_AUTO_PORT=1`）
- 数据目录优先读 `AGENTORCH_DATA_DIR` env（由 Tauri 注入 `appDataDir()`）
- SQLite 文件名暂沿用 `agentorch.db`，避免迁移踩坑
