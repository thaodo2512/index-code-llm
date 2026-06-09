import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { codegraphBin, serveArgs } from './codegraph.js';

export interface ToolResult {
  content: unknown;
  isError?: boolean;
}

/**
 * Owns ONE long-lived `codegraph serve --mcp --no-watch` process and speaks MCP
 * client to it. Rich per-repo tools are forwarded here with a per-call
 * `projectPath`; CodeGraph keeps each opened project cached, so a single child
 * serves every view. Connects lazily and reconnects on transport failure.
 */
export class CodegraphChild {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: codegraphBin,
        args: serveArgs(),
        stderr: 'ignore',
      });
      const client = new Client({ name: 'codegraph-workspace', version: '0.1.0' }, {});
      transport.onclose = () => {
        if (this.client === client) this.client = null;
      };
      await client.connect(transport);
      this.client = client;
      this.connecting = null;
      return client;
    })();
    try {
      return await this.connecting;
    } catch (e) {
      this.connecting = null;
      throw e;
    }
  }

  /** List CodeGraph's own MCP tools (used to reflect the passthrough surface). */
  async listTools(): Promise<Tool[]> {
    const client = await this.connect();
    const { tools } = await client.listTools();
    return tools;
  }

  /** Call a CodeGraph tool with `projectPath` injected. Retries once on a dropped transport. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    projectPath: string,
  ): Promise<ToolResult> {
    const params = { name, arguments: { ...args, projectPath } };
    try {
      const client = await this.connect();
      return (await client.callTool(params)) as ToolResult;
    } catch (e) {
      // One reconnect attempt covers a child that died between calls.
      this.client = null;
      this.connecting = null;
      const client = await this.connect();
      try {
        return (await client.callTool(params)) as ToolResult;
      } catch {
        throw e;
      }
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
  }
}
