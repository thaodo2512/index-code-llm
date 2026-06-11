import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import type { Repo } from './types.js';

const MANIFEST = '.cgws-manifest.json';
/** Never symlinked/pruned: git internals and CodeGraph's own data dir. */
const SKIP_TOPLEVEL = new Set(['.git', '.codegraph', MANIFEST, '.gitignore']);

interface Manifest {
  version: 1;
  symlinks: string[];
  dirs: string[];
  gitignore: boolean;
}

export interface ViewResult {
  repo: string;
  viewDir: string;
  symlinks: number;
  warnings: string[];
}

/** Reject scope entries that could escape the repo (absolute paths, `..`). */
export function validateScopeEntry(entry: string): void {
  if (entry === '.') return;
  const norm = posix.normalize(entry);
  if (norm.startsWith('/') || norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
    throw new Error(`Unsafe scope entry "${entry}" — must be a repo-relative path without "..".`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(viewDir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(viewDir, MANIFEST), 'utf-8');
    const m = JSON.parse(raw) as Manifest;
    if (m.version === 1 && Array.isArray(m.symlinks) && Array.isArray(m.dirs)) return m;
  } catch {
    /* absent or unreadable — treat as no prior state */
  }
  return null;
}

/** Remove a previously-managed symlink, only if it is in fact a symlink. */
async function removeManagedLink(viewDir: string, rel: string): Promise<void> {
  const abs = join(viewDir, rel);
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) await unlink(abs);
  } catch {
    /* already gone */
  }
}

/**
 * Build (or rebuild) a repo's view directory: a NON-git dir of symlinks to only
 * the scoped subtrees. The view root is always a real directory — never a symlink
 * to the repo — so CodeGraph writes `.codegraph/` inside the view, never into the
 * real repo. Prunes managed entries that are no longer in scope.
 */
export async function buildView(repo: Repo, viewDir: string): Promise<ViewResult> {
  const warnings: string[] = [];
  for (const entry of repo.scope) validateScopeEntry(entry);

  // 1. View root must be a real directory, never a symlink (would redirect
  //    `.codegraph/` into the real repo).
  if (await pathExists(viewDir)) {
    const st = await lstat(viewDir);
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to use view root ${viewDir}: it is a symlink. The view root must be a real ` +
          `directory so CodeGraph never writes .codegraph/ into the real repo.`,
      );
    }
    if (!st.isDirectory()) throw new Error(`View root ${viewDir} exists but is not a directory.`);
  } else {
    await mkdir(viewDir, { recursive: true });
  }

  // 2. Prune everything we managed last time (remove-then-recreate). Never touch
  //    `.codegraph/` or the manifest.
  const prev = await readManifest(viewDir);
  if (prev) {
    for (const rel of prev.symlinks) await removeManagedLink(viewDir, rel);
    if (prev.gitignore) await removeManagedLink(viewDir, '.gitignore');
    const deepestFirst = [...prev.dirs].sort((a, b) => b.split('/').length - a.split('/').length);
    for (const rel of deepestFirst) {
      try {
        await rmdir(join(viewDir, rel));
      } catch {
        /* non-empty or shared — leave it */
      }
    }
  }

  // 3. Resolve the symlink set. `scope: ["."]` fans out top-level entries.
  let symlinkRels: string[];
  if (repo.scope.includes('.')) {
    const entries = await readdir(repo.path, { withFileTypes: true });
    symlinkRels = entries.map((e) => e.name).filter((n) => !SKIP_TOPLEVEL.has(n));
  } else {
    symlinkRels = repo.scope.map((s) => posix.normalize(s));
  }

  // 4. Intermediate dirs (parents of nested entries) must be real dirs.
  const dirSet = new Set<string>();
  for (const rel of symlinkRels) {
    let parent = posix.dirname(rel);
    while (parent && parent !== '.') {
      dirSet.add(parent);
      parent = posix.dirname(parent);
    }
  }
  const dirs = [...dirSet].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const d of dirs) await mkdir(join(viewDir, d), { recursive: true });

  // 5. Create the scope symlinks (absolute targets), skipping missing sources.
  const created: string[] = [];
  for (const rel of symlinkRels) {
    const target = resolve(repo.path, rel.split('/').join(sep));
    if (!(await pathExists(target))) {
      warnings.push(`scope path not found, skipped: ${rel}`);
      continue;
    }
    const linkPath = join(viewDir, rel.split('/').join(sep));
    await symlink(target, linkPath);
    created.push(rel);
  }

  // 6. Root .gitignore symlink so repo-root ignore rules apply inside the view.
  let gitignore = false;
  const repoGitignore = join(repo.path, '.gitignore');
  if (await pathExists(repoGitignore)) {
    await symlink(repoGitignore, join(viewDir, '.gitignore'));
    gitignore = true;
  }

  // 7. Persist the manifest for next time's prune.
  const manifest: Manifest = { version: 1, symlinks: created, dirs, gitignore };
  await writeFile(join(viewDir, MANIFEST), JSON.stringify(manifest, null, 2));

  return { repo: repo.name, viewDir, symlinks: created.length, warnings };
}

/** For tests/inspection: read back the managed symlink targets in a view. */
export async function readViewLinks(viewDir: string): Promise<Record<string, string>> {
  const m = await readManifest(viewDir);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const rel of m.symlinks) {
    try {
      out[rel] = await readlink(join(viewDir, rel));
    } catch {
      /* skip */
    }
  }
  return out;
}
