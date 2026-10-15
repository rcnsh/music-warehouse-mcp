import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source files newer than the build that runs them. MCP clients run
 * `dist/index.js` directly, so a `git pull` without `npm run build` leaves the
 * old tools running with nothing to show for it. Comparing modification times
 * of a dozen files at startup is cheap; a checkout or edit touches the source,
 * and `tsc` rewrites every output file.
 *
 * Empty when there is no `src/` beside `dist/` (an installed package ships
 * only `dist/`) or nothing is stale.
 */
export function staleSources(distDir: string, srcDir: string): string[] {
  if (!existsSync(srcDir)) return [];
  const stale: string[] = [];
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
    const built = join(distDir, name.replace(/\.ts$/, '.js'));
    if (!existsSync(built) || statSync(join(srcDir, name)).mtimeMs > statSync(built).mtimeMs) stale.push(name);
  }
  return stale.sort();
}

/** What to tell the user about a stale build. */
export function staleBuildNotice(stale: string[]): string {
  const shown = stale.slice(0, 5).join(', ') + (stale.length > 5 ? `, and ${stale.length - 5} more` : '');
  return (
    `This server's build (dist/) is older than its source (${shown}), so it may be running outdated tools. ` +
    'Run `npm run build` in the music-warehouse-mcp directory, then restart the MCP client.'
  );
}
