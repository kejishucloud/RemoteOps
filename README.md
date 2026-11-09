# kejishu RemoteOps

基于 MCP 的**自托管多设备远程运维中心**，提供统一的 ChatGPT / MCP 接入入口，支持 macOS、Windows、Linux。服务端自行持有设备注册信息和审计记录；设备主动建立出站 WebSocket，不要求在工作站上开放入站端口。

> 本项目基于 [SelfHostDesktopMCP](https://github.com/andyching168/SelfHostDesktopMCP) 改造，保留原项目 MIT 许可证及归属。远程终端具有系统用户权限；安装前务必审阅 [安全说明](docs/SECURITY.md)。

## 架构

```text
ChatGPT / MCP 客户端
       |
       | HTTPS + OAuth2 /mcp
       v
RemoteOps Gateway (VPS, 127.0.0.1:8765)
       |
       | Tailscale Funnel / 自有 HTTPS 反向代理
       | WSS /device + 独立设备密钥
       +----- macbook  (LaunchAgent, 用户权限)
       +----- macmini  (LaunchAgent, 用户权限)
       +----- windows  (计划任务, 指定账户权限)
       +----- vps      (独立 systemd 低权限账户)
                    |
                MCP stdio / Desktop Commander 0.3.1
```

## 要求

- Node.js >= 22.13、npm、Git；macOS 需 launchd，Linux 需 systemd，Windows 需 PowerShell 5.1+。
- 对公网入口使用 HTTPS。推荐 Tailscale Funnel（无需自有域名），但也可使用反向代理。
- **每台设备独立密钥**。不要上传 `device.json`、`owner-token`、`.env`、SQLite 数据或私钥。

## 本机快速开始（macOS）

```bash
git clone https://github.com/kejishucloud/RemoteOps.git
cd RemoteOps
npm ci
npm test
bash scripts/bootstrap-macos.sh --check
# 首次配对：在 Gateway 上运行 node gateway/admin.js pair
# 设备端执行：
# node agent/agent.js pair https://gateway.example.com --device-id macbook
bash scripts/bootstrap-macos.sh --apply
```

脚本自动校验运行环境、安装固定版本 Desktop Commander、保护本地设备配置，并部署登录后自启的 LaunchAgent。已有配对设备无需重新配对。未指定 `--apply` 时只做检查，不替换正在运行的 Agent。**不要通过当前要重启的 RemoteOps Agent 本身执行 `--apply`**；请使用 Mac 本地终端或独立 SSH/远程控制通道，以免控制连接中断后安装步骤无法完成。

## Linux 与 Windows

- Linux Gateway：`sudo PUBLIC_URL=https://gateway.example.com bash scripts/bootstrap-linux-gateway.sh`，需要部署自己的 HTTPS/Funnel；该脚本不适合在已有同端口 Gateway 上盲目重复执行。
- Linux Agent：`GATEWAY_URL=https://gateway.example.com DEVICE_ID=linux-main bash scripts/bootstrap-linux-agent.sh`（首先在 Gateway CLI 中打开配对审批窗口）。
- Windows Agent：在 PowerShell 中以指定用户执行 `powershell -ExecutionPolicy Bypass -File scripts/bootstrap-windows.ps1 -GatewayUrl https://gateway.example.com -DeviceId windows`。需先在 Gateway CLI 开启配对。
- 验收 / 运维 / 回滚详见 [部署指南](docs/DEPLOYMENT.md)。

## ChatGPT 接入

在 ChatGPT 中新建自定义 MCP 服务，URL 为 `https://gateway.example.com/mcp`，身份验证选择 OAuth。Gateway 将提供 `/.well-known/oauth-authorization-server`、`/authorize`、`/token` 和动态客户端注册。OAuth 授权通过 Gateway 的 Owner Token 审批；**不得把 Owner Token 写入任何聊天、公开仓库或日志**。

## 工具能力

支持设备列表与选择、文件读写、目录遍历、内容搜索、Shell/PowerShell 进程、会话管理和 MCP 扩展工具管理。Mac / Windows 的能力取决于 Agent 运行用户的操作系统权限；建议 VPS 单独使用无特权账户和 systemd 沙箱。设备侧安全策略会限制敏感路径及危险命令。

## 测试、CI 与安全

```bash
npm ci
npm test
python3 scripts/secret_scan.py
```

GitHub Actions 会在 Ubuntu、macOS 和 Windows 下运行 Node 22 测试，并扫描提交文件中常见凭据模式。不包含自动生产部署或远程重启：正式服务升级必须先备份，避免中断既有 VPN/FRP。

## 项目结构

```text
agent/        设备侧 WebSocket / MCP 调度 / 安全策略
gateway/      OAuth、设备注册、管理控制台、审计
deploy/       原项目基础安装模板
scripts/      平台自动化、敏感信息检查
docs/         安全、部署、反向代理指南
test/         单元与端到端测试
.github/      CI
```

许可证：MIT。感谢原作者及 Desktop Commander 开源贡献。
