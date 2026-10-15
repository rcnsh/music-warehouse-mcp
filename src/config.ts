import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The macOS Keychain service the read token is stored under; the account is the Worker's host. */
export const KEYCHAIN_SERVICE = 'music-warehouse-mcp';

export interface Config {
  /** The Worker's origin, without a trailing slash. */
  url: string;
  /** IANA zone for local dates and times. */
  timeZone: string;
  /** Resolves the read token, once. */
  token: () => Promise<string>;
}

export class ConfigError extends Error {}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The token from the Keychain, or null if there is none (or no Keychain). */
async function keychainToken(host: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', host, '-w']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read from the environment. Problems with the URL or zone throw now; a
 * missing token only throws when a tool first needs it, so the server still
 * starts and each tool says what to fix.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.MUSIC_WAREHOUSE_URL?.trim();
  if (!raw) throw new ConfigError('MUSIC_WAREHOUSE_URL is not set: the Worker origin, e.g. https://music-api.example.com');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`MUSIC_WAREHOUSE_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new ConfigError('MUSIC_WAREHOUSE_URL must be https (plain http only on loopback), so the token is never sent in the clear');
  }

  const timeZone = env.MUSIC_WAREHOUSE_TZ?.trim() || systemTimeZone();
  if (!isValidTimeZone(timeZone)) throw new ConfigError(`MUSIC_WAREHOUSE_TZ is not an IANA zone: ${timeZone}`);

  let pending: Promise<string> | null = null;
  const token = () => {
    pending ??= (async () => {
      const fromEnv = env.MUSIC_WAREHOUSE_TOKEN?.trim();
      if (fromEnv) return fromEnv;
      const fromKeychain = await keychainToken(url.host);
      if (fromKeychain) return fromKeychain;
      throw new ConfigError(
        `No read token. Set MUSIC_WAREHOUSE_TOKEN, or store it in the Keychain: ` +
          `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${url.host} -w`,
      );
    })();
    // A failed lookup is retried next time, so storing the token needs no restart.
    pending.catch(() => (pending = null));
    return pending;
  };

  return { url: url.origin, timeZone, token };
}
