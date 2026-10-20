#!/usr/bin/env bash
# Deploy Postoffice onto the live Ensemble website host (nginx + systemd).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
SSH_USER="${SSH_USER:-ubuntu}"
SSH_HOST="${SSH_HOST:-49.232.1.174}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/ensemble.pem}"
if [[ ! -f "$SSH_KEY" ]]; then
  SSH_KEY="$REPO_ROOT/ensemble.pem"
fi
WEB_PUBLIC="${WEB_PUBLIC:-$REPO_ROOT/ensemble_web/public}"
REMOTE_APP="/opt/ensemble-postoffice"
REMOTE_DATA="/var/lib/ensemble-postoffice"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -i "$SSH_KEY")
SSH_TARGET="$SSH_USER@$SSH_HOST"

say() { printf '\n\033[36m[postoffice-deploy]\033[0m %s\n' "$*"; }

[[ -f "$SSH_KEY" ]] || { echo "missing SSH key: $SSH_KEY" >&2; exit 1; }
[[ -f "$ROOT/mcp/package.json" ]] || { echo "mcp/package.json missing" >&2; exit 1; }

say "building mcp"
( cd "$ROOT/mcp" && npx --yes tsc -p tsconfig.json )
[[ -f "$ROOT/mcp/dist/index.js" ]] || { echo "build produced no dist/index.js" >&2; exit 1; }

say "provisioning $SSH_HOST"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "sudo mkdir -p $REMOTE_APP $REMOTE_DATA && sudo chown -R $SSH_USER:$SSH_USER $REMOTE_APP $REMOTE_DATA"

say "uploading postoffice tree"
tar -C "$ROOT" --exclude node_modules --exclude .git --exclude 'mcp/data' -cf - . \
  | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "tar -C $REMOTE_APP -xf -"

if [[ -f "$WEB_PUBLIC/index.html" ]]; then
  say "uploading www static site (for 邮局 nav link)"
  tar -C "$WEB_PUBLIC" -cf - . \
    | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
      "sudo tar -C /var/www/ensemble-site -xf - && sudo chown -R www-data:www-data /var/www/ensemble-site"
fi

say "installing production deps"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cd $REMOTE_APP/mcp && npm install --omit=dev --no-audit --no-fund"

say "installing systemd unit"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "sed -i 's/\r$//' $REMOTE_APP/deploy/postoffice.service && sudo cp $REMOTE_APP/deploy/postoffice.service /etc/systemd/system/ensemble-postoffice.service && sudo systemctl daemon-reload && sudo systemctl enable ensemble-postoffice && sudo systemctl restart ensemble-postoffice"

say "patching nginx /postoffice/"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "sed -i 's/\r$//' $REMOTE_APP/deploy/patch-nginx.py && sudo python3 $REMOTE_APP/deploy/patch-nginx.py && sudo nginx -t && sudo systemctl reload nginx"

say "waiting for health"
sleep 2
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "systemctl is-active ensemble-postoffice"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "curl -fsS http://127.0.0.1:8790/healthz"
echo
say "smoke-testing public URLs"
curl -fsSI "https://www.ensemble-ai.cn/postoffice/" | head -12
curl -fsS "https://www.ensemble-ai.cn/postoffice/healthz"
echo
curl -fsS -X POST "https://www.ensemble-ai.cn/postoffice/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"deploy-smoke","version":"0"}}}'
echo
say "done — https://www.ensemble-ai.cn/postoffice/"
