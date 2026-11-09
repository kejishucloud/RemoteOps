/**
 * 可选的真实 Desktop Commander MCP Apps 验收。
 * 运行时通过 REMOTEOPS_REAL_BACKEND_SCRIPT 提供本地后端绝对路径，
 * 测试仅在临时 Gateway/SQLite 中进行，不修改任何生产设备配置。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { cleanupResources } from './fixtures/resource-cleanup.js';

test('real MCP Apps backend HTML resources survive the complete gateway relay',
  { skip: !process.env.REMOTEOPS_REAL_BACKEND_SCRIPT ? 'requires optional local MCP backend path' : false,
    timeout: 70000 }, async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteops-real-ui-'));
    const processes = [];
    const port = 40000 + Math.floor(Math.random() * 12000);
    const base = 'http://127.0.0.1:' + port;
    const database = path.join(temp, 'gateway.db');
    const env = { ...process.env, RMCP_DB: database };
    const backendScript = path.resolve(process.env.REMOTEOPS_REAL_BACKEND_SCRIPT);
    assert.ok(fs.statSync(backendScript).isFile(), 'the opt-in backend must exist');
    const admin = (...args) => execFileSync(process.execPath, ['gateway/admin.js', ...args],
      { env, encoding: 'utf8' });
    const secretValue = (output, key) => {
      const match = new RegExp(key + ':\\s+(\\S+)').exec(output);
      assert.ok(match);
      return match[1];
    };
    let bearer;
    let sessionId;
    let requestId = 0;
    const rpc = async (method, params = {}) => {
      const response = await fetch(base + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json',
          authorization: 'Bearer ' + bearer,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      });
      if (method === 'initialize') sessionId = response.headers.get('mcp-session-id');
      return await response.json();
    };
    try {
      bearer = secretValue(admin('client-create', 'real-ui-client'), 'client_token');
      const secret = secretValue(admin('device-create', 'real-ui-agent'), 'device_secret');
      const gateway = spawn(process.execPath, ['gateway/server.js', '--host', '127.0.0.1',
        '--port', String(port), '--db', database], { env, stdio: 'pipe' });
      processes.push(gateway);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try { if ((await fetch(base + '/health')).ok) break; } catch { /* connecting */ }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const config = path.join(temp, 'device.json');
      fs.writeFileSync(config, JSON.stringify({
        gateway: 'ws://127.0.0.1:' + port + '/device',
        device_id: 'real-ui-agent', device_secret: secret,
        desktop_commander: { command: [process.execPath, backendScript] },
      }), { mode: 0o600 });
      const agent = spawn(process.execPath, ['agent/agent.js', '--config', config, '--policy',
        path.join(temp, 'no-policy.json')], { env, stdio: 'pipe' });
      processes.push(agent);
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'real-resource-test', version: '1' } });
      let resources = [];
      while (Date.now() < deadline + 15000) {
        await rpc('tools/call', { name: 'device_select', arguments: { device_id: 'real-ui-agent' } });
        const result = await rpc('resources/list');
        resources = result.result?.resources ?? [];
        if (resources.some((entry) => entry.uri === 'ui://desktop-commander/file-preview') &&
            resources.some((entry) => entry.uri === 'ui://desktop-commander/config-editor')) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      assert.ok(resources.some((entry) => entry.uri === 'ui://desktop-commander/file-preview'));
      assert.ok(resources.some((entry) => entry.uri === 'ui://desktop-commander/config-editor'));
      for (const uri of ['ui://desktop-commander/config-editor', 'ui://desktop-commander/file-preview']) {
        const result = await rpc('resources/read', { uri });
        assert.ok(result.result?.contents?.[0], 'resource must be available: ' + uri);
        const resource = result.result.contents[0];
        assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
        assert.ok(resource.text.startsWith('<!') || resource.text.includes('<html'), 'must return HTML');
        assert.ok(resource.text.length >= 100_000, 'must return the unmodified full UI bundle');
        assert.ok(resource._meta?.ui?.csp, 'must retain MCP Apps CSP metadata');
        console.log('UI resource validated:', uri,
          'chars=', resource.text.length, 'mime=', resource.mimeType);
      }
    } finally {
      await cleanupResources({ directory: temp, processes });
    }
  });
