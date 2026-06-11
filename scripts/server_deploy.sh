#!/usr/bin/env bash
# Deploy codegraph-workspace in Docker directly ON this server (run it here, on
# the machine where the heavy repos live). Counterpart to remote_deploy.sh,
# which drives the same deployment from a laptop over SSH. The final output is
# written for the laptop side: tunnel command, MCP config, and a cgw wrapper.
# shellcheck disable=SC1007  # CDPATH= cd is intentional
set -euo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

ROOT="$(project_root)"
NL=$'\n'

need_cmd docker
COMPOSE="$(compose_cmd)"

hr; info "${BOLD}codegraph-workspace — server Docker deploy${RST}"
info "Run this ON the server. Repos are indexed here; laptops connect over SSH."; hr

# --- project name ---
while true; do
  ask PROJECT "Deployment name (container/project slug)" "cgw-server"
  valid_slug "$PROJECT" && break
  warn "Use only letters, digits, dot, underscore, hyphen."
done

# --- repos (paths on THIS machine) ---
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

# --- port (bound to this server's localhost; reached via SSH tunnel) ---
pick_free_port HOST_PORT "HTTP port to bind on this server's localhost" "8765"

# --- auth (always on: clients are remote) ---
TOKEN="$(gen_token)"; ok "generated bearer token"

# --- index now? ---
INDEX_NOW=0
if confirm_yes "Index immediately after start? (recommended; large repos take a while)"; then INDEX_NOW=1; fi

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
    image: codegraph-workspace:server
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
info "  binds:   127.0.0.1:$HOST_PORT (this server only — laptops come in over SSH)"
info "  files:   $DEPLOY_DIR/{docker-compose.yml,workspace.json,.env,cgw}"
hr
confirm_yes "Build the image and start the container now?" || { info "Generated files only. Run: (cd '$DEPLOY_DIR' && $COMPOSE up -d --build)"; exit 0; }

( cd "$DEPLOY_DIR" && $COMPOSE up -d --build )
ok "container is up"

if [ "$INDEX_NOW" = "1" ]; then
  info "Indexing (this can take a while for large repos)..."
  ( cd "$DEPLOY_DIR" && $COMPOSE exec -T gateway codegraph-workspace index )
  ( cd "$DEPLOY_DIR" && $COMPOSE exec -T gateway codegraph-workspace status )
fi

# --- laptop-side instructions ---
DEFAULT_TARGET="$(whoami)@$(hostname -f 2>/dev/null || hostname)"
ask SSH_TARGET "How do laptops SSH into this machine? (user@host or ssh alias)" "$DEFAULT_TARGET"

hr
ok "${BOLD}Deployed.${RST} Everything below runs ON YOUR LAPTOP."
info ""
info "${BOLD}1) Tunnel${RST} (keep running, or add -f to background it):"
info "   ssh -N -L $HOST_PORT:127.0.0.1:$HOST_PORT $SSH_TARGET"
info ""
info "${BOLD}2) Claude Code${RST} (~/.claude.json):"
printf '  "mcpServers": {\n    "workspace": {\n      "type": "http",\n      "url": "http://127.0.0.1:%s/mcp",\n      "headers": { "Authorization": "Bearer %s" }\n    }\n  }\n' "$HOST_PORT" "$TOKEN"
info ""
info "${BOLD}Alternative — no tunnel, any MCP client${RST} (stdio over SSH):"
info "  command: ssh"
info "  args:    [\"$SSH_TARGET\", \"docker\", \"exec\", \"-i\", \"$PROJECT\", \"codegraph-workspace\", \"serve\", \"--stdio\"]"
info ""
info "${BOLD}3) Optional laptop wrapper${RST} for day-2 commands — save as 'cgw' on the laptop, chmod +x:"
printf '  #!/usr/bin/env bash\n  exec ssh %s "cd %s && ./cgw \\$(printf %s "\\$@")"\n' "$SSH_TARGET" "'$DEPLOY_DIR'" "'%q '"
info ""
info "${BOLD}Day-2 ops on this server:${RST}"
info "  cd '$DEPLOY_DIR'"
info "  ./cgw sync                          # refresh after pulls / branch switches"
info "  ./cgw status | logs -f | down"
info "  ./cgw add-repo <name> <path> [subtree...]"
info "  ./cgw remove-repo <name>"
