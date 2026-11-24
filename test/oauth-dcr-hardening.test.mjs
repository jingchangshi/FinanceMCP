// OAuth hardening: fail-closed write scope by default, DCR redirect-host
// allowlist, client-count cap, login-failure cap, and a consent page that shows
// who is asking and where the authorization code will be sent.
//
// Every assertion drives the real HTTP server; no unit-helper-only guards.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const ROOT = process.cwd();
const RESOURCE_PATH = '/private/mcp';
const PASSWORD = 'correct-horse-battery-staple';
const APPEND = 'ashare_chatgpt_research_record_append';

async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function start(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ashare-oauth-hardening-'));
  const port = await reservePort();
  const issuer = `http://127.0.0.1:${port}`;
  const oauthDb = join(dir, 'oauth.sqlite');
  const child = spawn(process.execPath, ['build/httpServer.js'], {
    cwd: ROOT,
    env: {
      ...process.env, TUSHARE_TOKEN: '', QVERIS_API_KEY: '', TWINGLY_API_KEY: '',
      NODE_ENV: 'production', PORT: String(port), MCP_HTTP_HOST: '127.0.0.1',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost', FINANCE_TOOL_PROFILE: 'ashare_daily',
      ASHARE_DATA_DIR: dir, ASHARE_DB_PATH: join(dir, 'market.sqlite'),
      ASHARE_PORTFOLIO_DB_PATH: join(dir, 'portfolio.sqlite'),
      ASHARE_OAUTH_ENABLED: '1', ASHARE_OAUTH_ISSUER: issuer,
      ASHARE_OAUTH_RESOURCE: `${issuer}${RESOURCE_PATH}`,
      ASHARE_OAUTH_LOGIN_PASSWORD: PASSWORD, ASHARE_OAUTH_DB_PATH: oauthDb,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${issuer}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const json = async (path, options = {}) => {
    const res = await fetch(`${issuer}${path}`, options);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, headers: res.headers, body, text };
  };
  const register = (redirectUris, clientName = 'ChatGPT (hardening test)') => json('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const mint = scope => {
    const raw = randomBytes(32).toString('base64url');
    const db = new DatabaseSync(oauthDb);
    try {
      db.prepare(`INSERT INTO oauth_access_token (token_hash, client_id, subject, scope, resource, issuer, expires_at, revoked_at, created_at)
        VALUES (?,?,?,?,?,?,?,NULL,?)`).run(
        createHash('sha256').update(raw, 'utf8').digest('hex'), 'test-client', 'owner', scope,
        `${issuer}${RESOURCE_PATH}`, issuer, Date.now() + 600_000, Date.now(),
      );
    } finally { db.close(); }
    return raw;
  };
  const call = async (token, name, args = {}) => {
    const res = await fetch(`${issuer}${RESOURCE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* sse */ }
    return { status: res.status, headers: res.headers, body, text };
  };
  return {
    issuer, json, register, mint, call, logs: () => logs,
    stop: async () => {
      if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    },
  };
}

function authorizeQuery(server, { clientId, redirectUri, scope = 'portfolio:read' }) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: 'challenge-placeholder',
    code_challenge_method: 'S256',
    scope,
    resource: `${server.issuer}${RESOURCE_PATH}`,
  });
}

test('H1 DCR rejects redirect hosts outside the default allowlist', async () => {
  const server = await start();
  try {
    const evil = await server.register(['https://evil.example/oauth/callback']);
    assert.equal(evil.status, 400, evil.text);
    assert.equal(evil.body.error, 'invalid_redirect_uri');
    assert.match(evil.body.error_description, /evil\.example.*不在 DCR 允许列表/);

    // A lookalike suffix must not match an allowlisted host.
    const lookalike = await server.register(['https://chatgpt.com.evil.example/cb']);
    assert.equal(lookalike.status, 400, lookalike.text);

    const known = await server.register(['https://chatgpt.com/connector/oauth/callback']);
    assert.equal(known.status, 201, known.text);
  } finally { await server.stop(); }
});

test('H2 the consent page names the client and shows the redirect host prominently', async () => {
  const server = await start();
  try {
    const registered = await server.register(['https://chatgpt.com/connector/oauth/callback'], '可疑但注册过的应用');
    assert.equal(registered.status, 201, registered.text);
    const page = await server.json(`/oauth/authorize?${authorizeQuery(server, {
      clientId: registered.body.client_id,
      redirectUri: 'https://chatgpt.com/connector/oauth/callback',
    })}`);
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /请求授权的应用/);
    assert.match(page.text, /可疑但注册过的应用/);
    assert.match(page.text, /授权码将发送到/);
    assert.match(page.text, /<strong>chatgpt\.com<\/strong>/);
    assert.match(page.text, /只有在你确认上述主机属于你信任的应用时才继续/);
    assert.match(page.text, /<code>chatgpt\.com<\/code>|chatgpt\.com/);
  } finally { await server.stop(); }
});

test('H3 the allowlist is configurable and replaces the default set', async () => {
  const server = await start({ ASHARE_OAUTH_DCR_REDIRECT_HOSTS: '*.example.test,localhost' });
  try {
    const wildcard = await server.register(['https://oauth.example.test/cb']);
    assert.equal(wildcard.status, 201, wildcard.text);
    const removedDefault = await server.register(['https://chatgpt.com/cb']);
    assert.equal(removedDefault.status, 400, removedDefault.text);
  } finally { await server.stop(); }
});

test('H4 DCR client-count cap refuses further registrations', async () => {
  const server = await start({ ASHARE_OAUTH_MAX_CLIENTS: '1' });
  try {
    const first = await server.register(['https://chatgpt.com/cb']);
    assert.equal(first.status, 201, first.text);
    const second = await server.register(['https://chatgpt.com/cb2']);
    assert.equal(second.status, 403, second.text);
    assert.equal(second.body.error, 'registration_limit_reached');
  } finally { await server.stop(); }
});

test('H5 repeated wrong-password attempts are blocked after the configured cap', async () => {
  const server = await start({ ASHARE_OAUTH_MAX_LOGIN_FAILURES: '1' });
  try {
    const registered = await server.register(['https://chatgpt.com/cb']);
    const query = authorizeQuery(server, {
      clientId: registered.body.client_id,
      redirectUri: 'https://chatgpt.com/cb',
    });
    const attempt = password => server.json('/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(query), password }).toString(),
      redirect: 'manual',
    });
    const first = await attempt('wrong-password-1');
    assert.equal(first.status, 401, first.text);
    // Even the correct password is refused while the failure window is open.
    const blocked = await attempt(PASSWORD);
    assert.equal(blocked.status, 429, blocked.text);
    assert.match(blocked.text, /登录失败次数过多/);
  } finally { await server.stop(); }
});

test('H6 default write-scope enforcement is fail-closed (read token cannot append)', async () => {
  const server = await start();
  try {
    const denied = await server.call(server.mint('portfolio:read'), APPEND, {});
    assert.equal(denied.status, 403, denied.text);
    assert.match(denied.headers.get('www-authenticate') ?? '', /insufficient_scope/);
    const allowed = await server.call(server.mint('portfolio:read research:append'), APPEND, {});
    assert.notEqual(allowed.status, 403, allowed.text);
  } finally { await server.stop(); }
});
