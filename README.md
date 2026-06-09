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

## Requirements

- [CodeGraph](https://github.com/colbymchenry/codegraph) on `PATH` (or set `CODEGRAPH_BIN`).
- Node.js ≥ 20.

## Install

```bash
npm install -g codegraph-workspace
# or run from a clone:
npm install && npm run build
```

## Quick start (on the server)

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

## Connect a client (on the laptop)

The server is reached by launching it over SSH; stdio is tunneled through the connection. Point
`CODEGRAPH_WORKSPACE_CONFIG` at your registry on the server.

| Client | Config file | Entry |
|---|---|---|
| Claude Code | `~/.claude.json` | `"workspace": { "type": "stdio", "command": "ssh", "args": ["devserver", "codegraph-workspace", "serve", "--stdio"] }` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.workspace]`<br>`command = "ssh"`<br>`args = ["devserver", "codegraph-workspace", "serve", "--stdio"]` |
| Cursor | `~/.cursor/mcp.json` | same JSON shape as Claude Code |
| opencode | `~/.config/opencode/opencode.jsonc` | `"workspace": { "type": "local", "command": ["ssh", "devserver", "codegraph-workspace", "serve", "--stdio"] }` |

Tip: enable SSH connection reuse (`ControlMaster auto`, `ControlPersist 10m` in `~/.ssh/config`) so
repeated sessions are instant.

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
codegraph-workspace serve       --stdio              # run the MCP server
```

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

MIT
