/**
 * Agent 端 MCP Apps 资源中心。
 * 只转发已经由可见工具声明的 ui:// 模板，禁止把任意文件 URI 当作资源读取。
 * 通过后端 SDK 的 listResources/readResource 获取原始资源和 CSP 元数据。
 */
export const MAX_UI_BYTES = 4 * 1024 * 1024;
export const MAX_UI_RESOURCES = 64;

/**
 * 提取 MCP Apps/ChatGPT 兼容的资源 URI。
 * @param {object} tool MCP 工具声明
 * @returns {string[]} ui:// URI 列表
 */
export function toolUiUris(tool) {
  const meta = tool?._meta ?? {};
  const candidates = [meta?.ui?.resourceUri, meta?.['ui/resourceUri'], meta?.['openai/outputTemplate']];
  return [...new Set(candidates.filter((uri) =>
    typeof uri === 'string' && uri.startsWith('ui://') && uri.length <= 512))];
}

/**
 * 专门提供只读、已声明的 MCP Apps UI 资源。
 * 每个资源与其本地 MCP 后端绑定，避免自定义后端跨服务读取。
 */
export class AgentUiResources {
  /**
   * @param {() => Map<string, object>} getSlots 获取当前后端集合
   * @param {() => Map<string, object>} getRoutes 获取可用工具的路由集合
   */
  constructor(getSlots, getRoutes) {
    this.getSlots = getSlots;
    this.getRoutes = getRoutes;
  }

  /**
   * 只展示已由当前可访问工具引用的 UI 资源。
   * @returns {object[]} 包含内部 server 字段的资源列表
   */
  list() {
    const allowed = new Map();
    for (const route of this.getRoutes().values()) {
      const key = route.slot.name;
      if (!allowed.has(key)) allowed.set(key, new Set());
      for (const uri of toolUiUris(route.tool)) allowed.get(key).add(uri);
    }
    const result = [];
    for (const slot of this.getSlots().values()) {
      if (slot.status !== 'running' || !slot.conn) continue;
      const uris = allowed.get(slot.name) ?? new Set();
      for (const resource of slot.resources ?? []) {
        if (result.length >= MAX_UI_RESOURCES) return result;
        if (!resource || typeof resource.uri !== 'string' ||
            !uris.has(resource.uri) || !resource.uri.startsWith('ui://')) continue;
        if (resource.mimeType !== 'text/html;profile=mcp-app') continue;
        result.push({
          uri: resource.uri,
          name: String(resource.name || resource.uri).slice(0, 120),
          ...(resource.title ? { title: String(resource.title).slice(0, 160) } : {}),
          mimeType: resource.mimeType,
          ...(resource._meta && typeof resource._meta === 'object' ? { _meta: resource._meta } : {}),
          server: slot.name,
        });
      }
    }
    return result;
  }

  /**
   * 读取属于指定后端且由可见工具引用的资源。
   * @param {{uri:string,server:string}} request 严格指定 URI 和 MCP 后端
   * @returns {Promise<object>} 标准 resources/read 返回体
   */
  async read(request) {
    const uri = request?.uri;
    const server = request?.server;
    if (typeof uri !== 'string' || typeof server !== 'string') {
      throw Object.assign(new Error('Resource URI and server are required'), { code: 'INVALID_RESOURCE' });
    }
    const declared = this.list().find((item) => item.uri === uri && item.server === server);
    if (!declared) {
      throw Object.assign(new Error('UI resource not registered or not permitted'), { code: 'RESOURCE_NOT_FOUND' });
    }
    const slot = this.getSlots().get(server);
    if (!slot?.conn?.readResource || slot.status !== 'running') {
      throw Object.assign(new Error('UI resource backend unavailable'), { code: 'DEVICE_OFFLINE' });
    }
    const result = await slot.conn.readResource(uri);
    if (!result || !Array.isArray(result.contents) || result.contents.length === 0) {
      throw Object.assign(new Error('Empty UI resource response'), { code: 'INVALID_RESOURCE' });
    }
    for (const item of result.contents) {
      if (item.uri !== uri || item.mimeType !== 'text/html;profile=mcp-app' ||
          typeof item.text !== 'string') {
        throw Object.assign(new Error('Invalid UI resource content'), { code: 'INVALID_RESOURCE' });
      }
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_UI_BYTES) {
      throw Object.assign(new Error('UI resource exceeds 4 MiB limit'), { code: 'RESOURCE_TOO_LARGE' });
    }
    return result;
  }
}

/**
 * 调用 SDK listResources，不支持资源协议的普通 MCP 后端自然退化为空资源列表。
 * @param {object} conn 后端连接
 * @returns {Promise<object[]>} 安全的 UI 资源列表
 */
export async function discoverUiResources(conn) {
  if (typeof conn?.listResources !== 'function') return [];
  try {
    const response = await conn.listResources();
    return (Array.isArray(response?.resources) ? response.resources : [])
      .filter((resource) => resource?.uri?.startsWith('ui://') &&
        resource?.mimeType === 'text/html;profile=mcp-app')
      .slice(0, MAX_UI_RESOURCES);
  } catch (error) {
    // 老式工具后端可能没有 resources 能力；此时工具调用不应中断。
    if (/Method not found|not supported|does not support|Unsupported method|resources\/list/i.test(error?.message || '')) return [];
    throw error;
  }
}
