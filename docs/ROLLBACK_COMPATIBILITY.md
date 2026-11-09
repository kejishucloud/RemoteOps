# 回滚兼容版本（Google 登录上线前的功能集合）

此分支基于 `a4fdc9c`（Google 登录上线前的主干版本），仅作一项向前兼容修复：

```sql
-- 原实现（仅适用于旧 4 列 schema，禁止用作当前生产回滚）
INSERT INTO web_sessions VALUES (?,?,?,?);

-- 兼容实现（适用于 4 列旧 schema 以及新增 4 列的新版 schema）
INSERT INTO web_sessions (token_hash, csrf, created_at, last_seen) VALUES (?,?,?,?);
```

Google 登录已升级 SQLite 表 `web_sessions`，新增 `expires_at`、`idle_ms`、`provider`、`subject`。没有该修复，旧版 TOTP 登录可能在回滚后无法创建会话。

**本分支是可测试的回滚候选，不是已在 VPS 验证成功的成套回滚。** 该版本不包含 Google 管理员登录，回滚后只保留原有 TOTP 和 MCP OAuth。

测试方法：

```bash
npm ci
npm test
```

其中 `test/web.test.js` 会在测试网关启动前模拟已经升级的 8 列数据库，再验证旧版登录及控制台接口。

线上执行回滚前仍需用独立特权终端核实版本匹配、服务命令行参数、数据库备份与恢复能力。恢复时 Agent 和 Gateway 应从**同一版本**切换，不能只修改其中一个服务。
