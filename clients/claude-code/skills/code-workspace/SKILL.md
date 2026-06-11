---
name: code-workspace
description: Navigate multi-repo codebases through the codegraph-workspace MCP server (tools named workspace_* and ws_*). Use whenever the user asks where a symbol lives, how something is implemented, who calls a function, what breaks if it changes, or to compare implementations across repos (e.g. Linux vs Zephyr). Prefer these tools over grep/find/read for any repo that is indexed in the workspace.
---

# Working with the code workspace

The `workspace` MCP server fronts a pre-built code index (symbols, call graphs, full-text search)
covering several repositories at once. Searching it is far cheaper and more precise than grepping:
results are ranked, tagged with their repo, and resolve to `file:line`.

## Tool map

| Tool | Use it to | Cost |
|---|---|---|
| `workspace_repos` | discover what repos exist and their index size | cheap |
| `workspace_search` | find a symbol/file across ALL repos (or `repos:[...]` subset); supports `kind` (function, class, …) and `limit` | cheap |
| `ws_context` | get a focused briefing for a task inside ONE repo (key files, symbols, relationships) | medium |
| `ws_node` | inspect one symbol in detail (signature, location, doc) | cheap |
| `ws_callers` / `ws_callees` | who calls X / what X calls | cheap |
| `ws_impact` | blast radius of changing a symbol — run BEFORE proposing edits | medium |
| `ws_trace` | follow a call path between symbols | medium |
| `ws_explore` / `ws_files` | structure of an unfamiliar repo / file list with symbol counts | cheap |

Every `ws_*` tool requires a `repo` argument — get valid names from `workspace_repos` once and
remember them for the session.

## Standard workflows

**"Where is X / how does X work?"**
1. `workspace_search {query:"X"}` → note `repo` + `file:line` of the best hits.
2. `ws_node` or `ws_context` on the winning repo for detail.
3. Quote findings as `repo/file:line`.

**"Who uses X / can I change X?"**
1. `workspace_search` to pin down the symbol and repo.
2. `ws_callers {repo, ...}` for direct users; `ws_impact` for the full blast radius.
3. Only then read or edit code.

**"Compare A across repos" (e.g. scheduler in Linux vs Zephyr)**
1. `workspace_search {query:"A"}` — hits arrive tagged per repo.
2. `ws_context` in each repo separately.
3. Contrast the two; cite `repo/file:line` on both sides.

**Unfamiliar repo orientation**
`ws_files {repo}` or `ws_explore {repo}` before reading files one by one.

## Rules of thumb

- **Search before grep.** Only fall back to grep/Read for repos NOT in `workspace_repos`, or for
  exact-string matches the symbol index can't express (log messages, config keys).
- **Filter early.** Pass `repos:[...]`, `kind`, and a sensible `limit` to keep responses small.
- **Empty result ≠ doesn't exist.** The index covers only each repo's configured scope
  (subtrees), and C macro-generated symbols may not resolve. Say so instead of concluding the
  symbol is absent; optionally confirm with one targeted grep if the tree is locally readable.
- **Index is a snapshot.** After the user pulls or switches branches, results can be stale —
  suggest `./cgw sync` (Docker deploy) or `codegraph-workspace sync`. To check, call
  `workspace_repos {includeFreshness:true}` (slow — only when staleness is suspected).
- **Read-only.** These tools never modify code; edits still go through your normal file tools,
  ideally after `ws_impact`.
