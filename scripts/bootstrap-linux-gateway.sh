#!/usr/bin/env bash
# 全新 VPS 安装 Gateway；发现既有端口或服务时拒绝覆盖。
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
: "${PUBLIC_URL:?set PUBLIC_URL=https://gateway.example.com}"
[[ "$PUBLIC_URL" == https://* ]] || { echo "PUBLIC_URL must use HTTPS" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
USER_NAME="${SERVICE_USER:-remoteops}"
SERVICE="kejishu-remoteops-gateway.service"
DST="${INSTALL_DIR:-/opt/kejishucloud/RemoteOps}"
DATA_DIR="${DATA_DIR:-/var/lib/remoteops}"
PORT="${PORT:-8765}"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "Node >=22.13 required" >&2; exit 1; }
if [[ -e "/etc/systemd/system/$SERVICE" ]] || systemctl is-active --quiet "$SERVICE"; then
  echo "Gateway service already exists; refusing to overwrite" >&2; exit 1
fi
if command -v ss >/dev/null && ss -ltn | grep -Eq "[:.]$PORT[[:space:]]"; then
  echo "Port $PORT is already used; aborting without changes" >&2; exit 1
fi
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || a===22&&b>=13?0:1)'
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USER_NAME"
install -d -m 0755 "$DST"
# git archive only includes committed project files; excludes secrets and untracked files.
git -C "$ROOT" archive HEAD | tar -xf - -C "$DST"
(cd "$DST" && npm ci --omit=dev --no-audit --no-fund)
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "$DATA_DIR"
DB="$DATA_DIR/mcp.db"
TOKEN_PATH="$DATA_DIR/owner-token"
if [[ ! -f "$TOKEN_PATH" ]]; then
  TOKEN="$(cd "$DST" && runuser -u "$USER_NAME" -- env RMCP_DB="$DB" "$NODE" gateway/admin.js client-create owner --admin | sed -n 's/^client_token: //p')"
  [[ -n "$TOKEN" ]] || { echo "Owner token creation failed" >&2; exit 1; }
  umask 077
  printf '%s\n' "$TOKEN" > "$TOKEN_PATH"
  chown "$USER_NAME:$USER_NAME" "$TOKEN_PATH"
  chmod 0600 "$TOKEN_PATH"
  unset TOKEN
fi
cat > "/etc/systemd/system/$SERVICE" <<EOF
[Unit]
Description=Kejishu RemoteOps MCP Gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$DST
Environment=NODE_ENV=production
ExecStart=$NODE --disable-warning=ExperimentalWarning $DST/gateway/server.js --host 127.0.0.1 --port $PORT --db $DB --public-url $PUBLIC_URL
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemd-analyze verify "/etc/systemd/system/$SERVICE"
systemctl daemon-reload
systemctl enable --now "$SERVICE"
curl --noproxy '*' --retry 6 --retry-delay 1 --retry-connrefused -fsS "http://127.0.0.1:$PORT/health"
echo
echo "Gateway ready on localhost:$PORT; configure TLS/Funnel separately."
echo "Owner token stored privately at $TOKEN_PATH (not printed)."
