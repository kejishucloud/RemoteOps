# RemoteOps MCP Apps 资源代理与部署验收

## 功能边界

MCP Apps UI 和 Web 管理后台 V2 严格分离：Web 管理后台仍从 /admin/ 提供服务；ChatGPT UI 由设备本地 MCP 服务声明，Gateway 经 resources/list 与 resources/read 转发。普通工具仍支持 tools/list 与 tools/call。

设计依据：MCP Resources 与 MCP Apps 标准。HTML 使用 ui:// 与 text/html;profile=mcp-app。优先遵循 _meta.ui.resourceUri，同时保留 ui/resourceUri 与 openai/outputTemplate 兼容字段。HTML 内的 ui/initialize、通知和消息由原生应用及其宿主处理，Gateway 不修改 HTML。

## 模块

- agent/ui-resources.js：Agent 按已授权工具筛选 UI 模板，使用 SDK 读取资源。
- agent/agent.js：资源发现、设备握手、resources_changed 通知、读取转发。
- gateway/ui-resources.js：设备作用域 URI、会话绑定、权限与大小校验。
- gateway/server.js：resources 能力声明、请求分发和结果元数据绑定。
- test/mcp-apps.test.js：双 Agent 端到端测试、权限和跨设备隔离。
- test/real-mcp-apps.test.js：真实 Desktop Commander 完整 HTML 读取验证。

## 安全边界

仅允许转发在线 Agent 中已由可见工具引用且 SDK 列出的 ui:// HTML 资源，不允许任意 file://、HTTPS 或未经声明的资源 URI。完整资源响应不得超过 4 MiB，列表最多 64 条，不记录 HTML 内容和用户操作参数。

原始资源 URI 用于兼容旧版工具元数据；明确目标的动态工具或工具结果使用 ui://remoteops/设备/后端/原始URI 的 Base64url 设备作用域表示。服务端会验证该客户端会话选中的设备或最近一次工具调用目标，防止并行操作把 UI 资源误路由到另一设备。

保留原有 OAuth、TOTP、SQLite 和管理后台 V2。不能仅靠 URL 中的设备标识授予权限。如需更细粒度的多用户设备权限，应增加 ACL；当前沿用原 Gateway 的客户端认证和设备访问模型。

## 本地运行与测试

要求 Node.js >=22.13；依赖版本由 package-lock.json 管理。

    npm ci
    npm test
    python3 scripts/secret_scan.py

可选的真实本地 MCP 后端资源测试：

    REMOTEOPS_REAL_BACKEND_SCRIPT=/absolute/path/to/server.js node --test test/real-mcp-apps.test.js

测试启动独立临时 Gateway、SQLite 和 Agent，结束后清理；仅打印资源 URI、HTML 字符数和 MIME，不打印实际 HTML、Token 或配置内容。

## 生产升级要求

1. GitHub CI 必须在 Ubuntu、macOS、Windows 均通过。
2. 使用独立管理通道备份现有 Gateway 代码、systemd 服务文件及 SQLite 在线一致性快照。
3. 优先升级 MacBook Agent，保留原设备 ID、密钥、LaunchAgent、固定 Desktop Commander 后端以及用户权限。
4. 在独立管理通道更新 VPS Gateway，继续以 rdcagent 身份运行，只监听原有 127.0.0.1 地址，保留 Tailscale Funnel 与 OAuth。
5. 核实 /health、OAuth、工具调用、resources/list、resources/read、管理后台、401 拒绝与设备重连。
6. 通过真实 ChatGPT 连接验证配置编辑和文件预览是否真正显示。RPC 返回 HTML 不代表宿主 iframe 已完成渲染。
7. 异常时由独立通道回滚 Gateway 或 Agent 源码与服务文件，不回滚运行期间生成的审计日志，也不覆盖设备密钥及 OAuth 关系。

禁止通过正在运行的 Agent 重启自己。VPS Agent 仍须保持独立低权限，不更改 sing-box、FRP、SSH、Caddy、Tailscale、防火墙、DNS、公网 IP 或网络拓扑。

## 验收层级

- 协议级：resources 能力声明、两类 HTML UI 读回、CSP 保留、未知资源拒绝。
- 部署级：真实 Agent 在线、工具稳定调用、Gateway 重启恢复、无重复进程。
- ChatGPT UI 级：需宿主真实打开对应界面，不能把下载成功视作图形界面成功。
