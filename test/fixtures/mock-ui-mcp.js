/**
 * MCP Apps 本地模拟后端：真实 MCP SDK stdio 协议，模拟两个资源与工具声明。
 * 可指定实例标签，用于验证跨设备 UI 资源不会混用。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const marker = process.argv[2] || 'DEVICE_A';
const mimeType = 'text/html;profile=mcp-app';
const templates = [
  { uri: 'ui://desktop-commander/config-editor', name: 'Configuration Editor', mimeType },
  { uri: 'ui://desktop-commander/file-preview', name: 'File Preview', mimeType },
];
const editor = templates[0].uri;
const preview = templates[1].uri;

/**
 * 为模拟工具声明真实的 UI 元数据。
 * @param {string} name 工具名称
 * @param {string|null} uri 所属 UI 资源，null 表示无 UI
 * @returns {object} MCP 工具对象
 */
function tool(name, uri) {
  return {
    name,
    description: 'Fixture ' + name,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    ...(uri ? { _meta: {
      ui: { resourceUri: uri },
      'ui/resourceUri': uri,
      'openai/outputTemplate': uri,
      'openai/widgetAccessible': true,
    } } : {}),
  };
}

const server = new Server({ name: 'mock-ui', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  tool('get_config', editor),
  tool('read_file', preview),
  tool('write_file', preview),
  tool('list_directory', preview),
  tool('edit_block', preview),
  tool('echo', null),
] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: marker + ':' + request.params.name }],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: templates }));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resource = templates.find((candidate) => candidate.uri === request.params.uri);
  if (!resource) throw new Error('Missing resource');
  return {
    contents: [{
      uri: resource.uri,
      mimeType,
      text: '<!doctype html><html><head><title>' + marker +
        '</title></head><body data-device="' + marker + '"><main>RemoteOps MCP Apps UI</main></body></html>',
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } },
    }],
  };
});

await server.connect(new StdioServerTransport());
