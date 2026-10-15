import { parseArgs } from 'node:util';
import { ConfigError, KEYCHAIN_SERVICE, keychainToken, parseWarehouseUrl } from './config.js';
import { LoginError, login } from './login.js';
import { tokenFilePath } from './store.js';

const USAGE = `Usage:
  music-warehouse-mcp                      Run the MCP server over stdio (what an MCP client spawns).
  music-warehouse-mcp login [--url URL] [--name NAME]
                                           Sign in with Spotify and save a read token for the server.

login options:
  --url URL    The warehouse origin. Defaults to MUSIC_WAREHOUSE_URL.
  --name NAME  How the token is listed on the warehouse. Defaults to "MCP (<hostname>)".`;

/** Run a terminal command. Returns the exit code. */
export async function runCli(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command !== 'login') {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  try {
    const { values } = parseArgs({ args, options: { url: { type: 'string' }, name: { type: 'string' } } });
    if (!values.url && !env.MUSIC_WAREHOUSE_URL?.trim()) {
      throw new ConfigError('Which warehouse? Pass --url https://music-api.example.com, or set MUSIC_WAREHOUSE_URL.');
    }
    const url = parseWarehouseUrl(values.url ?? env.MUSIC_WAREHOUSE_URL, values.url ? '--url' : 'MUSIC_WAREHOUSE_URL');
    const name = values.name?.trim();
    if (name !== undefined && (!name || name.length > 64)) throw new ConfigError('--name must be 1 to 64 characters.');

    const tokenFile = tokenFilePath(env);
    const saved = await login({ url, name, tokenFile });
    const until = saved.expires_ms === null ? 'does not expire' : `valid until ${new Date(saved.expires_ms).toISOString().slice(0, 10)}`;
    console.log(`Signed in. Saved a read token for ${url} (${saved.name}, ${until}) to ${tokenFile}.`);

    // The explicit sources win, so say if one would hide the new token.
    if (env.MUSIC_WAREHOUSE_TOKEN?.trim()) {
      console.log('Note: MUSIC_WAREHOUSE_TOKEN is set here, and takes precedence over the signed-in token wherever it is set.');
    }
    if (await keychainToken(new URL(url).host)) {
      console.log(
        `Note: a Keychain token for ${new URL(url).host} takes precedence over the signed-in token. ` +
          `Remove it to use this one: security delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${new URL(url).host}`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof LoginError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`music-warehouse-mcp: ${(error as Error).message}`);
      return 1;
    }
    throw error;
  }
}
