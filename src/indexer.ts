import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as cg from './codegraph.js';
import { viewPath } from './registry.js';
import type { Repo, Workspace } from './types.js';
import { buildView, type ViewResult } from './viewbuilder.js';

export interface IndexResult extends ViewResult {
  action: 'indexed' | 'synced';
}

function isInitialized(viewDir: string): boolean {
  return existsSync(join(viewDir, '.codegraph'));
}

/**
 * Build the repo's view, then full-index it with CodeGraph. Initializes the
 * CodeGraph project on first run.
 */
export async function indexRepo(ws: Workspace, repo: Repo, force = false): Promise<IndexResult> {
  const dir = viewPath(ws, repo);
  const view = await buildView(repo, dir);
  if (!isInitialized(dir)) await cg.init(dir);
  await cg.index(dir, force);
  return { ...view, action: 'indexed' };
}

/**
 * Rebuild the view (picks up scope changes / new files) and incrementally sync.
 * Falls back to a full index if the project isn't initialized yet.
 */
export async function syncRepo(ws: Workspace, repo: Repo): Promise<IndexResult> {
  const dir = viewPath(ws, repo);
  const view = await buildView(repo, dir);
  if (!isInitialized(dir)) {
    await cg.init(dir);
    await cg.index(dir);
    return { ...view, action: 'indexed' };
  }
  await cg.sync(dir);
  return { ...view, action: 'synced' };
}
