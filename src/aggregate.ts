import * as cg from './codegraph.js';
import { readDbStats } from './dbstats.js';
import { viewPath } from './registry.js';
import type { Repo, RepoStats, SearchHit, Workspace } from './types.js';

/**
 * Cross-repo fuzzy search: fan out `codegraph query --json -p <view>` to each
 * repo concurrently, tag hits with their repo, merge, and rank by score.
 */
export async function searchAll(
  ws: Workspace,
  repos: Repo[],
  query: string,
  opts: { limit?: number; kind?: string } = {},
): Promise<SearchHit[]> {
  const perRepoLimit = opts.limit ?? 10;
  const results = await Promise.allSettled(
    repos.map((repo) => cg.query(viewPath(ws, repo), query, { limit: perRepoLimit, kind: opts.kind })),
  );

  const hits: SearchHit[] = [];
  results.forEach((res, i) => {
    const repo = repos[i]!;
    if (res.status !== 'fulfilled') return; // not-indexed / no match → skip this repo
    for (const r of res.value) {
      hits.push({
        repo: repo.name,
        name: r.node.name,
        kind: r.node.kind,
        file: r.node.filePath,
        line: r.node.startLine ?? null,
        language: r.node.language ?? null,
        score: r.score,
      });
    }
  });

  hits.sort((a, b) => b.score - a.score);
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

/**
 * Per-repo index stats. Default path is cheap: counts read straight from each
 * view's SQLite DB. `includeFreshness` additionally runs `codegraph status`
 * (which does a full change scan — expensive on non-git views).
 */
export async function repoStats(
  ws: Workspace,
  repos: Repo[],
  includeFreshness = false,
): Promise<RepoStats[]> {
  return Promise.all(
    repos.map(async (repo): Promise<RepoStats> => {
      const dir = viewPath(ws, repo);
      const base: RepoStats = {
        repo: repo.name,
        indexed: false,
        fileCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        dbSizeBytes: 0,
        languages: [],
      };
      try {
        const stats = readDbStats(dir);
        if (!stats) return base;
        const out: RepoStats = { ...base, indexed: true, ...stats };
        if (includeFreshness) {
          const st = await cg.status(dir);
          out.pendingChanges = st.pendingChanges ?? { added: 0, modified: 0, removed: 0 };
        }
        return out;
      } catch (e) {
        return { ...base, error: (e as Error).message };
      }
    }),
  );
}
