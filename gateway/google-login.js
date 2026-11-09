import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { sha256 } from './db.js';

const FLOW_TTL = 10 * 60_000;
const COOKIE_NAME = 'rmcp_google_flow';

/**
 * Google OpenID Connect 管理员登录。
 * 仅允许配置的邮箱白名单，邮箱只是准入条件，身份由 Google 签名 ID Token 证明。
 */
export function createGoogleLogin({ db, publicUrl, log, config = process.env, fetcher = fetch, verifier = null }) {
  const clientId = String(config.RMCP_GOOGLE_CLIENT_ID || '').trim();
  const secret = String(config.RMCP_GOOGLE_CLIENT_SECRET || '').trim();
  const allowed = new Set(String(config.RMCP_GOOGLE_ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const active = Boolean(clientId && secret && allowed.size && publicUrl.startsWith('https://'));
  const callback = new URL('/admin/auth/google/callback', publicUrl).toString();
  const client = verifier || new OAuth2Client(clientId);
  const secure = publicUrl.startsWith('https://');
  const sameOrigin = new URL(publicUrl).origin;

  db.exec(`CREATE TABLE IF NOT EXISTS google_login_flows (
    state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
    nonce TEXT NOT NULL, remember INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);

  const cookie = (value, seconds) =>
    `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/admin/auth/google; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const header = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
  const redirect = (res, where, cookieValue = null) => {
    res.writeHead(303, { ...header, location: where, ...(cookieValue ? { 'set-cookie': cookieValue } : {}) }); res.end();
  };
  const error = (res, reason) => redirect(res, '/admin/?google_error=' + encodeURIComponent(reason), cookie('', 0));

  /**
   * 生成 OAuth 授权请求；使用 state + PKCE + nonce 防范重放和登录 CSRF。
   * @param {IncomingMessage} req HTTP 请求
   * @param {ServerResponse} res HTTP 响应
   * @param {URL} url 已解析 URL
   * @returns {void} 无返回
   */
  function start(req, res, url) {
    if (!active) return error(res, 'not_configured');
    if (req.headers.origin && req.headers.origin !== sameOrigin) return error(res, 'origin');
    const remember = url.searchParams.get('remember') === '1';
    const state = crypto.randomBytes(32).toString('base64url');
    const browser = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    db.prepare('DELETE FROM google_login_flows WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO google_login_flows VALUES (?,?,?,?,?,?)').run(
      sha256(state), sha256(browser), codeVerifier, nonce, remember ? 1 : 0, Date.now() + FLOW_TTL
    );
    const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [k, v] of Object.entries({
      client_id: clientId, redirect_uri: callback, response_type: 'code',
      scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
      prompt: 'select_account',
    })) authorize.searchParams.set(k, v);
    redirect(res, authorize.toString(), cookie(browser, 600));
  }

  /**
   * 处理 Google 回调，在经过签名、受众、nonce、state 和邮箱校验后创建本地会话。
   * @param {IncomingMessage} req 请求
   * @param {ServerResponse} res 响应
   * @param {URL} url 回调地址
   * @param {(remember:boolean,email:string,sub:string)=>string} issue 创建会话并返回完整 Cookie
   * @returns {Promise<void>} 无返回
   */
  async function finish(req, res, url, issue) {
    if (!active) return error(res, 'not_configured');
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const browser = /(?:^|;\s*)rmcp_google_flow=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || '')?.[1] || '';
    if (!state || !browser) return error(res, 'invalid_state');
    // 无论后续请求是否成功，state 均一次性消费。
    const flow = db.prepare('DELETE FROM google_login_flows WHERE state_hash=? RETURNING *').get(sha256(state));
    if (!flow || flow.browser_hash !== sha256(browser) || flow.expires_at < Date.now() || !code || url.searchParams.has('error')) {
      return error(res, 'invalid_state');
    }
    try {
      const tokenReply = await fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: secret,
          redirect_uri: callback, grant_type: 'authorization_code', code_verifier: flow.verifier,
        }),
      });
      if (!tokenReply.ok) throw new Error('token_exchange');
      const tokens = await tokenReply.json();
      if (typeof tokens.id_token !== 'string') throw new Error('missing_id_token');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const payload = ticket.getPayload();
      const email = String(payload?.email || '').toLowerCase();
      if (!payload || payload.nonce !== flow.nonce || payload.email_verified !== true ||
          !allowed.has(email) || !payload.sub) {
        log('WARN', 'google admin: identity not allowed');
        return error(res, 'access_denied');
      }
      const sessionCookie = issue(flow.remember === 1, email, payload.sub);
      log('INFO', 'google admin: authorized account login');
      // 清理握手 Cookie，同时设置 HttpOnly 后台会话 Cookie。
      res.writeHead(303, { ...header, location: '/admin/',
        'set-cookie': [cookie('', 0), sessionCookie] }); res.end();
    } catch (e) {
      log('WARN', 'google admin: login failed (' + (e?.message || 'unknown') + ')');
      error(res, 'authentication_failed');
    }
  }

  return { active, start, finish };
}
