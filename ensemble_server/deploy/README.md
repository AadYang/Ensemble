# ensemble_server — Linux + nginx 部署手册

腾讯云轻量/CVM Ubuntu 22.04 LTS（或 Debian 12）一键蓝本。其它 distro 调整包名即可。

---

## 0. 域名 + 安全组

1. 申请两条 A 记录：
   - `api.<your-domain>` → 服务器公网 IP（版本接口）
   - `dl.<your-domain>` → 同一 IP（安装包下载，便于将来分离 CDN）
2. 腾讯云控制台「安全组」开 **80 / 443**。**禁止**开放 8787（Node 进程只听 loopback）。

---

## 1. 一次性环境准备

```bash
# 系统包
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx curl rsync

# Node 22 LTS（NodeSource 源）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm
sudo npm i -g pnpm@9

# 业务账号 + 目录
sudo useradd --system --create-home --shell /usr/sbin/nologin ensemble
sudo mkdir -p /opt/ensemble-server /var/www/ensemble-dl /var/www/acme
sudo chown -R ensemble:ensemble /opt/ensemble-server /var/www/ensemble-dl
```

## 2. 部署 Node 服务

本地：

```bash
# 在 Ensemble 仓库根目录
pnpm -F @agentorch/shared build
pnpm -F @ensemble/server build

# 同步 dist + package.json + node_modules 到服务器
rsync -avz --delete \
  ensemble_server/dist/ \
  ensemble_server/package.json \
  ensemble_server/manifest.example.json \
  shared/dist/ \
  YOUR_USER@YOUR_HOST:/tmp/ensemble-server-stage/
```

服务器（首次）：

```bash
sudo rsync -a /tmp/ensemble-server-stage/ /opt/ensemble-server/
cd /opt/ensemble-server
sudo -u ensemble pnpm install --prod --frozen-lockfile

# 写第一份 manifest（参考 manifest.example.json，改成真实 URL/sha256/size）
sudo -u ensemble cp manifest.example.json manifest.json
sudo -u ensemble nano manifest.json

# 上 systemd
sudo cp deploy/ensemble-server.service /etc/systemd/system/ensemble-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now ensemble-server
sudo systemctl status ensemble-server  # → active (running)
curl -s http://127.0.0.1:8787/v1/version/latest | head -3
```

## 3. 配置 nginx + TLS

```bash
sudo cp ensemble_server/deploy/nginx.conf /etc/nginx/sites-available/ensemble-api.conf
sudo sed -i 's/api\.example\.com/api.YOUR_DOMAIN/g; s/dl\.example\.com/dl.YOUR_DOMAIN/g' \
  /etc/nginx/sites-available/ensemble-api.conf
sudo ln -sf /etc/nginx/sites-available/ensemble-api.conf /etc/nginx/sites-enabled/

# 先用 HTTP 起来，certbot 才能完成 acme 验证
sudo nginx -t
sudo systemctl reload nginx

# 自动签发并装到 nginx 上
sudo certbot --nginx -d api.YOUR_DOMAIN -d dl.YOUR_DOMAIN \
  --redirect --agree-tos -m you@your-email.com --non-interactive

# 续期 cron 已由 certbot 自动装好；验证一下
sudo certbot renew --dry-run
```

## 4. 发布新版本

每次出新版安装包，按以下流程：

```bash
# A. 算 sha256 + size，更新本地 manifest 模板
sha256sum Ensemble_0.0.2_x64-setup.exe
stat -c %s  Ensemble_0.0.2_x64-setup.exe

# B. 把安装包推到下载机
rsync -avz Ensemble_0.0.2_x64-setup.exe \
  YOUR_USER@YOUR_HOST:/var/www/ensemble-dl/releases/

# C. 更新 manifest（服务端自动热加载，无需重启）
ssh YOUR_USER@YOUR_HOST 'sudo -u ensemble nano /opt/ensemble-server/manifest.json'
# schemaVersion=2 时优先更新 platforms.<platformKey> 下的
# version / publishedAt / downloadUrl / sha256 / sizeBytes / releaseNotes /
# mandatory / minSupportedVersion。顶层 version/downloadUrl 保留给旧客户端。

# D. 验证
curl -s https://api.YOUR_DOMAIN/v1/version/latest | jq .
```

## 5. 客户端集成（待办，本次不实现）

桌面端启动后或定时调用：

```
GET https://api.YOUR_DOMAIN/v1/version/latest
```

得到 `UpdateManifest`（schema 在 `shared/src/update-manifest.ts`，前后端共用类型）。客户端逻辑：

1. 新客户端先按当前 `platformKey` 读取 `platforms[platformKey]`，并比较该平台自己的 `version / minSupportedVersion / mandatory`
2. 若当前平台没有 asset → 视为“本平台暂无更新”，不要回退到其他平台下载链接
3. 若 `current < minSupportedVersion` 或 `mandatory && current < version` → 强制提示 + 阻止继续使用
4. 若 `current < version` → 顶部小红点 / 设置里提醒，点击下载当前平台的 `downloadUrl`
5. 下载完成后客户端 SHOULD 校验 sha256，匹配再执行 installer

## 6. 监控（最小）

```bash
# 实时日志
sudo journalctl -u ensemble-server -f

# nginx 访问日志（看更新接口被请求多频繁）
sudo tail -f /var/log/nginx/access.log | grep '/v1/version/'
```

后续可加 healthcheck 探活 → 阿里云监控 / Prometheus + node_exporter / 第三方 uptime 监控。

---

## 端口/路径速查

| 角色 | 监听 | 备注 |
|---|---|---|
| ensemble_server (Node) | 127.0.0.1:8787 | 安全组**不要**开 |
| nginx HTTPS | 0.0.0.0:443 | 反代 + 静态分发 |
| nginx HTTP | 0.0.0.0:80 | 仅 ACME + 301 |
| manifest 文件 | /opt/ensemble-server/manifest.json | 修改自动热加载 |
| installer 静态根 | /var/www/ensemble-dl/releases/ | nginx 直出 |
