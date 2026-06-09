#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command } from 'commander';
import { repoStats } from './aggregate.js';
import { GatewayBackend, createServer } from './gateway.js';
import { serveHttp } from './httpServer.js';
import { indexRepo, syncRepo } from './indexer.js';
import { buildView } from './viewbuilder.js';
import { loadWorkspace, selectRepos, viewPath } from './registry.js';

const program = new Command();

program
  .name('codegraph-workspace')
  .description('Multi-repo workspace gateway over CodeGraph')
  .option('-c, --config <path>', 'Workspace registry (default: ./workspace.json or $CODEGRAPH_WORKSPACE_CONFIG)');

function ws(): ReturnType<typeof loadWorkspace> {
  return loadWorkspace(program.opts().config);
}

program
  .command('build-views')
  .description('Materialize views/<repo>/ symlink trees from the registry (no indexing)')
  .option('-r, --repo <names...>', 'Limit to these repos')
  .action(async (o: { repo?: string[] }) => {
    const w = ws();
    for (const repo of selectRepos(w, o.repo)) {
      const r = await buildView(repo, viewPath(w, repo));
      console.log(`✓ ${r.repo}: ${r.symlinks} symlink(s) → ${r.viewDir}`);
      r.warnings.forEach((m) => console.warn(`  ! ${m}`));
    }
  });

program
  .command('index')
  .description('Build views and full-index each repo with CodeGraph')
  .option('-r, --repo <names...>', 'Limit to these repos')
  .option('-f, --force', 'Force a full re-index')
  .action(async (o: { repo?: string[]; force?: boolean }) => {
    const w = ws();
    for (const repo of selectRepos(w, o.repo)) {
      process.stdout.write(`indexing ${repo.name} … `);
      const r = await indexRepo(w, repo, o.force);
      console.log(`${r.action} (${r.symlinks} subtree symlink(s))`);
      r.warnings.forEach((m) => console.warn(`  ! ${m}`));
    }
  });

program
  .command('sync')
  .description('Rebuild views and incrementally sync each repo')
  .option('-r, --repo <names...>', 'Limit to these repos')
  .action(async (o: { repo?: string[] }) => {
    const w = ws();
    for (const repo of selectRepos(w, o.repo)) {
      process.stdout.write(`syncing ${repo.name} … `);
      const r = await syncRepo(w, repo);
      console.log(r.action);
    }
  });

program
  .command('status')
  .description('Show per-repo index stats')
  .option('-r, --repo <names...>', 'Limit to these repos')
  .option('--freshness', 'Include pending-change scan (slower)')
  .option('-j, --json', 'Output JSON')
  .action(async (o: { repo?: string[]; freshness?: boolean; json?: boolean }) => {
    const w = ws();
    const stats = await repoStats(w, selectRepos(w, o.repo), Boolean(o.freshness));
    if (o.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }
    for (const s of stats) {
      const head = s.indexed
        ? `${s.fileCount} files · ${s.nodeCount} nodes · ${s.edgeCount} edges · ${(s.dbSizeBytes / 1e6).toFixed(1)} MB`
        : s.error
          ? `error: ${s.error}`
          : 'not indexed';
      console.log(`${s.repo.padEnd(16)} ${head}`);
      if (s.pendingChanges) {
        const p = s.pendingChanges;
        console.log(`${' '.repeat(16)} pending: +${p.added} ~${p.modified} -${p.removed}`);
      }
    }
  });

program
  .command('serve')
  .description('Run the workspace MCP server')
  .option('--http', 'Use Streamable HTTP transport (listens on a port)')
  .option('--stdio', 'Use stdio transport (default)')
  .option('--host <host>', 'HTTP bind address', '127.0.0.1')
  .option('--port <port>', 'HTTP port', '8765')
  .option('--path <path>', 'HTTP endpoint path', '/mcp')
  .option('--token <token>', 'Require this bearer token (or set CGW_TOKEN)')
  .action(async (o: { http?: boolean; host: string; port: string; path: string; token?: string }) => {
    const backend = new GatewayBackend(ws());
    if (o.http) {
      const port = Number(o.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --port: ${o.port}`);
      }
      await serveHttp(backend, {
        host: o.host,
        port,
        path: o.path,
        token: o.token ?? process.env.CGW_TOKEN,
      });
      return;
    }
    const transport = new StdioServerTransport();
    await createServer(backend).connect(transport);
    process.stderr.write('codegraph-workspace: MCP server ready (stdio)\n');
    const shutdown = async () => {
      await backend.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parseAsync().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
