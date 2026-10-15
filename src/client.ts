import type { Config } from './config.js';

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
      if (response.ok) return (await response.json()) as T;

      const body = (await response.json().catch(() => ({}))) as { error?: string; needs_reauth?: boolean };
      const retryAfterS = Number(response.headers.get('Retry-After'));
      if (response.status === 503 && !body.needs_reauth && Number.isFinite(retryAfterS) && retryAfterS > 0) {
        const waitMs = Math.min(retryAfterS, 10) * 1000;
        if (waitedMs + waitMs <= this.maxWaitMs) {
          waitedMs += waitMs;
          await this.sleep(waitMs);
          continue;
        }
      }
      throw new WarehouseError(explain(response.status, body, retryAfterS), response.status);
    }
  }
}

function explain(status: number, body: { error?: string; needs_reauth?: boolean }, retryAfterS: number): string {
  const detail = body.error ?? 'no detail';
  if (status === 401) return 'The warehouse rejected the token (401). Check the stored read token.';
  if (status === 403) return `Forbidden (403): ${detail}. A read token can only fetch Wrapped presets or ranges already computed; see list_wrapped_ranges.`;
  if (body.needs_reauth) {
    return "Spotify's grant has lapsed, so live data is unavailable. Stored history still works. The owner must re-run `npm run authorize` in the music-warehouse repo.";
  }
  if (status === 503) {
    const when = Number.isFinite(retryAfterS) && retryAfterS > 0 ? ` Try again in about ${retryAfterS} s.` : '';
    return `Still computing (503): ${detail}.${when}`;
  }
  if (status === 429) return `Spotify rate limit (429): ${detail}. Try again later.`;
  return `Warehouse error ${status}: ${detail}`;
}
