# Ensemble Postoffice

客户端无关的远程信箱 MCP。Claude Code、Codex、Cursor、DSH、Ensemble 只要能连 HTTP MCP，就能用通讯码互通文字和附件。

- 实施文档：[`docs/plans/ensemble-postoffice.md`](../docs/plans/ensemble-postoffice.md)
- 产品方案：[`docs/plans/remote-peer-mcp.html`](../docs/plans/remote-peer-mcp.html)

```
ensemble-postoffice/
  mcp/        # Fastify + sqlite + MCP
  website/    # 静态配置站（由 mcp 托管）
  deploy/     # systemd + nginx
  scripts/deploy.sh
```

本地：

```bash
cd mcp
pnpm install
pnpm dev
```

默认 http://127.0.0.1:8790/ 。邀请码 `redtea-yzr`。

现网：https://www.ensemble-ai.cn/postoffice/
