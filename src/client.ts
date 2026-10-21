import { type Config, loginHint } from './config.js';

/** A failed call, with a message written for the agent reading it. */
export class WarehouseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Params = Record<string, string | number | undefined>;

export interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Longest total wait on `503 Retry-After` (a stat or Wrapped computing) before giving up. */
  maxWaitMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A read-only client for the Worker's /api/* routes. */
export class WarehouseClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: Config,
    options: ClientOptions = {},
  ) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? sleep;
    this.maxWaitMs = options.maxWaitMs ?? 25_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async get<T = unknown>(path: string, params: Params = {}): Promise<T> {
    const url = new URL(`/api/${path}`, this.config.url);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const token = await this.config.token();

    let waitedMs = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new WarehouseError(`Could not reach the warehouse at ${this.config.url}: ${(error as Error).message}`, 0);
      }
      if (response.ok) return parseJson<T>(response, this.config.url);

      const body = (await response.json().catch(() => ({}))) as ErrorBody;
      const retryAfterS = Number(response.headers.get('Retry-After'));
      if (response.status === 503 && !body.needs_reauth && Number.isFinite(retryAfterS) && retryAfterS > 0) {
        const waitMs = Math.min(retryAfterS, 10) * 1000;
        if (waitedMs + waitMs <= this.maxWaitMs) {
          waitedMs += waitMs;
          await this.sleep(waitMs);
          continue;
        }
      }
      // A rejected token may be a cached one that has since been replaced.
      if (response.status === 401) this.config.forgetToken?.();
      throw new WarehouseError(explain(response.status, body, retryAfterS, this.config.url), response.status);
    }
  }
}

/**
 * A 200 body as JSON. Something in front of the Worker (a Cloudflare error or
 * challenge page, a captive portal, a wrong URL) can answer 200 with HTML,
 * which would otherwise surface as `Unexpected token <`.
 */
async function parseJson<T>(response: Response, origin: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const type = response.headers.get('Content-Type')?.split(';')[0]?.trim() || 'no content type';
    const what = /^\s*</.test(text) ? 'an HTML page' : 'something that is not JSON';
    throw new WarehouseError(
      `The warehouse at ${origin} answered ${response.status} with ${what} (${type}) instead of JSON. ` +
        'Something in front of the Worker may have answered (a Cloudflare error or challenge page, a proxy), ' +
        'or MUSIC_WAREHOUSE_URL may not point at the Worker. Try again shortly; if it persists, check the URL.',
      response.status,
    );
  }
}

/**
 * The Worker's error body: always `{ error }`, plus `needs_reauth: true` on
 * the 503 for a lapsed Spotify grant and `retry_after_seconds` (null when
 * Spotify gave none) on a 429 or 502 from Spotify.
 */
interface ErrorBody {
  error?: string;
  needs_reauth?: boolean;
  retry_after_seconds?: number | null;
}

function explain(status: number, body: ErrorBody, retryAfterS: number, origin: string): string {
  const detail = (body.error ?? 'no detail').replace(/\.$/, '');
  if (status === 401) {
    return (
      `The warehouse rejected the token (401): it is wrong, revoked or expired. To sign in again with Spotify, ${loginHint(origin)}. ` +
      'A MUSIC_WAREHOUSE_TOKEN or Keychain token takes precedence over a signed-in one, so fix or remove it if set.'
    );
  }
  if (status === 403) return `Forbidden (403): ${detail}. A read token can only fetch Wrapped presets or ranges already computed; see list_wrapped_ranges.`;
  if (body.needs_reauth) {
    return "Spotify's grant has lapsed, so live data is unavailable. Stored history still works. The owner must re-run `npm run authorize` in the music-warehouse repo.";
  }
  if (status === 503) {
    const when = Number.isFinite(retryAfterS) && retryAfterS > 0 ? ` Try again in about ${retryAfterS} s.` : '';
    return `Still computing (503): ${detail}.${when}`;
  }
  if (status === 429 || status === 502) {
    // Spotify's answer, passed on: the Worker's own rows are unaffected.
    const seconds = body.retry_after_seconds ?? (Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS : null);
    const when = seconds === null ? 'Try again later.' : `Try again in about ${seconds} s.`;
    return status === 429
      ? `Spotify rate limit (429): ${detail}. ${when} Stored history still works.`
      : `Spotify failed upstream (502): ${detail}. ${when} Stored history still works.`;
  }
  return `Warehouse error ${status}: ${detail}`;
}
