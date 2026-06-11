# codegraph-workspace

Turn many code repositories into **one searchable workspace** for MCP clients, on top of
[CodeGraph](https://github.com/colbymchenry/codegraph).

CodeGraph builds a fast semantic index (symbols, call graphs, FTS search) of a single repo.
`codegraph-workspace` adds the layer it doesn't have:

- **Multiple repos, one endpoint.** Register N repos; query them through a single MCP server with
  cross-repo fuzzy search and per-repo tools.
- **Built for remote development.** Index heavy trees on a powerful server; query them from a laptop
  over plain SSH. No open ports, no extra daemons.
- **Scoped indexing for huge trees.** Index only the subtrees you work on (e.g. `include` +
  `kernel` + `arch/arm64` of the Linux kernel) instead of the whole tree.
- **Zero footprint in your repos.** Your source repositories are never modified — no `.codegraph/`
  directory, no `.gitignore` edits, nothing in `git status`. All index data lives outside the repo.

## How it works

```
Laptop (MCP client)            ssh             Server
  ┌───────────────┐    stdio over ssh    ┌───────────────────────────────────────┐
  │ one MCP server │ ───────────────────▶ │ codegraph-workspace serve --stdio       │
  └───────────────┘                       │   ├─ cross-repo search & repo stats     │
                                          │   └─ one `codegraph serve` child,        │
   all repos, one tool surface            │      routed per call by repo            │
                                          │   views/<repo>/  ← scoped symlink trees  │
                                          └───────────────────────────────────────┘
```

Each repo is indexed through a **view**: a directory of symlinks pointing only at the subtrees you
chose. CodeGraph indexes the view, so the index is naturally scoped and its data lives next to the
view — never inside your real repository.

## Deploy with Docker (recommended)

Everything — the gateway **and** CodeGraph — runs in a container, so the only requirement on the
host is Docker. Two guided scripts walk you through setup (prompting for repos, scopes, and ports,
and validating each answer — e.g. if a port is busy it offers the next free one):

```bash
# On your laptop: gateway + your repos, all local. Client connects over localhost.
./scripts/local_deploy.sh

# On a powerful server: index there, query from your laptop over SSH.
./scripts/remote_deploy.sh
```

Each script generates a `deploy/<name>/` folder (`docker-compose.yml`, `workspace.json`, `.env`),
builds the image, starts the container, indexes your repos, and prints the exact MCP client config
to paste in. The server listens on a port you choose (bound to localhost), with optional bearer-token
auth; `remote_deploy.sh` also sets up the SSH tunnel.

**Requirements:** Docker Engine with the Compose plugin (on the host that runs the container). For
`remote_deploy.sh`, also `ssh` + `rsync` locally and Docker on the server.

## Run without Docker

Requires [CodeGraph](https://github.com/colbymchenry/codegraph) on `PATH` (or `CODEGRAPH_BIN`) and
Node ≥ 20.

```bash
npm install -g codegraph-workspace
# or from a clone: npm install && npm run build
```

## Quick start (manual / on the server)

1. Describe your workspace in `workspace.json` (see `workspace.example.json`):

   ```json
   {
     "root": "/ws",
     "viewsDir": "/ws/.codegraph-workspace/views",
     "repos": [
       { "name": "linux",  "path": "/ws/linux",  "scope": ["include", "kernel", "arch/arm64"] },
       { "name": "zephyr", "path": "/ws/zephyr", "scope": ["kernel", "include", "soc/x"] },
       { "name": "myapp",  "path": "/ws/myapp",  "scope": ["."] }
     ]
   }
   ```

   `scope` is a list of repo-relative subtrees to index; `["."]` indexes the whole repo. Keep
   `viewsDir` **outside** every repository.

2. Build the views and index them:

   ```bash
   codegraph-workspace build-views
   codegraph-workspace index
   codegraph-workspace status
   ```

3. Keep indexes fresh (e.g. from cron / a systemd timer):

   ```bash
   codegraph-workspace sync
   ```

## Connect a client

Two transports are supported (the deploy scripts print a ready-to-paste config for you):

**Streamable HTTP** (used by the Docker deploys) — point the client at the server's URL:

```jsonc
// Claude Code (~/.claude.json)
"mcpServers": {
  "workspace": {
    "type": "http",
    "url": "http://127.0.0.1:8765/mcp",
    "headers": { "Authorization": "Bearer <token>" }
  }
}
```

**Stdio** (no port; works with every MCP client) — launch the server as a command:

| Setup | Command / args |
|---|---|
| Docker, local | `command: docker`, `args: ["exec", "-i", "<container>", "codegraph-workspace", "serve", "--stdio"]` |
| Docker, remote | `command: ssh`, `args: ["devserver", "docker", "exec", "-i", "<container>", "codegraph-workspace", "serve", "--stdio"]` |
| No Docker, remote | `command: ssh`, `args: ["devserver", "codegraph-workspace", "serve", "--stdio"]` |

Tip: for SSH, enable connection reuse (`ControlMaster auto`, `ControlPersist 10m` in `~/.ssh/config`)
so repeated sessions are instant.

## MCP tools

| Tool | Purpose |
|---|---|
| `workspace_search` | Fuzzy symbol search across all repos (or a subset); ranked hits tagged with their repo. |
| `workspace_repos` | List repos with index stats. Cheap by default; `includeFreshness: true` reports un-synced changes. |
| `ws_context`, `ws_trace`, `ws_explore`, `ws_callers`, `ws_callees`, `ws_impact`, `ws_node`, `ws_files` | CodeGraph's rich per-repo tools, each taking a `repo` argument. |

## CLI

```
codegraph-workspace build-views [-r <repo...>]      # materialize views from the registry
codegraph-workspace index       [-r <repo...>] [-f] # build views and full-index
codegraph-workspace sync        [-r <repo...>]       # rebuild views and incrementally sync
codegraph-workspace status      [-r <repo...>] [--freshness] [--json]
codegraph-workspace serve       --stdio                          # MCP over stdio (default)
codegraph-workspace serve       --http [--host H] [--port N] [--token T]   # MCP over HTTP
```

`--token` (or `CGW_TOKEN`) requires `Authorization: Bearer <token>` on every HTTP request.

`-c, --config <path>` selects the registry (default `./workspace.json` or
`CODEGRAPH_WORKSPACE_CONFIG`).

## Notes & limitations

- **Scope, not build config.** CodeGraph parses source text; it does not run the C preprocessor, so
  symbols gated behind macros / `CONFIG_*` / generated devicetree headers may not fully resolve.
  Scoping is by directory, independent of any build configuration.
- **Views are not git repos**, so `sync` walks the scoped tree and hashes contents to detect
  changes (there is no `git status` fast-path). This is bounded by your scope size.
- Keep `viewsDir` on a local disk (SQLite WAL mode does not enable on network filesystems).

## License

Apache-2.0 — Copyright 2026 Tinh Nguyen
