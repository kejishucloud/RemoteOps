# RemoteOps 管理控制台

RemoteOps 提供独立、自托管的设备与 MCP（模型上下文协议）网关管理控制台。所有设备信息由网关根据注册状态和 Agent（设备代理）心跳动态提供。仓库中没有预置的真实主机、设备清单、IP 地址、登录令牌或使用量。

## 页面及接口

| 页面 | 接口 | 作用 |
| --- | --- | --- |
| 运行总览 | GET /admin/api/overview?days=7 | 在线设备、客户端数、调用量及成功率 |
| 设备管理 | GET /admin/api/devices | 设备在线状态与详情入口 |
| 设备重命名 | POST /admin/api/devices/:id/rename | 只更新显示名称，不重置 Agent 密钥 |
| 使用量统计 | GET /admin/api/overview?days=7、30、90 | 调用趋势、工具排名、失败次数和平均耗时 |
| 认证信息 | GET /admin/api/credentials | 仅显示会话及 OAuth/静态令牌数量 |
| 注销其他会话 | POST /admin/api/credentials/revoke-sessions | 仅注销其他控制台登录会话 |
| ChatGPT 插件展示 | GET /admin/api/settings | MCP 服务地址、通用插件说明 |
| 系统设置 | GET/POST /admin/api/settings | 主题、刷新间隔、统计周期、展示名称 |
| 操作审计 | GET /admin/api/audit | 按条件查阅请求元数据 |
| 设备配对 | GET/POST /admin/api/pairing* | 短时配对窗口与审批 |

除登录入口外，所有接口均要求有效后台会话。修改操作要求 JSON、同源校验与每会话 CSRF Token（跨站请求伪造令牌）。接口不会返回 TOTP 密钥、OAuth 密钥、设备密钥、访问令牌或工具调用参数。

**注意：**本控制台统计的是网关 MCP 工具调用，不提供 ChatGPT 模型 Token 用量、计费数据或平台配额。

## 跨平台兼容性

- 浏览器：现代稳定版 Chrome、Edge、Firefox、Safari，以及对应移动浏览器。
- 操作系统：Gateway 使用 Node.js >= 22.13，Agent 面向 macOS、Windows、Linux；管理页面不依赖操作系统专属路径。
- 前端：原生 HTML、CSS、JavaScript，不依赖 CDN、外部字体、前端打包器或浏览器扩展。
- 适配：桌面侧边导航、移动端横向导航；跟随系统、浅色和深色主题。
- 安全：同源静态资源、严格 CSP（内容安全策略）；动态字符串均按文本处理。ChatGPT 标识以本地 SVG 提供。
- 离线：控制台静态资源可从网关直接服务，但设备实时状态和用量仍需访问网关数据库。

Node.js 22 的内置 SQLite 在部分版本中标记为实验性功能。升级后应先备份数据库并执行自动化测试。

## ChatGPT 自定义连接

插件展示页仅展示当前网关的 HTTPS /mcp 地址、图标和接入说明。修改展示名称或简介，不会在 ChatGPT 平台发布应用，也不会修改用户已经安装的连接。

是否能够添加自定义 MCP 连接，取决于 ChatGPT 产品、账户和工作空间能力。应采用网关既有的 OAuth 授权流程，禁止将 Owner Token、设备密钥或内部后台密码写入公开页面、截图、README 和工单。

## 配置项

展示设置存储在 SQLite settings 表内、以 ui_ 为前缀，服务器采用字段白名单：

- console_name：显示名称，1–64 字符
- ui_theme：system / light / dark
- ui_refresh_seconds：10 / 15 / 30 / 60
- usage_period_days：7 / 30 / 90
- plugin_name：连接展示名称，1–64 字符
- plugin_description：连接描述，最多 240 字符
- show_chatgpt_plugin：是否显示 ChatGPT 连接卡片

新增组件位于 gateway/ui/ 和 gateway/console-service.js；没有添加数据表或第三方依赖。原有认证、设备连接协议和网关端口配置均保持不变。

## 验证与回滚

本地依次执行：npm ci、npm test、python3 scripts/secret_scan.py。

还应验证未登录访问拒绝、TOTP 登录、CSRF 拒绝、设备重命名、非法设置拒绝、空统计区间、无设备、断线重连，以及 320px 宽度至桌面宽屏布局。

发布时仅替换本次 UI 和网关代码，保留原 SQLite 数据库、密钥文件和设备配置。生产部署前先备份，并通过独立控制通道完成更新，避免重启当前网关造成连接丢失。
