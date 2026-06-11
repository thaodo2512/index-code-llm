import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addRepo, removeRepo } from '../src/registryEdit';

let root: string;
let configPath: string;
let repoA: string;
let repoB: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cgws-edit-'));
  repoA = join(root, 'repo-a');
  repoB = join(root, 'repo-b');
  await mkdir(join(repoA, 'src'), { recursive: true });
  await mkdir(repoB, { recursive: true });
  configPath = join(root, 'workspace.json');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        root,
        viewsDir: join(root, 'views'),
        repos: [{ name: 'a', path: repoA, scope: ['src'] }],
      },
      null,
      2,
    ),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readConfig(): Promise<{ root?: string; repos: Array<{ name: string }> }> {
  return JSON.parse(await readFile(configPath, 'utf-8'));
}

describe('addRepo', () => {
  it('appends a validated repo and preserves unknown top-level fields', async () => {
    const r = addRepo(configPath, { name: 'b', path: repoB, scope: ['.'] });
    expect(r.workspace.repos.map((x) => x.name)).toEqual(['a', 'b']);
    const onDisk = await readConfig();
    expect(onDisk.repos.map((x) => x.name)).toEqual(['a', 'b']);
    expect(onDisk.root).toBe(root); // untouched field survives the rewrite
  });

  it('makes the repo path absolute and warns on missing scope subtrees', () => {
    const r = addRepo(configPath, { name: 'b', path: repoB, scope: ['no-such-dir'] });
    expect(r.workspace.repos[1]!.path).toBe(repoB);
    expect(r.warnings.some((w) => w.includes('no-such-dir'))).toBe(true);
  });

  it('rejects duplicate names without touching the file', async () => {
    expect(() => addRepo(configPath, { name: 'a', path: repoB, scope: ['.'] })).toThrow(/Duplicate/i);
    expect((await readConfig()).repos).toHaveLength(1);
  });

  it('rejects a path that is not a directory', async () => {
    const file = join(root, 'file.txt');
    await writeFile(file, 'x');
    expect(() => addRepo(configPath, { name: 'b', path: file, scope: ['.'] })).toThrow(/not a directory/i);
    expect(() => addRepo(configPath, { name: 'b', path: join(root, 'ghost'), scope: ['.'] })).toThrow(
      /does not exist/i,
    );
  });

  it('rejects unsafe names and scope entries', () => {
    expect(() => addRepo(configPath, { name: 'bad/name', path: repoB, scope: ['.'] })).toThrow();
    expect(() => addRepo(configPath, { name: 'b', path: repoB, scope: ['../escape'] })).toThrow(/Unsafe/i);
  });

  it('rejects a repo path that overlaps viewsDir', async () => {
    const inside = join(root, 'views', 'evil');
    await mkdir(inside, { recursive: true });
    expect(() => addRepo(configPath, { name: 'evil', path: inside, scope: ['.'] })).toThrow(/overlaps/i);
  });
});

describe('removeRepo', () => {
  it('removes a repo and reports its view dir', async () => {
    addRepo(configPath, { name: 'b', path: repoB, scope: ['.'] });
    const r = removeRepo(configPath, 'b');
    expect(r.removed.name).toBe('b');
    expect(r.viewDir).toBe(join(root, 'views', 'b'));
    expect((await readConfig()).repos.map((x) => x.name)).toEqual(['a']);
  });

  it('errors on unknown names and refuses to remove the last repo', async () => {
    expect(() => removeRepo(configPath, 'ghost')).toThrow(/Unknown repo/i);
    expect(() => removeRepo(configPath, 'a')).toThrow(/last repo/i);
    expect((await readConfig()).repos).toHaveLength(1);
  });
});
