# 管理后台 Google 登录与 30 天保持登录

## 功能与安全边界

本功能只用于 `/admin/` 的管理员网页登录。MCP 客户端的 `/authorize`、`/token` 和 ChatGPT OAuth 独立运行，不受本功能影响。Google 账户使用 **OpenID Connect（开放身份认证）**，邮箱必须在服务端白名单中；不开放公共自助注册，不允许任意 Google 账号取得远程命令权限。

- 身份验证器（TOTP）登录继续可用，用于应急管理。
- Google 登录采用 OAuth 2.0 授权码、PKCE S256、state、浏览器绑定 Cookie 和 OIDC nonce。
- 服务端通过 Google ID Token 的签名、发行者、受众、有效期和验证邮箱状态校验身份，再匹配邮箱白名单。
- 未勾选“保持登录 30 天”：最大有效期 12 小时、空闲超过 30 分钟失效。勾选后：最大 30 天；服务端数据库记录过期时间。退出登录/撤销其他会话会立即失效。
- Cookie 为 HttpOnly；HTTPS 下启用 Secure；Google 回调的会话采用 SameSite=Lax 以支持跨站授权重定向；TOTP 会话保留 SameSite=Strict；所有后台 JSON 写接口继续校验 Origin 和 CSRF。
- Google 注册/登录表示**白名单用户首次登录自动开通管理员访问权**，不提供公开注册入口。仅凭 Google 邮箱不等于管理员身份。

## Google Cloud Console 配置

1. 打开 [Google Cloud Console](https://console.cloud.google.com/apis/credentials)，选择项目，配置 OAuth consent screen（OAuth 同意界面）及所需测试用户或发布状态。
2. 创建 **OAuth Client ID → Web application（Web 应用）**，按照生产部署配置 Authorized redirect URI：
   `https://实际网关域名/admin/auth/google/callback`。
3. 在 VPS Gateway 的受保护环境中设置以下值（不要提交到 GitHub，也不要复制到聊天）：

```bash
RMCP_PUBLIC_URL=https://实际网关域名
RMCP_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
RMCP_GOOGLE_CLIENT_SECRET=从Google控制台获取
RMCP_GOOGLE_ALLOWED_EMAILS=owner@gmail.com,another-owner@gmail.com
```

4. 重启 Gateway 服务以加载环境变量，再打开 `https://实际网关域名/admin/`。只有三项 Google 参数与 HTTPS 公网地址都配置完整时，登录页才显示 Google 按钮。
5. 先验证 TOTP 和已连接设备，再进行 Google 登录。若服务器时间偏移、回调 URI 不完全一致或 OAuth consent screen 用户不在测试名单中，Google 可能拒绝授权。

## 会话生命周期

服务端表 `web_sessions` 迁移增加 `expires_at`、`idle_ms`、`provider` 和 `subject` 字段；迁移保持原数据。服务端始终校验过期与空闲期限，不能通过编辑 Cookie 延长。数据库旧会话沿用原本 12 小时/30 分钟策略。

**安全注意事项**：30 天免登录仅建议在个人可信设备使用；它并非 30 天免认证的 Google Refresh Token，不会在本地存储 Google Access Token 或 Refresh Token。管理员仍需安全保存 TOTP 及 Owner Token，应保护服务器数据库备份（备份中含有效会话摘要）。

## 验证

```bash
npm ci
node --test test/google-login.test.js
npm test
npm run check:secrets
```

覆盖 Google 白名单、state 重放、nonce、邮箱验证、30 天选择和现有后台接口回归。**正式上线前**仍须在实际 Google OAuth 客户端和 HTTPS 域名下完成一次真实授权回调测试。