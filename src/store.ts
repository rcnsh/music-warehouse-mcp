import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The macOS Keychain service the read token is stored under; the account is the Worker's host. */
export const KEYCHAIN_SERVICE = 'music-warehouse-mcp';

/**
 * Whether tokens live in the Keychain here rather than in the token file: on
 * macOS, unless MUSIC_WAREHOUSE_KEYCHAIN is `off` (which the tests set, so
 * they never touch the real Keychain).
 */
export const useKeychain = (env: NodeJS.ProcessEnv = process.env): boolean =>
  process.platform === 'darwin' && env.MUSIC_WAREHOUSE_KEYCHAIN?.trim().toLowerCase() !== 'off';

/** The token from the Keychain, or null if there is none (or no Keychain). */
export async function keychainToken(host: string): Promise<string | null> {
  if (!useKeychain()) return null;
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', host, '-w']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Characters a minted token and a host are made of; anything else is refused rather than quoted. */
const KEYCHAIN_SAFE = /^[A-Za-z0-9._:~+=\/-]+$/;

/**
 * Store `token` in the Keychain for `host`, replacing any there (`-U`), and
 * read it back to confirm. The command goes to `security -i` on stdin rather
 * than argv, so the token never shows in a process listing. `security -i`
 * exits 0 even when a command fails, hence the read-back.
 */
export async function saveKeychainToken(host: string, token: string): Promise<void> {
  if (!KEYCHAIN_SAFE.test(host) || !KEYCHAIN_SAFE.test(token)) throw new Error('The token or host has characters the Keychain command cannot take.');
  await new Promise<void>((resolve, reject) => {
    // A locked Keychain can wait on a dialog nobody sees; give up rather than hang.
    const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'], timeout: 15_000 });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`security ${signal ? `was stopped (${signal})` : `exited ${code}`}: ${stderr.trim() || 'no detail'}`)),
    );
    child.stdin.end(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${host}" -w "${token}"\n`);
  });
  if ((await keychainToken(host)) !== token) throw new Error('The Keychain did not keep the token.');
}

/** A token minted by signing in, as saved for one warehouse. */
export interface SavedToken {
  token: string;
  /** The token's id on the warehouse, for revoking it there. */
  id: string;
  name: string;
  /** When the warehouse stops accepting it; null if it never expires. */
  expires_ms: number | null;
  saved_ms: number;
}

/** Saved tokens, keyed by warehouse origin, so a token is only ever sent to the warehouse that minted it. */
type TokenFile = Record<string, SavedToken>;

/** `$XDG_CONFIG_HOME/music-warehouse-mcp/tokens.json`, defaulting to `~/.config`. */
export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'music-warehouse-mcp', 'tokens.json');
}

async function readAll(path: string): Promise<TokenFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TokenFile) : {};
}

/** The token saved for `origin`, or null. Expiry is the caller's to judge. */
export async function readSavedToken(origin: string, path = tokenFilePath()): Promise<SavedToken | null> {
  const saved = (await readAll(path))[origin];
  return saved && typeof saved.token === 'string' && saved.token ? saved : null;
}

/**
 * Drop the token saved for `origin`, keeping any for other warehouses, and
 * remove the file once it holds none. A missing file is fine.
 */
export async function removeSavedToken(origin: string, path = tokenFilePath()): Promise<void> {
  const all = await readAll(path);
  if (!(origin in all)) return;
  delete all[origin];
  if (Object.keys(all).length === 0) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  await writeAll(all, path);
}

/**
 * Save the token for `origin`, keeping any for other warehouses. Owner-only
 * permissions (0700 directory, 0600 file), set again on every write in case
 * an existing file was looser. Written to a temporary file and renamed, so a
 * reader never sees half a file.
 */
export async function saveToken(origin: string, saved: SavedToken, path = tokenFilePath()): Promise<void> {
  const all = await readAll(path).catch(() => ({}) as TokenFile);
  all[origin] = saved;
  await writeAll(all, path);
}

async function writeAll(all: TokenFile, path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
