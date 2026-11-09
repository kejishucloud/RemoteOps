# RemoteOps 部署与验收

## 1. 架构与基本原则

公网只公开 HTTPS 入口。Gateway 仅监听 `127.0.0.1:8765`，Tailscale Funnel 或支持 WebSocket 的反向代理将其公开为 `https://gateway.example.com`。所有设备只向 `wss://gateway.example.com/device` 发起出站连接。**在运行现有服务的机器上禁止同时运行第二个 8765 Gateway。**

- macOS / Windows：使用目标登录用户运行 Agent，权限随用户，**不提升系统安全边界**。
- VPS：单独创建非特权用户运行 Agent，阻止访问 SSH 凭据、Gateway DB 和其他密钥。
- 关键服务：配置修改前备份，启用监控，不覆盖 sing-box、Caddy、FRP、OpenSSH 等现有服务。

## 2. 首次 Gateway（全新 Linux 服务器）

```bash
git clone https://github.com/kejishucloud/RemoteOps.git
cd RemoteOps
npm ci && npm test
sudo PUBLIC_URL=https://gateway.example.com bash scripts/bootstrap-linux-gateway.sh
```

脚本创建专用服务用户、私有 SQLite 目录和 Owner Token，并安装 `kejishu-remoteops-gateway.service`，监听 127.0.0.1:8765。Token 仅保存在服务器上，不显示。后续需自行开启 HTTPS 反向代理或 Tailscale Funnel。**对于已运行 Gateway 的服务器，应检查现有 unit，直接部署到测试环境，而不是执行新装脚本。**

用以下命令验收：
```bash
curl -fsS http://127.0.0.1:8765/health
sudo systemctl status kejishu-remoteops-gateway.service
```

## 3. 设备配对

Gateway 管理主机上运行：
```bash
# 数据库路径与运行用户必须指向真实 Gateway 的实例
RMCP_DB=/var/lib/remoteops/mcp.db node gateway/admin.js pair
```

然后在设备上运行自动安装脚本（或 `node agent/agent.js pair https://gateway.example.com --device-id DEVICE`）。核对两个终端显示的配对码，由管理员批准。配对密钥将保存在设备本地、被 Git 排除。

## 4. Mac（保留登录自启动）

```bash
bash scripts/bootstrap-macos.sh --check
bash scripts/bootstrap-macos.sh --apply
launchctl list | grep com.selfhost.remote-mcp-agent
tail -20 ~/Library/Logs/remote-mcp-agent.log
```

已有 Mac Agent 会保留现有设备 ID 和 Gateway 地址。安装程序使用固定版本 Desktop Commander；现有 LaunchAgent 配置会备份。**升级/重启 Mac Agent 必须通过本地终端或独立管理通道发起，禁止通过待重启的 Agent 自己发起**，否则命令可能在 bootout 后失去执行上下文。用户未登录时，LaunchAgent 不能运行。

## 5. Windows（最高运行级别属于当前管理员用户）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-windows.ps1 -GatewayUrl https://gateway.example.com -DeviceId windows
Get-ScheduledTask -TaskName kejishu-RemoteOps-Agent
Get-Content "$env:LOCALAPPDATA\kejishucloud\RemoteOps\logs\agent.log" -Tail 30
```

任务在 Windows 启动和该用户登录时触发，身份为当前账户，`RunLevel=Highest`。用户必须本来就具备管理员权限，脚本不会提权、修改 UAC 或自动设置密码。部分 Windows 环境的 S4U 计划任务无法使用某些网络凭据；以 Gateway 实际在线及远程工具调用结果验收。

## 6. Linux Agent（用户级 systemd）

```bash
GATEWAY_URL=https://gateway.example.com DEVICE_ID=linux-01 bash scripts/bootstrap-linux-agent.sh
systemctl --user status kejishu-remoteops-agent.service
```

若要求注销后继续运行，应使用有权启用 linger 的管理员执行 `loginctl enable-linger <user>`。本脚本不更改防火墙、DNS、默认路由或服务器已有 systemd 服务。

## 7. 公网与 OAuth 验证

```bash
curl -fsS https://gateway.example.com/health
curl -fsS https://gateway.example.com/.well-known/oauth-authorization-server
```

进入 `https://gateway.example.com/admin/setup` 初始化 TOTP；启用之前不得扩大远程 Agent 权限。ChatGPT 使用 `https://gateway.example.com/mcp` + OAuth，并通过拥有者令牌审核授权。

## 8. 升级、备份与回滚

- Git 版本在本地验证测试后再推送，CI 通过后才升级生产服务。
- 备份 Gateway SQLite 采用 SQLite 在线备份 API，而不是复制活动 WAL 文件。
- 备份 `device.json`、现有 LaunchAgent / systemd unit（权限 0600），不要上传至 GitHub。
- Mac 出现问题：恢复旧 LaunchAgent plist 或旧安装目录，执行 `launchctl kickstart -k gui/$(id -u)/com.selfhost.remote-mcp-agent`。
- Windows 出现问题：`Stop-ScheduledTask -TaskName kejishu-RemoteOps-Agent`，回滚脚本及用户设备配置；不要修改 OpenSSH / FRP。
- 网关变更先在测试环境验证回滚，不要修改生产公网 IP、sing-box 443 端口或现有 FRP 端口。

## 9. 验收标准

设备在线、工具发现、Shell、读写临时文件、清理临时文件、未授权 MCP 401、OAuth 自动发现、敏感路径拒绝、关机/登录自动恢复，并验证原有 VPN / FRP / SSH 正常。只检查到进程存在，不等于完整网络验收通过。
