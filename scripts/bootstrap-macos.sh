#!/usr/bin/env bash
# Mac 自动化安装：检测 -> 配对 -> 固定后端 -> 安装登录自启动 LaunchAgent。
# 默认只做安全检查；明确 --apply 才修改运行环境。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MODE="${1:---check}"
NODE="${NODE:-$(command -v node || true)}"
CONFIG="$HOME/.config/remote-mcp/device.json"
BACKEND_ROOT="$HOME/.local/share/kejishucloud-mcp/desktop-commander"
BACKEND_VERSION="0.3.1"

if [[ "${MODE}" != "--check" && "${MODE}" != "--apply" ]]; then
  echo "Usage: bash scripts/bootstrap-macos.sh [--check|--apply]" >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin ]]; then echo "macOS only" >&2; exit 1; fi
if [[ -z "$NODE" ]]; then echo "Node >=22.13 is required" >&2; exit 1; fi
if ! "$NODE" -e 'const v=process.versions.node.split(".").map(Number); process.exit(v[0]>22 || (v[0]===22 && v[1]>=13) ? 0 : 1)'; then
  echo "Node >=22.13 is required" >&2; exit 1
fi

echo "[RemoteOps] root=$ROOT"
echo "[RemoteOps] node=$("$NODE" --version)"
if [[ "$MODE" == "--check" ]]; then
  [[ -f "$CONFIG" ]] && echo "Pairing: existing device configuration (secret hidden)" || echo "Pairing: not configured"
  if launchctl list | grep -q com.selfhost.remote-mcp-agent; then
    echo "LaunchAgent: present"
  else
    echo "LaunchAgent: not running"
  fi
  echo "Dry check completed. Pass --apply to install."
  exit 0
fi

cd "$ROOT"
npm ci --omit=dev --no-audit --no-fund
if [[ ! -f "$CONFIG" ]]; then
  : "${GATEWAY_URL:?set GATEWAY_URL=https://gateway.example.com}"
  : "${DEVICE_ID:?set DEVICE_ID=your-device}"
  "$NODE" agent/agent.js pair "$GATEWAY_URL" --device-id "$DEVICE_ID"
fi

# 通过显式版本锁定后端，避免 npx @latest 在每次重启时下载新代码。
mkdir -p "$BACKEND_ROOT"
npm install --prefix "$BACKEND_ROOT" --save-exact --omit=dev --no-audit --no-fund "@wonderwhy-er/desktop-commander@$BACKEND_VERSION"
BACKEND="$BACKEND_ROOT/node_modules/@wonderwhy-er/desktop-commander/dist/index.js"
[[ -f "$BACKEND" ]] || { echo "Backend missing: $BACKEND" >&2; exit 1; }
"$NODE" - "$CONFIG" "$NODE" "$BACKEND" <<'JS'
const fs = require('node:fs');
const [file, node, backend] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!data.device_id || !data.device_secret || !/^wss:\/\//.test(data.gateway)) throw Error('invalid pairing config');
const next = [node, backend];
if (JSON.stringify(data.desktop_commander?.command) !== JSON.stringify(next)) {
  fs.copyFileSync(file, file + '.before-remoteops');
  fs.chmodSync(file + '.before-remoteops', 0o600);
  data.desktop_commander = {command: next};
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode:0o600});
  fs.renameSync(tmp, file);
}
fs.chmodSync(file, 0o600);
console.log('Device configuration validated; no secrets displayed.');
JS

# 保留旧启动定义，原安装程序会通过 launchctl 替换启动服务。
PLIST="$HOME/Library/LaunchAgents/com.selfhost.remote-mcp-agent.plist"
[[ ! -f "$PLIST" ]] || cp -p "$PLIST" "$PLIST.before-remoteops"
bash deploy/install-macos.sh
launchctl list | grep com.selfhost.remote-mcp-agent
echo "Installed. Logs: $HOME/Library/Logs/remote-mcp-agent.log"
