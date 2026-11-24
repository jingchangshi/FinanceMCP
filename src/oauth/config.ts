import { dirname, join } from 'node:path';
import { portfolioDbPath } from '../portfolio/db.js';

/**
 * OAuth 2.1 配置（ChatGPT 自定义 MCP 连接器使用）。
 *
 * 只支持**单实例、单用户**的最小授权服务器：没有用户注册、没有多租户、没有外部 IdP。
 * 未显式开启时整个 OAuth 层不挂载，私有端点行为与之前完全一致。
 *
 * 失败方向：一旦 `ASHARE_OAUTH_ENABLED=1`，任何必填项缺失都在启动时抛错，
 * 绝不"静默降级为匿名/静态令牌"。
 */

export const OAUTH_SCOPE = 'portfolio:read';
/**
 * 独立的写 scope：只覆盖 `ashare_chatgpt_research_record_append`（只追加、白名单入参的研究记录）。
 * `portfolio:read` 永远不被视为写权限。它不授予下单、转账或修改账本的能力。
 */
export const OAUTH_WRITE_SCOPE = 'research:append';
export const OAUTH_SUBJECT = 'owner';

export interface OAuthConfig {
  /** 授权服务器 issuer（也是 MCP 资源的 origin）。 */
  issuer: string;
  /** 规范化的 MCP 资源标识；令牌的 audience 必须等于它。 */
  resource: string;
  /** 本地登录密码（授权端点使用）。 */
  loginPassword: string;
  /** OAuth 状态库（客户端、授权码、令牌）路径。 */
  dbPath: string;
  accessTokenLifetime: number;
  refreshTokenLifetime: number;
  scope: string;
  writeScope: string;
  /**
   * 为真时，追加工具必须持有 writeScope（或 portfolio:admin）。
   * **默认开启（fail closed）**：只读令牌无法追加研究记录。过渡期若某个旧连接器
   * 尚未重新授权，运维必须显式设置 `ASHARE_OAUTH_REQUIRE_WRITE_SCOPE=0` 才允许
   * 兼容行为——默认再也不能静默放宽写权限。
   */
  requireWriteScope: boolean;
  /** DCR 允许的回调主机白名单（精确主机或 `*.example.com` 通配）。 */
  dcrRedirectHosts: string[];
  /** DCR 客户端数量上限（单用户私服的保守上限）。 */
  maxClients: number;
  /** 同一来源在 15 分钟窗口内允许的登录失败次数。 */
  maxLoginFailures: number;
}

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`ASHARE_OAUTH_ENABLED=1 时必须设置 ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数（秒）`);
  return value;
}

function positiveCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

/**
 * DCR 回调主机白名单。
 *
 * 默认只覆盖本机回环与已知连接器（ChatGPT / Gemini）实际使用的回调主机；
 * 这既保住现有验收测试和真实连接器，又阻止任意 HTTPS 主机通过 DCR 注册一个
 * 钓鱼回调地址。运维可以用 `ASHARE_OAUTH_DCR_REDIRECT_HOSTS`（逗号分隔，
 * 支持 `*.example.com`）显式增删。
 */
const DEFAULT_DCR_REDIRECT_HOSTS = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'oauth-redirect.googleusercontent.com',
];

function dcrRedirectHosts(): string[] {
  const raw = (process.env.ASHARE_OAUTH_DCR_REDIRECT_HOSTS ?? '').trim();
  const hosts = (raw ? raw.split(',') : DEFAULT_DCR_REDIRECT_HOSTS)
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length === 0) {
    throw new Error('ASHARE_OAUTH_DCR_REDIRECT_HOSTS 不能为空：请列出允许的 DCR 回调主机');
  }
  return hosts;
}

function normalizedUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`${name} 必须是 https（本地测试可用 localhost）：${raw}`);
  }
  return url.toString().replace(/\/$/, '');
}

export function oauthEnabled(): boolean {
  return (process.env.ASHARE_OAUTH_ENABLED ?? '').trim() === '1';
}

/**
 * 读取并校验配置。未开启时返回 null；开启但配置不全时抛错（启动即失败）。
 */
export function oauthConfig(): OAuthConfig | null {
  if (!oauthEnabled()) return null;

  const issuer = normalizedUrl(required('ASHARE_OAUTH_ISSUER'), 'ASHARE_OAUTH_ISSUER');
  const resource = normalizedUrl(required('ASHARE_OAUTH_RESOURCE'), 'ASHARE_OAUTH_RESOURCE');
  if (!resource.startsWith(`${issuer}/`)) {
    throw new Error(`ASHARE_OAUTH_RESOURCE (${resource}) 必须位于 issuer (${issuer}) 之下`);
  }
  const loginPassword = required('ASHARE_OAUTH_LOGIN_PASSWORD');
  if (loginPassword.length < 12) {
    throw new Error('ASHARE_OAUTH_LOGIN_PASSWORD 至少 12 个字符');
  }

  return {
    issuer,
    resource,
    loginPassword,
    dbPath: (process.env.ASHARE_OAUTH_DB_PATH ?? '').trim() || join(dirname(portfolioDbPath()), 'oauth.sqlite'),
    accessTokenLifetime: positiveInt('ASHARE_OAUTH_ACCESS_TOKEN_TTL', 3600),
    refreshTokenLifetime: positiveInt('ASHARE_OAUTH_REFRESH_TOKEN_TTL', 30 * 24 * 3600),
    scope: OAUTH_SCOPE,
    writeScope: OAUTH_WRITE_SCOPE,
    // Fail closed by default; `=0` is the explicit, documented compatibility switch.
    requireWriteScope: (process.env.ASHARE_OAUTH_REQUIRE_WRITE_SCOPE ?? '').trim() !== '0',
    dcrRedirectHosts: dcrRedirectHosts(),
    maxClients: positiveCount('ASHARE_OAUTH_MAX_CLIENTS', 50),
    maxLoginFailures: positiveCount('ASHARE_OAUTH_MAX_LOGIN_FAILURES', 10),
  };
}
