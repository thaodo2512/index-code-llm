import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type GatewayBackend } from './gateway.js';

export interface HttpOptions {
  host: string;
  port: number;
  path: string;
  /** If set, requests must carry `Authorization: Bearer <token>`. */
  token?: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

/**
 * Serve the gateway over MCP Streamable HTTP. One shared backend (single
 * CodeGraph child) is reused across all sessions; each MCP session gets its own
 * transport + Server. Optional bearer-token auth gates every request.
 */
export async function serveHttp(backend: GatewayBackend, opts: HttpOptions): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const authorized = (req: IncomingMessage): boolean => {
    if (!opts.token) return true;
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${opts.token}`;
  };

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/healthz') {
        send(res, 200, { ok: true });
        return;
      }
      if (url.pathname !== opts.path) {
        send(res, 404, { error: 'not found' });
        return;
      }
      if (!authorized(req)) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      try {
        if (req.method === 'POST') {
          const body = await readJson(req);
          let transport = sessionId ? transports.get(sessionId) : undefined;

          if (!transport) {
            if (sessionId || !isInitializeRequest(body)) {
              send(res, 400, { error: 'no valid session; send an initialize request first' });
              return;
            }
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                transports.set(sid, transport!);
              },
            });
            transport.onclose = () => {
              if (transport!.sessionId) transports.delete(transport!.sessionId);
            };
            await createServer(backend).connect(transport);
          }
          await transport.handleRequest(req, res, body);
          return;
        }

        // GET (SSE stream) / DELETE (session teardown) need an existing session.
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          send(res, 400, { error: 'unknown or missing session' });
          return;
        }
        await transport.handleRequest(req, res);
      } catch (e) {
        if (!res.headersSent) send(res, 500, { error: (e as Error).message });
      }
    })();
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port, opts.host, resolve));
  process.stderr.write(
    `codegraph-workspace: MCP server on http://${opts.host}:${opts.port}${opts.path}` +
      `${opts.token ? ' (bearer auth on)' : ' (no auth)'}\n`,
  );

  const shutdown = async (): Promise<void> => {
    httpServer.close();
    for (const t of transports.values()) await t.close().catch(() => {});
    await backend.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
