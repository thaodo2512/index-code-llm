import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseWorkspace, resolveConfigPath, viewPath } from './registry.js';
import type { Repo, Workspace } from './types.js';
import { validateScopeEntry } from './viewbuilder.js';

export interface EditResult {
  configPath: string;
  workspace: Workspace;
  warnings: string[];
}

export interface RemoveResult extends EditResult {
  removed: Repo;
  /** The removed repo's view directory (index data) — caller decides whether to delete it. */
  viewDir: string;
}

/** Read the registry as raw JSON, preserving fields the schema doesn't know about. */
function readRegistryRaw(configPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(
      `Workspace registry not found at ${configPath}. Create one (see workspace.example.json) ` +
        `or set CODEGRAPH_WORKSPACE_CONFIG.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Workspace registry at ${configPath} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`Workspace registry at ${configPath} must be a JSON object.`);
  }
  return json as Record<string, unknown>;
}

/** Write the registry atomically (temp file + rename) so a crash can't truncate it. */
function writeRegistry(configPath: string, json: Record<string, unknown>): void {
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
  renameSync(tmp, configPath);
}

/**
 * Add a repo to the registry. Validates the same invariants as loading does
 * (slug name, no duplicates, absolute existing path, safe scope entries) BEFORE
 * writing, so a bad call can never corrupt the file. Returns warnings for scope
 * entries that don't exist yet (the viewbuilder will skip them too).
 */
export function addRepo(
  configOpt: string | undefined,
  repo: { name: string; path: string; scope: string[] },
): EditResult {
  const configPath = resolveConfigPath(configOpt);
  const raw = readRegistryRaw(configPath);

  const repoPath = resolve(repo.path);
  const scope = [...new Set(repo.scope)];
  for (const entry of scope) validateScopeEntry(entry);

  let st;
  try {
    st = statSync(repoPath);
  } catch {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }
  if (!st.isDirectory()) throw new Error(`Repo path is not a directory: ${repoPath}`);

  const entry = { name: repo.name, path: repoPath, scope };
  const repos = Array.isArray(raw.repos) ? raw.repos : [];
  const candidate = { ...raw, repos: [...repos, entry] };
  // Full-registry validation (schema, duplicate names, absolute paths) before write.
  const workspace = parseWorkspace(candidate, configPath);

  const view = viewPath(workspace, entry as Repo);
  if (repoPath === view || view.startsWith(repoPath + '/') || repoPath.startsWith(view + '/')) {
    throw new Error(
      `Repo path ${repoPath} overlaps the views directory ${view}. ` +
        `Keep viewsDir outside every repository.`,
    );
  }

  const warnings: string[] = [];
  for (const s of scope) {
    if (s !== '.' && !existsSync(join(repoPath, s))) {
      warnings.push(`scope path not found in repo (will be skipped until it exists): ${s}`);
    }
  }

  writeRegistry(configPath, candidate);
  return { configPath, workspace, warnings };
}

/**
 * Remove a repo from the registry. Refuses to remove the last repo (the registry
 * must stay loadable). Does NOT touch the filesystem — the caller decides what to
 * do with the returned `viewDir` (the repo's index data).
 */
export function removeRepo(configOpt: string | undefined, name: string): RemoveResult {
  const configPath = resolveConfigPath(configOpt);
  const raw = readRegistryRaw(configPath);
  // Validate the current file first so we resolve viewsDir/names reliably.
  const current = parseWorkspace(raw, configPath);

  const target = current.repos.find((r) => r.name === name);
  if (!target) {
    throw new Error(`Unknown repo "${name}". Known: ${current.repos.map((r) => r.name).join(', ')}`);
  }
  if (current.repos.length === 1) {
    throw new Error(`Refusing to remove "${name}": it is the last repo in the registry.`);
  }

  const repos = (raw.repos as Array<Record<string, unknown>>).filter((r) => r.name !== name);
  const candidate = { ...raw, repos };
  const workspace = parseWorkspace(candidate, configPath);

  writeRegistry(configPath, candidate);
  return {
    configPath,
    workspace,
    warnings: [],
    removed: target,
    viewDir: viewPath(current, target),
  };
}
