'use strict';
// No innerHTML anywhere: every value (hostnames, tool names, ...) is untrusted and goes through textContent.
const $ = (s, r = document) => r.querySelector(s);
let csrf = null, tab = 'overview', timer = null, detail = null;

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'style') {
      // 严格 CSP 禁止 setAttribute('style', ...)；只允许数字化的布局属性通过 CSSOM 更新。
      // 动态值来自统计数据，做白名单校验，避免任意 CSS 注入。
      for (const declaration of String(v).split(';')) {
        const match = /^(height|width|opacity):((?:[0-9]+(?:\.[0-9]+)?)(?:px|%)?)$/.exec(declaration.trim());
        if (!match) continue;
        const [, property, value] = match;
        if (property === 'opacity' && Number(value) > 1) continue;
        if (property !== 'opacity' && !/(?:px|%)$/.test(value)) continue;
        e.style.setProperty(property, value);
      }
    }
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
async function api(path, opts = {}) {
  const r = await fetch('/admin/api' + path, {
    method: opts.body !== undefined ? 'POST' : (opts.method || 'GET'), credentials: 'same-origin',
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json', 'x-csrf-token': csrf || '' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('signed out'); }
  if (!r.ok) throw Object.assign(new Error(data.error || r.status), { status: r.status, data });
  return data;
}
function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.hidden = false; t.style.color = bad ? 'var(--bad)' : ''; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4000); }
const ago = (iso) => { if (!iso) return '从未'; const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`; };
const confirmDo = async (msg, fn) => { if (!confirm(msg)) return; try { await fn(); } catch (e) { toast(e.message, true); } };

// ---- login ----
function showLogin(enrolled = true) {
  clearInterval(timer); csrf = null; document.documentElement.dataset.theme = 'light'; $('#app').hidden = true; $('#logout').hidden = true; $('#login').hidden = false;
  $('#enroll').hidden = enrolled; $('#login-form').hidden = !enrolled; $('#code').value = ''; if (enrolled) $('#code').focus();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const msg = $('#login-msg'); msg.textContent = '';
  try { const r = await api('/login', { body: { code: $('#code').value.trim() } }); csrf = r.csrf; showApp(); }
  catch (err) {
    msg.textContent = err.status === 429 ? `验证次数过多，请在 ${Math.ceil((err.data.retry_after || 60) / 60)} 分钟后重试。`
      : err.status === 401 ? '验证码无效或已使用，请输入新的验证码。'
      : err.data?.error === 'bad origin' ? '访问地址不匹配，请使用网关配置的正式 HTTPS 地址。' : `登录失败：${err.message}`;
    $('#code').value = '';
  }
});
$('#logout').addEventListener('click', async () => { try { await api('/logout', { body: {} }); } catch {} showLogin(); });

/**
 * 打开工作台并加载持久化主题/刷新频率。
 * @returns {void} 无
 */
function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  render();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && !['audit', 'settings'].includes(tab)) render(); }, 15000);
  loadUISettings().catch((error) => toast('无法读取显示设置：' + error.message, true));
}

const pageInfo = {
  overview: ['运行总览', '统一查看设备状态、连接与工具调用情况。'],
  devices: ['设备管理', '查看跨平台 Agent 连接并管理各设备的 MCP 工具。'],
  usage: ['使用量统计', '分析网关工具调用趋势、延迟及错误情况。'],
  clients: ['认证信息', '管理 OAuth 客户端、令牌和后台安全会话。'],
  chatgpt: ['ChatGPT 插件展示', '配置自定义 MCP 服务的展示信息与接入说明。'],
  audit: ['操作审计', '检索各类工具请求的安全审计记录。'],
  pairing: ['设备配对', '通过限时授权窗口添加新的远程设备。'],
  settings: ['系统设置', '配置主题、刷新频率与连接展示信息。'],
};

/**
 * 统一的前端路由；不会修改浏览器 URL 或泄露设备信息。
 * @param {string} name 目标页面名称
 * @returns {void} 无
 */
function navigate(name) {
  if (!pageInfo[name]) return;
  tab = name;
  document.querySelectorAll('.tabs button').forEach((button) => {
    const current = button.dataset.tab === name;
    button.classList.toggle('active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  // 横向导航在窄屏时保证当前页面入口可见，不改变业务操作或路由。
  const active = document.querySelector('.tabs button.active');
  if (active && window.matchMedia('(max-width: 740px)').matches) {
    active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  }
  render();
}
document.querySelectorAll('.tabs button').forEach((button) =>
  button.addEventListener('click', () => navigate(button.dataset.tab)));
$('#refresh').addEventListener('click', render);

/** 当前页按需刷新并保持失败反馈。@returns {void} 无 */
function render() {
  for (const name of Object.keys(pageInfo)) $('#tab-' + name).hidden = name !== tab;
  const [title, subtitle] = pageInfo[tab];
  $('#page-title').textContent = title;
  $('#page-location').textContent = title;
  $('#page-subtitle').textContent = subtitle;
  const routes = {
    overview: renderOverview, devices: renderDevices, usage: renderUsage,
    clients: renderClientCenter, chatgpt: renderChatGPT,
    audit: renderAudit, pairing: renderPairing, settings: renderSettings,
  };
  routes[tab]().catch((error) => error.message !== 'signed out' && toast(error.message, true));
}

// ---- devices ----
/**
 * 设备管理：展示运行时获取的注册信息，不在仓库中保存实际设备名。
 * @returns {Promise<void>} 无
 */
async function renderDevices() {
  if (detail) return renderDeviceDetail();
  const devices = await api('/devices');
  const root = $('#tab-devices');
  const search = h('input', { type: 'search', placeholder: '搜索设备名称、系统或标识…', 'aria-label': '搜索设备' });
  const createTile = (d) => {
    const code = encodeURIComponent(d.device_id);
    const online = d.status === 'online';
    const platform = (d.platform || '').toLowerCase();
    const platformLabel = platform.includes('darwin') ? 'macOS' : platform.includes('win') ? 'Windows'
      : platform.includes('linux') ? 'Linux' : d.platform || '未知系统';
    // 平台统一使用简洁文字标记，避免不一致的 Unicode 图标造成视觉噪声。
    const avatar = platformLabel === 'Windows' ? 'WIN' : platformLabel === 'Linux' ? 'LIN' : platformLabel === 'macOS' ? 'MAC' : 'PC';
    return h('article', { class: 'device-tile' },
      h('div', { class: 'device-top' }, h('div', { class: 'device-avatar', 'aria-hidden': 'true' }, avatar),
        h('span', { class: 'pill ' + (online ? 'ok' : '') },
          h('span', { class: 'dot' + (online ? ' on' : '') }), online ? '在线' : '离线')),
      h('div', { class: 'device-title' }, d.name || d.device_id),
      h('div', { class: 'device-meta' },
        h('div', {}, platformLabel + ' · ' + d.device_id),
        h('div', {}, d.hostname || '未报告主机名'),
        h('div', {}, online ? '当前已连接' : '上次在线：' + ago(d.last_seen))),
      h('div', { class: 'device-actions' },
        h('button', { class: 'small', onclick: () => { detail = d.device_id; render(); } }, 'MCP 工具'),
        h('button', { class: 'small ghost', onclick: async () => {
          const next = prompt('设置设备显示名称（最多 64 个字符）', d.name || d.device_id);
          if (next === null || next.trim() === (d.name || d.device_id)) return;
          try { await api('/devices/' + code + '/rename', { body: { name: next.trim() } }); toast('设备名称已更新'); render(); }
          catch (error) { toast(error.message, true); }
        } }, '重命名'),
        h('button', { class: 'small ghost', onclick: () => confirmDo('注销设备「' + d.device_id + '」？注销后必须重新配对才能连接。', async () => {
          await api('/devices/' + code + '/revoke', { body: {} });
          toast('设备已注销'); render();
        }) }, '注销')));
  };
  const tiles = devices.map(createTile);
  const list = h('div', { class: 'device-grid' }, ...tiles);
  const empty = h('div', { class: 'empty-state' }, devices.length ? '没有匹配的设备。' : '尚无注册设备，请在「设备配对」中添加。');
  const filter = () => {
    const value = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    tiles.forEach((tile, index) => {
      const d = devices[index];
      const match = [d.name, d.device_id, d.hostname, d.platform].some((part) => String(part || '').toLocaleLowerCase().includes(value));
      tile.hidden = !match;
      if (match) visible++;
    });
    empty.hidden = visible !== 0;
  };
  search.addEventListener('input', filter);
  const summary = h('div', { class: 'list-head' },
    h('div', {}, h('h2', {}, '已注册设备 · ' + devices.length), h('p', { class: 'muted' }, '在线、离线和 MCP 服务状态来自网关实时上报。')),
    search);
  const add = h('button', { class: 'small', onclick: () => navigate('pairing') }, '+ 添加设备');
  root.replaceChildren(summary, h('div', { class: 'row' }, add), list, empty);
  filter();
}

// ---- device detail: MCP servers ----
const openTools = new Set();
const pillFor = (st) => h('span', { class: 'pill ' + (st === 'running' ? 'ok' : st === 'error' ? 'err' : '') }, st);
async function renderDeviceDetail() {
  const root = $('#tab-devices');
  const d = await api(`/devices/${encodeURIComponent(detail)}/backends`), base = `/devices/${encodeURIComponent(detail)}/backends`;
  const act = (path, body, msg) => async () => { try { await api(base + path, { body }); if (msg) toast(msg); render(); } catch (e) { toast(e.message, true); } };

  const rows = d.servers.map((sv) => {
    const eff = new Set(sv.enabled_tools || []);
    const toolsOpen = openTools.has(sv.name) && sv.tools.length;
    const checks = toolsOpen && !sv.builtin ? sv.tools.map((t) => h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-tool': t.name, checked: eff.has(t.name) }), ' ', h('b', {}, t.name), h('span', { class: 'sub' }, ' ' + (t.description || '').split('\n')[0]))) : [];
    return h('div', { class: 'item col' },
      h('div', { class: 'row' },
        h('div', { class: 'main' }, h('div', { class: 'name' }, sv.name, ' ', pillFor(sv.status), ' ', sv.builtin ? h('span', { class: 'pill' }, 'built-in') : null),
          h('div', { class: 'sub' }, sv.error ? h('span', { class: 'warn' }, sv.error) : `${sv.tools.length} tools${sv.prefix ? ' · prefix ' + sv.prefix : ''}${sv.builtin ? '' : ' · ' + sv.template}`)),
        sv.tools.length ? h('button', { class: 'small ghost', onclick: () => { openTools.has(sv.name) ? openTools.delete(sv.name) : openTools.add(sv.name); render(); } }, toolsOpen ? '收起工具' : '工具') : null,
        sv.builtin ? null : h('button', { class: 'small ghost', onclick: act(`/${encodeURIComponent(sv.name)}/update`, { enabled: !sv.enabled }) }, sv.enabled ? '禁用' : '启用'),
        sv.builtin ? null : h('button', { class: 'small danger', onclick: () => confirmDo(`Remove ${sv.name} from this device?`, act(`/${encodeURIComponent(sv.name)}/remove`, {}, 'Removed')) }, '移除')),
      toolsOpen && !sv.builtin ? h('div', { class: 'tools' }, ...checks,
        h('div', { class: 'row' },
          h('button', { class: 'small', onclick: async (e) => { const names = [...e.target.closest('.tools').querySelectorAll('input[data-tool]')].filter((i) => i.checked).map((i) => i.dataset.tool); await act(`/${encodeURIComponent(sv.name)}/update`, { enabled_tools: names }, 'Tools saved')(); } }, '保存'),
          h('button', { class: 'small ghost', onclick: act(`/${encodeURIComponent(sv.name)}/update`, { enabled_tools: null }, '恢复默认') }, '恢复默认'))) : null);
  });

  // add form
  const sel = h('select', {}, ...d.catalog.map((t) => h('option', { value: t.id }, t.title)), d.device.custom_backends ? h('option', { value: 'custom' }, 'Custom command…') : null);
  const desc = h('p', { class: 'sub' }), fields = h('div', {});
  const draw = () => {
    const t = d.catalog.find((c) => c.id === sel.value); fields.replaceChildren();
    if (t) { desc.textContent = t.description + (t.default_disabled.length ? ` Disabled by default: ${t.default_disabled.join(', ')}.` : ''); for (const p of t.params) fields.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-param': p.key, checked: !!p.default }), ' ' + p.label)); }
    else { desc.textContent = 'Runs any command as this device\'s user (it must be installed there; an absolute path is safest). Prefer a template when one exists.'; fields.append(h('input', { id: 'c-name', placeholder: 'name (a-z, 0-9, -)' }), h('input', { id: 'c-cmd', placeholder: 'command, e.g. npx' }), h('textarea', { id: 'c-args', rows: 3, placeholder: 'one argument per line' })); }
  };
  sel.addEventListener('change', draw); draw();
  const add = h('div', { class: 'item col' }, h('div', { class: 'name' }, '添加 MCP 服务'), sel, desc, fields,
    h('div', { class: 'row' }, h('button', { class: 'small', onclick: async () => {
      const body = { template: sel.value, params: {} };
      if (sel.value === 'custom') { body.name = $('#c-name').value.trim(); body.params = { command: $('#c-cmd').value.trim(), args: $('#c-args').value.split('\n').map((x) => x.trim()).filter(Boolean) }; }
      else fields.querySelectorAll('[data-param]').forEach((i) => (body.params[i.dataset.param] = i.checked));
      try { await api(base, { body }); toast('Added. The device is starting it (first run may download the package).'); render(); } catch (e) { toast(e.message, true); }
    } }, '添加'), d.device.online ? null : h('span', { class: 'sub' }, '设备当前离线，重连后将启动服务。')));

  root.replaceChildren(
    h('div', { class: 'row' }, h('button', { class: 'small ghost', onclick: () => { detail = null; render(); } }, '← 返回设备列表'), h('div', { class: 'name' }, d.device.name || d.device.device_id, ' ', h('span', { class: 'pill ' + (d.device.online ? 'ok' : '') }, d.device.online ? 'online' : 'offline'))),
    h('h2', {}, '当前设备的 MCP 服务'), ...rows, add);
  if (d.servers.some((x) => x.status === 'starting' || x.status === 'waiting for agent')) { clearTimeout(renderDeviceDetail.t); renderDeviceDetail.t = setTimeout(() => detail && tab === 'devices' && renderDeviceDetail().catch(() => {}), 3000); }
}

// ---- clients ----
const modeSelect = (c) => h('label', { class: 'sub' }, '工具列表模式：', h('select', { class: 'inline', onchange: async (e) => { try { await api('/clients/mode', { body: { client_id: c.principal, mode: e.target.value } }); toast('Saved. Reconnect the client to refresh its tool list.'); } catch (err) { toast(err.message, true); } } },
  h('option', { value: 'stable', selected: c.tool_mode === 'stable' }, '固定列表（推荐）'), h('option', { value: 'all', selected: c.tool_mode === 'all' }, '动态列表（随设备变化）')));
async function renderClients() {
  const { static: st, oauth } = await api('/clients'), root = $('#tab-clients');
  const stat = st.map((c) => h('div', { class: 'item' },
    h('div', { class: 'main' }, h('div', { class: 'name' }, c.client_id, ' ', c.is_admin ? h('span', { class: 'pill' }, 'owner') : null, ' ', c.revoked_at ? h('span', { class: 'pill err' }, 'revoked') : null),
      h('div', { class: 'sub' }, `static token · created ${ago(c.created_at)} · last used ${ago(c.last_used)}`), c.revoked_at || c.is_admin ? null : modeSelect(c)),
    c.revoked_at ? null : h('button', { class: 'small danger', onclick: () => confirmDo(`Revoke token "${c.client_id}"?` + (c.is_admin ? ' This is an OWNER token.' : ''), async () => { await api(`/clients/${encodeURIComponent(c.client_id)}/revoke`, { body: {} }); toast('Token revoked'); render(); }) }, '撤销')));
  const oa = oauth.map((c) => h('div', { class: 'item' },
    h('div', { class: 'main' }, h('div', { class: 'name' }, c.client_name, ' ', h('span', { class: 'pill ' + (c.active_grants ? 'ok' : '') }, c.active_grants ? '已授权' : '无有效授权')),
      h('div', { class: 'sub' }, `OAuth · registered ${ago(c.created_at)} · last used ${ago(c.last_used)}`), modeSelect(c)),
    h('button', { class: 'small danger', onclick: () => confirmDo(`Remove "${c.client_name}"? It must be approved again to reconnect.`, async () => { await api(`/oauth/${encodeURIComponent(c.client_id)}/revoke`, { body: {} }); toast('Client removed'); render(); }) }, '移除')));
  root.replaceChildren(h('h2', {}, 'OAuth 授权客户端'), ...(oa.length ? oa : [h('p', { class: 'muted' }, '暂无')]), h('h2', {}, '静态访问令牌'), ...(stat.length ? stat : [h('p', { class: 'muted' }, '暂无')]));
}

// ---- audit ----
const filt = { client: '', device: '', tool: '', status: '' };
async function renderAudit() {
  const root = $('#tab-audit'), q = new URLSearchParams({ limit: 150, ...Object.fromEntries(Object.entries(filt).filter(([, v]) => v)) });
  const rows = await api('/audit?' + q);
  const input = (k, ph) => h('input', { placeholder: ph, value: filt[k], onchange: (e) => { filt[k] = e.target.value.trim(); renderAudit(); } });
  const status = h('select', { onchange: (e) => { filt.status = e.target.value; renderAudit(); } }, ...['', 'success', 'error'].map((v) => h('option', { value: v, selected: filt.status === v }, v || 'any status')));
  const cell = (r, k) => h('td', {}, r[k] ?? '');
  const table = h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ...['time', 'client', 'device', 'tool', 'ms', 'status', 'detail'].map((c) => h('th', {}, c)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, new Date(r.timestamp).toLocaleString()), cell(r, 'client_id'), cell(r, 'device_id'), cell(r, 'tool'), cell(r, 'duration_ms'),
      h('td', {}, h('span', { class: 'pill ' + (r.status === 'success' ? 'ok' : 'err') }, r.error_code || r.status)), h('td', { class: 'sub' }, r.error_detail || ''))))));
  root.replaceChildren(h('div', { class: 'filters' }, input('client', 'client'), input('device', 'device'), input('tool', 'tool'), status), rows.length ? table : h('p', { class: 'muted' }, '没有符合条件的审计记录。'),
    h('p', { class: 'muted' }, '只记录调用元数据，不保存工具参数与输出。'));
}

// ---- pairing ----
async function renderPairing() {
  const p = await api('/pairing'), root = $('#tab-pairing'), left = Math.max(0, Math.round((p.open_until - Date.now()) / 1000));
  const pend = p.pending.map((r) => h('div', { class: 'item' },
    h('div', { class: 'main' }, h('div', { class: 'code' }, r.code), h('div', { class: 'sub' }, `${r.device_id} · ${r.hostname || '?'} (${r.platform || '?'}) · from ${r.remote || '?'}`),
      h('div', { class: 'sub' }, 'Approve only if this code is showing on the device you are setting up.')),
    h('button', { class: 'small', onclick: async () => { try { await api('/pairing/approve', { body: { id: r.id } }); toast('Approved. The device is collecting its credentials.'); render(); } catch (e) { toast(e.message, true); } } }, 'Approve'),
    h('button', { class: 'small ghost', onclick: async () => { try { await api('/pairing/deny', { body: { id: r.id } }); render(); } catch (e) { toast(e.message, true); } } }, 'Deny')));
  root.replaceChildren(
    h('div', { class: 'item' }, h('div', { class: 'main' }, h('div', { class: 'name' }, p.open_until ? `Window open · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : '配对窗口已关闭'),
      h('div', { class: 'sub' }, p.open_until ? 'On the new device run: node agent/agent.js pair <gateway-url> --device-id <name>' : '开放限时配对窗口，再从设备端发起配对。')),
      p.open_until ? h('button', { class: 'small ghost', onclick: async () => { await api('/pairing/close', { body: {} }); render(); } }, '立即关闭')
        : h('button', { class: 'small', onclick: async () => { await api('/pairing/open', { body: { minutes: 3 } }); render(); } }, '开放 3 分钟')),
    ...(pend.length ? pend : p.open_until ? [h('p', { class: 'muted' }, '等待设备申请配对…')] : []));
}

// ---- boot ----
(async () => {
  try { const s = await api('/session'); if (s.authenticated) { csrf = s.csrf; showApp(); } else showLogin(s.enrolled); } catch { showLogin(); }
})();
