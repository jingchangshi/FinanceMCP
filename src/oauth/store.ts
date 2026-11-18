import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * OAuth 状态存储（独立 SQLite，不触碰市场库与账户账本）。
 *
 * 安全约定：
 * - 授权码、访问令牌、刷新令牌**只存 SHA-256 哈希**，数据库泄露也不等于令牌泄露。
 * - 授权码一次性使用（`used_at`），过期即失效。
 * - 刷新令牌轮换：使用旧刷新令牌换取新令牌时，旧令牌立即标记 `rotated_to`。
 * - 所有时间用 epoch 毫秒整数，避免时区/字符串比较问题。
 */

export interface StoredClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_secret_hash: string | null;
  created_at: number;
}

/**
 * 校验授权请求的 `redirect_uri` 是否被客户端允许：
 * - 支持精确字符串匹配；
 * - 支持显式以 `/*` 结尾的 `https:` 路径前缀模式（如 Google Connected Apps 的
 *   `https://oauth-redirect.googleusercontent.com/r/*`），强制同 origin 且无 fragment。
 */
export function isRedirectUriAllowed(registeredUris: string[], candidateUri: string): boolean {
  if (registeredUris.includes(candidateUri)) return true;
  let cand: URL;
  try { cand = new URL(candidateUri); } catch { return false; }
  if (cand.hash || cand.username || cand.password) return false;
  for (const pattern of registeredUris) {
    if (!pattern.endsWith('/*')) continue;
    let pat: URL;
    try { pat = new URL(pattern); } catch { continue; }
    if (pat.protocol !== 'https:' || pat.search || pat.hash) continue;
    const prefix = pat.pathname.slice(0, -1);
    if (cand.protocol === 'https:' && cand.origin === pat.origin && cand.pathname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export interface StoredCode {
  client_id: string;
  redirect_uri: string;
  scope: string;
  resource: string;
  code_challenge: string;
  code_challenge_method: string;
  subject: string;
  expires_at: number;
  used_at: number | null;
}

export interface StoredToken {
  client_id: string;
  subject: string;
  scope: string;
  resource: string;
  issuer: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_client (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  client_secret_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_code (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  subject TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_access_token (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  issuer TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_refresh_token (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  issuer TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  rotated_to TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_access_expiry ON oauth_access_token(expires_at);
CREATE INDEX IF NOT EXISTS oauth_refresh_client ON oauth_refresh_token(client_id);
`;

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class OAuthStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    const cols = this.db.prepare('PRAGMA table_info(oauth_client)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'client_secret_hash')) {
      this.db.exec('ALTER TABLE oauth_client ADD COLUMN client_secret_hash TEXT');
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- 客户端（DCR / 预置机密客户端）

  createClient(input: {
    clientId?: string;
    clientName: string | null;
    redirectUris: string[];
    grantTypes: string[];
    responseTypes: string[];
    tokenEndpointAuthMethod: string;
    clientSecret?: string | null;
  }): StoredClient {
    const secretHash = input.clientSecret ? tokenHash(input.clientSecret) : null;
    const client: StoredClient = {
      client_id: input.clientId?.trim() || `fmc_${opaqueToken(18)}`,
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      grant_types: input.grantTypes,
      response_types: input.responseTypes,
      token_endpoint_auth_method: input.tokenEndpointAuthMethod,
      client_secret_hash: secretHash,
      created_at: Date.now(),
    };
    this.db.prepare(`INSERT INTO oauth_client
      (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, client_secret_hash, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      client.client_id, client.client_name, JSON.stringify(client.redirect_uris),
      JSON.stringify(client.grant_types), JSON.stringify(client.response_types),
      client.token_endpoint_auth_method, client.client_secret_hash, client.created_at,
    );
    return client;
  }

  getClient(clientId: string): StoredClient | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_client WHERE client_id = ?').get(clientId) as any;
    if (!row) return undefined;
    return {
      client_id: row.client_id,
      client_name: row.client_name ?? null,
      redirect_uris: JSON.parse(row.redirect_uris),
      grant_types: JSON.parse(row.grant_types),
      response_types: JSON.parse(row.response_types),
      token_endpoint_auth_method: row.token_endpoint_auth_method,
      client_secret_hash: row.client_secret_hash ?? null,
      created_at: row.created_at,
    };
  }

  listClients(): Array<Omit<StoredClient, 'client_secret_hash'> & { confidential: boolean }> {
    const rows = this.db.prepare('SELECT * FROM oauth_client ORDER BY created_at ASC').all() as any[];
    return rows.map(row => ({
      client_id: row.client_id,
      client_name: row.client_name ?? null,
      redirect_uris: JSON.parse(row.redirect_uris),
      grant_types: JSON.parse(row.grant_types),
      response_types: JSON.parse(row.response_types),
      token_endpoint_auth_method: row.token_endpoint_auth_method,
      confidential: !!row.client_secret_hash,
      created_at: row.created_at,
    }));
  }

  /** 将已通过前缀匹配验证的精确回调地址固化进客户端记录，保证后续 token 换取通过精确校验。 */
  rememberRedirectUri(clientId: string, redirectUri: string): void {
    const existing = this.getClient(clientId);
    if (!existing || existing.redirect_uris.includes(redirectUri)) return;
    if (!isRedirectUriAllowed(existing.redirect_uris, redirectUri)) return;
    const wildcards = existing.redirect_uris.filter(u => u.endsWith('/*'));
    const concretes = existing.redirect_uris.filter(u => !u.endsWith('/*'));
    const maxConcrete = Math.max(1, 32 - wildcards.length);
    const next = [...wildcards, ...[...concretes, redirectUri].slice(-maxConcrete)];
    this.db.prepare('UPDATE oauth_client SET redirect_uris = ? WHERE client_id = ?').run(JSON.stringify(next), clientId);
  }

  // ---------------------------------------------------------------- 授权码

  saveCode(input: {
    code: string; clientId: string; redirectUri: string; scope: string; resource: string;
    codeChallenge: string; codeChallengeMethod: string; subject: string; expiresAt: number;
  }): void {
    this.db.prepare(`INSERT INTO oauth_code
      (code_hash, client_id, redirect_uri, scope, resource, code_challenge, code_challenge_method, subject, expires_at, used_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`).run(
      tokenHash(input.code), input.clientId, input.redirectUri, input.scope, input.resource,
      input.codeChallenge, input.codeChallengeMethod, input.subject, input.expiresAt, Date.now(),
    );
  }

  getCode(code: string): StoredCode | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_code WHERE code_hash = ?').get(tokenHash(code)) as any;
    if (!row) return undefined;
    return {
      client_id: row.client_id, redirect_uri: row.redirect_uri, scope: row.scope, resource: row.resource,
      code_challenge: row.code_challenge, code_challenge_method: row.code_challenge_method,
      subject: row.subject, expires_at: row.expires_at, used_at: row.used_at ?? null,
    };
  }

  /** 原子地标记授权码已使用；返回 false 表示已被使用（重放）。 */
  consumeCode(code: string): boolean {
    const result = this.db.prepare('UPDATE oauth_code SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
      .run(Date.now(), tokenHash(code));
    return Number(result.changes) === 1;
  }

  // ---------------------------------------------------------------- 令牌

  saveAccessToken(input: {
    token: string; clientId: string; subject: string; scope: string; resource: string;
    issuer: string; expiresAt: number;
  }): void {
    this.db.prepare(`INSERT INTO oauth_access_token
      (token_hash, client_id, subject, scope, resource, issuer, expires_at, revoked_at, created_at)
      VALUES (?,?,?,?,?,?,?,NULL,?)`).run(
      tokenHash(input.token), input.clientId, input.subject, input.scope, input.resource,
      input.issuer, input.expiresAt, Date.now(),
    );
  }

  getAccessToken(token: string): StoredToken | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_access_token WHERE token_hash = ?').get(tokenHash(token)) as any;
    if (!row) return undefined;
    return {
      client_id: row.client_id, subject: row.subject, scope: row.scope, resource: row.resource,
      issuer: row.issuer, expires_at: row.expires_at, revoked_at: row.revoked_at ?? null, created_at: row.created_at,
    };
  }

  saveRefreshToken(input: {
    token: string; clientId: string; subject: string; scope: string; resource: string;
    issuer: string; expiresAt: number;
  }): void {
    this.db.prepare(`INSERT INTO oauth_refresh_token
      (token_hash, client_id, subject, scope, resource, issuer, expires_at, revoked_at, rotated_to, created_at)
      VALUES (?,?,?,?,?,?,?,NULL,NULL,?)`).run(
      tokenHash(input.token), input.clientId, input.subject, input.scope, input.resource,
      input.issuer, input.expiresAt, Date.now(),
    );
  }

  getRefreshToken(token: string): StoredToken | undefined {
    const row = this.db.prepare('SELECT * FROM oauth_refresh_token WHERE token_hash = ?').get(tokenHash(token)) as any;
    if (!row) return undefined;
    return {
      client_id: row.client_id, subject: row.subject, scope: row.scope, resource: row.resource,
      issuer: row.issuer, expires_at: row.expires_at, revoked_at: row.revoked_at ?? null, created_at: row.created_at,
    };
  }

  /** 轮换：把旧刷新令牌标记为已轮换到新令牌，并返回是否成功（防止并发重放）。 */
  rotateRefreshToken(oldToken: string, newToken: string): boolean {
    const result = this.db.prepare(
      'UPDATE oauth_refresh_token SET rotated_to = ?, revoked_at = ? WHERE token_hash = ? AND rotated_to IS NULL AND revoked_at IS NULL',
    ).run(tokenHash(newToken), Date.now(), tokenHash(oldToken));
    return Number(result.changes) === 1;
  }

  revokeAccessToken(token: string): boolean {
    return Number(this.db.prepare('UPDATE oauth_access_token SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(Date.now(), tokenHash(token)).changes) === 1;
  }

  revokeRefreshToken(token: string): boolean {
    return Number(this.db.prepare('UPDATE oauth_refresh_token SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(Date.now(), tokenHash(token)).changes) === 1;
  }

  /** 删除过期记录；在写操作后顺带调用，避免库无限增长。 */
  prune(now = Date.now()): void {
    this.db.prepare('DELETE FROM oauth_code WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM oauth_access_token WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM oauth_refresh_token WHERE expires_at < ?').run(now);
  }
}
