import { z } from 'zod';

/**
 * A single repository in the workspace. `scope` is a list of repo-relative
 * subtree paths to index; `["."]` means the whole repo (fanned out as top-level
 * symlinks — never as a symlink of the repo root itself).
 */
export const RepoSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, 'repo name must be a safe slug (A-Z a-z 0-9 . _ -)'),
  path: z.string().min(1),
  scope: z.array(z.string().min(1)).default(['.']),
});

export const WorkspaceSchema = z.object({
  /** Informational root the repos live under (not required to be their parent). */
  root: z.string().optional(),
  /** Where view directories are materialized. Must be outside every real repo. */
  viewsDir: z.string().min(1),
  repos: z.array(RepoSchema).min(1),
});

export type Repo = z.infer<typeof RepoSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** One cross-repo search hit, normalized from `codegraph query --json`. */
export interface SearchHit {
  repo: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  language: string | null;
  score: number;
}

/** Per-repo index statistics (cheap path reads these directly from SQLite). */
export interface RepoStats {
  repo: string;
  indexed: boolean;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  languages: string[];
  /** Present only when freshness was requested (expensive on non-git views). */
  pendingChanges?: { added: number; modified: number; removed: number };
  error?: string;
}
