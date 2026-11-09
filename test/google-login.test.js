/**
 * Google 管理员登录专项测试：不访问 Google，使用签名校验器替身隔离外部依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createGoogleLogin } from '../gateway/google-login.js';

function fixture({ email = 'owner@example.com', verified = true, nonceOk = true } = {}) {
  /** 创建独立内存数据库和模拟 Google 身份提供方。 */
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const verifier = {
    async verifyIdToken({ idToken, audience }) {
      assert.equal(idToken, 'signed-id-token');
      assert.equal(audience, 'example-client');
      return { getPayload: () => ({
        sub: 'google-sub-001', email, email_verified: verified,
        nonce: nonceOk ? calls[0]?.nonce : 'wrong-nonce',
      }) };
    },
  };
  const auth = createGoogleLogin({
    db, publicUrl: 'https://gateway.example.com', log: () => {},
    config: {
      RMCP_GOOGLE_CLIENT_ID: 'example-client',
      RMCP_GOOGLE_CLIENT_SECRET: 'example-secret',
      RMCP_GOOGLE_ALLOWED_EMAILS: 'owner@example.com',
    },
    fetcher: async (url, req) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(new URLSearchParams(req.body).get('grant_type'), 'authorization_code');
      assert.ok(new URLSearchParams(req.body).get('code_verifier'));
      return { ok: true, async json() { return { id_token: 'signed-id-token' }; } };
    },
    verifier,
  });
  return { db, auth, calls };
}

function response() {
  /** 模拟 Node.js HTTP 响应接口。 */
  return {
    headers: null, status: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end() {},
  };
}

async function flow({ remember = false, email = 'owner@example.com', verified = true, nonceOk = true } = {}) {
  /** 完成受控 Google 跳转和回调并返回测试状态。 */
  const f = fixture({ email, verified, nonceOk });
  const start = response();
  f.auth.start({ headers: {} }, start, new URL('https://gateway.example.com/admin/auth/google/start?remember=' + Number(remember)));
  assert.equal(start.status, 303);
  const authorization = new URL(start.headers.location);
  assert.equal(authorization.hostname, 'accounts.google.com');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('nonce'));
  f.calls.push({ nonce: authorization.searchParams.get('nonce') });
  const cookie = start.headers['set-cookie'].split(';')[0];
  const callback = new URL('https://gateway.example.com/admin/auth/google/callback');
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('code', 'authorization-code');
  const issued = [];
  const done = response();
  const issue = (persist, userEmail, sub) => {
    issued.push({ persist, userEmail, sub });
    return 'rmcp_session=opaque; HttpOnly; Secure; Path=/admin; SameSite=Strict';
  };
  await f.auth.finish({ headers: { cookie } }, done, callback, issue);
  return { ...f, done, issued, callback, cookie, issue };
}

test('Google authorization is closed without explicit email allowlist', () => {
  const db = new DatabaseSync(':memory:');
  const auth = createGoogleLogin({ db, publicUrl: 'https://gateway.example.com', log: () => {}, config: {
    RMCP_GOOGLE_CLIENT_ID: 'id', RMCP_GOOGLE_CLIENT_SECRET: 'secret',
  } });
  assert.equal(auth.active, false);
  db.close();
});

test('Google login validates state/nonce/verified email and remembers exactly the requested duration', async () => {
  for (const remember of [false, true]) {
    const f = await flow({ remember });
    assert.equal(f.done.status, 303);
    assert.equal(f.done.headers.location, '/admin/');
    assert.deepEqual(f.issued, [{ persist: remember, userEmail: 'owner@example.com', sub: 'google-sub-001' }]);
    assert.equal(f.done.headers['set-cookie'].length, 2);
    assert.match(f.done.headers['set-cookie'][1], /HttpOnly/);
    const replay = response();
    await f.auth.finish({ headers: { cookie: f.cookie } }, replay, f.callback, f.issue);
    assert.equal(replay.headers.location, '/admin/?google_error=invalid_state');
    assert.equal(f.issued.length, 1);
    f.db.close();
  }
});

test('Unknown and unverified accounts are not permitted administrator access', async () => {
  for (const option of [{ email: 'intruder@example.com' }, { verified: false }, { nonceOk: false }]) {
    const f = await flow(option);
    assert.equal(f.issued.length, 0);
    assert.equal(f.done.headers.location, '/admin/?google_error=access_denied');
    f.db.close();
  }
});

test('Google callback rejects missing browser binding', async () => {
  const f = fixture();
  const result = response();
  await f.auth.finish({ headers: {} }, result, new URL('https://gateway.example.com/admin/auth/google/callback?state=bad&code=bad'), () => { throw new Error('unexpected session'); });
  assert.equal(result.headers.location, '/admin/?google_error=invalid_state');
  f.db.close();
});
