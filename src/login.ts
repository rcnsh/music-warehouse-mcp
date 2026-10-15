import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { type SavedToken, saveToken, tokenFilePath } from './store.js';

/**
 * Sign in with Spotify to get a read token, the way a CLI does OAuth with
 * PKCE (RFC 7636) and a loopback redirect (RFC 8252): the warehouse sends the
 * browser back to a one-shot listener on 127.0.0.1 with a code, and the code
 * plus the verifier only this process holds buys a token at /auth/token.
 *
 * This runs as its own command, never inside the MCP server: the server's
 * stdout is the protocol, and a client that spawned it can't show a browser.
 */

export class LoginError extends Error {}

/** A token as minted by the warehouse's POST /auth/token. */
export interface MintedToken {
  id: string;
  token: string;
  name: string;
  access: string;
  expires_ms: number | null;
}

export function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** A fresh verifier (43 characters of base64url) and its S256 challenge. */
export function createPkce(random: (size: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = base64url(random(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** The device name the warehouse lists the token under: 1 to 64 characters. */
export function deviceName(host: string = hostname()): string {
  const name = `MCP (${host.trim() || 'unknown host'})`;
  return name.length <= 64 ? name : `${name.slice(0, 62)}…)`;
}

export function loginUrl(origin: string, params: { name: string; returnTo: string; challenge: string }): string {
  const url = new URL('/auth/login', origin);
  url.searchParams.set('name', params.name);
  url.searchParams.set('return_to', params.returnTo);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

const ERRORS: Record<string, string> = {
  access_denied: 'Sign-in was cancelled or not approved on Spotify.',
  not_owner: 'That Spotify account does not own this warehouse. Sign in with the account that authorized it.',
  unavailable: 'The warehouse could not confirm your Spotify account, or has not been authorized with Spotify yet. Try again later.',
};

/** What the browser brought back to the listener: a code, or why there isn't one. */
export function parseCallback(url: URL): { code: string } | { error: string; message: string } | null {
  const code = url.searchParams.get('code');
  if (code) return { code };
  const error = url.searchParams.get('error');
  if (error) return { error, message: ERRORS[error] ?? `Sign-in failed: ${error}.` };
  return null;
}

function page(response: ServerResponse, status: number, title: string, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}</style>` +
      `<h1>${title}</h1><p>${body}</p>`,
  );
}

export interface Callback {
  /** `http://127.0.0.1:<port>/callback`. */
  returnTo: string;
  /** Settles on the first request to /callback carrying a code or an error, or on timeout. */
  result: Promise<{ code: string }>;
  close: () => void;
}

/** Listen on an OS-assigned loopback port for the one redirect back from the warehouse. */
export async function listenForCallback(timeoutMs: number): Promise<Callback> {
  let settle!: (outcome: { code: string } | Error) => void;
  const result = new Promise<{ code: string }>((resolve, reject) => {
    settle = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const outcome = request.method === 'GET' && url.pathname === '/callback' ? parseCallback(url) : null;
    if (!outcome) {
      page(response, 404, 'Not found', 'This is the music-warehouse-mcp sign-in listener.');
      return;
    }
    if ('code' in outcome) {
      page(response, 200, 'Signed in', 'You can close this tab and return to the terminal.');
      settle(outcome);
    } else {
      page(response, 400, 'Sign-in failed', outcome.message);
      settle(new LoginError(outcome.message));
    }
    close();
  });

  const timer = setTimeout(
    () => settle(new LoginError(`No answer from the browser within ${Math.round(timeoutMs / 60_000)} minutes. Run login again.`)),
    timeoutMs,
  );
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
  };
  result.catch(close);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { returnTo: `http://127.0.0.1:${port}/callback`, result, close };
}

/** POST /auth/token: trade the one-time code and the verifier for a read token. */
export async function exchangeCode(
  origin: string,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MintedToken> {
  let response: Response;
  try {
    response = await fetchImpl(new URL('/auth/token', origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new LoginError(`Could not reach the warehouse at ${origin}: ${(error as Error).message}`);
  }
  const body = (await response.json().catch(() => ({}))) as Partial<MintedToken> & { error?: string };
  if (!response.ok) {
    if (body.error === 'invalid_grant') {
      throw new LoginError('The warehouse refused the sign-in code (invalid_grant): it expired or was already used. Run login again.');
    }
    throw new LoginError(`The warehouse answered ${response.status} to the token exchange: ${body.error ?? 'no detail'}`);
  }
  if (typeof body.token !== 'string' || !body.token) throw new LoginError('The warehouse returned no token.');
  return {
    id: String(body.id ?? ''),
    token: body.token,
    name: String(body.name ?? ''),
    access: String(body.access ?? 'read'),
    expires_ms: typeof body.expires_ms === 'number' ? body.expires_ms : null,
  };
}

/** Open `url` in the default browser. Failure is ignored: the URL is printed too. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Printed below; the user can open it by hand.
  }
}

export interface LoginOptions {
  /** The warehouse origin, already validated. */
  url: string;
  name?: string;
  fetch?: typeof fetch;
  open?: (url: string) => void | Promise<void>;
  log?: (line: string) => void;
  timeoutMs?: number;
  tokenFile?: string;
  now?: () => number;
}

/** Run the whole sign-in and save the token. Returns what was saved. */
export async function login(options: LoginOptions): Promise<SavedToken> {
  const log = options.log ?? ((line: string) => console.log(line));
  const tokenFile = options.tokenFile ?? tokenFilePath();
  const { verifier, challenge } = createPkce();
  const callback = await listenForCallback(options.timeoutMs ?? 5 * 60_000);
  try {
    const url = loginUrl(options.url, { name: options.name ?? deviceName(), returnTo: callback.returnTo, challenge });
    log(`Opening your browser to sign in with Spotify. If it doesn't open, visit:\n\n  ${url}\n`);
    await (options.open ?? openBrowser)(url);

    const { code } = await callback.result;
    const minted = await exchangeCode(options.url, code, verifier, options.fetch);
    const saved: SavedToken = {
      token: minted.token,
      id: minted.id,
      name: minted.name,
      expires_ms: minted.expires_ms,
      saved_ms: (options.now ?? Date.now)(),
    };
    await saveToken(options.url, saved, tokenFile);
    return saved;
  } finally {
    callback.close();
  }
}
