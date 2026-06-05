#!/usr/bin/env bash
# Push the static site (public/) to /var/www/ensemble-site/ on the Tencent
# server. nginx is already configured (by ensemble_server's deploy.sh) to
# serve from that path on www.ensemble-ai.cn. Idempotent — safe to re-run.

set -euo pipefail

WEB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$WEB_ROOT/.." && pwd)"
SSH_KEY="$REPO_ROOT/ensemble_server/tencent_cloud_key.pem"
SSH_USER="ubuntu"
SSH_HOST="43.156.94.143"
REMOTE_DIR="/var/www/ensemble-site"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -i "$SSH_KEY")
SSH_TARGET="$SSH_USER@$SSH_HOST"

say() { printf '\n\033[36m[web-deploy]\033[0m %s\n' "$*"; }

[[ -f "$SSH_KEY" ]] || { echo "missing SSH key: $SSH_KEY" >&2; exit 1; }
[[ -f "$WEB_ROOT/public/index.html" ]] || { echo "public/index.html missing" >&2; exit 1; }

# Rebuild the QR crops if the source jpgs are newer than the outputs — keeps
# everything in sync if someone replaces a screenshot.
say "regenerating QR crops"
node "$WEB_ROOT/scripts/prep-qr.mjs"

say "uploading public/ via tar over ssh"
tar -C "$WEB_ROOT/public" -cf - . \
  | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
      "sudo install -d -o www-data -g www-data $REMOTE_DIR.next && sudo tar -C $REMOTE_DIR.next -xf - && \
       if [ -d $REMOTE_DIR ]; then sudo rm -rf $REMOTE_DIR.prev && sudo mv $REMOTE_DIR $REMOTE_DIR.prev; fi && \
       sudo mv $REMOTE_DIR.next $REMOTE_DIR && \
       sudo chown -R www-data:www-data $REMOTE_DIR"

say "smoke-testing https://www.ensemble-ai.cn"
sleep 1
curl -sI "https://www.ensemble-ai.cn/" | head -5
echo "--- /tutorial.html ---"
curl -sI "https://www.ensemble-ai.cn/tutorial.html" | head -3

say "done — site live at https://www.ensemble-ai.cn"
