/**
 * MCP Apps 端到端集成测试：真实 Gateway + 双 Agent + SDK stdio 后端。
 * 不接触生产凭据、设备、GitHub 或公网服务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { cleanupResources } from './fixtures/resource-cleanup.js';
import { AgentUiResources, toolUiUris } from '../agent/ui-resources.js';
import { GatewayUiResources } from '../gateway/ui-resources.js';

/**
 * 启动并等待随机端口的 HTTP 服务。
 * @param {string} url 健康检查 URL
 * @returns {Promise<void>} 健康检查通过
 */
async function waitHealthy(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch { /* Gateway 尚未启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('test Gateway did not start');
}

/**
 * 验证未授权模板及超大资源的 Agent 侧拒绝。
 */
test('UI registry only reads templates referenced by visible tools', async () => {
  let readCalls = 0;
  const uri = 'ui://test/config';
  const template = { uri, name: 'config', mimeType: 'text/html;profile=mcp-app' };
  const connection = { readResource: async () => {
    readCalls++;
    return { contents: [{ uri, mimeType: template.mimeType, text: '<html>ok</html>' }] };
  } };
  const slot = { name: 'test-server', status: 'running', conn: connection, resources: [template] };
  const slots = new Map([[slot.name, slot]]);
  const routes = new Map([['get_config', {
    slot, tool: { name: 'get_config', _meta: { ui: { resourceUri: uri } } },
  }]]);
  const registry = new AgentUiResources(() => slots, () => routes);
  assert.deepEqual(toolUiUris(routes.get('get_config').tool), [uri]);
  assert.equal(registry.list().length, 1);
  await assert.rejects(() => registry.read({ uri: 'ui://test/private', server: 'test-server' }), /not registered/);
  assert.equal(readCalls, 0);
  assert.match((await registry.read({ uri, server: 'test-server' })).contents[0].text, /ok/);
  assert.equal(readCalls, 1);
  connection.readResource = async () => ({
    contents: [{ uri, mimeType: template.mimeType, text: 'x'.repeat(4 * 1024 * 1024) }],
  });
  await assert.rejects(() => registry.read({ uri, server: 'test-server' }), /exceeds/);
});

/**
 * 验证未选设备时不能擅自读取其他设备资源。
 */
test('Gateway rejects ambiguous UI resources across devices', async () => {
  const resources = [{ uri: 'ui://example/template', server: 'mock', mimeType: 'text/html;profile=mcp-app', name: 'Mock' }];
  const devices = new Map([
    ['a', { resources, tools: [] }],
    ['b', { resources, tools: [] }],
  ]);
  const proxy = new GatewayUiResources({ devices, resolveDevice: () => null,
    relay: async () => { throw new Error('must not relay'); } });
  const ctx = { session: { session_id: 'session-1' } };
  assert.equal(proxy.list(ctx).resources.filter((resource) => resource.uri === resources[0].uri).length, 1);
  assert.equal(proxy.list(ctx).resources.length, 3);
  await assert.rejects(() => proxy.read(ctx, { uri: resources[0].uri }), /select a connected device/);
});

/**
 * 从真实 OAuth 等价 Bearer 认证入口经过 Gateway、Agent、SDK 读取两个 UI 模板，
 * 同时验证跨设备隔离、tool metadata、普通工具和未授权拒绝。
 */
test('MCP Apps resources/list and resources/read relay end-to-end', { timeout: 60000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteops-ui-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = 'http://127.0.0.1:' + port;
  const db = path.join(directory, 'gateway.sqlite3');
  const environment = { ...process.env, RMCP_DB: db };
  const processes = [];
  const admin = (...args) => execFileSync(process.execPath,
    ['gateway/admin.js', ...args], { env: environment, encoding: 'utf8' });
  const extract = (output, key) => {
    const match = new RegExp(key + ':\\s+(\\S+)').exec(output);
    assert.ok(match, 'Admin CLI did not return ' + key);
    return match[1];
  };
  const backend = path.resolve('test/fixtures/mock-ui-mcp.js');
  let sessionId = null;
  let nextId = 0;
  const rpc = async (method, params = {}, options = {}) => {
    const response = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer ' + (options.token || clientToken),
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
    });
    if (!sessionId && method === 'initialize') sessionId = response.headers.get('mcp-session-id');
    return { status: response.status, body: await response.json() };
  };
  let clientToken;
  try {
    clientToken = extract(admin('client-create', 'ui-fixture'), 'client_token');
    const secrets = ['A', 'B'].map((name) => extract(
      admin('device-create', 'fixture-' + name.toLowerCase()), 'device_secret'));
    const gateway = spawn(process.execPath,
      ['gateway/server.js', '--host', '127.0.0.1', '--port', String(port), '--db', db],
      { stdio: 'pipe', env: environment });
    processes.push(gateway);
    await waitHealthy(base + '/health');
    for (let i = 0; i < 2; i++) {
      const deviceId = 'fixture-' + ['a', 'b'][i];
      const configPath = path.join(directory, deviceId + '.json');
      fs.writeFileSync(configPath, JSON.stringify({
        device_id: deviceId, device_secret: secrets[i],
        gateway: 'ws://127.0.0.1:' + port + '/device',
        desktop_commander: { command: [process.execPath, backend, 'DEVICE_' + ['A', 'B'][i]] },
      }), { mode: 0o600 });
      const agent = spawn(process.execPath,
        ['agent/agent.js', '--config', configPath, '--policy', path.join(directory, 'no-policy.json')],
        { stdio: 'pipe', env: environment });
      processes.push(agent);
    }
    const init = await rpc('initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.status, 200);
    assert.ok(sessionId);
    assert.deepEqual(init.body.result.capabilities.resources, {});
    const deadline = Date.now() + 20000;
    let devices;
    do {
      const r = await rpc('tools/call', { name: 'devices_list', arguments: {} });
      devices = JSON.parse(r.body.result.content[0].text);
      if (devices.filter((item) => item.status === 'online').length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    assert.equal(devices.filter((item) => item.status === 'online').length, 2,
      'both fixture Agents should register');
    const list = await rpc('tools/list');
    const tools = list.body.result.tools;
    const config = tools.find((item) => item.name === 'get_config');
    assert.ok(config, 'built-in tool snapshot must contain get_config');
    assert.equal(config._meta?.ui?.resourceUri, 'ui://desktop-commander/config-editor');
    assert.equal(config._meta?.['openai/outputTemplate'], 'ui://desktop-commander/config-editor');

    await rpc('tools/call', { name: 'device_select', arguments: { device_id: 'fixture-a' } });
    const discovery = await rpc('resources/list');
    assert.equal(discovery.status, 200);
    assert.ok(discovery.body.result.resources.length >= 2);
    const byUri = new Set(discovery.body.result.resources.map((item) => item.uri));
    assert.ok(byUri.has('ui://desktop-commander/config-editor'));
    assert.ok(byUri.has('ui://desktop-commander/file-preview'));
    const called = await rpc('tools/call',
      { name: 'get_config', arguments: { device_id: 'fixture-a' } });
    assert.match(called.body.result.content[0].text, /DEVICE_A:get_config/);
    const editor = await rpc('resources/read', { uri: 'ui://desktop-commander/config-editor' });
    assert.equal(editor.status, 200);
    assert.match(editor.body.result.contents[0].text, /DEVICE_A/);
    const scopedEditorUri = called.body.result._meta?.ui?.resourceUri;
    assert.match(scopedEditorUri, /^ui:\/\/remoteops\//);
    const scopedEditor = await rpc('resources/read', { uri: scopedEditorUri });
    assert.equal(scopedEditor.body.result.contents[0].uri, scopedEditorUri);
    assert.match(scopedEditor.body.result.contents[0].text, /DEVICE_A/);
    assert.equal(editor.body.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(editor.body.result.contents[0]._meta.ui.csp.connectDomains, []);

    for (const name of ['read_file', 'write_file', 'list_directory', 'edit_block']) {
      const output = await rpc('tools/call', { name, arguments: { device_id: 'fixture-b' } });
      assert.match(output.body.result.content[0].text, new RegExp('DEVICE_B:' + name));
      const filePreview = await rpc('resources/read', { uri: 'ui://desktop-commander/file-preview' });
      assert.equal(filePreview.status, 200);
      assert.match(filePreview.body.result.contents[0].text, /DEVICE_B/);
      const scopedPreview = output.body.result._meta?.ui?.resourceUri;
      assert.match(scopedPreview, /^ui:\/\/remoteops\//);
      const scopedResponse = await rpc('resources/read', { uri: scopedPreview });
      assert.equal(scopedResponse.body.result.contents[0].uri, scopedPreview);
      assert.match(scopedResponse.body.result.contents[0].text, /DEVICE_B/);
      assert.doesNotMatch(filePreview.body.result.contents[0].text, /DEVICE_A/);
    }
    // 其他设备调用完成后，先前明确作用域的 A 模板仍指向设备 A。
    const isolated = await rpc('resources/read', { uri: scopedEditorUri });
    assert.match(isolated.body.result.contents[0].text, /DEVICE_A/);
    assert.doesNotMatch(isolated.body.result.contents[0].text, /DEVICE_B/);
    const plain = await rpc('tools/call', { name: 'echo', arguments: { device_id: 'fixture-a' } });
    assert.match(plain.body.result.content[0].text, /DEVICE_A:echo/);
    const denied = await rpc('resources/read', { uri: 'ui://desktop-commander/private' });
    assert.equal(denied.body.error.code, -32002);
    const malicious = await rpc('resources/read', { uri: 'file:///etc/passwd' });
    assert.equal(malicious.body.error.code, -32602);

    const unauthorized = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'resources/read',
        params: { uri: 'ui://desktop-commander/file-preview' } }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await cleanupResources({ directory, processes });
  }
});
