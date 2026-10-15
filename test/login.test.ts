import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarehouseClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import {
  createPkce,
  deviceName,
  exchangeCode,
  listenForCallback,
  login,
  loginUrl,
  parseCallback,
} from '../src/login.js';
import { readSavedToken, saveToken, tokenFilePath } from '../src/store.js';

const ORIGIN = 'https://warehouse.test';

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let dir: string;
let tokenFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mwmcp-'));
  tokenFile = join(dir, 'music-warehouse-mcp', 'tokens.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('PKCE and the login URL', () => {
  it('makes a 43-character verifier and its S256 challenge, without padding', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(createPkce().verifier).not.toBe(verifier);
  });

  it('matches the RFC 7636 appendix B example', () => {
    const bytes = Buffer.from([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91,
      88, 5, 88, 83, 132, 141, 121,
    ]);
    expect(createPkce(() => bytes)).toEqual({
      verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    });
  });

  it('builds /auth/login with every parameter', () => {
    const url = new URL(loginUrl(ORIGIN, { name: 'MCP (box)', returnTo: 'http://127.0.0.1:5000/callback', challenge: 'c' }));
    expect(url.origin + url.pathname).toBe('https://warehouse.test/auth/login');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: 'MCP (box)',
      return_to: 'http://127.0.0.1:5000/callback',
      code_challenge: 'c',
      code_challenge_method: 'S256',
    });
  });

  it('names the device after the host, within 64 characters', () => {
    expect(deviceName('laptop.local')).toBe('MCP (laptop.local)');
    const long = deviceName('x'.repeat(100));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith(')')).toBe(true);
  });
});

describe('the callback', () => {
  it('parses a code, a known error, and nothing', () => {
    expect(parseCallback(new URL('http://127.0.0.1/callback?code=abc'))).toEqual({ code: 'abc' });
    expect(parseCallback(new URL('http://127.0.0.1/callback?error=not_owner'))).toMatchObject({ error: 'not_owner', message: /does not own/ });
    expect(parseCallback(new URL('http://127.0.0.1/callback?error=weird'))).toMatchObject({ message: /weird/ });
    expect(parseCallback(new URL('http://127.0.0.1/callback'))).toBeNull();
  });

  it('listens on a 127.0.0.1 port, ignores other paths, answers the redirect with a page, then stops', async () => {
    const callback = await listenForCallback(10_000);
    expect(callback.returnTo).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await fetch(new URL('/favicon.ico', callback.returnTo))).status).toBe(404);
    const answer = await fetch(`${callback.returnTo}?code=xyz`);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toMatch(/Signed in/);
    expect(await callback.result).toEqual({ code: 'xyz' });
    await expect(fetch(`${callback.returnTo}?code=again`)).rejects.toThrow();
  });

  it('rejects with the reason when the warehouse sends an error', async () => {
    const callback = await listenForCallback(10_000);
    const answer = await fetch(`${callback.returnTo}?error=access_denied`);
    expect(answer.status).toBe(400);
    await expect(callback.result).rejects.toThrow(/cancelled/);
  });

  it('times out', async () => {
    const callback = await listenForCallback(20);
    await expect(callback.result).rejects.toThrow(/No answer from the browser/);
  });
});

describe('exchangeCode', () => {
  it('posts the code and verifier as JSON and returns the token', async () => {
    const fetch = vi.fn(async (_url: URL | string | Request, _init?: RequestInit) =>
      reply({ id: 'id1', token: 'tok', name: 'MCP (box)', access: 'read', expires_ms: 123 }),
    );
    const minted = await exchangeCode(ORIGIN, 'code', 'verifier', fetch as typeof globalThis.fetch);
    expect(minted).toEqual({ id: 'id1', token: 'tok', name: 'MCP (box)', access: 'read', expires_ms: 123 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://warehouse.test/auth/token');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'code', code_verifier: 'verifier' });
  });

  it('explains invalid_grant', async () => {
    const fetch = async () => reply({ error: 'invalid_grant' }, 400);
    await expect(exchangeCode(ORIGIN, 'c', 'v', fetch as typeof globalThis.fetch)).rejects.toThrow(/expired or was already used/);
  });
});

describe('login, end to end against a stubbed warehouse', () => {
  it('opens the URL, takes the redirect, exchanges with the matching verifier, and saves 0600', async () => {
    let challenge = '';
    const fetch = vi.fn(async (_url: URL | string | Request, init?: RequestInit) => {
      const { code, code_verifier } = JSON.parse(String(init?.body)) as { code: string; code_verifier: string };
      const ok = code === 'one-time' && createHash('sha256').update(code_verifier).digest('base64url') === challenge;
      return ok ? reply({ id: 'id1', token: 'signed-in', name: 'MCP (box)', access: 'read', expires_ms: 9e12 }) : reply({ error: 'invalid_grant' }, 400);
    });
    // Plays the browser: the warehouse would send it back to return_to with a code.
    const open = async (url: string) => {
      const params = new URL(url).searchParams;
      challenge = params.get('code_challenge')!;
      await globalThis.fetch(`${params.get('return_to')}?code=one-time`);
    };
    const log = vi.fn();

    const saved = await login({ url: ORIGIN, name: 'MCP (box)', fetch: fetch as typeof globalThis.fetch, open, log, tokenFile, now: () => 1 });

    expect(saved).toEqual({ token: 'signed-in', id: 'id1', name: 'MCP (box)', expires_ms: 9e12, saved_ms: 1 });
    expect(log.mock.calls[0]![0]).toContain('https://warehouse.test/auth/login?');
    expect(await readSavedToken(ORIGIN, tokenFile)).toEqual(saved);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'music-warehouse-mcp'))).mode & 0o777).toBe(0o700);
  });
});

describe('the token file', () => {
  it('lives under XDG_CONFIG_HOME, else ~/.config', () => {
    expect(tokenFilePath({ XDG_CONFIG_HOME: '/x' })).toBe('/x/music-warehouse-mcp/tokens.json');
    expect(tokenFilePath({})).toMatch(/\.config\/music-warehouse-mcp\/tokens\.json$/);
  });

  it('keeps tokens per warehouse and tightens a loose file', async () => {
    const entry = { token: 'a', id: '1', name: 'n', expires_ms: null, saved_ms: 0 };
    await saveToken('https://one.test', entry, tokenFile);
    await chmod(tokenFile, 0o644);
    await saveToken('https://two.test', { ...entry, token: 'b' }, tokenFile);
    expect((await readSavedToken('https://one.test', tokenFile))?.token).toBe('a');
    expect((await readSavedToken('https://two.test', tokenFile))?.token).toBe('b');
    expect(await readSavedToken('https://three.test', tokenFile)).toBeNull();
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  });
});

describe('token precedence', () => {
  const env = (extra: Record<string, string> = {}) => ({ MUSIC_WAREHOUSE_URL: ORIGIN, ...extra });
  const saved = (token: string, expires_ms: number | null) => saveToken(ORIGIN, { token, id: '1', name: 'n', expires_ms, saved_ms: 0 }, tokenFile);

  it('environment, then Keychain, then the signed-in token', async () => {
    await saved('from-login', null);
    const keychain = vi.fn(async () => 'from-keychain');
    expect(await loadConfig(env({ MUSIC_WAREHOUSE_TOKEN: 'from-env' }), { keychain, tokenFile }).token()).toBe('from-env');
    expect(keychain).not.toHaveBeenCalled();
    expect(await loadConfig(env(), { keychain, tokenFile }).token()).toBe('from-keychain');
    expect(await loadConfig(env(), { keychain: async () => null, tokenFile }).token()).toBe('from-login');
  });

  it('picks up a new sign-in without a restart', async () => {
    const config = loadConfig(env(), { keychain: async () => null, tokenFile });
    await expect(config.token()).rejects.toThrow(/npm run login -- --url https:\/\/warehouse\.test/);
    await saved('first', null);
    expect(await config.token()).toBe('first');
    await saved('second', null);
    expect(await config.token()).toBe('second');
  });

  it('refuses an expired signed-in token and says to sign in again', async () => {
    await saved('old', 1000);
    const config = loadConfig(env(), { keychain: async () => null, tokenFile, now: () => 2000 });
    await expect(config.token()).rejects.toThrow(/expired on 1970-01-01.*npm run login/);
  });

  it('sends the signed-in token, and a 401 points at login', async () => {
    await saved('signed-in', null);
    const fetch = vi.fn(async (_url: URL | string | Request, _init?: RequestInit) => reply({ error: 'Unauthorized' }, 401));
    const client = new WarehouseClient(loadConfig(env(), { keychain: async () => null, tokenFile }), {
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.get('search')).rejects.toThrow(/401.*npm run login -- --url https:\/\/warehouse\.test/);
    expect((fetch.mock.calls[0]![1]?.headers as Record<string, string>).Authorization).toBe('Bearer signed-in');
  });
});
