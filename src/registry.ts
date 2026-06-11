import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { WorkspaceSchema, type Repo, type Workspace } from './types.js';

const DEFAULT_CONFIG = 'workspace.json';

/** Resolve the registry path: explicit arg, then env, then ./workspace.json. */
export function resolveConfigPath(explicit?: string): string {
  const p = explicit ?? process.env.CODEGRAPH_WORKSPACE_CONFIG ?? DEFAULT_CONFIG;
  return resolve(p);
}

/** Validate parsed registry JSON (schema + name/path invariants). */
export function parseWorkspace(json: unknown, source: string): Workspace {
  const parsed = WorkspaceSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid workspace registry at ${source}:\n${parsed.error.toString()}`);
  }
  const ws = parsed.data;

  const names = new Set<string>();
  for (const repo of ws.repos) {
    if (names.has(repo.name)) throw new Error(`Duplicate repo name in registry: "${repo.name}"`);
    names.add(repo.name);
    if (!isAbsolute(repo.path)) {
      throw new Error(`Repo "${repo.name}" path must be absolute: ${repo.path}`);
    }
  }
  if (!isAbsolute(ws.viewsDir)) {
    throw new Error(`viewsDir must be an absolute path: ${ws.viewsDir}`);
  }
  return ws;
}

/** Load and validate the workspace registry from disk. */
export function loadWorkspace(configPath?: string): Workspace {
  const path = resolveConfigPath(configPath);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw new Error(
      `Workspace registry not found at ${path}. Create one (see workspace.example.json) ` +
        `or set CODEGRAPH_WORKSPACE_CONFIG.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Workspace registry at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseWorkspace(json, path);
}

/** Absolute path of a repo's view directory (the CodeGraph project root). */
export function viewPath(ws: Workspace, repo: Repo): string {
  return resolve(ws.viewsDir, repo.name);
}

/** Select repos by name; empty/undefined selects all. Throws on unknown names. */
export function selectRepos(ws: Workspace, names?: string[]): Repo[] {
  if (!names || names.length === 0) return ws.repos;
  const byName = new Map(ws.repos.map((r) => [r.name, r]));
  return names.map((n) => {
    const r = byName.get(n);
    if (!r) throw new Error(`Unknown repo "${n}". Known: ${[...byName.keys()].join(', ')}`);
    return r;
  });
}
