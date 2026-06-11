# Client setup

Ready-to-paste MCP configs for popular AI agents, plus a **skill** that teaches the agent how to
use this server well. Every agent consumes the same 10 tools — only the config file differs.

## 1 · Pick a transport

| Transport | When | Endpoint |
|---|---|---|
| **Streamable HTTP** | Docker deploys (what the deploy scripts print) | `http://127.0.0.1:<port>/mcp` + `Authorization: Bearer <token>` |
| **stdio, local Docker** | container on the same machine | `docker exec -i <container> codegraph-workspace serve --stdio` |
| **stdio over SSH** | server-side deploy, no tunnel needed | `ssh <server> docker exec -i <container> codegraph-workspace serve --stdio` |
| **stdio, no Docker** | npm-installed on the same machine / server | `codegraph-workspace serve --stdio` |

The deploy scripts print the exact values (port, token, container name) at the end of a deploy.

## 2 · Add the server to your agent

| Agent | Config file | Sample |
|---|---|---|
| Claude Code | `~/.claude.json` (user) or `.mcp.json` (project) | [`claude-code/mcp.json`](claude-code/mcp.json) |
| Codex CLI | `~/.codex/config.toml` | [`codex/config.toml`](codex/config.toml) |
| Cursor | `~/.cursor/mcp.json` | [`cursor/mcp.json`](cursor/mcp.json) |
| opencode | `~/.config/opencode/opencode.json` | [`opencode/opencode.json`](opencode/opencode.json) |

Copy the sample, replace `<port>` / `<token>` / `<container>` / `<server>` with your deploy's
values, and restart the agent. Claude Code can also do it from the CLI:

```bash
claude mcp add --transport http workspace http://127.0.0.1:8765/mcp \
  --header "Authorization: Bearer <token>"
```

## 3 · Install the skill / steering doc

Configs make the tools *available*; the skill teaches the agent *when and how* to reach for them
(search before grep, trace callers before editing, compare across repos, …).

| Agent | What | Install |
|---|---|---|
| Claude Code | skill | `cp -r clients/claude-code/skills/code-workspace ~/.claude/skills/` (user-wide) or into `<project>/.claude/skills/` |
| Codex CLI | steering doc | append [`codex/AGENTS.md`](codex/AGENTS.md) to `~/.codex/AGENTS.md` (global) or your project's `AGENTS.md` |
| Cursor | rule | `cp clients/cursor/rules/codegraph-workspace.mdc <project>/.cursor/rules/` |
| opencode | rule file | append [`codex/AGENTS.md`](codex/AGENTS.md) to `~/.config/opencode/AGENTS.md` — opencode reads the same format |

## 4 · Smoke test

Ask the agent:

> Which repos are in the workspace, and where is `<some symbol>` defined?

It should call `workspace_repos`, then `workspace_search`, and answer with `repo/file:line`
references without grepping anything.
