import { describe, expect, it, vi } from 'vitest';
import { WarehouseClient, WarehouseError } from '../src/client.js';
import { ConfigError, loadConfig } from '../src/config.js';

const config = { url: 'https://warehouse.test', timeZone: 'UTC', token: async () => 'read-token' };

function reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function clientWith(...responses: Response[]) {
  const fetch = vi.fn(async (_url: URL | string | Request, _init?: RequestInit) => responses.shift() ?? reply({ error: 'no more' }, 500));
  const sleep = vi.fn(async (_ms: number) => {});
  return { client: new WarehouseClient(config, { fetch: fetch as typeof globalThis.fetch, sleep }), fetch, sleep };
}

describe('WarehouseClient', () => {
  it('sends the token and drops empty params', async () => {
    const { client, fetch } = clientWith(reply({ ok: true }));
    expect(await client.get('search', { q: 'x y', artist: undefined, limit: 5, tz: '' })).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://warehouse.test/api/search?q=x+y&limit=5');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer read-token');
  });

  it('waits out Retry-After while a stat computes, then succeeds', async () => {
    const { client, sleep } = clientWith(reply({ error: 'computing' }, 503, { 'Retry-After': '3' }), reply({ done: 1 }));
    expect(await client.get('stats/rhythm')).toEqual({ done: 1 });
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('gives up once the total wait would pass the budget', async () => {
    const computing = () => reply({ error: 'Stat is being computed' }, 503, { 'Retry-After': '10' });
    const { client, sleep } = clientWith(computing(), computing(), computing(), computing());
    await expect(client.get('stats/rhythm')).rejects.toThrow(/Still computing.*about 10 s/);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a lapsed grant, and says how to fix it', async () => {
    const { client, sleep } = clientWith(reply({ error: 'reauth', needs_reauth: true }, 503, { 'Retry-After': '5' }));
    await expect(client.get('now-playing')).rejects.toThrow(/npm run authorize/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    [401, { error: 'Unauthorized' }, /rejected the token/],
    [403, { error: 'This range has not been computed.' }, /computed\. A read token/],
    [400, { error: 'q is required' }, /400: q is required/],
    // The Worker's Spotify errors carry retry_after_seconds, null when Spotify gave none.
    [429, { error: 'Spotify upstream: rate_limited', retry_after_seconds: 42 }, /rate limit \(429\).*about 42 s/],
    [429, { error: 'Spotify upstream: quota_exceeded', retry_after_seconds: null }, /rate limit \(429\).*Try again later/],
    [502, { error: 'Spotify upstream: http', retry_after_seconds: null }, /upstream \(502\).*Stored history still works/],
  ])('explains a %i', async (status, body, message) => {
    const { client } = clientWith(reply(body, status));
    await expect(client.get('x')).rejects.toThrow(message);
  });

  it('reads Retry-After on a 429 when the body gives no seconds', async () => {
    const { client, sleep } = clientWith(reply({ error: 'Spotify upstream: rate_limited', retry_after_seconds: null }, 429, { 'Retry-After': '7' }));
    await expect(client.get('now-playing')).rejects.toThrow(/about 7 s/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('explains a 200 that is not JSON instead of a parse error', async () => {
    const { client } = clientWith(new Response('<html>Bad gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    const error = await client.get('plays').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WarehouseError);
    expect((error as Error).message).toMatch(/https:\/\/warehouse\.test answered 200 with an HTML page \(text\/html\)/);
    const { client: other } = clientWith(new Response('', { status: 200 }));
    await expect(other.get('plays')).rejects.toThrow(/something that is not JSON/);
  });

  it('forgets a cached token when the warehouse rejects it', async () => {
    const forgetToken = vi.fn();
    const fetch = vi.fn(async () => reply({ error: 'Unauthorized' }, 401));
    const client = new WarehouseClient({ ...config, forgetToken }, { fetch: fetch as typeof globalThis.fetch });
    await expect(client.get('x')).rejects.toThrow(/401/);
    expect(forgetToken).toHaveBeenCalledOnce();
    const { client: forbidden } = clientWith(reply({ error: 'no' }, 403));
    await expect(forbidden.get('x')).rejects.toThrow(/403/);
  });

  it('reports a network failure with the URL', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new WarehouseClient(config, { fetch: fetch as typeof globalThis.fetch });
    await expect(client.get('plays')).rejects.toThrow('Could not reach the warehouse at https://warehouse.test: fetch failed');
  });
});

describe('loadConfig', () => {
  it('requires an https URL, except on loopback', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ MUSIC_WAREHOUSE_URL: 'http://example.com' })).toThrow(/https/);
    expect(loadConfig({ MUSIC_WAREHOUSE_URL: 'http://127.0.0.1:8787/' }).url).toBe('http://127.0.0.1:8787');
    expect(loadConfig({ MUSIC_WAREHOUSE_URL: 'https://music.example.com/' }).url).toBe('https://music.example.com');
  });

  it('validates the zone', () => {
    const base = { MUSIC_WAREHOUSE_URL: 'https://music.example.com' };
    expect(() => loadConfig({ ...base, MUSIC_WAREHOUSE_TZ: 'Mars/Base' })).toThrow(/IANA/);
    expect(loadConfig({ ...base, MUSIC_WAREHOUSE_TZ: 'Asia/Singapore' }).timeZone).toBe('Asia/Singapore');
  });

  it('prefers the token from the environment', async () => {
    const loaded = loadConfig({ MUSIC_WAREHOUSE_URL: 'https://music.example.com', MUSIC_WAREHOUSE_TOKEN: ' tok ' });
    expect(await loaded.token()).toBe('tok');
  });
});
