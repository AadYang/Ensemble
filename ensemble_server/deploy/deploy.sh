#!/usr/bin/env bash
# One-shot deploy to the Tencent server. Idempotent — safe to re-run.
#
# Pre-reqs on local: bash, pnpm, ssh, tar, openssl. (rsync not required —
# we pipe a tarball over ssh so this runs from plain Git Bash on Windows.)
# Pre-reqs on remote: just SSH access for `ubuntu` with the configured key.
#
# What this does:
#   1. Builds @ensemble/server locally (tsc) + bundles dependencies.
#   2. Provisions Ubuntu: Node 22, nginx, system user `ensemble`.
#   3. Rsyncs code + TLS cert + nginx vhost + systemd unit.
#   4. Reloads systemd + nginx.
#   5. Smoke-tests the public HTTPS endpoint.

set -euo pipefail

# ─── Config (only edit ip/host/email if they change) ─────────────────────────
SSH_USER="ubuntu"
SSH_HOST="43.156.94.143"
SSH_KEY="$(cd "$(dirname "$0")/.." && pwd)/tencent_cloud_key.pem"
# Apex hosts the backend (API + downloads). www hosts the website (separate
# placeholder vhost). Both share the same TLS cert.
API_HOST="ensemble-ai.cn"
SITE_HOST="www.ensemble-ai.cn"
SERVER_DIR="/opt/ensemble-server"
DL_DIR="/var/www/ensemble-dl/download"
CERT_DIR="/etc/nginx/ssl/ensemble-ai"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCAL_PKG="$REPO_ROOT/ensemble_server"
CERT_SRC="$LOCAL_PKG/ensemble-ai.cn_nginx"
SECRETS_FILE="$LOCAL_PKG/.env.production"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -i "$SSH_KEY")
SSH_TARGET="$SSH_USER@$SSH_HOST"

say() { printf '\n\033[36m[deploy]\033[0m %s\n' "$*"; }

# Generate or load persistent secrets for MySQL + admin bearer.
# .env.production is gitignored — it carries the live secrets across re-deploys
# so we don't rotate the DB password on every run (which would orphan the
# existing database content).
if [[ ! -f "$SECRETS_FILE" ]]; then
  say "generating new secrets file at $SECRETS_FILE"
  mkdir -p "$(dirname "$SECRETS_FILE")"
  {
    echo "# generated $(date -u +%Y-%m-%dT%H:%M:%SZ) — do not commit"
    echo "ENSEMBLE_MYSQL_HOST=127.0.0.1"
    echo "ENSEMBLE_MYSQL_PORT=3306"
    echo "ENSEMBLE_MYSQL_USER=ensemble"
    echo "ENSEMBLE_MYSQL_PASSWORD=$(openssl rand -hex 24)"
    echo "ENSEMBLE_MYSQL_DATABASE=ensemble_telemetry"
    echo "ENSEMBLE_ADMIN_TOKEN=$(openssl rand -hex 32)"
  } > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
fi
# shellcheck disable=SC1090
set -a; . "$SECRETS_FILE"; set +a

# ─── 1. Local build ──────────────────────────────────────────────────────────
say "building @ensemble/server"
( cd "$REPO_ROOT" && pnpm -F @ensemble/server build )

if [[ ! -f "$CERT_SRC/ensemble-ai.cn_bundle.crt" ]] || [[ ! -f "$CERT_SRC/ensemble-ai.cn.key" ]]; then
  echo "[deploy] missing cert files in $CERT_SRC" >&2
  exit 1
fi

# Stage everything in a single dir to rsync in one go.
STAGE="$(mktemp -d -t ensemble-stage-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

say "staging artifacts at $STAGE"
mkdir -p "$STAGE/app" "$STAGE/shared" "$STAGE/cert" "$STAGE/etc"
cp -r "$LOCAL_PKG/dist"           "$STAGE/app/dist"
cp    "$LOCAL_PKG/package.json"   "$STAGE/app/package.json"
cp    "$LOCAL_PKG/manifest.example.json" "$STAGE/app/manifest.example.json"
cp -r "$REPO_ROOT/shared/src"     "$STAGE/shared/src"
cp    "$REPO_ROOT/shared/package.json" "$STAGE/shared/package.json"
cp    "$REPO_ROOT/shared/tsconfig.json" "$STAGE/shared/tsconfig.json"
cp    "$CERT_SRC/ensemble-ai.cn_bundle.crt" "$STAGE/cert/fullchain.crt"
cp    "$CERT_SRC/ensemble-ai.cn.key"        "$STAGE/cert/server.key"
cp    "$LOCAL_PKG/deploy/ensemble-server.service" "$STAGE/etc/ensemble-server.service"
cp    "$LOCAL_PKG/deploy/nginx.conf"              "$STAGE/etc/ensemble.conf"
cp    "$SECRETS_FILE"                             "$STAGE/etc/env.production"

# ─── 2. Remote bootstrap ─────────────────────────────────────────────────────
say "provisioning remote ($SSH_HOST)"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "MYSQL_USER='$ENSEMBLE_MYSQL_USER' MYSQL_PASS='$ENSEMBLE_MYSQL_PASSWORD' MYSQL_DB='$ENSEMBLE_MYSQL_DATABASE' bash -se" <<'REMOTE_BOOTSTRAP'
set -euo pipefail
need_install=()
command -v node    >/dev/null 2>&1 || need_install+=("node")
command -v nginx   >/dev/null 2>&1 || need_install+=("nginx")
command -v rsync   >/dev/null 2>&1 || need_install+=("rsync")
command -v mysqld  >/dev/null 2>&1 || need_install+=("mysql-server")
if (( ${#need_install[@]} > 0 )); then
  echo "[remote] installing: ${need_install[*]}"
  sudo apt-get update -y
  if [[ " ${need_install[*]} " == *" node "* ]]; then
    # Node 22 LTS from NodeSource.
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  for pkg in nginx rsync mysql-server; do
    if [[ " ${need_install[*]} " == *" $pkg "* ]]; then
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg"
    fi
  done
fi
sudo systemctl enable --now mysql
# Idempotent DB + user setup. Quote password via single-quotes inside SQL;
# the password from openssl rand -hex 24 is a-z0-9 only so no escaping needed.
sudo mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${MYSQL_PASS}';
ALTER USER '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${MYSQL_PASS}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DB}\`.* TO '${MYSQL_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "[remote] mysql database '${MYSQL_DB}' ready"

id ensemble >/dev/null 2>&1 || sudo useradd --system --create-home --shell /usr/sbin/nologin ensemble
sudo mkdir -p /opt/ensemble-server /var/www/ensemble-dl/download /var/www/ensemble-site /etc/nginx/ssl/ensemble-ai
# Migrate any installers placed at the legacy /releases path so the rename
# doesn't 404 anything that was already up.
if [[ -d /var/www/ensemble-dl/releases ]]; then
  sudo find /var/www/ensemble-dl/releases -maxdepth 1 -type f -exec mv -n {} /var/www/ensemble-dl/download/ \;
  sudo rmdir /var/www/ensemble-dl/releases 2>/dev/null || true
fi
sudo chown -R ensemble:ensemble /opt/ensemble-server /var/www/ensemble-dl
echo "[remote] versions: node=$(node -v 2>/dev/null || echo missing) nginx=$(nginx -v 2>&1 | awk '{print $NF}') mysql=$(mysqld --version 2>/dev/null | awk '{print $3}')"
REMOTE_BOOTSTRAP

# ─── 3. Push artifacts ───────────────────────────────────────────────────────
say "uploading artifacts (tar | ssh — no rsync needed locally)"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "rm -rf /tmp/ensemble-stage && mkdir -p /tmp/ensemble-stage"
tar -C "$STAGE" -cf - app shared cert etc \
  | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "tar -C /tmp/ensemble-stage -xf -"

say "installing on remote"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "API_HOST='$API_HOST' SITE_HOST='$SITE_HOST' SERVER_DIR='$SERVER_DIR' DL_DIR='$DL_DIR' CERT_DIR='$CERT_DIR' MYSQL_DB='$ENSEMBLE_MYSQL_DATABASE' bash -se" <<'REMOTE_INSTALL'
set -euo pipefail
STAGE=/tmp/ensemble-stage

# 3a. Move shared into a sibling of the app dir so the workspace-style
#     `@agentorch/shared` reference resolves at runtime.
sudo rm -rf "${SERVER_DIR}.next"
sudo mkdir -p "${SERVER_DIR}.next/app" "${SERVER_DIR}.next/shared"
sudo rsync -a --delete "$STAGE/app/"    "${SERVER_DIR}.next/app/"
sudo rsync -a --delete "$STAGE/shared/" "${SERVER_DIR}.next/shared/"

# 3a-bis. Preserve the LIVE manifest.json across re-deploys. The bundle
# ships manifest.example.json (template); ops-edited manifest.json must
# carry over. Without this, every code re-deploy nukes published version
# state.
if [[ -f "$SERVER_DIR/app/manifest.json" ]]; then
  sudo cp -p "$SERVER_DIR/app/manifest.json" "${SERVER_DIR}.next/app/manifest.json"
  echo "[remote] preserved existing manifest.json"
fi

# 3b. Install runtime deps. Convert the workspace:* spec to a relative
#     file: path before npm install because pnpm isn't on the remote.
cd "${SERVER_DIR}.next/app"
sudo sed -i 's|"@agentorch/shared": *"workspace:\*"|"@agentorch/shared": "file:../shared"|' package.json
sudo npm install --omit=dev --no-audit --no-fund --silent

# 3c. Atomic swap into the live location. If a previous version is running,
#     it stays up until systemd restarts.
if [[ -d "$SERVER_DIR" ]]; then
  sudo rm -rf "${SERVER_DIR}.prev"
  sudo mv "$SERVER_DIR" "${SERVER_DIR}.prev"
fi
sudo mv "${SERVER_DIR}.next" "$SERVER_DIR"
sudo chown -R ensemble:ensemble "$SERVER_DIR"

# 3d. Seed manifest.json if missing — admin will edit later.
if [[ ! -f "$SERVER_DIR/app/manifest.json" ]]; then
  sudo -u ensemble cp "$SERVER_DIR/app/manifest.example.json" "$SERVER_DIR/app/manifest.json"
  echo "[remote] seeded manifest.json from manifest.example.json"
fi

# 3e. Install TLS cert.
sudo install -m 644 "$STAGE/cert/fullchain.crt" "$CERT_DIR/fullchain.crt"
sudo install -m 600 "$STAGE/cert/server.key"    "$CERT_DIR/server.key"

# 3e-bis. Install secrets env file. mode 600, owned by ensemble. Carries
# ENSEMBLE_MYSQL_* + ENSEMBLE_ADMIN_TOKEN; systemd loads it via
# EnvironmentFile= below.
sudo install -m 600 -o ensemble -g ensemble \
  "$STAGE/etc/env.production" "$SERVER_DIR/env.production"

# 3f. Install systemd unit. Adjust ExecStart + WorkingDirectory so it
#     matches the SERVER_DIR/app layout.
sudo tee /etc/systemd/system/ensemble-server.service >/dev/null <<UNIT
[Unit]
Description=Ensemble version-update server
After=network.target mysql.service

[Service]
Type=simple
User=ensemble
Group=ensemble
WorkingDirectory=${SERVER_DIR}/app
EnvironmentFile=${SERVER_DIR}/env.production
Environment=ENSEMBLE_SERVER_HOST=127.0.0.1
Environment=ENSEMBLE_SERVER_PORT=8787
Environment=ENSEMBLE_MANIFEST_PATH=${SERVER_DIR}/app/manifest.json
Environment=NODE_ENV=production
ExecStart=/usr/bin/node ${SERVER_DIR}/app/dist/index.js
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${SERVER_DIR}

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now ensemble-server
sudo systemctl restart ensemble-server
sleep 1
sudo systemctl is-active ensemble-server
curl -sf -o /dev/null http://127.0.0.1:8787/healthz && echo "[remote] sidecar healthz OK"
# Verify telemetry tables were created by the migrate-on-boot step.
if sudo mysql -uroot -e "SHOW TABLES FROM \`${MYSQL_DB:-ensemble_telemetry}\`" 2>/dev/null | grep -qE '^device$|^session$|^usage_daily$'; then
  echo "[remote] telemetry tables present"
else
  echo "[remote] WARN: telemetry tables missing — check journalctl -u ensemble-server"
fi

# 3g. Install nginx vhost. Drop the default site so our vhost wins on :443.
sudo cp "$STAGE/etc/ensemble.conf" /etc/nginx/sites-available/ensemble.conf
sudo ln -sf /etc/nginx/sites-available/ensemble.conf /etc/nginx/sites-enabled/ensemble.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
echo "[remote] nginx reloaded"
REMOTE_INSTALL

# ─── 4. Local smoke test ─────────────────────────────────────────────────────
say "smoke-testing"
sleep 1
echo "--- apex (backend) ---"
curl -sSf "https://$API_HOST/healthz" && echo
curl -sS  "https://$API_HOST/v1/version/latest" | head -c 400; echo
echo "--- www (site placeholder) ---"
curl -sI "https://$SITE_HOST/" | head -3

say "done"
say "  API:       https://$API_HOST/v1/version/latest"
say "  Downloads: https://$API_HOST/download/<file>"
say "  Website:   https://$SITE_HOST/  (placeholder)"
