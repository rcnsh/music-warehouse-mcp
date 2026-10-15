import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { staleBuildNotice, staleSources } from '../src/freshness.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mwmcp-fresh-'));
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'dist'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function file(path: string, seconds: number) {
  await writeFile(join(dir, path), '');
  await utimes(join(dir, path), seconds, seconds);
}

describe('staleSources', () => {
  it('lists source files newer than their build, or with none', async () => {
    await file('src/a.ts', 100);
    await file('dist/a.js', 200);
    await file('src/b.ts', 300);
    await file('dist/b.js', 200);
    await file('src/c.ts', 100);
    await file('src/types.d.ts', 999);
    expect(staleSources(join(dir, 'dist'), join(dir, 'src'))).toEqual(['b.ts', 'c.ts']);
  });

  it('says nothing for an installed package, which has no src/', () => {
    expect(staleSources(join(dir, 'dist'), join(dir, 'nowhere'))).toEqual([]);
  });

  it('names the files and the fix', () => {
    const notice = staleBuildNotice(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']);
    expect(notice).toMatch(/a\.ts, b\.ts, c\.ts, d\.ts, e\.ts, and 2 more/);
    expect(notice).toMatch(/npm run build/);
  });
});
