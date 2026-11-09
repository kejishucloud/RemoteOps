/**
 * RemoteOps UI v3 静态契约测试。
 * 确保管理后台的前端重构保留既有认证与路由，并遵循严格 CSP。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../gateway/ui/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../gateway/ui/style.css', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../gateway/ui/app.js', import.meta.url), 'utf8');

/**
 * 首页必须提供明确的首次管理员初始化入口，而不能把未配置状态作为空白登录页。
 */
test('unconfigured admin view has a visible onboarding action', () => {
  assert.match(html, /id="enroll"/);
  assert.match(html, /href="\/admin\/setup"/);
  assert.match(html, /配置管理员验证/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="code"/);
  assert.match(app, /\$\('#login-form'\)\.hidden = !enrolled/);
});

/**
 * 导航结构与后台已有 API/视图 ID 保持兼容，避免视觉升级导致功能回归。
 */
test('all eight management views and navigation controls are preserved', () => {
  for (const name of ['overview', 'devices', 'usage', 'clients', 'chatgpt',
    'audit', 'pairing', 'settings']) {
    assert.ok(html.includes('data-tab="' + name + '"'), 'missing tab ' + name);
    assert.ok(html.includes('id="tab-' + name + '"'), 'missing view ' + name);
  }
  assert.ok(html.includes('id="logout"'));
  assert.ok(html.includes('id="refresh"'));
  assert.ok(html.includes('id="page-title"'));
});

/**
 * 禁用 CDN、CSS 渐变、大面积装饰图片与不必要的外部脚本。
 */
test('console uses local assets, restrained tokens and responsive styles', () => {
  assert.match(html, /<html lang="zh-CN" data-theme="light">/);
  assert.match(html, /\/admin\/style\.css/);
  assert.match(css, /--line:/);
  assert.match(css, /--accent:/);
  assert.match(css, /@media\(max-width:740px\)/);
  assert.doesNotMatch(css, /linear-gradient\s*\(/);
  // SVG 的 xmlns 是标准命名空间，不属于远程资源；仅禁止外部脚本与样式地址。
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/);
});

/**
 * CSP 禁用 style 属性注入时，动态柱图应由受限制的 CSSOM 更新。
 */
test('dynamic numeric chart layout is CSP-safe', () => {
  assert.match(app, /e\.style\.setProperty\(property, value\)/);
  assert.doesNotMatch(app, /e\.setAttribute\(k, v === true \? '' : v\);\s*\/\/\s*unsafe style/i);
  assert.match(app, /height\|width\|opacity/);
});
