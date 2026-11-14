import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StrategyAdmissionStore, type AdmissionAction } from './strategyAdmission.js';

/** Independent CLI handler; callers may render its return value as JSON. */
export function handleStrategyAdmission(args: string[]): unknown {
  const [command, ...rest] = args;
  const required: Record<string, string[]> = {
    grant: ['release', 'account', 'market', 'environment', 'note', 'valid-from', 'valid-until'],
    pause: ['release', 'account', 'market', 'environment', 'note'],
    resume: ['release', 'account', 'market', 'environment', 'note'],
    revoke: ['release', 'account', 'market', 'environment', 'note'],
    status: ['release', 'account', 'market', 'environment'],
  };
  if (!command || !Object.hasOwn(required, command)) throw new Error('invalid_admission_arguments');
  const options: Record<string, string> = Object.create(null);
  let confirm = false;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === '--confirm' && command === 'grant' && !confirm) { confirm = true; continue; }
    const name = key.startsWith('--') ? key.slice(2) : '';
    if (![...required[command], 'db', 'operator'].includes(name) || Object.hasOwn(options, name) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('invalid_admission_arguments');
    options[name] = rest[++i];
  }
  if (required[command].some(key => !options[key]) || (command === 'grant' && !confirm)) throw new Error('invalid_admission_arguments');
  const release: unknown = JSON.parse(readFileSync(options.release, 'utf8'));
  const scope = { account: options.account, market: options.market, environment: options.environment };
  const path = options.db ?? process.env.ASHARE_STRATEGY_ADMISSION_DB_PATH ?? join(homedir(), '.local', 'share', 'ashare-private', 'strategy-admission.sqlite');
  // A status lookup never creates an authorization store.
  if (command === 'status' && !existsSync(path)) return { admitted: false };
  if (command === 'grant' && !existsSync(path)) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = new StrategyAdmissionStore(path, { create: command === 'grant' && !existsSync(path) });
  try {
    if (command === 'status') {
      const implementation = (release as { strategy?: { implementation_sha256?: string } })?.strategy?.implementation_sha256 ?? '';
      return { admitted: store.check(release, scope, implementation) };
    }
    const action = (command === 'pause' ? 'SUSPEND' : command.toUpperCase()) as AdmissionAction;
    store.record(action, release, scope, { reason: options.note, operator: options.operator, validFrom: options['valid-from'], validUntil: options['valid-until'] });
    return { recorded: command };
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = handleStrategyAdmission(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (typeof result === 'object' && result !== null && 'admitted' in result && !result.admitted) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'admission_error'}\n`);
    process.exitCode = 1;
  }
}
