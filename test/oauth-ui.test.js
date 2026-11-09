/**
 * OAuth 授权界面的视图、安全边界与移动回调回归测试。
 * 不使用生产令牌、真实客户端或公网服务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  sendOAuthHtml, consentHtml, mobileResultHtml, oauthErrorHtml,
} from '../gateway/oauth-ui.js';

const oauthCss = fs.readFileSync(new URL('../gateway/ui/oauth.css', import.meta.url), 'utf8');
const i18n = fs.readFileSync(new URL('../gateway/ui/i18n.js', import.meta.url), 'utf8');

/** 仅记录响应，不进行任何网络访问。 */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(content) { this.body = content; },
  };
}

test('OAuth consent page uses the same self-hosted design and strict CSP', () => {
  const res = fakeResponse();
  sendOAuthHtml(res, 200, consentHtml(
    { client_name: 'ChatGPT' },
    'https://chatgpt.com/connector_platform_oauth_redirect',
    '<input type=hidden name="state" value="safe">',
  ));
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.match(res.headers['content-security-policy'], /style-src 'self'/);
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(res.headers['content-security-policy'], /unsafe-inline/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(res.body, /href="\/admin\/oauth\.css"/);
  assert.match(res.body, /src="\/admin\/i18n\.js"/);
  assert.match(res.body, /id="locale-switch"/);
  assert.match(res.body, /class="oauth-actions"/);
  assert.match(res.body, /type="password" name="owner_token"/);
  assert.match(res.body, /name="action" value="approve"/);
  assert.match(res.body, /name="action" value="deny"/);
  assert.match(res.body, /https:\/\/chatgpt\.com/);
  assert.match(oauthCss, /@media\(max-width:360px\)/);
  assert.match(oauthCss, /\.oauth-shell \.bar \{ position:relative/);
});

test('self-reported client labels and error descriptions are HTML-escaped', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const consent = consentHtml({client_name:hostile}, 'https://client.example/callback',
    '<input type=hidden name="state" value="safe">', hostile);
  assert.doesNotMatch(consent, /<img src=x/);
  assert.match(consent, /&lt;img src=x/);
  assert.match(consent, /Application names are provided by the client/);
  const error = oauthErrorHtml(hostile);
  assert.doesNotMatch(error, /<img src=x/);
  assert.match(error, /&lt;img/);
});

test('mobile app approval and rejection keep the verified redirect and return link', () => {
  const target = 'https://chatgpt.com/connector_platform_oauth_redirect?state=ok&iss=https%3A%2F%2Fgateway.example';
  const allowed = mobileResultHtml(false, target, 'ChatGPT');
  const denied = mobileResultHtml(true, target, 'ChatGPT');
  assert.match(allowed, /Return to ChatGPT/);
  assert.match(allowed, /Approved/);
  assert.match(denied, /Cancelled/);
  assert.match(allowed, /&amp;iss=/);
  assert.match(denied, /class=btn href=/);
});

test('OAuth UI supports Chinese and English through the existing localization dictionary', () => {
  for(const text of ['Authorize remote access','Connection request','Requested access',
    'Approve access','Deny','Invalid owner token.','Return to']) {
    // The return link has a runtime client name and uses a dynamic pattern.
    if(text==='Return to') assert.match(i18n, /Return to/);
    else assert.ok(i18n.includes(text), 'missing bilingual text: '+text);
  }
});
