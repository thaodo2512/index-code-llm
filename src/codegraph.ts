import { execa, type ExecaError } from 'execa';

/**
 * Thin wrapper over the external `codegraph` CLI. The single source of truth for
 * its argument quirks:
 *   - init / index / sync / status / files take a POSITIONAL path (no -p)
 *   - query / context / callers / callees / impact take -p <path>
 *   - serve takes --mcp (we add --no-watch)
 */
export const codegraphBin = process.env.CODEGRAPH_BIN ?? 'codegraph';

const BIG_BUFFER = 64 * 1024 * 1024;

async function run(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  try {
    const { stdout } = await execa(codegraphBin, args, {
      cwd: opts.cwd,
      maxBuffer: BIG_BUFFER,
      stripFinalNewline: true,
    });
    return stdout;
  } catch (e) {
    const err = e as ExecaError;
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new Error(
        `Could not run "${codegraphBin}". Install CodeGraph (https://github.com/colbymchenry/codegraph) ` +
          `or set CODEGRAPH_BIN to its path.`,
      );
    }
    const detail = err.stderr || err.stdout || err.shortMessage || String(e);
    throw new Error(`codegraph ${args.join(' ')} failed: ${detail}`);
  }
}

/** `codegraph init <path>` — idempotent; creates the .codegraph/ dir. */
export async function init(projectPath: string): Promise<void> {
  await run(['init', projectPath]);
}

/** `codegraph index <path>` — full (re)index. */
export async function index(projectPath: string, force = false): Promise<void> {
  await run(['index', projectPath, ...(force ? ['--force'] : []), '--quiet']);
}

/** `codegraph sync <path>` — incremental refresh. */
export async function sync(projectPath: string): Promise<void> {
  await run(['sync', projectPath, '--quiet']);
}

export interface CodegraphStatus {
  initialized: boolean;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  dbSizeBytes?: number;
  languages?: string[];
  pendingChanges?: { added: number; modified: number; removed: number };
}

/** `codegraph status --json <path>` (positional). Runs a change scan — not cheap on non-git views. */
export async function status(projectPath: string): Promise<CodegraphStatus> {
  const out = await run(['status', '--json', projectPath]);
  return JSON.parse(out) as CodegraphStatus;
}

export interface QueryNode {
  node: {
    name: string;
    kind: string;
    filePath: string;
    startLine?: number | null;
    language?: string | null;
  };
  score: number;
}

/** `codegraph query --json -p <path> <q>` (uses -p). */
export async function query(
  projectPath: string,
  search: string,
  opts: { limit?: number; kind?: string } = {},
): Promise<QueryNode[]> {
  const args = ['query', '--json', '-p', projectPath];
  if (opts.limit != null) args.push('--limit', String(opts.limit));
  if (opts.kind) args.push('--kind', opts.kind);
  args.push(search);
  const out = await run(args);
  return JSON.parse(out) as QueryNode[];
}

/** Argv for the long-lived MCP child the gateway proxies. */
export function serveArgs(): string[] {
  return ['serve', '--mcp', '--no-watch'];
}
