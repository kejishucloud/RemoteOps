#!/usr/bin/env bash
# Linux 当前非 root 用户的自动化 Agent：设备配对、版本锁定、systemd --user 自启动。
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo "Linux only" >&2; exit 1; }
[[ "$(id -u)" -ne 0 ]] || { echo "Agent must run as a non-root user" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "Node >=22.13 required" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=13?0:1)'
cd "$ROOT"
npm ci --omit=dev --no-audit --no-fund
CONFIG="$HOME/.config/remote-mcp/device.json"
if [[ ! -f "$CONFIG" ]]; then
  : "${GATEWAY_URL:?set GATEWAY_URL=https://gateway.example.com}"
  : "${DEVICE_ID:?set DEVICE_ID=linux-01}"
  "$NODE" agent/agent.js pair "$GATEWAY_URL" --device-id "$DEVICE_ID"
fi
BACKEND="$HOME/.local/share/kejishucloud-mcp/desktop-commander"
mkdir -p "$BACKEND"
npm install --prefix "$BACKEND" --save-exact --omit=dev --no-audit --no-fund @wonderwhy-er/desktop-commander@0.3.1
"$NODE" - "$CONFIG" "$NODE" "$BACKEND/node_modules/@wonderwhy-er/desktop-commander/dist/index.js" <<'JS'
const fs = require('node:fs');
const [file,node,backend]=process.argv.slice(2);
const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
if(!cfg.device_id || !cfg.device_secret || !/^wss:\/\//.test(cfg.gateway)) throw Error('not paired');
const cmd=[node,backend];
if(JSON.stringify(cfg.desktop_commander?.command)!==JSON.stringify(cmd)){
  fs.copyFileSync(file,file+'.before-remoteops');
  fs.chmodSync(file+'.before-remoteops',0o600);
  cfg.desktop_commander={command:cmd};
  fs.writeFileSync(file,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});
}
fs.chmodSync(file,0o600);
console.log('Paired config validated; secret hidden.');
JS
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"
cat > "$SYSTEMD_DIR/kejishu-remoteops-agent.service" <<EOF
[Unit]
Description=Kejishu RemoteOps Linux Device Agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/agent/agent.js
Environment=HOME=$HOME
Restart=always
RestartSec=8
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now kejishu-remoteops-agent.service
systemctl --user is-active kejishu-remoteops-agent.service
echo "Agent installed; loginctl linger may need administrator approval."
