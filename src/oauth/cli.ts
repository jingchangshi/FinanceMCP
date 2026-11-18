import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { portfolioDbPath } from '../portfolio/db.js';
import { OAuthStore, opaqueToken } from './store.js';

export interface OAuthCliHelpers {
  arg(name: string): string | undefined;
  flag(name: string): boolean;
  print(value: unknown): void;
}

const ALLOWED_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
type AuthMethod = typeof ALLOWED_METHODS[number];

function resolveOAuthDbPath(explicit?: string): string {
  return explicit?.trim()
    || process.env.ASHARE_OAUTH_DB_PATH?.trim()
    || join(dirname(portfolioDbPath()), 'oauth.sqlite');
}

function parseRedirectUris(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) {
    throw new Error('--redirect-uri 需要一个或多个逗号分隔的合法回调地址');
  }
  const uris = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (uris.length === 0) throw new Error('--redirect-uri 不能为空');
  for (const uri of uris) {
    let parsed: URL;
    try { parsed = new URL(uri); } catch {
      throw new Error(`--redirect-uri 不是合法 URL: ${uri}`);
    }
    if (uri.endsWith('/*')) {
      if (parsed.protocol !== 'https:' || parsed.search || parsed.hash) {
        throw new Error(`通配 redirect_uri 必须是无查询无 fragment 的 https URL: ${uri}`);
      }
      continue;
    }
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !local) {
      throw new Error(`redirect_uri 必须是 https（或 localhost）: ${uri}`);
    }
    if (parsed.hash) {
      throw new Error(`redirect_uri 不能带 fragment: ${uri}`);
    }
  }
  return [...new Set(uris)];
}

export function runOAuthCliCommand(command: string, h: OAuthCliHelpers): boolean {
  if (command !== 'oauth-client-create' && command !== 'oauth-client-list') return false;
  const dbPath = resolveOAuthDbPath(h.arg('db'));

  if (command === 'oauth-client-list') {
    if (!existsSync(dbPath)) {
      h.print({ db: dbPath, clients: [] });
      return true;
    }
    const store = new OAuthStore(dbPath);
    try {
      h.print({ db: dbPath, clients: store.listClients() });
    } finally {
      store.close();
    }
    return true;
  }

  const name = h.arg('name')?.trim();
  if (!name) throw new Error('--name 不能为空');
  const redirectUris = parseRedirectUris(h.arg('redirect-uri'));
  const methodRaw = (h.arg('auth-method') ?? 'client_secret_post').trim();
  if (!(ALLOWED_METHODS as readonly string[]).includes(methodRaw)) {
    throw new Error(`--auth-method 仅支持 ${ALLOWED_METHODS.join(' / ')}`);
  }
  const authMethod = methodRaw as AuthMethod;
  const clientSecret = authMethod === 'none' ? null : opaqueToken(32);

  const store = new OAuthStore(dbPath);
  try {
    const client = store.createClient({
      clientName: name.slice(0, 200),
      redirectUris,
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: authMethod,
      clientSecret,
    });
    h.print({
      client_id: client.client_id,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      db: dbPath,
    });
  } finally {
    store.close();
  }
  return true;
}
