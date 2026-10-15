import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
 * Save the token for `origin`, keeping any for other warehouses. Owner-only
 * permissions (0700 directory, 0600 file), set again on every write in case
 * an existing file was looser. Written to a temporary file and renamed, so a
 * reader never sees half a file.
 */
export async function saveToken(origin: string, saved: SavedToken, path = tokenFilePath()): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const all = await readAll(path).catch(() => ({}) as TokenFile);
  all[origin] = saved;
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
