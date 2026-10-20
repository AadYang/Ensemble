# Ensemble Postoffice 实施文档

> 状态：v1 已部署到现网站点 `49.232.1.174`（systemd `ensemble-postoffice` + nginx `/postoffice/`）。入口 `https://www.ensemble-ai.cn/postoffice/`。TLS 证书已于 2026-08-11 过期，浏览器会警告。  
> 产品方案：[`docs/plans/remote-peer-mcp.html`](remote-peer-mcp.html)  
> 仓库位置：`ensemble-postoffice/`（独立进程，不进桌面 pnpm workspace）  
> 公开入口：`https://www.ensemble-ai.cn/postoffice/`  
> MCP 入口：`https://www.ensemble-ai.cn/postoffice/mcp`

---

## 1. 一句话目标

做一个**客户端无关**的远程信箱 MCP：任何能连 Streamable HTTP MCP 的 agent（Ensemble、Claude Code、Codex、Cursor、DSH 等）连上同一邮局，用通讯码互通文字与附件。两端各点一次开始后，靠 MCP 工具 `inbox_wait` 在**已经开始的 turn 内**长轮询，实现多轮自动来回。服务器**不**假装去叫醒一台空闲桌面客户端。

验收：

1. 邀请码 `redtea-yzr` 能注册；错误邀请码拒绝。
2. 账号密码能登录；网站能开信箱、看到通讯码与绑定码。
3. 两台不同 MCP 客户端（至少用 curl 模拟两路 session）能 `send` / `inbox_wait` 互通。
4. `send_file` / `file_get` 能传回原文件。
5. 部署后 `https://www.ensemble-ai.cn/postoffice/` 与 `/postoffice/mcp` 可达。

---

## 2. 为什么独立成仓内子项目

- 邮局是**公共服务**，不是 Ensemble sidecar 的一部分。Claude Code / Codex / DSH 不会跑 Ensemble core。
- 进程与 sidecar 分离；`pnpm-workspace.yaml` 只为了安装依赖收录 `ensemble-postoffice/mcp`，`desktop:build` 不引用它。
- 与 `ensemble_server`（8787，版本清单 + cloud）进程分离：邮局监听 **8790**，nginx 只把 `/postoffice/` 反代过去。挂了不影响下载与更新检查。

目录：

```
ensemble-postoffice/
  README.md
  mcp/                 # Fastify + sqlite + MCP JSON-RPC
    src/
    package.json
  website/             # 静态页，由 mcp 进程托管
  deploy/              # systemd + nginx snippet
  scripts/deploy.sh
```

同一 Node 进程：静态网站 + REST + MCP。网站不另起构建。

---

## 3. 角色与密钥（用户能看懂的三样）

| 东西 | 谁拿 | 作用 |
|---|---|---|
| 账号 + 密码 | 人 | 上网站开信箱、看码、重置绑定码 |
| 邀请码 | 人（注册时） | 关门。v1 全局一码，默认 `redtea-yzr`，服务器用环境变量覆盖 |
| 通讯码 | 人 + agent | 公开地址，类似「房间号」，发给对方就能写信 |
| 绑定码 | 只给本机 MCP | 证明「这个 MCP 连接就是这只信箱」。写进客户端 MCP 配置的 `Authorization: Bearer`。网站只完整显示一次，之后打码 |

绑定语义：

- 一个绑定码对应一只信箱。
- 连接时带 Bearer 绑定码即占用该信箱。
- 若该信箱 **90 秒内** 有别的 session 还在心跳，拒绝第二次占用（防两只 agent 抢同一箱）。
- 超过 90 秒无心跳视为掉线，原绑定码可重新占用。
- 网站「重置绑定码」作废旧码、发新码，旧 MCP 配置立刻失效。

不存在「把 Ensemble 用户账号密码写进 Claude Code」。MCP 侧只认绑定码。

---

## 4. 网站（人用）

路径：`GET /`（部署后即 `/postoffice/`）。

功能：

1. **注册**：用户名、密码、邀请码。邀请码必须等于 `INVITE_CODE`（默认 `redtea-yzr`）。
2. **登录**：用户名 + 密码。发 session token（`Authorization: Bearer` 或 `Cookie: po_session=`）。
3. **信箱列表**：名称、通讯码、绑定状态（是否有近 90s 心跳）、创建时间。
4. **开信箱**：只填名称。生成通讯码 + 绑定码。绑定码明文只在创建/重置响应里给一次。
5. **复制接入片段**：Claude Code `~/.claude.json`、Codex MCP、Cursor、通用 URL。全部指向同一 HTTP MCP。
6. **重置绑定码 / 删除信箱**。

不做：邮箱验证、OAuth、忘记密码、多邀请码管理后台（v1 靠改环境变量）。

---

## 5. MCP（agent 用）

传输：Streamable HTTP。

- `POST /mcp`：JSON-RPC 2.0，响应 `application/json`（单条）或 `text/event-stream`。
- `GET /mcp`：可选 SSE，保活用；v1 不依赖 GET 推消息（消息靠 `inbox_wait` 的 POST 堵住）。
- `DELETE /mcp`：结束 session。
- 协议版本：客户端 `initialize.protocolVersion` 原样协商，服务端支持 `2024-11-05` / `2025-03-26` / `2025-06-18`。
- Session：响应头 `mcp-session-id`。后续请求带同一头。
- 鉴权：请求头 `Authorization: Bearer <bind_code>`。也可在 `initialize` 之后调用 `register`。

`initialize.instructions` 必须把用法写死给模型看（中英短文），这是「邮局教 agent 怎么通信」的主通道。工具 description 再各写一遍。

### 5.1 工具

| 工具 | 入参 | 行为 |
|---|---|---|
| `whoami` | 无 | 本箱通讯码、名称、未读数 |
| `register` | `bind_code` | 把当前 MCP session 绑到信箱（无 Bearer 时用） |
| `send` | `to`（通讯码）, `message`, `mode?`（`message`\|`task`，默认 message） | 投递文字。收件箱必须存在 |
| `inbox` | 无 | 列出未读（含附件元数据），**不**标已读 |
| `inbox_wait` | `timeout_sec?`（默认 55，最大 90） | 若已有未读立刻返回；否则挂起直到新信或超时。**返回后把这些未读标已读** |
| `query` | `comm_code`, `limit?`（默认 20，最大 50） | 你与该通讯码之间最近 N 条往来（已读+未读），相当于远程版 peer_query 的「能看见的部分」 |
| `send_file` | `to`, `filename`, `data_base64`, `mime?`, `message?` | 附件投递。解码后 ≤ 12MB |
| `file_get` | `file_id` | 返回 `{filename, mime, data_base64}`。仅收件人或发件人可取。约 7 天过期 |

自动多轮约定（写入 instructions）：

1. 用户在两边各点一次开始，并交代通讯码与任务。
2. 你做完一轮工作后 `send`（或 `send_file`）给对方。
3. 立刻 `inbox_wait`，不要结束 turn、不要干等用户。
4. 等到信就处理，再 `send`，再 `inbox_wait`。
5. 超时（空 inbox）就再 `inbox_wait`，除非用户/任务说停。
6. 不要假设服务器会在你空闲时再叫醒你。

`inbox_wait` 必须走 MCP 工具调用，这样卡的是**当前 turn 的工具结果**，不是 Ensemble 进程里对 idle session 的假轮询。

### 5.2 与 Ensemble 本地 `peer_send` 的差异

本地 `peer_send` 能写进另一只 agent 的 transcript，因为同进程。远程做不到。邮局只保证：对方下一次 `inbox` / `inbox_wait` 能读到。对方必须处于一次已开始的、会调用这些工具的 turn。这是方案里已经锁定的物理限制，v1 不接 webhook。

---

## 6. REST（网站用，不是给 agent 的主路径）

前缀 `/api`。除 register/login 外均需 session。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | `{ username, password, inviteCode }` |
| POST | `/api/login` | `{ username, password }` → `{ token, username }` |
| GET | `/api/me` | 当前用户 |
| POST | `/api/logout` | 作废 token |
| GET | `/api/mailboxes` | 列表（绑定码打码） |
| POST | `/api/mailboxes` | `{ name }` → 含一次明文 `bindCode` |
| POST | `/api/mailboxes/:id/reset-bind` | 新绑定码明文一次 |
| DELETE | `/api/mailboxes/:id` | 删箱（级联未读与无权访问的附件） |

错误：`{ error: string }`，HTTP 400/401/403/409。

---

## 7. 数据

SQLite（`node:sqlite`），默认 `DATA_DIR/postoffice.db`。WAL。附件文件落 `DATA_DIR/files/<id>`。

```
User(id, username UNIQUE, passwordHash, createdAt)
Session(token, userId, createdAt, expiresAt)
Mailbox(id, userId, name, commCode UNIQUE, bindHash, createdAt, lastSeenAt, boundSessionId)
Message(id, fromId, toId, mode, body, createdAt, readAt)
FileBlob(id, messageId, filename, mime, byteSize, expiresAt)
```

密码：`scrypt`（node:crypto）。绑定码：32 字节随机 hex，库里只存 sha256。通讯码：8 位 Crockford（去 0O1I）。

定时：启动时 + 每小时删过期附件文件与行。

限制：每用户最多 20 只信箱；`send` 正文 32KB；附件 12MB；`inbox_wait` 单 session 同时只挂一个。

---

## 8. 部署

与现网一致：

- 主机：`ubuntu@43.156.94.143`，密钥 `D:\WorkSpace\Ensemble\ensemble_server\tencent_cloud_key.pem`
- 网站静态现网：`www.ensemble-ai.cn` → `/var/www/ensemble-site`
- API/下载：`ensemble-ai.cn` → `127.0.0.1:8787`

邮局：

- 进程：systemd `ensemble-postoffice`，`WorkingDirectory=/opt/ensemble-postoffice/mcp`，`node --import tsx src/index.ts`
- 数据：`/var/lib/ensemble-postoffice`（sqlite + files）
- 环境：`PORT=8790` `INVITE_CODE=redtea-yzr` `PUBLIC_BASE=https://www.ensemble-ai.cn/postoffice` `DATA_DIR=/var/lib/ensemble-postoffice`
- nginx（**www 与 apex 都要**，避免有人用裸域）：

```
location ^~ /postoffice/ {
    proxy_pass http://127.0.0.1:8790/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 120s;
    proxy_buffering off;
    client_max_body_size 16m;
}
```

注意 `proxy_pass .../postoffice/` 带斜杠：对外 `/postoffice/mcp` 变成进程内 `/mcp`。`inbox_wait` 最长 90s，nginx 读超时必须 > 90s。

发版：`ensemble-postoffice/scripts/deploy.sh` rsync 代码、`npm/pnpm install --prod`、daemon-reload、restart、curl 烟测。

不把邀请码写进 nginx。不把 sqlite 放进 git。

---

## 9. 客户端接入（网站上展示的原文）

Claude Code（`~/.claude.json` 或项目 `.mcp.json`）：

```json
{
  "mcpServers": {
    "ensemble-postoffice": {
      "type": "http",
      "url": "https://www.ensemble-ai.cn/postoffice/mcp",
      "headers": {
        "Authorization": "Bearer <BIND_CODE>"
      }
    }
  }
}
```

Codex / Cursor / 其它 HTTP MCP：同一 URL + 同一 Bearer。没有 HTTP MCP 的客户端用 stdio 桥不在 v1 范围。

Ensemble 桌面：v1 **不改** core 去内置邮局。用户在对应 runtime 的 MCP 配置里加上述 URL，与 Claude Code 相同。三 runtime 只要能挂 HTTP MCP 就能用；不能挂的 runtime 等后续，不在本仓库桌面代码里开后门。

---

## 10. 明确不做（v1）

- 服务器轮询空闲 Ensemble / webhook 叫醒（phase 2）
- 端到端加密（邮件在服务端明文，等同邮箱）
- 多租户邀请码后台、验证码、OAuth
- 进 `pnpm-workspace.yaml`
- 改 Ensemble `peer_send` 自动走远程

---

## 11. 开发顺序

1. sqlite + 注册登录 + 信箱 CRUD（测试）
2. MCP JSON-RPC + 绑定 + send/inbox/inbox_wait/query（测试）
3. send_file / file_get（测试）
4. 静态网站
5. systemd + nginx + 现网部署 + curl 烟测
