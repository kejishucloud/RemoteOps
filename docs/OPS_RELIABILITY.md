# RemoteOps VPS 可靠性与发布一致性

> 状态基线：2026-11-09。下述检查来源于 VPS 的只读 RemoteOps Agent；生产级修改需独立、受授权的系统管理员终端执行，不要通过即将被重启的 Agent 自身运行。

## 1. 发布兼容审计（P0）

当前运行状态：

| 组件 | 发布目录 | 内部协议 |
| --- | --- | --- |
| Gateway | `/opt/kejishucloud/RemoteOps-google-f6dc917` | 1 |
| Agent | `/opt/kejishucloud/RemoteOps-c84903d` | 1 |

旧 Agent 与新 Gateway 已完成握手，**当前兼容**，但提交不一致导致成套回滚不透明。版本号 `0.1.0` 不足以追踪具体 Git 提交。

读取版本报告：

```bash
python3 scripts/ops_guard.py releases \
  --agent /opt/kejishucloud/RemoteOps-c84903d \
  --gateway /opt/kejishucloud/RemoteOps-google-f6dc917
```

`--strict` 会在 Git 提交无法核对或不一致时返回状态码 3；协议不兼容时返回状态码 2。**只读检查，不会重启服务。**

### 成套版本切换推荐设计

以单一不可变发布目录保存完整 Agent + Gateway 代码（`/opt/kejishucloud/RemoteOps-<gitsha>`），为两个 systemd 服务引入**同一 release symlink**（例如 `/opt/kejishucloud/RemoteOps-current`）。Gateway `WorkingDirectory` 和 Agent `ExecStart` 必须指向同一 symlink；不要只修改 Gateway。应用发布前记录两个服务的 **完整** systemd 单元及 drop-in 配置，同时保留上一个发布目录。

第一次实施时：
1. 使用独立 SSH/root 连接，确认两个服务当前的 `ExecStart`、`WorkingDirectory`、`LoadCredential`、`ReadWritePaths`，不打印密钥。
2. 对 SQLite 在线备份并执行独立恢复验证。确保目标目录已经安装依赖、同一 Git 提交且协议兼容。
3. 保留历史 systemd drop-in 副本。让两个服务都引用同一目标发布（Agent 的 `--config`、`--policy` 原样保留，Gateway `--public-url` 原样保留）。
4. `systemctl daemon-reload` 后依次重启 Gateway、Agent，验证 `/health`、`/admin/`、设备重新握手和工具调用。
5. 失败时将 symlink 和**两个** systemd 服务配置恢复到先前组合，重新启动两个服务并重复验证。数据库已发生不可逆迁移时不得直接用旧版本打开新数据库；需由数据库备份回滚并确认数据损失窗口。

**绝不通过需要重启的 Agent 会话触发自重启**，否则连接断开后可能无法观察回滚结果。

## 2. 内存与 OOM 监控（P1）

VPS：物理内存 961 MiB，Swap 1 GiB。当前读数（cgroup v2）：

| 指标 | VPS Agent | Gateway |
| --- | ---: | ---: |
| memory.current | 60.5 MiB | 34.4 MiB |
| memory.peak | 167.1 MiB | 38.1 MiB |
| memory.max | 250 MiB | max（无限额） |
| memory.swap.current | 109.1 MiB | 0 MiB |
| memory.events oom_kill | 0 | 0 |
| memory.events max | 0 | 0 |

**不立即提升 250 MiB 限额**。先按 1～5 分钟采样当前内存、Swap、peak、max、oom_kill；按日保留历史，峰值超过上限 80% 或 max/oom_kill 增量大于零时告警。可以把结果发往现有监控系统，但要避免日志或告警泄露命令参数、令牌等敏感数据。

```bash
python3 scripts/ops_guard.py memory \
  --service kejishu-remoteops-vps-agent.service \
  --service kejishu-mcp-gateway.service
```

该命令不依赖 root；如果指标不可读，会返回 null，不应当被解释为零。重启计数需从 `systemctl show ... -p NRestarts` 或系统日志读取；当前 RemoteOps Agent 的最小权限不能读取系统日志，因此该项尚未完整验收。

## 3. SQLite 一致性备份与隔离恢复（P1）

已知数据目录 `/home/rdcagent/kejishu-mcp-data/`、数据库 `mcp.db`。此前已生成备份：
`/home/rdcagent/kejishu-mcp-data/backups/mcp-before-google-20261109T101019Z.db`
且创建时 `PRAGMA integrity_check = ok`，但**尚未对这个真实备份完成独立恢复演练**。

工具实现了：
- 在线 SQLite Backup API：一致性备份，不直接复制运行中的 `db`、`-wal`、`-shm`；
- 将备份转换成可独立使用的非 WAL 快照，生成仅当前账号可读的权限 `0600`；
- 在独立临时目录中还原一份，验证原始与恢复后的完整性检查、表名及逐表行数一致；不打印任何真实业务行；
- 绝不直接覆盖生产数据库。

应使用拥有数据访问权的服务账号/独立特权终端执行：

```bash
# 只读验证已存在的真实备份（必须由具有备份读取权限的账号执行）
python3 scripts/ops_guard.py restore-verify \
  --backup /home/rdcagent/kejishu-mcp-data/backups/mcp-before-google-20261109T101019Z.db

# 下一次生产备份，用一个全新的文件名，拒绝覆盖历史备份
python3 scripts/ops_guard.py backup \
  --source /home/rdcagent/kejishu-mcp-data/mcp.db \
  --destination /home/rdcagent/kejishu-mcp-data/backups/mcp-new-YYYYMMDDTHHMMSSZ.db
```

两步都应记录执行时间、检查结果和备份文件 SHA256；定期额外执行**使用临时数据库启动只读演练环境**的验证。恢复演练不等于生产系统已实际回滚。

## 4. Google OpenID Connect（OIDC，开放身份认证）登录

后端代码位于 `gateway/google-login.js`，已实现安全的 Google OAuth 2.0 授权码 + PKCE + state + nonce + Google ID Token 签名校验与管理员白名单。当前生产管理后台 `GET /admin/api/session` 未报告 `google_enabled=true`，说明 **真实 Google 登录尚未生效**。TOTP 原有登录仍然有效。

需要在 [Google Cloud Console → Clients](https://console.cloud.google.com/auth/clients) 创建 Web application OAuth Client；Google 凭据必须保存在只允许 Gateway 服务读取的受保护配置（**不得提交 Git、放进聊天**）。

当前设置中 `RMCP_PUBLIC_URL` 为：
`https://kejishu-mcp.tail10c99d.ts.net`

若 Google Cloud 接受该回调地址，可使用：
`https://kejishu-mcp.tail10c99d.ts.net/admin/auth/google/callback`

不过 Google 的 OAuth 品牌验证要求对所用域名具有相应授权；对于 `*.ts.net` 这类共享服务域，**不能假设可以完成正式域名验证**。长期建议使用已验证、用户控制的独立 HTTPS 域名，并同步更新 Gateway 的 `RMCP_PUBLIC_URL`、反向代理、OAuth 回调和 ChatGPT MCP 接入，切换时必须保证旧客户端连续性。

受保护的服务环境必须设置：

```dotenv
RMCP_GOOGLE_CLIENT_ID=<Google Cloud Web OAuth Client ID>
RMCP_GOOGLE_CLIENT_SECRET=<Google Cloud OAuth Client Secret>
RMCP_GOOGLE_ALLOWED_EMAILS=<经授权的管理员邮箱，多个以英文逗号分隔>
```

验收顺序：检查后台出现 Google 登录按钮 → Google 同意界面 → 回调后后台 `/session` 返回 authenticated=true → 30 天与短期会话有效期 → 非白名单账户拒绝 → 退出登录后原 Cookie 无效。当前真实回调因为未取得 Google Cloud 应用凭据，尚未验收。

## 5. 回归指令

```bash
python3 -m unittest discover -s test -p test_ops_guard.py -v
npm ci
npm test
python3 scripts/secret_scan.py
```

部署与回滚的操作权限必须和终端工具执行权限隔离，不能为了方便运维而开放默认 Agent 的系统配置写权限。
