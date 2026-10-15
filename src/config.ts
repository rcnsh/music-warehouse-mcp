import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSavedToken, tokenFilePath } from './store.js';

const run = promisify(execFile);

/** The macOS Keychain service the read token is stored under; the account is the Worker's host. */
export const KEYCHAIN_SERVICE = 'music-warehouse-mcp';

/** How to sign in to a warehouse, for messages. */
export function loginHint(origin: string): string {
  return `run \`npm run login -- --url ${origin}\` in the music-warehouse-mcp directory`;
}

export interface Config {
  /** The Worker's origin, without a trailing slash. */
  url: string;
  /** IANA zone for local dates and times. */
  timeZone: string;
  /**
   * Resolves the read token: MUSIC_WAREHOUSE_TOKEN, else the Keychain, else
   * the token saved by signing in.
   */
  token: () => Promise<string>;
}

export interface LoadOptions {
  /** Looks up the Keychain entry for a host. */
  keychain?: (host: string) => Promise<string | null>;
  /** Where signing in saves tokens. */
  tokenFile?: string;
  now?: () => number;
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
export async function keychainToken(host: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', host, '-w']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** A warehouse origin, without a trailing slash. Must be https except on loopback. */
export function parseWarehouseUrl(raw: string | undefined, label = 'MUSIC_WAREHOUSE_URL'): string {
  const value = raw?.trim();
  if (!value) throw new ConfigError(`${label} is not set: the Worker origin, e.g. https://music-api.example.com`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} is not a URL: ${value}`);
  }
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new ConfigError(`${label} must be https (plain http only on loopback), so the token is never sent in the clear`);
  }
  return url.origin;
}

/**
 * Read from the environment. Problems with the URL or zone throw now; a
 * missing token only throws when a tool first needs it, so the server still
 * starts and each tool says what to fix.
 *
 * An explicit token (environment, then Keychain) wins over one saved by
 * signing in. The Keychain answer is kept once found; the saved file is read
 * on every call, so signing in again needs no restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadOptions = {}): Config {
  const origin = parseWarehouseUrl(env.MUSIC_WAREHOUSE_URL);
  const host = new URL(origin).host;
  const keychain = options.keychain ?? keychainToken;
  const tokenFile = options.tokenFile ?? tokenFilePath(env);
  const now = options.now ?? Date.now;

  const timeZone = env.MUSIC_WAREHOUSE_TZ?.trim() || systemTimeZone();
  if (!isValidTimeZone(timeZone)) throw new ConfigError(`MUSIC_WAREHOUSE_TZ is not an IANA zone: ${timeZone}`);

  let fromKeychain: Promise<string | null> | null = null;
  const token = async () => {
    const fromEnv = env.MUSIC_WAREHOUSE_TOKEN?.trim();
    if (fromEnv) return fromEnv;

    // A miss is retried next time, so storing the token needs no restart.
    fromKeychain ??= keychain(host);
    const stored = await fromKeychain;
    if (stored) return stored;
    fromKeychain = null;

    let saved;
    try {
      saved = await readSavedToken(origin, tokenFile);
    } catch (error) {
      throw new ConfigError(`Could not read ${tokenFile}: ${(error as Error).message}. To sign in again, ${loginHint(origin)}.`);
    }
    if (saved) {
      if (saved.expires_ms === null || saved.expires_ms > now()) return saved.token;
      throw new ConfigError(
        `The signed-in token for ${origin} expired on ${new Date(saved.expires_ms).toISOString().slice(0, 10)}. ` +
          `To sign in again, ${loginHint(origin)}.`,
      );
    }
    throw new ConfigError(
      `No read token for ${origin}. To sign in with Spotify, ${loginHint(origin)}. ` +
        `Or set MUSIC_WAREHOUSE_TOKEN, or store it in the Keychain: ` +
        `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${host} -w`,
    );
  };

  return { url: origin, timeZone, token };
}
