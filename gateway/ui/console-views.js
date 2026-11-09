'use strict';
/**
 * RemoteOps 控制台扩展视图。
 * 仅处理浏览器侧展示：所有真实设备和使用量均由登录后的 API 动态返回。
 * 所有外部数据通过 textContent 插入，不拼接 HTML，杜绝脚本注入。
 */
let uiPreferences = null;
let usageDays = 7;

/** 数字格式化。@param {number} value 原值 @returns {string} 本地格式化值 */
function numberLabel(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

/**
 * 创建统计卡片。
 * @param {string} label 标题
 * @param {string|number} value 当前值
 * @param {string} hint 底部说明
 * @param {string} symbol 图标
 * @returns {HTMLElement} 指标卡片
 */
function metricCard(label, value, hint, symbol = '◈') {
  return h('div', { class: 'kpi' },
    h('span', { class: 'kpi-icon', 'aria-hidden': 'true' }, symbol),
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, String(value)),
    h('div', { class: 'kpi-foot' }, hint));
}

/**
 * 创建可复用的内容板块。
 * @param {string} title 板块名称
 * @param {...Node} nodes 正文节点
 * @returns {HTMLElement} 内容卡片
 */
function panel(title, ...nodes) {
  return h('article', { class: 'panel' },
    h('div', { class: 'panel-heading' }, h('h2', {}, title)), ...nodes);
}

/** 恢复刷新间隔与主题。@param {object} settings 配置 @returns {void} 无 */
function applyPreferences(settings) {
  uiPreferences = settings;
  usageDays = settings.usage_period_days;
  document.documentElement.dataset.theme = settings.ui_theme;
  $('#brand-name').textContent = settings.console_name;
  document.title = settings.console_name + ' · 管理控制台';
  if (!$('#app').hidden) {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!document.hidden && !['audit', 'settings'].includes(tab)) render();
    }, Number(settings.ui_refresh_seconds || 15) * 1000);
  }
}

/** 登录后读取配置；没有配置时仍允许使用已有功能。@returns {Promise<void>} 配置结束 */
async function loadUISettings() {
  const settings = await api('/settings');
  applyPreferences(settings);
}

/**
 * 使用普通 DOM 展示工具调用趋势，零使用量也会显示正确刻度。
 * @param {Array<object>} trend 每日计数
 * @returns {HTMLElement} 图表节点
 */
function trendChart(trend) {
  // 30 天合并为两日组，90 天合并为每周组，避免移动端过多柱子导致横向溢出。
  const interval = trend.length > 30 ? 7 : trend.length > 14 ? 2 : 1;
  const series = [];
  for (let i = 0; i < trend.length; i += interval) {
    const group = trend.slice(i, i + interval);
    series.push({
      start: group[0].day, end: group[group.length - 1].day,
      calls: group.reduce((total, item) => total + (Number(item.calls) || 0), 0),
    });
  }
  const max = Math.max(1, ...series.map((item) => item.calls));
  const bars = series.map((item) => {
    const height = item.calls ? Math.max(3, Math.round(item.calls / max * 100)) : 2;
    return h('div', { class: 'chart-col',
      title: item.start + (item.start === item.end ? '' : ' 至 ' + item.end) + '：' + item.calls + ' 次调用' },
      h('div', { class: 'chart-bar', style: 'height:' + height + '%;opacity:' + (item.calls ? '1' : '.22') }));
  });
  return h('div', {},
    h('div', { class: 'bar-chart', role: 'img', 'aria-label': '工具调用趋势图' }, ...bars),
    h('div', { class: 'chart-axis' },
      h('span', {}, series[0]?.start || '—'),
      h('span', {}, series[series.length - 1]?.end || '—')));
}

/** 创建最新设备在线状态清单。@param {Array<object>} devices 动态设备列表 @returns {HTMLElement} 清单 */
function onlineDeviceList(devices) {
  return h('div', {}, ...(devices.length ? devices.map((device) =>
    h('div', { class: 'info-line' },
      h('div', {}, h('strong', {}, device.name || device.device_id),
        h('div', { class: 'muted mono' }, device.device_id)),
      h('span', { class: 'pill ' + (device.status === 'online' ? 'ok' : '') },
        device.status === 'online' ? '在线' : '离线')))
    : [h('p', { class: 'muted' }, '暂无已注册设备')]));
}

/** 总览视图：关键指标、调用趋势和在线设备。@returns {Promise<void>} 无 */
async function renderOverview() {
  const d = await api('/overview?days=' + usageDays);
  const root = $('#tab-overview');
  const stats = d.usage;
  const kpis = h('div', { class: 'kpi-grid' },
    metricCard('已注册设备', numberLabel(d.devices.total), d.devices.online + ' 台当前在线', '▣'),
    metricCard('工具调用', numberLabel(stats.calls), '近 ' + d.days + ' 天', '▤'),
    metricCard('调用成功率', stats.success_rate + '%', numberLabel(stats.successes) + ' 次成功', '✓'),
    metricCard('已授权客户端', numberLabel(d.clients), '静态令牌与 OAuth 客户端', '◈'));
  const chart = panel('调用量趋势', trendChart(d.trend));
  const online = panel('设备连接状态', onlineDeviceList(d.devices.list));
  const summary = h('div', { class: 'split' }, chart, online);
  const footer = h('div', { class: 'split' },
    panel('运行质量',
      h('div', { class: 'metric-row' }, h('span', { class: 'muted' }, '平均调用耗时'), h('strong', {}, stats.average_ms + ' ms')),
      h('div', { class: 'metric-row' }, h('span', { class: 'muted' }, '失败调用'), h('strong', {}, numberLabel(stats.failures))),
      h('div', { class: 'meter' }, h('span', { style: 'width:' + stats.success_rate + '%' })),
      h('p', { class: 'panel-sub' }, '统计基于已持久化的审计记录，非模型 Token 用量。')),
    panel('快速入口',
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => navigate('devices') }, '查看设备管理'),
        h('button', { class: 'small ghost', onclick: () => navigate('usage') }, '使用量详情'),
        h('button', { class: 'small ghost', onclick: () => navigate('pairing') }, '添加设备'))));
  root.replaceChildren(kpis, summary, footer);
}

/**
 * 统计时间切换控件。
 * @returns {HTMLElement} 可交互选择器
 */
function daysSelector() {
  return h('select', {
    class: 'inline', 'aria-label': '统计时间范围',
    onchange: (event) => { usageDays = Number(event.target.value); renderUsage().catch((e) => toast(e.message, true)); },
  }, ...[7, 30, 90].map((days) =>
    h('option', { value: days, selected: usageDays === days }, '最近 ' + days + ' 天')));
}

/** 统计页面：设备排名、工具调用和失败率。@returns {Promise<void>} 无 */
async function renderUsage() {
  const data = await api('/overview?days=' + usageDays);
  const root = $('#tab-usage');
  const total = data.usage.calls || 0;
  const header = h('div', { class: 'section-intro' },
    h('div', {}, h('h2', {}, '调用分析'), h('p', {}, '网关审计数据 · 不包含敏感参数和工具输出')),
    daysSelector());
  const stats = h('div', { class: 'kpi-grid' },
    metricCard('总调用', numberLabel(total), '选定统计区间', '▥'),
    metricCard('成功', numberLabel(data.usage.successes), '成功率 ' + data.usage.success_rate + '%', '✓'),
    metricCard('失败', numberLabel(data.usage.failures), '审计记录中非 success 的调用', '!'),
    metricCard('平均耗时', data.usage.average_ms + ' ms', '有记录的调用耗时均值', '◷'));
  const top = data.top_tools.length
    ? data.top_tools.map((item) =>
      h('div', { class: 'info-line' },
        h('span', { class: 'mono' }, item.tool),
        h('strong', {}, numberLabel(item.calls) + ' 次')))
    : [h('p', { class: 'muted' }, '当前区间暂无工具调用记录')];
  const devices = data.per_device.length
    ? data.per_device.map((item) =>
      h('div', { class: 'info-line' },
        h('span', { class: 'mono' }, item.device_id),
        h('div', {}, h('strong', {}, numberLabel(item.calls) + ' 次'),
          h('div', { class: 'muted' }, numberLabel(item.failures) + ' 次失败'))))
    : [h('p', { class: 'muted' }, '当前区间暂无设备调用记录')];
  root.replaceChildren(header, stats,
    panel('工具调用趋势', trendChart(data.trend)),
    h('div', { class: 'split' }, panel('高频工具', ...top), panel('按设备统计', ...devices)));
}

/**
 * 认证中心：组合原有客户端操作及新安全概况。
 * @returns {Promise<void>} 无
 */
async function renderClientCenter() {
  const auth = await api('/credentials');
  await renderClients();
  const root = $('#tab-clients');
  const summary = h('div', { class: 'kpi-grid' },
    metricCard('双因素认证', auth.totp_enabled ? '已启用' : '未配置', '后台管理员登录', '⌁'),
    metricCard('OAuth 客户端', numberLabel(auth.oauth_clients), numberLabel(auth.oauth_grants) + ' 条有效授权', '◈'),
    metricCard('有效静态令牌', numberLabel(auth.static_tokens), '只显示数量，不展示令牌值', '▣'),
    metricCard('后台登录会话', numberLabel(auth.web_sessions), '最长 ' + auth.session_max_hours + ' 小时', '◷'));
  const security = panel('登录安全',
    h('div', { class: 'info-line' }, h('span', {}, '会话空闲超时'), h('strong', {}, auth.session_idle_minutes + ' 分钟')),
    h('div', { class: 'info-line' }, h('span', {}, '会话绝对有效期'), h('strong', {}, auth.session_max_hours + ' 小时')),
    h('div', { class: 'row' },
      h('button', { class: 'small danger', onclick: () => confirmDo('确定注销其他所有后台登录会话？', async () => {
        const result = await api('/credentials/revoke-sessions', { body: {} });
        toast('已注销 ' + result.removed + ' 个其他会话');
        await renderClientCenter();
      }) }, '注销其他会话')),
    h('p', { class: 'panel-sub' }, '页面不会显示、传输或导出身份验证密钥。'));
  root.prepend(summary, security);
}

/**
 * ChatGPT MCP 自定义连接卡片。
 * 仅展示公共 MCP 端点，不直接操作 ChatGPT 账户中的插件安装。
 * @returns {Promise<void>} 无
 */
async function renderChatGPT() {
  const prefs = uiPreferences || await api('/settings');
  const root = $('#tab-chatgpt');
  if (!prefs.show_chatgpt_plugin) {
    root.replaceChildren(h('div', { class: 'empty-state' }, 'ChatGPT 插件展示已关闭，可在「系统设置」中启用。'));
    return;
  }
  const logo = h('div', { class: 'plugin-logo' }, h('img', {
    src: '/admin/chatgpt-mark.svg', alt: 'ChatGPT 标识', width: 45, height: 45,
  }));
  const card = h('div', { class: 'panel plugin-card' }, logo,
    h('div', {},
      h('div', { class: 'row' }, h('span', { class: 'tag' }, 'MCP · 自定义连接'),
        h('span', { class: 'pill ok' }, '自托管')),
      h('h2', {}, prefs.plugin_name),
      h('p', { class: 'muted' }, prefs.plugin_description),
      h('p', { class: 'panel-sub' }, '通过兼容 MCP 的客户端连接远程设备。展示信息可在系统设置中自定义。')));
  const endpoint = h('div', { class: 'endpoint' }, h('code', {}, prefs.mcp_url),
    h('button', { class: 'small ghost', onclick: async () => {
      try { await navigator.clipboard.writeText(prefs.mcp_url); toast('已复制 MCP 地址'); }
      catch { toast('复制失败，请手动选择地址', true); }
    } }, '复制'));
  const steps = h('ol', { class: 'steps' },
    h('li', {}, h('b', {}, '打开 ChatGPT 的应用与连接设置。'), '添加支持的自定义 MCP 连接。'),
    h('li', {}, h('b', {}, '填写 MCP 服务器地址。'), '使用下方提供的 HTTPS 接入地址。'),
    h('li', {}, h('b', {}, '完成 OAuth 授权。'), '使用网关提供的标准认证流程审核连接。'),
    h('li', {}, h('b', {}, '验证工具访问。'), '先检查设备列表与权限，再执行需要授权的操作。'));
  root.replaceChildren(card,
    panel('MCP 服务接入地址', endpoint,
      h('p', { class: 'panel-sub' },
        prefs.is_https ? '当前使用 HTTPS 地址。' : '当前使用 HTTP 地址；跨公网连接必须配置 HTTPS。')),
    panel('配置步骤', steps,
      h('p', { class: 'panel-sub' }, '是否允许创建自定义 MCP 连接，取决于 ChatGPT 账户、工作空间和平台支持情况。此页面仅管理 RemoteOps 的展示信息。')));
}

/** 创建设置表单字段。@param {string} id 字段 ID @param {string} title 标题 @param {HTMLElement} control 控件 @param {string} help 帮助文本 @returns {HTMLElement} 组 */
function settingsField(id, title, control, help = '') {
  control.id = id;
  return h('div', { class: 'form-group' },
    h('label', { for: id }, title),
    control, help ? h('small', { class: 'form-help' }, help) : null);
}

/**
 * 系统设置：白名单中允许编辑的品牌与展示行为，不提供危险的远程特权开关。
 * @returns {Promise<void>} 无
 */
async function renderSettings() {
  const prefs = await api('/settings');
  const root = $('#tab-settings');
  const simpleInput = (value, max) => h('input', { value, maxlength: max });
  const select = (value, choices) => h('select', {}, ...choices.map(([v, label]) =>
    h('option', { value: v, selected: v === value }, label)));
  const fields = h('div', { class: 'form-grid' },
    settingsField('console_name', '控制台名称', simpleInput(prefs.console_name, 64), '仅影响管理页面的显示名称。'),
    settingsField('ui_theme', '界面主题', select(prefs.ui_theme, [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']])),
    settingsField('ui_refresh_seconds', '刷新间隔', select(String(prefs.ui_refresh_seconds),
      [['10', '10 秒'], ['15', '15 秒'], ['30', '30 秒'], ['60', '60 秒']])),
    settingsField('usage_period_days', '默认统计周期', select(String(prefs.usage_period_days),
      [['7', '7 天'], ['30', '30 天'], ['90', '90 天']])));
  const pluginCheck = h('input', { type: 'checkbox', id: 'show_chatgpt_plugin',
    checked: prefs.show_chatgpt_plugin });
  const pluginFields = h('div', {},
    settingsField('plugin_name', '插件展示名称', simpleInput(prefs.plugin_name, 64)),
    settingsField('plugin_description', '插件描述', h('textarea', { maxlength: 240, rows: 3 }, prefs.plugin_description)),
    h('label', { class: 'check', for: 'show_chatgpt_plugin' },
      pluginCheck, '在管理页面显示 ChatGPT 连接卡片'));
  const saveButton = h('button', { onclick: async () => {
    saveButton.disabled = true;
    try {
      const body = {
        console_name: $('#console_name').value.trim(),
        ui_theme: $('#ui_theme').value,
        ui_refresh_seconds: Number($('#ui_refresh_seconds').value),
        usage_period_days: Number($('#usage_period_days').value),
        plugin_name: $('#plugin_name').value.trim(),
        plugin_description: $('#plugin_description').value.trim(),
        show_chatgpt_plugin: $('#show_chatgpt_plugin').checked,
      };
      const saved = await api('/settings', { body });
      applyPreferences(saved);
      toast('设置已保存');
    } catch (error) { toast(error.message, true); }
    finally { saveButton.disabled = false; }
  } }, '保存全部设置');
  root.replaceChildren(
    panel('基本设置', fields, h('p', { class: 'panel-sub' }, '所有设置由网关保存至现有 SQLite 数据库，可在重新登录后恢复。')),
    panel('ChatGPT 连接展示', pluginFields,
      h('p', { class: 'panel-sub' }, '这里只影响控制台卡片文案，不修改 ChatGPT 应用、OAuth 客户端或权限。')),
    panel('连接与安全',
      h('div', { class: 'info-line' }, h('span', {}, 'MCP 服务地址'), h('code', {}, prefs.mcp_url)),
      h('div', { class: 'info-line' }, h('span', {}, '后台双因素认证'), h('span', { class: 'pill ' + (prefs.totp_enabled ? 'ok' : 'err') }, prefs.totp_enabled ? '已开启' : '未启用')),
      h('p', { class: 'panel-sub' }, '涉及设备权限、配对审批和凭据轮换的操作仍使用专门的安全流程。')),
    h('div', { class: 'row' }, saveButton));
}
