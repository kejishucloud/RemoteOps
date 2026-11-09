/**
 * 管理控制台回归测试：使用内存数据库和本地随机端口。
 * 模拟设备名和操作记录均为通用测试值，不依赖真实设备或登录凭据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { openDb, newSecret, sha256 } from '../gateway/db.js';
import { createWeb } from '../gateway/web.js';
import { ConsoleService } from '../gateway/console-service.js';
import { newTotpSecret, totp } from '../gateway/totp.js';

/** 将假设备写入测试数据库。@param {object} db 数据库 @returns {void} 无 */
function seedDevice(db) {
  db.prepare('INSERT INTO devices(device_id,name,platform,hostname,secret_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run('test-device', 'Test Device', 'linux-x64', 'example.local', sha256(newSecret()), new Date().toISOString());
}

/** 写入当前审计调用。@param {object} db 数据库 @param {string} status 状态 @returns {void} 无 */
function seedAudit(db, status) {
  db.prepare('INSERT INTO audit_logs(timestamp,client_id,device_id,tool,duration_ms,status) VALUES(?,?,?,?,?,?)')
    .run(new Date().toISOString(), 'demo-client', 'test-device', 'test_tool', 20, status);
}

test('控制台统计、配置白名单、隐私和设备重命名', () => {
  const db = openDb(':memory:');
  try {
    seedDevice(db);
    seedAudit(db, 'success');
    seedAudit(db, 'error');
    const service = new ConsoleService({
      db, publicUrl: 'https://gateway.example.com',
      listDevices: () => [{ device_id: 'test-device', status: 'online' }],
    });

    const report = service.overview(7);
    assert.equal(report.devices.online, 1);
    assert.equal(report.usage.calls, 2);
    assert.equal(report.usage.successes, 1);
    assert.equal(report.usage.failures, 1);
    assert.equal(report.usage.success_rate, 50);
    assert.equal(report.trend.length, 7);
    assert.equal(report.top_tools[0].tool, 'test_tool');
    assert.equal(service.settings().mcp_url, 'https://gateway.example.com/mcp');
    assert.throws(() => service.overview(999), RangeError);

    const prefs = service.updateSettings({ console_name: 'Generic Console', ui_theme: 'dark', usage_period_days: 30 });
    assert.equal(prefs.console_name, 'Generic Console');
    assert.equal(prefs.ui_theme, 'dark');
    assert.equal(prefs.usage_period_days, 30);
    assert.equal(service.settings().console_name, 'Generic Console');
    assert.throws(() => service.updateSettings({ api_token: 'test-secret' }), TypeError);
    assert.throws(() => service.updateSettings(JSON.parse('{"__proto__":{"admin":true}}')), TypeError);
    assert.throws(() => service.updateSettings({ ui_refresh_seconds: -1 }), TypeError);
    assert.throws(() => service.updateSettings({ plugin_name: '<script>alert(1)</script>\n' }), TypeError);
    assert.equal(service.renameDevice('test-device', 'Renamed Device'), true);
    assert.equal(db.prepare("SELECT name FROM devices WHERE device_id='test-device'").get().name, 'Renamed Device');
    assert.equal(service.renameDevice('missing', 'Unknown'), false);
    assert.throws(() => service.renameDevice('test-device', '\n'), TypeError);

    db.prepare("INSERT INTO settings(key,value) VALUES ('totp_secret','sensitive-value')").run();
    assert.equal(service.credentials().totp_enabled, true);
    assert.ok(!JSON.stringify(service.credentials()).includes('sensitive-value'));
    assert.ok(!JSON.stringify(service.settings()).includes('sensitive-value'));
    assert.ok(!JSON.stringify(service.overview()).includes('sensitive-value'));
  } finally { db.close(); }
});

test('控制台 HTTP API：鉴权、CSRF、统计、重命名与设置修改', async () => {
  const db = openDb(':memory:');
  seedDevice(db);
  seedAudit(db, 'success');
  const totpSecret = newTotpSecret();
  db.prepare("INSERT INTO settings(key,value) VALUES('totp_secret',?)").run(totpSecret);
  db.prepare("INSERT INTO settings(key,value) VALUES('totp_last_step','-1')").run();
  let web;
  const server = http.createServer((req, res) => {
    web.handle(req, res, new URL(req.url, 'http://' + req.headers.host))
      .catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  web = createWeb({
    db, publicUrl: base, devices: new Map(),
    log: () => {},
    listDevices: () => [{ device_id: 'test-device', name: db.prepare("SELECT name FROM devices WHERE device_id='test-device'").get().name, status: 'offline' }],
    revokeDevice: () => 0,
    pushConfig: () => {},
  });
  try {
    const request = async (path, { body, cookie, csrf } = {}) => {
      const response = await fetch(base + '/admin/api' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json', 'x-csrf-token': csrf || '' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { code: response.status, json: await response.json(), headers: response.headers };
    };
    assert.equal((await request('/overview')).code, 401);
    assert.equal((await request('/credentials')).code, 401);
    assert.equal((await request('/settings')).code, 401);
    const login = await request('/login', { body: { code: totp(totpSecret) } });
    assert.equal(login.code, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const csrf = login.json.csrf;
    const auth = { cookie, csrf };
    const overview = await request('/overview?days=7', auth);
    assert.equal(overview.code, 200);
    assert.equal(overview.json.usage.calls, 1);
    assert.equal((await request('/overview?days=42', auth)).code, 400);
    assert.equal((await request('/credentials', auth)).json.totp_enabled, true);
    assert.equal((await request('/settings', auth)).json.ui_theme, 'system');
    assert.equal((await request('/settings', { ...auth, body: { ui_theme: 'dark' } })).json.ui_theme, 'dark');
    assert.equal((await request('/settings', { cookie, body: { ui_theme: 'light' } })).code, 403);
    assert.equal((await request('/settings', { ...auth, body: { hidden_secret: 'any' } })).code, 400);
    assert.equal((await request('/devices/test-device/rename', { ...auth, body: { name: 'Linux Example' } })).code, 200);
    assert.equal((await request('/devices', auth)).json[0].name, 'Linux Example');
    assert.equal((await request('/devices/test-device/rename', { ...auth, body: { name: '' } })).code, 400);
    assert.equal((await request('/credentials/revoke-sessions', { ...auth, body: {} })).code, 200);
    for (const asset of ['/', '/app.js', '/console-views.js', '/style.css', '/chatgpt-mark.svg']) {
      const response = await fetch(base + '/admin' + asset);
      assert.equal(response.status, 200, 'asset ' + asset + ' should load');
      assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    }
    const html = await (await fetch(base + '/admin/')).text();
    assert.match(html, /data-tab="overview"/);
    assert.match(html, /data-tab="settings"/);
    assert.ok(!html.includes('example.local'), 'HTML template must not embed device data');
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    db.close();
  }
});
