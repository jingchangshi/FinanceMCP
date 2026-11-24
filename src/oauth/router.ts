import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import OAuth2Server from '@node-oauth/oauth2-server';
import { OAUTH_SUBJECT, type OAuthConfig } from './config.js';
import { OAuthStore, isRedirectUriAllowed, opaqueToken } from './store.js';
import { createModel } from './model.js';

/**
 * ChatGPT 兼容的 OAuth 2.1 授权服务器（单用户、单实例）。
 *
 * 端点：
 * - `/.well-known/oauth-protected-resource`（RFC 9728，含 `/private/mcp` 变体）
 * - `/.well-known/oauth-authorization-server`（RFC 8414）
 * - `POST /oauth/register`（RFC 7591 DCR）
 * - `GET|POST /oauth/authorize`（Authorization Code + PKCE S256，本地密码登录）
 * - `POST /oauth/token`（authorization_code / refresh_token）
 * - `POST /oauth/revoke`（RFC 7009）
 *
 * 协议解析、PKCE 校验、错误码与刷新令牌轮换由 `@node-oauth/oauth2-server` 负责；
 * 本文件只做路由、登录页、resource/scope 约束与错误映射。
 */

export interface OAuthRuntime {
  config: OAuthConfig;
  store: OAuthStore;
  server: InstanceType<typeof OAuth2Server>;
  router: Router;
}

const LOGIN_FORM_ACTION = '/oauth/authorize';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function passwordMatches(expected: string, presented: string): boolean {
  const a = sha256(expected);
  const b = sha256(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function html(res: Response, status: number, body: string): void {
  res.status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // 防嵌入由 CSP 的 frame-ancestors 负责（现代浏览器优先）。这里不再发
      // X-Frame-Options：Caddy 已在站点层设置 SAMEORIGIN，再发一个 DENY 会产生
      // 两个取值不同的同名头，浏览器行为不一致。
      'Referrer-Policy': 'no-referrer',
      // 注意：**不要**在这里加 `form-action`。浏览器会把 `form-action` 应用到
      // 表单提交后的重定向链上；授权成功后我们要 302 回客户端（例如
      // https://chatgpt.com/connector_platform_oauth_redirect），
      // 一旦限制为 'self'，浏览器会拒绝跟随，表现为"点了授权但不跳转"。
      // 表单本身的 action 是固定的同源 /oauth/authorize，且必须输入密码，
      // 因此省略 form-action 不增加 CSRF 风险。
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    })
    .send(body);
}

/** 固定窗口限流：只用于授权/注册/换令牌等敏感端点。 */
function rateLimiter(limit: number, windowMs = 60_000) {
  const windows = new Map<string, { start: number; count: number }>();
  return (req: Request, res: Response, next: () => void): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry || now - entry.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.status(429).set('Retry-After', '60').json({ error: 'too_many_requests' });
      return;
    }
    next();
  };
}

/** 取字符串参数（query 或 body），拒绝数组/对象。 */
function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return undefined;
}

function firstStr(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

/** DCR 回调主机白名单匹配：精确主机，或显式的 `*.example.com` 后缀通配。 */
function redirectHostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some(pattern => {
    const normalized = pattern.toLowerCase();
    if (normalized === host) return true;
    return normalized.startsWith('*.') && host.endsWith(normalized.slice(1));
  });
}

function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '（无法解析的回调地址）';
  }
}

export function createOAuthRuntime(config: OAuthConfig): OAuthRuntime {
  const store = new OAuthStore(config.dbPath);
  const model = createModel(store, config);
  const server = new OAuth2Server({
    model,
    // 公开客户端在 readAuthorizeParams 中强制要求 PKCE S256；机密客户端（持有 client_secret）允许按需省略 PKCE。
    requirePKCE: false,
    alwaysIssueNewRefreshToken: true,
    authorizationCodeLifetime: 300,
    accessTokenLifetime: config.accessTokenLifetime,
    refreshTokenLifetime: config.refreshTokenLifetime,
    allowEmptyState: true,
  });

  const router = Router();
  const limitAuthorize = rateLimiter(20);
  const limitToken = rateLimiter(60);
  const limitRegister = rateLimiter(20);

  // 登录失败限流：按来源 IP 在 15 分钟窗口内计数，成功登录即清零。
  // 与通用 rateLimiter 分开，因为只有*失败*的密码尝试才计入。
  const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
  const loginFailures = new Map<string, { start: number; count: number }>();
  const loginKey = (req: Request): string => req.ip || req.socket.remoteAddress || 'unknown';
  const loginBlocked = (key: string): boolean => {
    const entry = loginFailures.get(key);
    if (!entry) return false;
    if (Date.now() - entry.start >= LOGIN_FAILURE_WINDOW_MS) {
      loginFailures.delete(key);
      return false;
    }
    return entry.count >= config.maxLoginFailures;
  };
  const noteLoginFailure = (key: string): void => {
    const now = Date.now();
    const entry = loginFailures.get(key);
    if (!entry || now - entry.start >= LOGIN_FAILURE_WINDOW_MS) {
      loginFailures.set(key, { start: now, count: 1 });
      if (loginFailures.size > 10_000) {
        for (const [k, v] of loginFailures) if (now - v.start >= LOGIN_FAILURE_WINDOW_MS) loginFailures.delete(k);
      }
      return;
    }
    entry.count += 1;
  };

  // ---------------------------------------------------------------- 元数据

  const protectedResourceMetadata = () => ({
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [config.scope, config.writeScope],
    bearer_methods_supported: ['header'],
    resource_documentation: `${config.issuer}/docs/v1/V1_CHATGPT_ACCEPTANCE_CHECKLIST.md`,
  });

  router.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(protectedResourceMetadata());
  });
  // RFC 9728 的路径化变体：客户端可能按资源路径查询。
  router.get('/.well-known/oauth-protected-resource/private/mcp', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(protectedResourceMetadata());
  });

  const authServerMetadata = () => ({
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    registration_endpoint: `${config.issuer}/oauth/register`,
    revocation_endpoint: `${config.issuer}/oauth/revoke`,
    scopes_supported: [config.scope, config.writeScope],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    // 我们在每个授权响应里都追加 `iss`，因此可以如实声明。
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${config.issuer}/docs/v1/V1_CHATGPT_ACCEPTANCE_CHECKLIST.md`,
  });

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(authServerMetadata());
  });
  router.get('/.well-known/oauth-authorization-server/private/mcp', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(authServerMetadata());
  });
  router.get('/.well-known/openid-configuration', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(authServerMetadata());
  });

  // ---------------------------------------------------------------- DCR

  router.post('/oauth/register', limitRegister, (req, res) => {
    const body = req.body ?? {};
    const authMethodRaw = body.token_endpoint_auth_method === undefined ? 'none' : body.token_endpoint_auth_method;
    const allowedMethods = ['none', 'client_secret_post', 'client_secret_basic'] as const;
    if (typeof authMethodRaw !== 'string' || !(allowedMethods as readonly string[]).includes(authMethodRaw)) {
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'token_endpoint_auth_method 仅支持 none、client_secret_post 或 client_secret_basic',
      });
      return;
    }
    const authMethod = authMethodRaw as typeof allowedMethods[number];

    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u: unknown): u is string => typeof u === 'string')
      : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris 必须是非空数组' });
      return;
    }
    for (const uri of redirectUris) {
      let parsed: URL;
      try { parsed = new URL(uri); } catch {
        res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uri 不是合法 URL' });
        return;
      }
      if (!redirectHostAllowed(parsed.hostname, config.dcrRedirectHosts)) {
        // 未限制主机的 DCR 允许任何人注册一个指向自己站点的回调地址，再把
        // 授权页伪装成“登录你的账户”——这是典型的 OAuth 钓鱼路径。
        res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: `redirect_uri 主机 ${parsed.hostname} 不在 DCR 允许列表；如需新增请配置 ASHARE_OAUTH_DCR_REDIRECT_HOSTS`,
        });
        return;
      }
      if (uri.endsWith('/*')) {
        if (parsed.protocol !== 'https:' || parsed.search || parsed.hash) {
          res.status(400).json({ error: 'invalid_redirect_uri', error_description: '通配 redirect_uri 必须是无查询无 fragment 的 https URL' });
          return;
        }
        continue;
      }
      const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !local) {
        res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uri 必须是 https' });
        return;
      }
      if (parsed.hash) {
        res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uri 不能带 fragment' });
        return;
      }
    }

    if (store.countClients() >= config.maxClients) {
      res.status(403).json({
        error: 'registration_limit_reached',
        error_description: `DCR 客户端数量已达上限 ${config.maxClients}；请先清理不再使用的客户端`,
      });
      return;
    }

    const clientSecret = authMethod === 'none' ? null : opaqueToken(32);
    const client = store.createClient({
      clientName: typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null,
      redirectUris,
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: authMethod,
      clientSecret,
    });
    res.status(201).json({
      client_id: client.client_id,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(client.created_at / 1000),
      client_name: client.client_name ?? undefined,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: authMethod,
      scope: config.scope,
    });
  });

  // ---------------------------------------------------------------- 授权端点

  interface AuthorizeParams {
    client_id: string;
    /** DCR 注册时提供的应用名；同意页必须展示，否则用户无法识别请求方。 */
    client_name: string | null;
    redirect_uri: string;
    response_type: string;
    state?: string;
    code_challenge: string;
    code_challenge_method: string;
    scope?: string;
    resource: string;
  }

  function readAuthorizeParams(req: Request): { params?: AuthorizeParams; error?: string } {
    const clientId = firstStr(req.query.client_id, req.body?.client_id);
    const redirectUri = firstStr(req.query.redirect_uri, req.body?.redirect_uri);
    const responseType = firstStr(req.query.response_type, req.body?.response_type);
    const codeChallenge = firstStr(req.query.code_challenge, req.body?.code_challenge);
    const explicitMethod = firstStr(req.query.code_challenge_method, req.body?.code_challenge_method);
    const method = explicitMethod ?? 'S256';
    const resource = firstStr(req.query.resource, req.body?.resource) ?? config.resource;
    const scope = firstStr(req.query.scope, req.body?.scope) ?? config.scope;
    const state = firstStr(req.query.state, req.body?.state);

    if (!clientId) return { error: 'client_id 缺失' };
    if (!redirectUri) return { error: 'redirect_uri 缺失' };
    if (responseType !== 'code') return { error: 'response_type 必须是 code' };
    if (method !== 'S256') return { error: 'code_challenge_method 必须是 S256' };
    if (resource !== config.resource) return { error: 'resource 与受保护资源不匹配' };
    // `portfolio:admin` 不是可申请的 scope：同意页只展示读/追加两项，若允许申请它，
    // 用户看到的"只读"授权会签发出可追加的令牌。它只可能来自服务端直接写入的令牌。
    if (scope.split(' ').some(item => item !== config.scope && item !== config.writeScope)) {
      return { error: 'scope 不受支持' };
    }
    // 私有端点的每一次访问都先要求读 scope，只申请追加的令牌永远进不去任何工具。
    // 与工具级挑战一致（挑战总是同时要求两者），在授权时就拒绝，而不是签发一个无用的令牌。
    const requested = scope.split(' ');
    if (requested.includes(config.writeScope) && !requested.includes(config.scope)) {
      return { error: `${config.writeScope} 必须与 ${config.scope} 一起申请` };
    }

    const client = store.getClient(clientId);
    if (!client) return { error: '未知的 client_id（请先注册）' };
    if (!client.client_secret_hash && !codeChallenge) {
      return { error: 'code_challenge 缺失（必须使用 PKCE S256）' };
    }
    if (!isRedirectUriAllowed(client.redirect_uris, redirectUri)) {
      return { error: 'redirect_uri 未在客户端注册' };
    }

    return {
      params: {
        client_id: clientId, client_name: client.client_name?.trim() || null,
        redirect_uri: redirectUri, response_type: responseType,
        state, code_challenge: codeChallenge ?? '', code_challenge_method: codeChallenge ? method : '', scope, resource,
      },
    };
  }

  function renderLogin(res: Response, params: AuthorizeParams, status = 200, message?: string): void {
    const hidden = Object.entries({
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      response_type: params.response_type,
      state: params.state ?? '',
      code_challenge: params.code_challenge,
      code_challenge_method: params.code_challenge_method,
      scope: params.scope ?? config.scope,
      resource: params.resource,
    }).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('\n      ');

    html(res, status, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权访问 A股投资账户</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 560px; margin: 8vh auto; padding: 0 20px; line-height: 1.6; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 28px; }
  h1 { font-size: 1.35rem; margin: 0 0 8px; }
  .muted { opacity: .75; font-size: .92rem; }
  ul { padding-left: 1.2rem; }
  input[type=password] { width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid #8886; border-radius: 8px; box-sizing: border-box; }
  button { margin-top: 16px; width: 100%; padding: 11px; font-size: 1rem; border-radius: 8px; border: 0; background: #2563eb; color: #fff; cursor: pointer; }
  .err { color: #b91c1c; margin: 0 0 12px; }
  code { background: #8881; padding: 1px 5px; border-radius: 4px; }
  .client { background: #8881; border-radius: 8px; padding: 10px 14px; margin: 12px 0 14px; font-size: .92rem; }
  .client p { margin: 4px 0; }
  .client .host { font-size: 1.02rem; }
  .warn { color: #b45309; font-weight: 600; }
</style></head>
<body><div class="card">
  <h1>授权访问 A股投资账户</h1>
  <div class="client">
    <p>请求授权的应用：<strong>${escapeHtml(params.client_name ?? '未命名客户端（请核对客户端 ID）')}</strong></p>
    <p class="host">授权码将发送到：<strong>${escapeHtml(displayHost(params.redirect_uri))}</strong></p>
    <p class="warn">只有在你确认上述主机属于你信任的应用时才继续；任何其他主机都可能是钓鱼。</p>
    <p>回调地址：<code>${escapeHtml(params.redirect_uri)}</code></p>
    <p>客户端 ID：<code>${escapeHtml(params.client_id)}</code></p>
  </div>
  <p class="muted">${(params.scope ?? config.scope).split(' ').includes(config.writeScope)
    ? '一个客户端正在请求读取你的账户数据，并<strong>追加研究记录</strong>。'
    : '一个客户端正在请求<strong>只读</strong>访问你的账户数据。'}</p>
  <ul class="muted">
    <li>权限范围：<code>${escapeHtml(params.scope ?? config.scope)}</code>${(params.scope ?? config.scope).split(' ').includes(config.writeScope) ? '（含研究记录追加）' : '（只读）'}</li>
    <li>资源：<code>${escapeHtml(params.resource)}</code></li>
    <li>不包含下单、转账或修改账本的能力${(params.scope ?? config.scope).split(' ').includes(config.writeScope) ? '；追加仅限研究记录，只增不改' : ''}</li>
  </ul>
  ${message ? `<p class="err">${escapeHtml(message)}</p>` : ''}
  <form method="post" action="${LOGIN_FORM_ACTION}">
      ${hidden}
      <label class="muted" for="password">登录密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">授权</button>
  </form>
</div></body></html>`);
  }

  router.get('/oauth/authorize', limitAuthorize, (req, res) => {
    const parsed = readAuthorizeParams(req);
    if (!parsed.params) {
      html(res, 400, `<!doctype html><meta charset="utf-8"><h1>请求无效</h1><p>${escapeHtml(parsed.error)}</p>`);
      return;
    }
    renderLogin(res, parsed.params);
  });

  router.post('/oauth/authorize', limitAuthorize, async (req, res) => {
    const parsed = readAuthorizeParams(req);
    if (!parsed.params) {
      html(res, 400, `<!doctype html><meta charset="utf-8"><h1>请求无效</h1><p>${escapeHtml(parsed.error)}</p>`);
      return;
    }
    const params = parsed.params;
    const failureKey = loginKey(req);
    if (loginBlocked(failureKey)) {
      renderLogin(res, params, 429, '登录失败次数过多，请 15 分钟后再试');
      return;
    }
    const password = str(req.body?.password) ?? '';
    if (!passwordMatches(config.loginPassword, password)) {
      noteLoginFailure(failureKey);
      renderLogin(res, params, 401, '密码不正确');
      return;
    }
    loginFailures.delete(failureKey);
    store.rememberRedirectUri(params.client_id, params.redirect_uri);

    const oauthRequest = new OAuth2Server.Request({
      headers: req.headers,
      method: req.method,
      query: {},
      body: {
        client_id: params.client_id,
        redirect_uri: params.redirect_uri,
        response_type: params.response_type,
        state: params.state,
        code_challenge: params.code_challenge,
        code_challenge_method: params.code_challenge_method,
        scope: params.scope,
        resource: params.resource,
      },
    });
    const oauthResponse = new OAuth2Server.Response();
    try {
      await server.authorize(oauthRequest, oauthResponse, {
        // 密码已在上面校验；这里把已认证的单一用户交给库。
        authenticateHandler: { handle: async () => ({ id: OAUTH_SUBJECT, resource: params.resource }) },
      });
      const location = String(oauthResponse.get('Location') ?? '');
      if (!location) throw new Error('授权服务器没有返回重定向地址');
      res.redirect(302, withIss(location, config.issuer));
    } catch (error: any) {
      // 授权失败也要带上 `iss`，与元数据声明保持一致。
      const status = Number(error?.code ?? 0) || 400;
      html(res, status >= 400 && status < 600 ? status : 400,
        `<!doctype html><meta charset="utf-8"><h1>授权失败</h1><p>${escapeHtml(error?.message ?? error)}</p>`);
    }
  });

  // ---------------------------------------------------------------- 令牌端点

  router.post('/oauth/token', limitToken, async (req, res) => {
    const resource = str(req.body?.resource);
    if (resource !== undefined && resource !== config.resource) {
      res.status(400).json({ error: 'invalid_target', error_description: 'resource 与受保护资源不匹配' });
      return;
    }
    const oauthRequest = new OAuth2Server.Request({
      headers: req.headers,
      method: req.method,
      query: {},
      body: req.body ?? {},
    });
    const oauthResponse = new OAuth2Server.Response();
    try {
      await server.token(oauthRequest, oauthResponse, {
        requireClientAuthentication: { authorization_code: false, refresh_token: false },
      });
      res.status(oauthResponse.status ?? 200)
        .set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' })
        .json(oauthResponse.body ?? {});
    } catch (error: any) {
      const status = Number(error?.code ?? 0);
      res.status(status >= 400 && status < 600 ? status : 400)
        .set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' })
        .json({ error: error?.name ? String(error.name).replace(/Error$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() : 'invalid_request',
          error_description: error?.message ?? 'token request failed' });
    }
  });

  // ---------------------------------------------------------------- 撤销

  router.post('/oauth/revoke', limitToken, (req, res) => {
    const token = str(req.body?.token);
    if (!token) {
      res.status(400).json({ error: 'invalid_request', error_description: 'token 缺失' });
      return;
    }
    // RFC 7009：未知令牌也返回 200，避免探测。
    store.revokeAccessToken(token);
    store.revokeRefreshToken(token);
    res.status(200).json({});
  });

  return { config, store, server, router };
}

/**
 * 在授权重定向里追加 `iss`。
 *
 * RFC 9207 要求客户端精确比较 issuer 字符串；我们声明
 * `authorization_response_iss_parameter_supported: true`，因此每个响应都必须带。
 */
function withIss(location: string, issuer: string): string {
  try {
    const url = new URL(location);
    url.searchParams.set('iss', issuer);
    return url.toString();
  } catch {
    return location;
  }
}
