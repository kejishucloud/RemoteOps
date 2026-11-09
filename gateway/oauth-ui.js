/**
 * RemoteOps OAuth 授权页面（仅负责 HTML 输出，不修改协议与权限逻辑）。
 * 同源静态资源、严格 CSP，语言切换复用管理控制台的 i18n.js。
 */
const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** 输出统一且禁止缓存的安全 HTML 页面。 */
export function sendOAuthHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  res.end(`<!doctype html><html lang="en" data-theme="light"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>RemoteOps · Authorization</title>
<link rel="stylesheet" href="/admin/style.css"><link rel="stylesheet" href="/admin/oauth.css"></head><body class="oauth-shell">
<header class="bar"><a class="brand" href="/admin/" aria-label="RemoteOps">
<span class="brand-icon" aria-hidden="true">R<span class="brand-slash">/</span></span>
<span class="brand-name"><strong>RemoteOps</strong><small>Control center</small></span></a>
<span class="bar-spacer"></span><button id="locale-switch" data-i18n-ignore="true"
class="ghost locale-switch" type="button" aria-label="切换为中文" title="简体中文">中文</button>
<span class="header-security"><span class="header-security-dot" aria-hidden="true"></span>Secure connection</span></header>
<div class="oauth-page"><main class="oauth-main"><section class="oauth-card">${body}</section></main>
<footer class="oauth-footer">Authorization is handled by your self-hosted RemoteOps Gateway</footer></div>
<script src="/admin/i18n.js"></script></body></html>`);
}

/**
 * 权限告知：客户端名称是注册时自报字段，故不能作为已验证的应用身份。
 * 保留浏览器已有的 Owner Token 授权输入和同源 POST。
 */
export function consentHtml(client, redirectUri, hidden, message = '') {
  const name = esc(client.client_name);
  const initial = esc(String(client.client_name || 'C').trim().slice(0,1).toUpperCase() || 'C');
  const url = new URL(redirectUri);
  const origin = url.origin === 'null' ? url.protocol + '//' + (url.host || 'application') : url.origin;
  return `<p class="oauth-caption">Connection request</p>
<div class="oauth-apps" aria-label="RemoteOps connection">
<div class="oauth-app-block"><span class="oauth-app-mark" aria-hidden="true">R/</span><span class="oauth-app-label">RemoteOps</span></div>
<span class="oauth-connection" aria-hidden="true"></span>
<div class="oauth-app-block"><span class="oauth-app-mark" aria-hidden="true">${initial}</span><span class="oauth-app-label" data-i18n-ignore="true">${name}</span></div></div>
<h1 class="oauth-heading">Authorize remote access</h1>
<p class="oauth-lead">Review this request before allowing the application to access your RemoteOps Gateway.</p>
<div class="oauth-client-panel"><p class="oauth-panel-title">Requesting application</p>
<p class="oauth-client-name" data-i18n-ignore="true">${name}</p>
<p class="oauth-footnote">Application names are provided by the client and are not verified by RemoteOps.</p></div>
<div class="oauth-client-panel"><p class="oauth-panel-title">Requested access</p>
<ul class="oauth-permissions"><li><span class="permission-icon" aria-hidden="true">✓</span><span>View connected devices and available tools</span></li>
<li><span class="permission-icon" aria-hidden="true">✓</span><span>Use tools permitted by each device, including file operations and commands</span></li></ul></div>
<div class="oauth-redirect"><span class="oauth-redirect-title">Redirect destination</span>
<code data-i18n-ignore="true">${esc(origin)}</code></div>
${message ? `<p class="oauth-alert" role="alert">${esc(message)}</p>` : ''}
<form method="post" action="/authorize">${hidden}
<label class="oauth-token-label" for="oauth-owner-token">Owner (admin) token</label>
<input class="oauth-token-input" id="oauth-owner-token" type="password" name="owner_token"
autocomplete="off" aria-describedby="oauth-token-help" required autofocus>
<p class="oauth-helper" id="oauth-token-help">Use the Owner Token saved on your Gateway to approve this connection. Never share it with the requesting application.</p>
<div class="oauth-actions"><button class="ghost oauth-deny" type="submit" name="action" value="deny" formnovalidate>Deny</button>
<button class="oauth-approve" type="submit" name="action" value="approve">Approve access</button></div>
</form><p class="oauth-footnote">Only approve applications you recognize. Device-level policies continue to apply after authorization.</p>`;
}

/** 返回移动端原生应用；redirect 已由 OAuth 协议代码完成校验。 */
export function mobileResultHtml(denied, redirect, clientName) {
  return `<div class="oauth-result"><div class="oauth-state-icon ${denied ? 'denied' : ''}" aria-hidden="true">${denied ? '–' : '✓'}</div>
<p class="oauth-caption">Connection request</p><h1 class="oauth-heading">${denied ? 'Cancelled' : 'Approved'}</h1>
<p class="oauth-lead">${denied ? 'Authorization was cancelled. Tap below to return to the app.' :
    'Access was approved. Tap below to finish connecting in the app.'}</p>
<a class=btn href="${esc(redirect)}">Return to ${esc(clientName || 'the app')}</a></div>`;
}

/** 错误状态不显示任何密钥、code、或未经验证的回调链接。 */
export function oauthErrorHtml(message) {
  return `<div class="oauth-result"><div class="oauth-state-icon error" aria-hidden="true">!</div>
<p class="oauth-caption">Connection request</p><h1 class="oauth-heading">Unable to authorize</h1>
<p class="oauth-error-message">${esc(message)}</p></div>`;
}
