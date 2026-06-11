#!/usr/bin/env bash
# Deploy codegraph-workspace in Docker on THIS machine (laptop). The MCP client
# (Codex, Claude Code, ...) runs on the same machine and connects over localhost.
# shellcheck disable=SC1007  # CDPATH= cd is intentional
set -euo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

ROOT="$(project_root)"
NL=$'\n'

need_cmd docker
COMPOSE="$(compose_cmd)"

hr; info "${BOLD}codegraph-workspace — local Docker deploy${RST}"
info "Everything runs in a container on this machine; nothing else to install."; hr

# --- project name ---
while true; do
  ask PROJECT "Deployment name (container/project slug)" "cgw-local"
  valid_slug "$PROJECT" && break
  warn "Use only letters, digits, dot, underscore, hyphen."
done

# --- repos ---
REPOS_JSON=""
MOUNTS=""
info "${BOLD}Add the repositories to index.${RST} Paths are on THIS machine."
while true; do
  while true; do ask_required RNAME "  Repo name (slug)"; valid_slug "$RNAME" && break; warn "Invalid slug."; done
  while true; do
    ask_required RPATH_RAW "  Absolute path to '$RNAME'"
    RPATH="$(expand_path "$RPATH_RAW")"
    [ -d "$RPATH" ] && break
    warn "Not a directory: $RPATH"
  done
  RPATH="$(CDPATH= cd -- "$RPATH" && pwd -P)"
  ask RSCOPE "  Subtrees to index (comma-separated, '.' = whole repo)" "."
  SCOPE_JSON="$(csv_to_json_array "$RSCOPE")"
  REPOS_JSON="${REPOS_JSON}{\"name\":\"$RNAME\",\"path\":\"/repos/$RNAME\",\"scope\":$SCOPE_JSON},"
  MOUNTS="${MOUNTS}      - \"$RPATH:/repos/$RNAME:ro\"${NL}"
  ok "added $RNAME ($RPATH, scope $SCOPE_JSON)"
  confirm_yes "Add another repo?" || break
done
REPOS_JSON="[${REPOS_JSON%,}]"

# --- port ---
pick_free_port HOST_PORT "HTTP port to expose on 127.0.0.1" "8765"

# --- auth ---
TOKEN=""
if confirm_yes "Protect the endpoint with a bearer token?"; then
  TOKEN="$(gen_token)"; ok "generated token"
fi

# --- index now? ---
INDEX_NOW=0
if confirm_yes "Index immediately after start? (recommended for small/medium repos)"; then INDEX_NOW=1; fi

# --- where to write the generated deployment ---
ask DEPLOY_DIR "Directory to write the generated deployment to" "$ROOT/deploy/$PROJECT"
DEPLOY_DIR="$(expand_path "$DEPLOY_DIR")"
mkdir -p "$DEPLOY_DIR"

# --- generate files ---
printf '{\n  "viewsDir": "/data/views",\n  "repos": %s\n}\n' "$REPOS_JSON" > "$DEPLOY_DIR/workspace.json"

cat > "$DEPLOY_DIR/.env" <<EOF
COMPOSE_PROJECT_NAME=$PROJECT
HOST_PORT=$HOST_PORT
CGW_TOKEN=$TOKEN
CGW_INDEX_ON_START=0
EOF

cp "$HERE/cgw.sh" "$DEPLOY_DIR/cgw" && chmod +x "$DEPLOY_DIR/cgw"

cat > "$DEPLOY_DIR/docker-compose.yml" <<EOF
services:
  gateway:
    build:
      context: $ROOT
      args:
        CODEGRAPH_VERSION: latest
    image: codegraph-workspace:local
    container_name: $PROJECT
    restart: unless-stopped
    environment:
      CODEGRAPH_WORKSPACE_CONFIG: /config/workspace.json
      CGW_TOKEN: \${CGW_TOKEN:-}
      CGW_INDEX_ON_START: \${CGW_INDEX_ON_START:-0}
    ports:
      - "127.0.0.1:\${HOST_PORT}:8765"
    volumes:
      - "./workspace.json:/config/workspace.json:ro"
      - "cgw_views:/data/views"
${MOUNTS}    command: ["serve", "--http", "--host", "0.0.0.0", "--port", "8765"]

volumes:
  cgw_views:
EOF

hr
info "${BOLD}Summary${RST}"
info "  name:    $PROJECT"
info "  url:     http://127.0.0.1:$HOST_PORT/mcp"
info "  auth:    $([ -n "$TOKEN" ] && echo "bearer token" || echo "none")"
info "  files:   $DEPLOY_DIR/{docker-compose.yml,workspace.json,.env}"
hr
confirm_yes "Build the image and start the container now?" || { info "Generated files only. Run: (cd '$DEPLOY_DIR' && $COMPOSE up -d --build)"; exit 0; }

( cd "$DEPLOY_DIR" && $COMPOSE up -d --build )
ok "container is up"

if [ "$INDEX_NOW" = "1" ]; then
  info "Indexing (this can take a while for large repos)..."
  ( cd "$DEPLOY_DIR" && $COMPOSE exec -T gateway node /app/dist/cli.js index )
  ( cd "$DEPLOY_DIR" && $COMPOSE exec -T gateway node /app/dist/cli.js status )
fi

AUTH_LINE=""
[ -n "$TOKEN" ] && AUTH_LINE=",\n      \"headers\": { \"Authorization\": \"Bearer $TOKEN\" }"

hr
ok "${BOLD}Done.${RST} Connect your MCP client:"
info ""
info "${BOLD}Claude Code${RST} (~/.claude.json):"
printf '  "mcpServers": {\n    "workspace": {\n      "type": "http",\n      "url": "http://127.0.0.1:%s/mcp"%b\n    }\n  }\n' "$HOST_PORT" "$AUTH_LINE"
info ""
info "${BOLD}Any MCP client — stdio fallback${RST} (no token needed):"
info "  command: docker"
info "  args:    [\"exec\", \"-i\", \"$PROJECT\", \"codegraph-workspace\", \"serve\", \"--stdio\"]"
info ""
info "${BOLD}Day-2 ops${RST} — the ./cgw helper in the deploy folder:"
info "  cd '$DEPLOY_DIR'"
info "  ./cgw sync                          # refresh after pulls / branch switches"
info "  ./cgw status | logs -f | down"
info "  ./cgw add-repo <name> <path> [subtree...]   # mount + register + index"
info "  ./cgw remove-repo <name>"
