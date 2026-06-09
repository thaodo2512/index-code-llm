import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { repoStats, searchAll } from './aggregate.js';
import { CodegraphChild } from './child.js';
import { selectRepos, viewPath } from './registry.js';
import type { Workspace } from './types.js';

/** CodeGraph tools we do NOT reflect (the workspace_* aggregators cover them). */
const SKIP_REFLECT = new Set(['codegraph_search', 'codegraph_status']);

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Turn a CodeGraph tool schema into a repo-scoped `ws_*` passthrough: drop
 * `projectPath`, prepend a required `repo` (enum of workspace repo names).
 */
function reflectTool(tool: Tool, repoNames: string[]): { ws: Tool; codegraphName: string } {
  const wsName = 'ws_' + tool.name.replace(/^codegraph_/, '');
  const src = (tool.inputSchema ?? { type: 'object', properties: {} }) as {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const { projectPath: _drop, ...properties } = src.properties ?? {};
  const required = ['repo', ...(src.required ?? []).filter((r) => r !== 'projectPath')];
  const ws: Tool = {
    name: wsName,
    description: `${tool.description ?? tool.name} — scoped to one workspace repo.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Workspace repo name', enum: repoNames },
        ...properties,
      },
      required,
    },
  };
  return { ws, codegraphName: tool.name };
}

/**
 * Shared gateway state: the workspace registry plus ONE long-lived CodeGraph
 * child. Multiple MCP transports (stdio, or one per HTTP session) can share a
 * single backend, so we never spawn a child per connection.
 */
export class GatewayBackend {
  private readonly repoNames: string[];
  private readonly aggregators: Tool[];
  private readonly child = new CodegraphChild();
  private reflected: Tool[] | null = null;
  private readonly wsToCodegraph = new Map<string, string>();

  constructor(private readonly ws: Workspace) {
    this.repoNames = ws.repos.map((r) => r.name);
    this.aggregators = [
      {
        name: 'workspace_search',
        description:
          'Fuzzy symbol search across ALL workspace repos (or a subset). Returns ranked hits ' +
          'tagged with their repo. Use this first to find where a symbol lives across repos.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Symbol name or partial name' },
            repos: {
              type: 'array',
              items: { type: 'string', enum: this.repoNames },
              description: 'Limit to these repos (default: all)',
            },
            kind: { type: 'string', description: 'Filter by node kind (function, class, ...)' },
            limit: { type: 'number', description: 'Max total hits (default 30)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'workspace_repos',
        description:
          'List workspace repos with index stats (files/nodes/edges/size). Cheap by default; ' +
          'pass includeFreshness:true to also report pending (un-synced) changes.',
        inputSchema: {
          type: 'object',
          properties: {
            repos: { type: 'array', items: { type: 'string', enum: this.repoNames } },
            includeFreshness: { type: 'boolean', description: 'Run a change scan (slower)' },
          },
        },
      },
    ];
  }

  private async ensureReflected(): Promise<Tool[]> {
    if (this.reflected) return this.reflected;
    try {
      const tools = await this.child.listTools();
      const built: Tool[] = [];
      for (const t of tools) {
        if (SKIP_REFLECT.has(t.name) || !t.name.startsWith('codegraph_')) continue;
        const { ws: wsTool, codegraphName } = reflectTool(t, this.repoNames);
        this.wsToCodegraph.set(wsTool.name, codegraphName);
        built.push(wsTool);
      }
      this.reflected = built;
    } catch (e) {
      process.stderr.write(
        `codegraph-workspace: child unavailable, passthrough tools disabled: ${(e as Error).message}\n`,
      );
      return [];
    }
    return this.reflected;
  }

  async listToolDefs(): Promise<Tool[]> {
    return [...this.aggregators, ...(await this.ensureReflected())];
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      if (name === 'workspace_search') {
        const repos = selectRepos(this.ws, args.repos as string[] | undefined);
        const hits = await searchAll(this.ws, repos, String(args.query ?? ''), {
          limit: (args.limit as number | undefined) ?? 30,
          kind: args.kind as string | undefined,
        });
        return textResult({ count: hits.length, hits });
      }
      if (name === 'workspace_repos') {
        const repos = selectRepos(this.ws, args.repos as string[] | undefined);
        return textResult(await repoStats(this.ws, repos, Boolean(args.includeFreshness)));
      }
      await this.ensureReflected();
      const codegraphName = this.wsToCodegraph.get(name);
      if (!codegraphName) return errorResult(`Unknown tool: ${name}`);
      const { repo: repoName, ...rest } = args;
      const [repo] = selectRepos(this.ws, [String(repoName)]);
      return (await this.child.callTool(codegraphName, rest, viewPath(this.ws, repo!))) as CallToolResult;
    } catch (e) {
      return errorResult(`${name} failed: ${(e as Error).message}`);
    }
  }

  close(): Promise<void> {
    return this.child.close();
  }
}

/** A new MCP Server wired to a shared backend (one per transport/session). */
export function createServer(backend: GatewayBackend): Server {
  const server = new Server(
    { name: 'codegraph-workspace', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await backend.listToolDefs(),
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    backend.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  );
  return server;
}
