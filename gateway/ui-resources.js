/**
 * Gateway MCP Apps 资源代理。
 * 对外保持原始 ui:// URI 和 MIME/CSP 元数据；实际读取只转发到已经认证、
 * 具有该模板的在线 Agent。不会把 file://、任意远程 URL 或密钥当成资源。
 */
import { toolUiUris, MAX_UI_BYTES, MAX_UI_RESOURCES } from '../agent/ui-resources.js';

/**
 * 只保留合法的 MCP Apps 静态资源描述。
 * @param {unknown} raw Agent 上报的资源
 * @returns {object[]} 内部包含 server 的已过滤资源
 */
export function normalizeUiResources(raw) {
  if (!Array.isArray(raw)) return [];
  const resources = [];
  for (const item of raw.slice(0, MAX_UI_RESOURCES)) {
    if (!item || typeof item.uri !== 'string' || item.uri.length > 512 ||
        !item.uri.startsWith('ui://') || item.mimeType !== 'text/html;profile=mcp-app' ||
        typeof item.server !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(item.server)) continue;
    resources.push({
      uri: item.uri,
      name: String(item.name || item.uri).slice(0, 120),
      ...(item.title ? { title: String(item.title).slice(0, 160) } : {}),
      mimeType: item.mimeType,
      ...(item._meta && typeof item._meta === 'object' && !Array.isArray(item._meta) ?
        { _meta: item._meta } : {}),
      server: item.server,
    });
  }
  return resources;
}

/**
 * 资源访问拒绝按 MCP JSON-RPC 返回，不暴露设备内部文件路径。
 * @param {number} code RPC 错误号
 * @param {string} message 公共错误描述
 * @returns {Error} 携带 rpc 对象的异常
 */
function resourceError(code, message) {
  return Object.assign(new Error(message), { rpc: { code, message } });
}

/** 将内部 server 字段移除，避免泄露路由实现。 */
function publicResource(resource) {
  const { server: _internal, ...publicFields } = resource;
  return publicFields;
}

/**
 * 为明确的设备/后端分配隔离资源 URI，避免并行工具执行时串设备。
 * @param {string} deviceId 目标设备
 * @param {string} server MCP 后端
 * @param {string} uri 后端原始资源 URI
 * @returns {string} 对外 scoped URI
 */
export function scopedUiUri(deviceId, server, uri) {
  const encode = (value) => Buffer.from(value, 'utf8').toString('base64url');
  return 'ui://remoteops/' + encode(deviceId) + '/' + encode(server) + '/' + encode(uri);
}

/**
 * 解码并回读校验 scoped URI，拒绝不规范或恶意编码。
 * @param {string} uri 对外 scoped URI
 * @returns {object|null} 原始路由字段，普通 ui:// 返回 null
 */
export function parseScopedUiUri(uri) {
  const match = /^ui:\/\/remoteops\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,768})$/.exec(uri);
  if (!match) return null;
  const decode = (value) => Buffer.from(value, 'base64url').toString('utf8');
  const [deviceId, server, originalUri] = match.slice(1).map(decode);
  if (scopedUiUri(deviceId, server, originalUri) !== uri || !originalUri.startsWith('ui://')) return null;
  return { deviceId, server, originalUri };
}

export class GatewayUiResources {
  /**
   * @param {{devices:Map<string,object>,resolveDevice:Function,relay:Function}} dependencies 依赖注入
   */
  constructor({ devices, resolveDevice, relay }) {
    this.devices = devices;
    this.resolveDevice = resolveDevice;
    this.relay = relay;
    this.recentTools = new Map();
  }

  /**
   * 确定工具所属后端，新增 MCP 服务使用其前缀。
   * @param {string} deviceId 设备 ID
   * @param {string} toolName 工具名
   * @returns {string} 后端名称
   */
  serverOf(deviceId, toolName) {
    const dev = this.devices.get(deviceId);
    const extra = dev?.backends?.filter((item) => item.prefix && item.status === 'running') ?? [];
    return extra.find((item) => toolName.startsWith(item.prefix))?.name ?? 'desktop-commander';
  }

  /**
   * 将动态工具 UI 模板绑定到具体设备，保留原有工具描述和非 UI 元数据。
   * @param {object} tool 工具声明
   * @param {string} deviceId 设备 ID
   * @returns {object} 只修改 UI URI 的副本
   */
  scopeTool(tool, deviceId) {
    const dev = this.devices.get(deviceId);
    const server = this.serverOf(deviceId, tool.name);
    const permitted = new Set((dev?.resources ?? [])
      .filter((resource) => resource.server === server).map((resource) => resource.uri));
    const meta = tool?._meta;
    if (!meta || !toolUiUris(tool).some((uri) => permitted.has(uri))) return tool;
    const changeUri = (uri) => typeof uri === 'string' && permitted.has(uri) ?
      scopedUiUri(deviceId, server, uri) : uri;
    const updatedMeta = { ...meta };
    if (meta.ui && typeof meta.ui === 'object') {
      updatedMeta.ui = { ...meta.ui, resourceUri: changeUri(meta.ui.resourceUri) };
    }
    if (typeof meta['ui/resourceUri'] === 'string') {
      updatedMeta['ui/resourceUri'] = changeUri(meta['ui/resourceUri']);
    }
    if (typeof meta['openai/outputTemplate'] === 'string') {
      updatedMeta['openai/outputTemplate'] = changeUri(meta['openai/outputTemplate']);
    }
    return { ...tool, _meta: updatedMeta };
  }

  /**
   * 工具执行结果额外标注 scoped UI 地址；原始结果内容完全保留。
   * @param {object} result 工具返回值
   * @param {string} deviceId 实际执行设备
   * @param {string} toolName 工具名
   * @returns {object} 带有兼容 UI 元数据的结果
   */
  scopeResult(result, deviceId, toolName) {
    if (!result || typeof result !== 'object') return result;
    const tool = this.devices.get(deviceId)?.tools?.find((item) => item.name === toolName);
    if (!tool) return result;
    const scoped = this.scopeTool(tool, deviceId);
    const uri = scoped?._meta?.ui?.resourceUri ??
      scoped?._meta?.['ui/resourceUri'] ?? scoped?._meta?.['openai/outputTemplate'];
    if (typeof uri !== 'string' || !uri.startsWith('ui://remoteops/')) return result;
    const meta = { ...(result._meta ?? {}), ui: {
      ...(result._meta?.ui ?? {}), resourceUri: uri,
    }, 'ui/resourceUri': uri, 'openai/outputTemplate': uri };
    return { ...result, _meta: meta };
  }

  /**
   * 记住某 MCP 会话最近一次访问的设备和 UI 模板。
   * 解决 tools/call 通过 device_id 指定目标，但 UI 的 resources/read 不带该参数的问题。
   * @param {object} ctx 已验证身份的 MCP 请求上下文
   * @param {string} deviceId 已成功调用的设备
   * @param {string} toolName 工具名
   * @returns {void} 无
   */
  rememberTool(ctx, deviceId, toolName) {
    const dev = this.devices.get(deviceId);
    const tool = dev?.tools?.find((item) => item.name === toolName);
    if (!tool || !ctx?.session?.session_id) return;
    const uris = toolUiUris(tool);
    if (!uris.length) return;
    const server = this.serverOf(deviceId, toolName);
    this.recentTools.set(ctx.session.session_id, { deviceId, uris, server, at: Date.now() });
    // 有界缓存，避免无期限保存会话记录；不包含工具参数和资源内容。
    if (this.recentTools.size > 2048) {
      for (const [key, record] of this.recentTools) {
        if (Date.now() - record.at > 10 * 60_000) this.recentTools.delete(key);
      }
      if (this.recentTools.size > 2048) this.recentTools.clear();
    }
  }

  /**
   * 资源发现遵循现有会话选择；未选设备时合并在线设备的 URI，
   * 但不在未确定目标的情况下读取任何资源。
   * @param {object} ctx MCP 会话及认证信息
   * @returns {{resources: object[]}} 标准 resources/list
   */
  list(ctx) {
    const selectedId = this.resolveDevice(ctx);
    const selected = selectedId ? this.devices.get(selectedId) : null;
    const targets = selectedId ? (selected ? [[selectedId, selected]] : []) : [...this.devices.entries()];
    const seen = new Set();
    const resources = [];
    // 先提供明确的设备/后端作用域 URI，再暴露兼容旧工具声明的原始 URI。
    for (const [deviceId, dev] of targets) {
      for (const entry of dev.resources ?? []) {
        const uri = scopedUiUri(deviceId, entry.server, entry.uri);
        if (seen.has(uri)) continue;
        seen.add(uri);
        resources.push(publicResource({ ...entry, uri }));
      }
    }
    for (const [, dev] of targets) {
      for (const entry of dev.resources ?? []) {
        if (seen.has(entry.uri)) continue;
        seen.add(entry.uri);
        resources.push(publicResource(entry));
      }
    }
    return { resources: resources.slice(0, MAX_UI_RESOURCES * 2) };
  }

  /**
   * 读取 UI 模板时先完成设备/后端精确匹配，再走有超时的 Agent relay。
   * @param {object} ctx 已认证的 MCP 会话
   * @param {{uri:string}} params resources/read 参数
   * @returns {Promise<{contents:object[]}>} 原始 MIME、HTML 和 CSP 内容
   */
  async read(ctx, params) {
    const requestedUri = params?.uri;
    if (typeof requestedUri !== 'string' || !requestedUri.startsWith('ui://') || requestedUri.length > 1200) {
      throw resourceError(-32602, 'Invalid MCP Apps resource URI');
    }
    const scoped = requestedUri.startsWith('ui://remoteops/') ? parseScopedUiUri(requestedUri) : null;
    if (requestedUri.startsWith('ui://remoteops/') && !scoped) {
      throw resourceError(-32602, 'Invalid scoped MCP Apps resource URI');
    }
    const originalUri = scoped?.originalUri ?? requestedUri;
    const recent = this.recentTools.get(ctx.session.session_id);
    const stillRecent = recent && Date.now() - recent.at <= 10 * 60_000 &&
      recent.uris.includes(originalUri);
    const selectedId = this.resolveDevice(ctx);
    const deviceId = scoped?.deviceId ?? (stillRecent ? recent.deviceId : selectedId);
    // 跨设备 scoped URI 必须对应本会话最近一次工具调用或其明确选中的设备。
    if (scoped && !(selectedId === scoped.deviceId ||
      (stillRecent && recent.deviceId === scoped.deviceId && recent.server === scoped.server))) {
      throw resourceError(-32002, 'UI resource not authorized for this device selection');
    }
    if (!deviceId || !this.devices.has(deviceId)) {
      throw resourceError(-32002, 'UI resource unavailable: select a connected device');
    }
    const dev = this.devices.get(deviceId);
    const matches = (dev.resources ?? []).filter((resource) =>
      resource.uri === originalUri && (!scoped || resource.server === scoped.server));
    if (!matches.length) throw resourceError(-32002, 'UI resource not available for this device');
    const matched = scoped ? matches[0] : (stillRecent ?
      matches.find((item) => item.server === recent.server) : matches[0]);
    if (!matched) throw resourceError(-32002, 'UI resource not available for this tool');
    let result;
    try {
      result = await this.relay(deviceId, 'resources/read',
        { uri: originalUri, server: matched.server }, 45_000);
    } catch (error) {
      if (error?.code === 'TIMEOUT') throw resourceError(-32001, 'UI resource read timed out');
      if (error?.code === 'DEVICE_OFFLINE') throw resourceError(-32002, 'Device disconnected while loading UI');
      if (error?.code === 'RESOURCE_TOO_LARGE') throw resourceError(-32001, 'UI resource exceeds size limit');
      throw resourceError(-32002, 'UI resource read failed: ' + String(error?.code || 'BACKEND_ERROR').slice(0, 50));
    }
    if (!Array.isArray(result?.contents) || !result.contents.length ||
        result.contents.some((item) => item.uri !== originalUri ||
          item.mimeType !== 'text/html;profile=mcp-app' || typeof item.text !== 'string')) {
      throw resourceError(-32603, 'Invalid MCP Apps resource response');
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_UI_BYTES) {
      throw resourceError(-32001, 'UI resource exceeds size limit');
    }
    // 依 MCP 规范，返回内容中的 URI 必须与请求的对外 URI 完全一致。
    return { ...result, contents: result.contents.map((item) => ({ ...item, uri: requestedUri })) };
  }
}
