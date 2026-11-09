/**
 * 管理后台业务层：统计、设备名称、认证摘要与展示设置。
 * 数据仅来自审计元数据；绝不返回密钥、令牌、工具参数或输出。
 */
const DAY_MS = 86400000;
const DEFAULTS = Object.freeze({
  console_name: 'RemoteOps',
  ui_theme: 'light',
  ui_refresh_seconds: 15,
  usage_period_days: 7,
  plugin_name: 'RemoteOps MCP',
  plugin_description: '通过 ChatGPT 安全连接您授权的远程设备',
  show_chatgpt_plugin: true,
});

/** 使用 SQLite 访问控制台的安全展示数据。 */
export class ConsoleService {
  /** @param {{ db: object, publicUrl: string, listDevices: Function }} options 数据库与设备访问器 */
  constructor({ db, publicUrl, listDevices }) {
    this.db = db;
    this.publicUrl = publicUrl.replace(/\/$/, '');
    this.listDevices = listDevices;
  }

  /** 读取白名单展示配置。@param {string} key 配置键 @returns {string|null} 配置值 */
  get(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').get('ui_' + key)?.value ?? null;
  }

  /** 返回不含凭据的页面设置。@returns {object} 页面设置及公开接入地址 */
  settings() {
    const data = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      const raw = this.get(key);
      if (raw === null) continue;
      data[key] = typeof DEFAULTS[key] === 'boolean' ? raw === 'true'
        : typeof DEFAULTS[key] === 'number' ? Number(raw) : raw;
    }
    return { ...data, mcp_url: this.publicUrl + '/mcp',
      is_https: this.publicUrl.startsWith('https://'),
      totp_enabled: !!this.db.prepare("SELECT 1 FROM settings WHERE key='totp_secret'").get() };
  }

  /**
   * 以事务方式只写入可编辑的设置字段。
   * @param {Record<string, unknown>} data 用户提交的字段
   * @returns {object} 保存后的设置
   */
  updateSettings(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('invalid settings payload');
    const keys = Object.keys(data);
    if (!keys.length || keys.some((key) => !Object.hasOwn(DEFAULTS, key))) throw new TypeError('unknown settings field');
    const next = {};
    for (const key of keys) {
      const val = data[key];
      if (['console_name', 'plugin_name'].includes(key)) {
        if (typeof val !== 'string' || !val.trim() || val.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(val)) throw new TypeError('invalid ' + key);
        next[key] = val.trim();
      } else if (key === 'plugin_description') {
        if (typeof val !== 'string' || val.length > 240 || /[\u0000-\u001f\u007f]/.test(val)) throw new TypeError('invalid ' + key);
        next[key] = val.trim();
      } else if (key === 'ui_theme') {
        if (!['system', 'light', 'dark'].includes(val)) throw new TypeError('invalid ui_theme');
        next[key] = val;
      } else if (key === 'ui_refresh_seconds') {
        if (![10, 15, 30, 60].includes(val)) throw new TypeError('invalid ui_refresh_seconds');
        next[key] = val;
      } else if (key === 'usage_period_days') {
        if (![7, 30, 90].includes(val)) throw new TypeError('invalid usage_period_days');
        next[key] = val;
      } else if (key === 'show_chatgpt_plugin') {
        if (typeof val !== 'boolean') throw new TypeError('invalid show_chatgpt_plugin');
        next[key] = val;
      }
    }
    const stmt = this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.db.exec('BEGIN');
    try {
      for (const [key, value] of Object.entries(next)) stmt.run('ui_' + key, String(value));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.settings();
  }

  /**
   * 按日期、设备与工具汇总审计日志，不读取敏感信息。
   * @param {number} days 7、30、90 天
   * @returns {object} 调用统计和每日趋势
   */
  overview(days = 7) {
    if (![7, 30, 90].includes(days)) throw new RangeError('days must be 7, 30 or 90');
    const date = new Date();
    const since = new Date(date.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    const where = 'substr(timestamp,1,10) >= ?';
    const summary = this.db.prepare('SELECT COUNT(*) calls, SUM(CASE WHEN status=\'success\' THEN 1 ELSE 0 END) successes, SUM(CASE WHEN status!=\'success\' THEN 1 ELSE 0 END) failures, ROUND(AVG(CASE WHEN duration_ms >= 0 THEN duration_ms END)) average_ms FROM audit_logs WHERE ' + where).get(since);
    const rows = this.db.prepare('SELECT substr(timestamp,1,10) day, COUNT(*) calls, SUM(CASE WHEN status=\'success\' THEN 1 ELSE 0 END) successes FROM audit_logs WHERE ' + where + ' GROUP BY substr(timestamp,1,10) ORDER BY day').all(since);
    const byDay = new Map(rows.map((row) => [row.day, row]));
    const trend = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(date.getTime() - i * DAY_MS).toISOString().slice(0, 10);
      trend.push({ day, calls: byDay.get(day)?.calls ?? 0, successes: byDay.get(day)?.successes ?? 0 });
    }
    const topTools = this.db.prepare('SELECT tool, COUNT(*) calls FROM audit_logs WHERE ' + where + ' AND tool IS NOT NULL GROUP BY tool ORDER BY calls DESC LIMIT 8').all(since);
    const perDevice = this.db.prepare('SELECT device_id, COUNT(*) calls, SUM(CASE WHEN status!=\'success\' THEN 1 ELSE 0 END) failures FROM audit_logs WHERE ' + where + ' AND device_id IS NOT NULL GROUP BY device_id ORDER BY calls DESC LIMIT 20').all(since);
    const devices = this.listDevices();
    const staticClients = this.db.prepare('SELECT COUNT(*) n FROM client_tokens WHERE revoked_at IS NULL').get().n;
    const oauthClients = this.db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n;
    return {
      days, generated_at: new Date().toISOString(),
      devices: { total: devices.length, online: devices.filter((d) => d.status === 'online').length, list: devices },
      clients: staticClients + oauthClients,
      usage: { calls: summary.calls ?? 0, successes: summary.successes ?? 0, failures: summary.failures ?? 0,
        average_ms: summary.average_ms ?? 0, success_rate: summary.calls ? Math.round((summary.successes || 0) / summary.calls * 1000) / 10 : 0 },
      trend, top_tools: topTools, per_device: perDevice,
    };
  }

  /** 查询认证安全状态，禁止返回凭据原文。@returns {object} 安全摘要 */
  credentials() {
    const count = (sql) => this.db.prepare(sql).get().n;
    return {
      totp_enabled: !!this.db.prepare("SELECT 1 FROM settings WHERE key='totp_secret'").get(),
      web_sessions: count('SELECT COUNT(*) n FROM web_sessions'),
      oauth_clients: count('SELECT COUNT(*) n FROM oauth_clients'),
      oauth_grants: this.db.prepare("SELECT COUNT(*) n FROM oauth_tokens WHERE kind='refresh' AND revoked_at IS NULL AND expires_at>?").get(Date.now()).n,
      static_tokens: count('SELECT COUNT(*) n FROM client_tokens WHERE revoked_at IS NULL'),
      session_idle_minutes: 30,
      session_max_hours: 12,
    };
  }

  /** 更新设备展示名称。@param {string} id 设备 ID @param {unknown} name 设备名称 @returns {boolean} 成功状态 */
  renameDevice(id, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\u0000-\u001f\u007f]/.test(name)) throw new TypeError('invalid device name');
    return this.db.prepare('UPDATE devices SET name=? WHERE device_id=? AND revoked_at IS NULL').run(name.trim(), id).changes > 0;
  }

  /** 删除其他后台登录会话。@param {string} tokenHash 当前会话摘要 @returns {number} 删除个数 */
  revokeOtherSessions(tokenHash) {
    return this.db.prepare('DELETE FROM web_sessions WHERE token_hash != ?').run(tokenHash).changes;
  }
}
