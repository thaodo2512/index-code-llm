import { mkdtemp, mkdir, writeFile, symlink, lstat, readlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildView, readViewLinks } from '../src/viewbuilder';
import type { Repo } from '../src/types';

let root: string;
let repoPath: string;
let viewDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cgws-vb-'));
  repoPath = join(root, 'repo');
  viewDir = join(root, 'views', 'repo');
  // A fake repo with several subtrees, a .git, a top-level file, and a root .gitignore.
  for (const d of ['include', 'kernel', 'arch/arm64', 'arch/x86', 'drivers/foo', '.git']) {
    await mkdir(join(repoPath, d), { recursive: true });
  }
  await writeFile(join(repoPath, 'include', 'h.h'), '#define X 1\n');
  await writeFile(join(repoPath, 'arch', 'arm64', 'a.c'), 'int a(){return 0;}\n');
  await writeFile(join(repoPath, 'README.md'), '# repo\n');
  await writeFile(join(repoPath, '.gitignore'), '*.o\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function repo(scope: string[]): Repo {
  return { name: 'repo', path: repoPath, scope };
}

describe('buildView scoping', () => {
  it('symlinks only allowlisted subtrees, makes real intermediate dirs, and links root .gitignore', async () => {
    const r = await buildView(repo(['include', 'arch/arm64', 'drivers/foo']), viewDir);
    expect(r.symlinks).toBe(3);

    // Leaf symlinks point at the live subtrees.
    const links = await readViewLinks(viewDir);
    expect(links['include']).toBe(join(repoPath, 'include'));
    expect(links['arch/arm64']).toBe(join(repoPath, 'arch', 'arm64'));

    // `arch` is a REAL intermediate dir, not a symlink.
    expect((await lstat(join(viewDir, 'arch'))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(viewDir, 'arch'))).isDirectory()).toBe(true);

    // Out-of-scope subtree is absent.
    expect(existsSync(join(viewDir, 'arch', 'x86'))).toBe(false);
    expect(existsSync(join(viewDir, 'kernel'))).toBe(false);

    // Root .gitignore is symlinked into the view.
    expect((await lstat(join(viewDir, '.gitignore'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(viewDir, '.gitignore'))).toBe(join(repoPath, '.gitignore'));
  });

  it('scope ["."] fans out top-level entries, excluding .git', async () => {
    const r = await buildView(repo(['.']), viewDir);
    const links = await readViewLinks(viewDir);
    expect(Object.keys(links).sort()).toEqual(['README.md', 'arch', 'drivers', 'include', 'kernel']);
    expect(existsSync(join(viewDir, '.git'))).toBe(false);
    expect(r.symlinks).toBe(5);
  });

  it('warns and skips a missing scope path', async () => {
    const r = await buildView(repo(['include', 'does/not/exist']), viewDir);
    expect(r.symlinks).toBe(1);
    expect(r.warnings.join(' ')).toContain('does/not/exist');
  });
});

describe('buildView pruning', () => {
  it('removes de-scoped symlinks and empty intermediate dirs but preserves .codegraph/', async () => {
    await buildView(repo(['include', 'arch/arm64', 'drivers/foo']), viewDir);
    // Simulate an existing index that must survive rebuilds.
    await mkdir(join(viewDir, '.codegraph'), { recursive: true });
    await writeFile(join(viewDir, '.codegraph', 'codegraph.db'), 'DBDATA');

    await buildView(repo(['include']), viewDir);

    expect(existsSync(join(viewDir, 'include'))).toBe(true);
    expect(existsSync(join(viewDir, 'arch'))).toBe(false); // intermediate dir pruned
    expect(existsSync(join(viewDir, 'drivers'))).toBe(false);
    // The index is untouched.
    expect(existsSync(join(viewDir, '.codegraph', 'codegraph.db'))).toBe(true);
  });
});

describe('buildView safety', () => {
  it('refuses a symlinked view root (would redirect .codegraph into the real repo)', async () => {
    await mkdir(join(root, 'views'), { recursive: true });
    await symlink(repoPath, viewDir); // view root IS a symlink to the repo
    await expect(buildView(repo(['include']), viewDir)).rejects.toThrow(/symlink/i);
  });

  it('rejects scope entries that escape the repo', async () => {
    await expect(buildView(repo(['../evil']), viewDir)).rejects.toThrow(/Unsafe/i);
  });
});
