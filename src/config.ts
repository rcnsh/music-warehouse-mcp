import {
  KEYCHAIN_SERVICE,
  keychainToken,
  readSavedToken,
  removeSavedToken,
  saveKeychainToken,
  tokenFilePath,
  useKeychain,
} from './store.js';

export { KEYCHAIN_SERVICE, keychainToken };

/** How long a Keychain miss is remembered before `security` is asked again. */
export const KEYCHAIN_MISS_TTL_MS = 30_000;

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
  /** Drop any cached token, after the warehouse rejected it, so the next call looks again. */
  forgetToken?: () => void;
}

export interface LoadOptions {
  /** Looks up the Keychain entry for a host. */
  keychain?: (host: string) => Promise<string | null>;
  /**
   * Stores a token in the Keychain, used to move a token saved in the file
   * there. Null where there is no Keychain. Defaults to the Keychain on macOS.
   */
  keychainSave?: ((host: string, token: string) => Promise<void>) | null;
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
 * signing in. A Keychain hit is kept until the warehouse rejects it (401); a
 * miss is remembered for 30 s, so `security` doesn't run on every call but a
 * new token is still found without a restart. The saved file is read on every
 * call that gets that far.
 *
 * On macOS a token found in the file (from an older sign-in) is moved to the
 * Keychain: stored, read back, and only then removed from the file.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadOptions = {}): Config {
  const origin = parseWarehouseUrl(env.MUSIC_WAREHOUSE_URL);
  const host = new URL(origin).host;
  const keychain = options.keychain ?? keychainToken;
  const keychainSave = options.keychainSave === undefined ? (useKeychain() ? saveKeychainToken : null) : options.keychainSave;
  const tokenFile = options.tokenFile ?? tokenFilePath(env);
  const now = options.now ?? Date.now;

  const timeZone = env.MUSIC_WAREHOUSE_TZ?.trim() || systemTimeZone();
  if (!isValidTimeZone(timeZone)) throw new ConfigError(`MUSIC_WAREHOUSE_TZ is not an IANA zone: ${timeZone}`);

  let fromKeychain: { result: Promise<string | null>; at: number } | null = null;
  let migrating: Promise<void> | null = null;

  const lookUpKeychain = async (): Promise<string | null> => {
    if (fromKeychain) {
      const cached = await fromKeychain.result;
      if (cached || now() - fromKeychain.at < KEYCHAIN_MISS_TTL_MS) return cached;
    }
    const lookup = { result: keychain(host), at: now() };
    fromKeychain = lookup;
    return lookup.result;
  };

  const moveToKeychain = (token: string): Promise<void> =>
    (migrating ??= (async () => {
      if (!keychainSave) return;
      try {
        await keychainSave(host, token);
        await removeSavedToken(origin, tokenFile);
        fromKeychain = { result: Promise.resolve(token), at: now() };
      } catch {
        // Left in the file, which still works; tried again after a restart.
      }
    })());

  const token = async () => {
    const fromEnv = env.MUSIC_WAREHOUSE_TOKEN?.trim();
    if (fromEnv) return fromEnv;

    const stored = await lookUpKeychain();
    if (stored) return stored;

    let saved;
    try {
      saved = await readSavedToken(origin, tokenFile);
    } catch (error) {
      throw new ConfigError(`Could not read ${tokenFile}: ${(error as Error).message}. To sign in again, ${loginHint(origin)}.`);
    }
    if (saved) {
      if (saved.expires_ms === null || saved.expires_ms > now()) {
        await moveToKeychain(saved.token);
        return saved.token;
      }
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

  return {
    url: origin,
    timeZone,
    token,
    forgetToken: () => {
      fromKeychain = null;
    },
  };
}
