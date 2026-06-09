import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkspace, selectRepos, viewPath } from '../src/registry';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cgws-reg-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(config: unknown): Promise<string> {
  const p = join(root, 'workspace.json');
  await writeFile(p, JSON.stringify(config));
  return p;
}

const valid = {
  viewsDir: '/ws/.codegraph-workspace/views',
  repos: [
    { name: 'linux', path: '/ws/linux', scope: ['kernel', 'include'] },
    { name: 'myapp', path: '/ws/myapp' },
  ],
};

describe('loadWorkspace', () => {
  it('loads a valid registry and defaults scope to ["."]', async () => {
    const w = loadWorkspace(await write(valid));
    expect(w.repos).toHaveLength(2);
    expect(w.repos[1]!.scope).toEqual(['.']);
    expect(viewPath(w, w.repos[0]!)).toBe('/ws/.codegraph-workspace/views/linux');
  });

  it('rejects duplicate repo names', async () => {
    const cfg = { ...valid, repos: [valid.repos[0], valid.repos[0]] };
    await expect(async () => loadWorkspace(await write(cfg))).rejects.toThrow(/Duplicate/i);
  });

  it('rejects relative repo paths', async () => {
    const cfg = { ...valid, repos: [{ name: 'x', path: 'relative/dir' }] };
    await expect(async () => loadWorkspace(await write(cfg))).rejects.toThrow(/absolute/i);
  });

  it('rejects unsafe repo names', async () => {
    const cfg = { ...valid, repos: [{ name: 'bad/name', path: '/abs' }] };
    await expect(async () => loadWorkspace(await write(cfg))).rejects.toThrow();
  });

  it('throws a helpful error when the file is missing', async () => {
    await expect(async () => loadWorkspace(join(root, 'nope.json'))).rejects.toThrow(/not found/i);
  });
});

describe('selectRepos', () => {
  it('returns all repos when no names given, and errors on unknown names', async () => {
    const w = loadWorkspace(await write(valid));
    expect(selectRepos(w).map((r) => r.name)).toEqual(['linux', 'myapp']);
    expect(selectRepos(w, ['myapp']).map((r) => r.name)).toEqual(['myapp']);
    expect(() => selectRepos(w, ['ghost'])).toThrow(/Unknown repo/i);
  });
});
