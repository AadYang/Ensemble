#!/usr/bin/env bash
set -euo pipefail
echo '===os==='
head -5 /etc/os-release
echo '===nginx==='
dpkg -l nginx 2>/dev/null | tail -1 || true
command -v nginx || true
echo '===running services==='
systemctl list-units --type=service --state=running --no-pager | head -40
echo '===opt==='
ls -la /opt || true
echo '===www==='
ls -la /var/www || true
echo '===listening==='
sudo ss -lntp | head -40
