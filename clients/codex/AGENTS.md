# Code workspace (MCP server `workspace`)

<!-- Append this section to ~/.codex/AGENTS.md (global) or your project's AGENTS.md.
     opencode reads the same format from ~/.config/opencode/AGENTS.md. -->

A pre-built multi-repo code index is available through the `workspace` MCP server. **Prefer its
tools over grep/find/file-reading** for any repo it covers — results are ranked, repo-tagged, and
resolve to `file:line`.

## Tools

- `workspace_repos` — list indexed repos (call once, remember the names).
- `workspace_search {query, repos?, kind?, limit?}` — fuzzy symbol/file search across all repos.
  This is the entry point for nearly every code question.
- `ws_context {repo, ...}` — focused briefing for a task inside one repo.
- `ws_node` / `ws_callers` / `ws_callees` / `ws_impact` / `ws_trace` — symbol detail, call graph,
  change blast-radius (run `ws_impact` before proposing an edit).
- `ws_explore` / `ws_files` — orient in an unfamiliar repo.
  All `ws_*` tools require a `repo` argument.

## Workflow

1. Locate: `workspace_search` (filter with `repos`/`kind`/`limit`).
2. Understand: `ws_context` or `ws_node` in the winning repo.
3. Before changing code: `ws_callers` + `ws_impact`.
4. Cross-repo comparisons: search once (hits are repo-tagged), then `ws_context` per repo.

## Caveats

- The index covers only each repo's configured subtrees; macro-generated C symbols may not
  resolve. An empty result is **not** proof of absence — say so explicitly.
- The index is a snapshot: after `git pull` / branch switches suggest running `./cgw sync`
  (Docker) or `codegraph-workspace sync`. `workspace_repos {includeFreshness:true}` reports
  staleness but is slow.
- These tools are read-only; they never modify code.
