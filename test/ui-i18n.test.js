/**
 * RemoteOps i18n 国际化回归测试。
 * 验证中英文静态/动态文案、无外部网络依赖、语言选择器及认证流程不被改动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../gateway/ui/i18n.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../gateway/ui/index.html', import.meta.url), 'utf8');
const web = fs.readFileSync(new URL('../gateway/web.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../gateway/ui/style.css', import.meta.url), 'utf8');

/**
 * 创建不包含 document 和网络接口的纯翻译上下文。
 * :return: 可直接测试的国际化接口
 */
function translator() {
  const sandbox = { globalThis: {} };
  vm.runInNewContext(script, sandbox, { filename: 'gateway/ui/i18n.js' });
  return sandbox.globalThis.RemoteOpsI18n;
}

test('supports Simplified Chinese and English with deterministic fallback', () => {
  const i18n = translator();
  assert.equal(i18n.normalizeLanguage('en'), 'en-US');
  assert.equal(i18n.normalizeLanguage('en-US'), 'en-US');
  assert.equal(i18n.normalizeLanguage('zh-CN'), 'zh-CN');
  assert.equal(i18n.normalizeLanguage('fr-FR'), 'zh-CN');
  assert.deepEqual([...i18n.supported], ['zh-CN', 'en-US']);
});

test('translates all primary navigation, security and onboarding labels', () => {
  const i18n = translator();
  i18n.setLocale('en-US');
  for (const [chinese, english] of [
    ['运行总览', 'Overview'],
    ['设备管理', 'Devices'],
    ['使用量统计', 'Usage analytics'],
    ['认证信息', 'Credentials'],
    ['操作审计', 'Audit log'],
    ['设备配对', 'Device pairing'],
    ['系统设置', 'Settings'],
    ['配置管理员验证', 'Set up administrator verification'],
    ['管理员令牌不正确', 'Incorrect administrator token'],
    ['保存全部设置', 'Save settings'],
  ]) assert.equal(i18n.translateText(chinese), english);
  i18n.setLocale('zh-CN');
  assert.equal(i18n.translateText('Overview'), '运行总览');
  assert.equal(i18n.translateText('Settings'), '系统设置');
  assert.equal(i18n.translateText('Invalid filename not in dictionary'), 'Invalid filename not in dictionary');
});

test('translates dynamic counts and relative time, preserving unknown device names', () => {
  const i18n = translator();
  i18n.setLocale('en-US');
  assert.equal(i18n.translateText('3 台当前在线'), '3 currently online');
  assert.equal(i18n.translateText('最近 30 天'), 'Last 30 days');
  assert.equal(i18n.translateText('12 分钟前'), '12 min ago');
  assert.equal(i18n.translateText('15 秒'), '15 sec');
  assert.equal(i18n.translateText('30 天'), '30 days');
  assert.equal(i18n.translateText('2026-11-01：3 次调用'), '2026-11-01: 3 calls');
  assert.equal(i18n.translateText('My Device Workstation'), 'My Device Workstation');
  assert.equal(i18n.translateText(' RemoteOps '), ' RemoteOps ');
});

test('language control exists in login and server-rendered setup, without CSP weakening', () => {
  assert.match(index, /id="locale-switch"/);
  assert.match(index, /data-i18n-ignore="true"/);
  assert.ok(index.indexOf('/admin/i18n.js') < index.indexOf('/admin/app.js'));
  assert.match(web, /'\/admin\/i18n\.js': \['i18n\.js'/);
  assert.match(web, /<script src="\/admin\/i18n\.js"><\/script>/);
  assert.match(web, /'self'; style-src 'self'/);
  assert.match(styles, /\.locale-switch/);
  assert.match(styles, /\.main-area section > \.panel \+ \.panel/);
  assert.match(styles, /white-space:nowrap/);
});

test('translation script does not depend on remote translation, eval or external fonts', () => {
  assert.doesNotMatch(script, /\bfetch\s*\(/);
  assert.doesNotMatch(script, /\beval\s*\(/);
  assert.doesNotMatch(script, /innerHTML\s*=/);
  assert.match(script, /MutationObserver/);
  assert.match(script, /localStorage\.setItem/);
});
