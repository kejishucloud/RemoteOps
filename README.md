# RemoteOps

**RemoteOps 是一个自托管的多设备远程运维与 MCP 工具管理平台**，将 macOS、Windows、Linux 和 VPS 设备统一接入自有 Gateway，通过 ChatGPT 或其他兼容 MCP 的客户端集中访问设备工具。

项目面向个人开发者、多设备工作站和轻量研发团队。设备主动建立出站 WebSocket 连接，无需在每台工作站开放公网入站端口；设备注册、认证、工具路由和审计数据由自托管 Gateway 管理。

> 本项目基于 [SelfHostDesktopMCP](https://github.com/andyching168/SelfHostDesktopMCP) 改造，保留原项目 MIT 许可证及归属。远程终端具有运行账户的系统权限。部署前请阅读[安全说明](docs/SECURITY.md)。

## 界面预览

### 运行总览

集中查看注册设备、在线状态、工具调用量、调用成功率、授权客户端数量和近期调用趋势。运行质量区域用于快速观察平均调用耗时与失败调用情况。

![RemoteOps 运行总览](docs/images/dashboard-overview.jpg)

### 设备管理

以设备卡片方式统一管理 macOS、Linux、Windows 等 Agent。支持设备搜索、在线状态查看、MCP 工具入口、设备重命名和注销。

![RemoteOps 设备管理](docs/images/device-management.jpg)

### 使用量统计

按时间范围分析工具调用总量、成功与失败次数、平均耗时、工具调用趋势、高频工具排行及设备维度统计，辅助定位调用异常和性能瓶颈。

![RemoteOps 使用量统计](docs/images/usage-statistics.jpg)

## 核心功能

### 1. 多平台设备接入

- 支持 macOS、Windows、Linux 设备和 VPS Agent。
- 每台设备独立身份与密钥，统一向 Gateway 建立出站 WebSocket 连接。
- 展示设备名称、操作系统、主机标识、在线状态和最近心跳。
- 支持设备注册、配对审批、重命名、注销及重新接入。
- 设备能力受 Agent 运行账户权限及本地安全策略约束。

### 2. 自托管 MCP Gateway

- 自行部署 Gateway，集中管理设备连接、身份认证和工具请求路由。
- 为 ChatGPT 及其他兼容 MCP 的客户端提供统一 MCP 接入地址。
- 支持 HTTPS、OAuth 2.0、动态客户端注册及设备侧 WebSocket 通信。
- 支持多设备工具调用与设备选择，避免为每台设备单独暴露公网服务。

### 3. MCP 工具与资源管理

- 查看设备暴露的 MCP 工具并执行远程工具调用。
- 支持文件、目录、搜索、进程和会话等远程操作能力。
- 支持 MCP Resources 的列表与读取转发。
- 支持 MCP Apps UI 资源转发，保留工具关联的界面资源及安全策略。
- 支持扩展 MCP 后端服务，并通过统一入口进行管理和调用。

### 4. 运行总览与可观测性

- 注册设备数、在线设备数和授权客户端数量。
- 工具调用总量、成功率、成功/失败次数及平均耗时。
- 按日期展示调用趋势，辅助观察平台负载变化。
- 展示设备连接状态，快速定位离线设备。
- 提供常用管理入口，减少日常运维操作步骤。

### 5. 使用量统计与操作审计

- 支持按时间范围查看调用统计。
- 展示高频工具排行和设备维度调用分布。
- 记录调用状态、耗时等审计元数据。
- 审计记录不以完整工具输出或敏感参数作为统计依据。
- 可用于性能分析、故障追踪和使用情况复盘。

### 6. 管理控制台

- 运行总览、设备管理、使用量统计。
- 认证信息、ChatGPT 连接展示。
- 操作审计、设备配对和系统设置。
- 简体中文与英文切换。
- 响应式布局，适配桌面和移动端。
- 统一的深色/浅色主题及本地静态资源。

### 7. 身份认证与安全控制

- Owner Token 与管理员认证机制。
- OAuth 2.0 授权流程及客户端管理。
- Google OpenID Connect 管理员白名单登录，可选 30 天保持登录。
- 双因素认证、CSRF 防护、Origin 校验及安全 Cookie。
- 设备独立密钥、配对审批和设备撤销。
- 敏感路径保护、危险命令限制及最小权限运行建议。
- 严格内容安全策略（CSP）和敏感信息扫描。

### 8. 运维、备份与恢复

- SQLite 持久化设备、授权及审计相关数据。
- 提供 VPS 发布审计、资源监控和 SQLite 备份/恢复核验工具。
- 支持 systemd、launchd 和 Windows 计划任务等运行方式。
- 提供部署、升级、回滚和故障排查文档。
- GitHub Actions 多平台测试与安全扫描。

## 架构

```text
ChatGPT / MCP Client
        |
        | HTTPS + OAuth 2.0 / MCP
        v
RemoteOps Gateway
        |
        | WSS /device + per-device credential
        +----------------+----------------+----------------+
        |                |                |                |
    macOS Agent     Windows Agent     Linux Agent       VPS Agent
        |                |                |                |
    Local MCP       Local MCP         Local MCP         Local MCP
    backends        backends          backends          backends
```

Gateway 负责认证、设备注册、连接状态、工具路由、资源转发和审计；Agent 在设备本地调用 MCP 后端。设备主动连接 Gateway，不要求工作站开放公网入站端口。

## 技术栈

- **运行环境：** Node.js 22.13+
- **通信：** HTTPS、WebSocket / WSS、MCP
- **认证：** OAuth 2.0、Google OpenID Connect、双因素认证
- **持久化：** SQLite
- **进程管理：** systemd、launchd、Windows Task Scheduler
- **质量保障：** Node.js Test Runner、GitHub Actions、敏感信息扫描

## 快速开始

### macOS 本机检查

```bash
git clone https://github.com/kejishucloud/RemoteOps.git
cd RemoteOps
npm ci
npm test
bash scripts/bootstrap-macos.sh --check
```

首次配对需先在 Gateway 上开启配对审批，再在设备端执行 Agent 配对流程。确认检查结果后，使用部署脚本的 `--apply` 参数安装服务。

**注意：** 不要通过当前需要重启的 RemoteOps Agent 本身执行其升级或重启操作。请使用本地终端或独立 SSH 通道，避免控制连接中断导致部署无法完成。

### Linux Gateway 与 Agent

- Gateway：`sudo PUBLIC_URL=https://gateway.example.com bash scripts/bootstrap-linux-gateway.sh`
- Agent：`GATEWAY_URL=https://gateway.example.com DEVICE_ID=linux-main bash scripts/bootstrap-linux-agent.sh`

### Windows Agent

在 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-windows.ps1 -GatewayUrl https://gateway.example.com -DeviceId windows
```

完整步骤、反向代理、验收与回滚说明见[部署指南](docs/DEPLOYMENT.md)。

## ChatGPT 接入

在 ChatGPT 中配置自定义 MCP 服务，服务地址为：

`https://gateway.example.com/mcp`

身份验证选择 OAuth。Gateway 提供 OAuth 元数据、授权、令牌及动态客户端注册端点。Owner Token 仅用于受控管理操作，**不得写入聊天内容、公开仓库或日志**。

## 测试与安全检查

```bash
npm ci
npm test
npm run check:secrets
```

测试覆盖 Gateway、Agent、设备配对、OAuth、管理控制台、MCP Apps 资源转发、工具策略及安全边界。Windows 专属用例和需要额外本地后端的集成用例会在不满足运行环境时跳过。

## 项目结构

```text
agent/        设备侧 WebSocket、MCP 调度与安全策略
gateway/      OAuth、设备注册、管理控制台与审计
deploy/       基础部署模板
scripts/      平台自动化、备份检查与敏感信息扫描
docs/         安全、部署、控制台、MCP Apps 与运维文档
test/         单元、集成与端到端测试
.github/      CI 工作流
```

## 文档

- [部署指南](docs/DEPLOYMENT.md)
- [安全说明](docs/SECURITY.md)
- [管理控制台说明](docs/CONSOLE.md)
- [MCP Apps 开发与验收](docs/MCP_APPS.md)
- [UI System v3 设计规范](docs/UI_SYSTEM.md)
- [Google 登录配置](docs/GOOGLE_LOGIN.md)
- [可靠性运行手册](docs/OPS_RELIABILITY.md)

## 适用场景

- 个人开发者的 Mac、Windows、Linux 多设备统一管理。
- 通过 ChatGPT 或 MCP 客户端远程访问个人工作站。
- 自托管 AI Agent 与本地 MCP 工具的集中接入。
- 轻量研发团队的远程设备管理与运维审计。
- 需要保留自有身份认证、设备控制和审计数据的私有部署环境。

## 许可证与致谢

本项目采用 MIT 许可证。感谢 [SelfHostDesktopMCP](https://github.com/andyching168/SelfHostDesktopMCP) 原项目及 Desktop Commander 开源社区的贡献。
