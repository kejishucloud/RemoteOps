// Web admin console: /admin (static UI) and /admin/api/* (JSON). Login is TOTP only.
// Hardening: HttpOnly+SameSite=Strict cookie, per-session CSRF token + Origin check, global failure lockout,
// OTP replay refusal, idle/absolute session expiry, strict CSP (no inline script, no third-party resources).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { sha256, now } from './db.js';
import { newTotpSecret, verifyTotp, otpauthUri } from './totp.js';
import { CATALOG, NAME_RE } from '../agent/backends.js';
import { ConsoleService } from './console-service.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const ASSETS = { '/admin/': ['index.html', 'text/html; charset=utf-8'], '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/admin/console-views.js': ['console-views.js', 'text/javascript; charset=utf-8'], '/admin/style.css': ['style.css', 'text/css; charset=utf-8'], '/admin/chatgpt-mark.svg': ['chatgpt-mark.svg', 'image/svg+xml'] };
const IDLE_MS = 30 * 60_000, MAX_MS = 12 * 3600_000, LOCK_WINDOW = 15 * 60_000, LOCK_AFTER = 5;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createWeb({ db, publicUrl, log, devices, listDevices, revokeDevice, pushConfig }) {
  const origin = new URL(publicUrl).origin, secure = publicUrl.startsWith('https:');
  const host = new URL(publicUrl).host;
  const fails = [];
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
  const set = (k, v) => db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const del = (k) => db.prepare('DELETE FROM settings WHERE key=?').run(k);
  const consoleService = new ConsoleService({ db, publicUrl, listDevices });

  const baseHeaders = () => ({
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  const sendJson = (res, code, body, extra = {}) => { res.writeHead(code, { ...baseHeaders(), 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(body)); };
  const sendHtml = (res, code, body) => {
    res.writeHead(code, { ...baseHeaders(), 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>RemoteOps · 管理员验证设置</title><link rel="stylesheet" href="/admin/style.css"></head><body>
<header class="bar"><a class="brand" href="/admin/"><span class="brand-icon" aria-hidden="true">R<span class="brand-slash">/</span></span><span class="brand-name"><strong>RemoteOps</strong><small>管理控制台</small></span></a><span class="bar-spacer"></span><span class="header-security">安全初始化</span></header>
<div class="auth-page"><main class="auth-container setup-frame">${body}</main><footer class="auth-footer">管理员身份验证由自托管 Gateway 完成</footer></div></body></html>`);
  };
  const body = async (req, limit = 8192) => {
    let n = 0; const c = [];
    for await (const ch of req) { n += ch.length; if (n > limit) throw new Error('too large'); c.push(ch); }
    return Buffer.concat(c).toString('utf8');
  };
  const locked = () => { const t = Date.now(); while (fails.length && t - fails[0] > LOCK_WINDOW) fails.shift(); return fails.length >= LOCK_AFTER; };
  const lockRetry = () => Math.max(1, Math.ceil((LOCK_WINDOW - (Date.now() - fails[0])) / 1000));

  // ---- sessions ----
  const cookieOf = (req) => /(?:^|;\s*)rmcp_session=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || '')?.[1];
  function sessionOf(req) {
    const tok = cookieOf(req); if (!tok) return null;
    const row = db.prepare('SELECT * FROM web_sessions WHERE token_hash=?').get(sha256(tok));
    if (!row) return null;
    const t = Date.now();
    if (t - row.last_seen > IDLE_MS || t - row.created_at > MAX_MS) { db.prepare('DELETE FROM web_sessions WHERE token_hash=?').run(row.token_hash); return null; }
    db.prepare('UPDATE web_sessions SET last_seen=? WHERE token_hash=?').run(t, row.token_hash);
    return row;
  }
  const cookie = (v, maxAge) => `rmcp_session=${v}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const sweep = () => db.prepare('DELETE FROM web_sessions WHERE last_seen < ? OR created_at < ?').run(Date.now() - IDLE_MS, Date.now() - MAX_MS);

  // ---- setup (only while no TOTP is active) ----
  async function setup(req, res, p) {
    if (get('totp_secret')) return sendHtml(res, 404, '<span class=auth-step>安全验证已配置</span><h1>页面不可用</h1><p>管理员验证已经完成设置，请返回控制台登录。</p><p><a href=/admin/>返回控制台</a></p>'), true;
    const form = req.method === 'POST' ? Object.fromEntries(new URLSearchParams(await body(req))) : {};
    const page = (inner) => sendHtml(res, 200, inner);
    if (p === '/admin/setup' && req.method === 'GET')
      return page(`<span class=auth-step>步骤 01 / 02 · 验证管理员身份</span><h1>配置安全验证</h1><p>首次进入控制台需要绑定身份验证器。请先输入部署时生成的管理员 Owner Token。</p>
<form method=post action=/admin/setup><label for=owner-token>管理员 Owner Token</label><input id=owner-token type=password name=owner_token autocomplete=off autofocus placeholder="输入管理员令牌" required><button type=submit>验证并继续 →</button></form><p class=setup-hint>Owner Token 保存在你的 Gateway 服务器中，请通过安全的管理通道获取，不要将令牌发送到聊天或公开仓库。</p>`), true;
    if (p === '/admin/setup' && req.method === 'POST') {
      if (locked()) return sendHtml(res, 429, `<span class=auth-step>安全保护</span><h1>尝试次数过多</h1><p>请在 ${lockRetry()} 秒后重试。</p><p><a href=/admin/setup>返回验证页面</a></p>`), true;
      const ok = db.prepare('SELECT 1 FROM client_tokens WHERE token_hash=? AND is_admin=1 AND revoked_at IS NULL').get(sha256(form.owner_token || ''));
      if (!ok) { fails.push(Date.now()); log('WARN', 'web setup: bad owner token'); return sendHtml(res, 401, '<span class=auth-step>管理员身份验证</span><h1>管理员令牌不正确</h1><p>请确认令牌来自当前 Gateway 的管理员凭据。</p><p><a href=/admin/setup>重新输入</a></p>'), true; }
      const secret = newTotpSecret(); set('totp_pending', secret);
      const svg = await QRCode.toString(otpauthUri(secret, 'admin', `Remote MCP (${host})`), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      return page(`<span class=auth-step>步骤 02 / 02 · 绑定身份验证器</span><h1>扫描二维码</h1><p>使用 Google Authenticator、1Password 或其他兼容 TOTP 的验证器扫描下方二维码。</p>
<div class=qr>${svg}</div><p class=setup-hint>无法扫码？在验证器中手动输入以下密钥：</p><p><code class=key>${esc(secret.match(/.{1,4}/g).join(' '))}</code></p>
<form method=post action=/admin/setup/confirm><label for=setup-code>六位动态验证码</label><input id=setup-code name=code inputmode=numeric pattern="[0-9]{6}" maxlength=6 autocomplete=one-time-code placeholder="000000" autofocus required><button type=submit>确认并启用双因素验证 →</button></form>
<p class=setup-warning>密钥只会在本步骤显示。请勿截图、转发或保存到公开位置。</p>`), true;
    }
    if (p === '/admin/setup/confirm' && req.method === 'POST') {
      if (locked()) return sendHtml(res, 429, `<span class=auth-step>安全保护</span><h1>尝试次数过多</h1><p>请在 ${lockRetry()} 秒后重试。</p><p><a href=/admin/setup>返回验证页面</a></p>`), true;
      const pending = get('totp_pending');
      const step = pending && verifyTotp(pending, form.code);
      if (!step) { fails.push(Date.now()); return sendHtml(res, 400, '<span class=auth-step>验证码验证</span><h1>验证码不正确</h1><p>请确认验证器与服务器时间同步，然后<a href=/admin/setup>重新开始设置</a>。</p>'), true; }
      set('totp_secret', pending); set('totp_last_step', step); del('totp_pending');
      log('INFO', 'web admin: two-step login enabled');
      return sendHtml(res, 200, '<span class=auth-step>配置已完成</span><h1>管理员验证已启用</h1><p>现在可以使用身份验证器中的六位动态验证码登录控制台。</p><p><a class=primary-link href=/admin/>进入管理控制台 →</a></p><p class=setup-hint>请安全备份验证器账户。遗失设备后需通过 Gateway 的独立管理员通道执行恢复。</p>'), true;
    }
    return false;
  }

  // ---- JSON API ----
  async function api(req, res, url) {
    const p = url.pathname.replace('/admin/api', '');
    if (p === '/session' && req.method === 'GET') {
      const s = sessionOf(req);
      return sendJson(res, 200, s ? { authenticated: true, csrf: s.csrf } : { authenticated: false, enrolled: !!get('totp_secret') }), true;
    }
    if (req.method !== 'POST' && req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }), true;
    if (req.method === 'POST') {
      const o = req.headers.origin; if (o && o !== origin) return sendJson(res, 403, { error: 'bad origin' }), true;
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'json required' }), true;
    }
    let m = {}; if (req.method === 'POST') { try { m = JSON.parse((await body(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }), true; } }

    if (p === '/login' && req.method === 'POST') {
      const secret = get('totp_secret');
      if (!secret) return sendJson(res, 409, { error: 'two-step login not set up' }), true;
      if (locked()) return sendJson(res, 429, { error: 'locked', retry_after: lockRetry() }, { 'retry-after': lockRetry() }), true;
      const step = verifyTotp(secret, m.code, { lastStep: Number(get('totp_last_step') ?? -1) });
      if (!step) { fails.push(Date.now()); log('WARN', 'web login: bad code'); return sendJson(res, 401, { error: 'invalid code' }), true; }
      set('totp_last_step', step); fails.length = 0; sweep();
      const tok = crypto.randomBytes(32).toString('base64url'), csrf = crypto.randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO web_sessions VALUES (?,?,?,?)').run(sha256(tok), csrf, Date.now(), Date.now());
      log('INFO', 'web admin: signed in');
      return sendJson(res, 200, { csrf }, { 'set-cookie': cookie(tok, MAX_MS / 1000) }), true;
    }

    const s = sessionOf(req);
    if (!s) return sendJson(res, 401, { error: 'not signed in' }), true;
    if (req.method === 'POST' && !safeEq(String(req.headers['x-csrf-token'] || ''), s.csrf)) return sendJson(res, 403, { error: 'bad csrf token' }), true;

    if (p === '/logout' && req.method === 'POST') { db.prepare('DELETE FROM web_sessions WHERE token_hash=?').run(sha256(cookieOf(req))); return sendJson(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) }), true; }

    // ---- 管理驾驶舱：所有读取端点都必须通过后台会话认证 ----
    if (p === '/overview' && req.method === 'GET') {
      const days = Number(url.searchParams.get('days') || consoleService.settings().usage_period_days);
      if (![7, 30, 90].includes(days)) return sendJson(res, 400, { error: 'invalid days' }), true;
      return sendJson(res, 200, consoleService.overview(days)), true;
    }
    if (p === '/settings' && req.method === 'GET') return sendJson(res, 200, consoleService.settings()), true;
    if (p === '/settings' && req.method === 'POST') {
      try {
        const saved = consoleService.updateSettings(m);
        log('INFO', 'web admin: display settings updated');
        return sendJson(res, 200, saved), true;
      } catch (error) {
        if (error instanceof TypeError) return sendJson(res, 400, { error: error.message }), true;
        throw error;
      }
    }
    if (p === '/credentials' && req.method === 'GET') return sendJson(res, 200, consoleService.credentials()), true;
    if (p === '/credentials/revoke-sessions' && req.method === 'POST') {
      const removed = consoleService.revokeOtherSessions(sha256(cookieOf(req)));
      log('INFO', 'web admin: revoked other web sessions');
      return sendJson(res, 200, { ok: true, removed }), true;
    }
    if (p === '/devices' && req.method === 'GET') return sendJson(res, 200, listDevices()), true;
    let renameMatch = /^\/devices\/([^/]+)\/rename$/.exec(p);
    if (renameMatch && req.method === 'POST') {
      try {
        const id = decodeURIComponent(renameMatch[1]);
        const updated = consoleService.renameDevice(id, m.name);
        if (updated) log('INFO', 'web admin: device display name updated');
        return sendJson(res, updated ? 200 : 404, { ok: updated }), true;
      } catch (error) {
        if (error instanceof TypeError) return sendJson(res, 400, { error: error.message }), true;
        throw error;
      }
    }
    let mm;
    if ((mm = /^\/devices\/([^/]+)\/revoke$/.exec(p)) && req.method === 'POST') {
      const id = decodeURIComponent(mm[1]); const n = revokeDevice(id); log('INFO', `web admin: revoked device ${id}`);
      return sendJson(res, n ? 200 : 404, { revoked: n }), true;
    }

    // ---- per-device MCP servers ----
    if ((mm = /^\/devices\/([^/]+)\/backends(?:\/([^/]+)\/(update|remove))?$/.exec(p))) {
      const did = decodeURIComponent(mm[1]);
      const dev = db.prepare('SELECT device_id,name FROM devices WHERE device_id=? AND revoked_at IS NULL').get(did);
      if (!dev) return sendJson(res, 404, { error: 'unknown device' }), true;
      const live = devices.get(did);

      if (req.method === 'GET' && !mm[2]) {
        const rows = db.prepare('SELECT name,template,params,enabled,enabled_tools FROM device_backends WHERE device_id=? ORDER BY created_at').all(did);
        const st = new Map((live?.backends ?? []).map((b) => [b.name, b]));
        const shape = (name, extra) => { const b = st.get(name); return { name, status: live ? (b?.status ?? 'waiting for agent') : 'device offline', error: b?.error ?? null, prefix: b?.prefix ?? '', tools: b?.tools ?? [], enabled_tools: b?.enabled ?? [], ...extra }; };
        const servers = [shape('desktop-commander', { builtin: true, template: 'builtin', enabled: true, status: live ? (st.get('desktop-commander')?.status ?? 'running') : 'device offline' }),
          ...rows.map((r) => shape(r.name, { builtin: false, template: r.template, params: JSON.parse(r.params), enabled: !!r.enabled, explicit_tools: r.enabled_tools ? JSON.parse(r.enabled_tools) : null }))];
        const catalog = Object.entries(CATALOG).map(([id, t]) => ({ id, title: t.title, description: t.description, params: t.params, default_disabled: t.default_disabled }));
        return sendJson(res, 200, { device: { device_id: did, name: dev.name, online: !!live, custom_backends: !!live?.custom }, catalog, servers }), true;
      }

      if (req.method === 'POST' && !mm[2]) { // add
        const template = String(m.template ?? ''), params = m.params && typeof m.params === 'object' ? m.params : {};
        let name = template;
        if (template === 'custom') {
          name = String(m.name ?? '');
          if (!live) return sendJson(res, 409, { error: 'the device must be online to add a custom server' }), true;
          if (!live.custom) return sendJson(res, 403, { error: 'custom servers are disabled on this device (allow_custom_backends in its local policy.json)' }), true;
          if (!NAME_RE.test(name) || ['custom', 'desktop-commander'].includes(name)) return sendJson(res, 400, { error: 'name: lowercase letters, digits, dashes' }), true;
          const { command, args = [] } = params;
          if (typeof command !== 'string' || !command.trim() || command.length > 200 || !Array.isArray(args) || args.length > 20 || !args.every((a) => typeof a === 'string' && a.length <= 300)) return sendJson(res, 400, { error: 'command (string) and args (up to 20 strings) required' }), true;
        } else {
          const t = CATALOG[template]; if (!t) return sendJson(res, 400, { error: 'unknown template' }), true;
          for (const d of t.params) if (params[d.key] !== undefined && typeof params[d.key] !== d.type) return sendJson(res, 400, { error: `${d.key} must be ${d.type}` }), true;
        }
        if (db.prepare('SELECT COUNT(*) n FROM device_backends WHERE device_id=?').get(did).n >= 10) return sendJson(res, 400, { error: 'at most 10 servers per device' }), true;
        if (db.prepare('SELECT 1 FROM device_backends WHERE device_id=? AND name=?').get(did, name)) return sendJson(res, 409, { error: 'already added' }), true;
        db.prepare('INSERT INTO device_backends (device_id,name,template,params,enabled,created_at) VALUES (?,?,?,?,1,?)').run(did, name, template, JSON.stringify(params), now());
        log('INFO', `web admin: added MCP server ${name} to ${did}`); pushConfig(did);
        return sendJson(res, 200, { ok: true, name }), true;
      }

      if (req.method === 'POST' && mm[2]) {
        const name = decodeURIComponent(mm[2]);
        const row = db.prepare('SELECT 1 FROM device_backends WHERE device_id=? AND name=?').get(did, name);
        if (!row) return sendJson(res, 404, { error: 'unknown server' }), true;
        if (mm[3] === 'remove') { db.prepare('DELETE FROM device_backends WHERE device_id=? AND name=?').run(did, name); log('INFO', `web admin: removed MCP server ${name} from ${did}`); }
        else {
          if (typeof m.enabled === 'boolean') db.prepare('UPDATE device_backends SET enabled=? WHERE device_id=? AND name=?').run(m.enabled ? 1 : 0, did, name);
          if ('enabled_tools' in m) {
            const t = m.enabled_tools;
            if (t !== null && !(Array.isArray(t) && t.length <= 300 && t.every((x) => typeof x === 'string' && x.length <= 128))) return sendJson(res, 400, { error: 'enabled_tools must be null or a list of names' }), true;
            db.prepare('UPDATE device_backends SET enabled_tools=? WHERE device_id=? AND name=?').run(t === null ? null : JSON.stringify(t), did, name);
          }
        }
        if (mm[3] === 'update') log('INFO', `web admin: updated MCP server ${name} on ${did}` + (typeof m.enabled === 'boolean' ? ` enabled=${m.enabled}` : '') + ('enabled_tools' in m ? ` tools=${m.enabled_tools === null ? 'defaults' : m.enabled_tools.length}` : ''));
        pushConfig(did);
        return sendJson(res, 200, { ok: true }), true;
      }
    }

    if (p === '/clients' && req.method === 'GET') {
      const last = (cid) => db.prepare('SELECT MAX(timestamp) t FROM audit_logs WHERE client_id=?').get(cid).t;
      const mode = (cid) => db.prepare('SELECT tool_mode FROM client_settings WHERE client_id=?').get(cid)?.tool_mode ?? 'stable';
      const statics = db.prepare('SELECT client_id,is_admin,created_at,revoked_at FROM client_tokens ORDER BY created_at').all().map((c) => ({ ...c, principal: c.client_id, tool_mode: mode(c.client_id), last_used: last(c.client_id) }));
      const oauth = db.prepare("SELECT client_id,client_name,created_at,(SELECT COUNT(*) FROM oauth_tokens t WHERE t.client_id=c.client_id AND t.kind='refresh' AND t.revoked_at IS NULL AND t.expires_at>?) active_grants FROM oauth_clients c ORDER BY created_at").all(Date.now())
        .map((c) => { const principal = `oauth:${c.client_name}:${c.client_id.slice(2, 8)}`; return { ...c, principal, tool_mode: mode(principal), last_used: last(principal) }; });
      return sendJson(res, 200, { static: statics, oauth }), true;
    }
    if (p === '/clients/mode' && req.method === 'POST') { // how this client sees the tool list: 'stable' (fixed) or 'all' (live view of the selected device)
      const cid = String(m.client_id ?? '');
      const known = db.prepare('SELECT 1 FROM client_tokens WHERE client_id=?').get(cid)
        || db.prepare('SELECT client_id,client_name FROM oauth_clients').all().some((c) => `oauth:${c.client_name}:${c.client_id.slice(2, 8)}` === cid);
      if (!known || !['stable', 'all'].includes(m.mode)) return sendJson(res, 400, { error: 'unknown client or mode' }), true;
      db.prepare('INSERT INTO client_settings VALUES (?,?) ON CONFLICT(client_id) DO UPDATE SET tool_mode=excluded.tool_mode').run(cid, m.mode);
      return sendJson(res, 200, { ok: true }), true;
    }
    if ((mm = /^\/clients\/([^/]+)\/revoke$/.exec(p)) && req.method === 'POST') {
      const n = db.prepare('UPDATE client_tokens SET revoked_at=? WHERE client_id=? AND revoked_at IS NULL').run(now(), decodeURIComponent(mm[1])).changes;
      return sendJson(res, n ? 200 : 404, { revoked: n }), true;
    }
    if ((mm = /^\/oauth\/([^/]+)\/revoke$/.exec(p)) && req.method === 'POST') {
      const id = decodeURIComponent(mm[1]);
      db.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE client_id=? AND revoked_at IS NULL').run(now(), id);
      const n = db.prepare('DELETE FROM oauth_clients WHERE client_id=?').run(id).changes; // it must re-register and be re-approved
      return sendJson(res, n ? 200 : 404, { revoked: n }), true;
    }

    if (p === '/audit' && req.method === 'GET') {
      const q = url.searchParams, where = [], args = [];
      for (const [k, col] of [['client', 'client_id'], ['device', 'device_id'], ['status', 'status']]) if (q.get(k)) { where.push(`${col}=?`); args.push(q.get(k)); }
      if (q.get('tool')) { where.push("tool LIKE ? ESCAPE '\\'"); args.push(`%${q.get('tool').replace(/[\\%_]/g, (c) => '\\' + c)}%`); } // escape LIKE wildcards instead of dropping them
      const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 500);
      const rows = db.prepare(`SELECT id,timestamp,client_id,device_id,tool,request_id,duration_ms,status,error_code,error_detail FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit);
      return sendJson(res, 200, rows), true;
    }

    if (p === '/pairing' && req.method === 'GET') {
      const until = Number(get('pairing_open_until') ?? 0);
      const pending = db.prepare("SELECT id,code,device_id,hostname,platform,remote,created_at FROM pairing_requests WHERE status='pending' AND expires_at>? ORDER BY id").all(Date.now());
      return sendJson(res, 200, { open_until: until > Date.now() ? until : 0, pending }), true;
    }
    if (p === '/pairing/open' && req.method === 'POST') {
      const minutes = Math.min(Math.max(Number(m.minutes) || 3, 1), 5); set('pairing_open_until', Date.now() + minutes * 60_000);
      log('INFO', `web admin: pairing window opened for ${minutes} min`); return sendJson(res, 200, { open_until: Date.now() + minutes * 60_000 }), true;
    }
    if (p === '/pairing/close' && req.method === 'POST') {
      set('pairing_open_until', 0); db.prepare("UPDATE pairing_requests SET status='denied' WHERE status='pending'").run(); return sendJson(res, 200, { ok: true }), true;
    }
    if ((p === '/pairing/approve' || p === '/pairing/deny') && req.method === 'POST') {
      const n = db.prepare("UPDATE pairing_requests SET status=? WHERE id=? AND status='pending' AND expires_at>?").run(p.endsWith('approve') ? 'approved' : 'denied', Number(m.id), Date.now()).changes;
      return sendJson(res, n ? 200 : 404, { ok: n > 0 }), true;
    }
    return sendJson(res, 404, { error: 'not found' }), true;
  }

  return {
    async handle(req, res, url) {
      const p = url.pathname;
      if (!p.startsWith('/admin')) return false;
      try {
        if (p === '/admin') { res.writeHead(301, { location: '/admin/' }); res.end(); return true; }
        if (ASSETS[p] && req.method === 'GET') {
          const [file, type] = ASSETS[p];
          res.writeHead(200, { ...baseHeaders(), 'content-type': type }); res.end(fs.readFileSync(path.join(UI_DIR, file))); return true;
        }
        if (p.startsWith('/admin/setup')) return await setup(req, res, p);
        if (p.startsWith('/admin/api/')) return await api(req, res, url);
        sendJson(res, 404, { error: 'not found' }); return true;
      } catch (e) { log('ERROR', `web: ${e.message}`); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); return true; }
    },
  };
}
