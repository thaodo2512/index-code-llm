#!/usr/bin/env bash
# Deploy codegraph-workspace in Docker on a REMOTE server (where the heavy repos
# live and get indexed), and connect to it from this laptop over SSH. Only Docker
# is required on the server — nothing else is installed there.
# shellcheck disable=SC1007,SC2088  # CDPATH= cd and the ~ default are intentional
set -euo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

ROOT="$(project_root)"
NL=$'\n'

need_cmd ssh
need_cmd rsync

hr; info "${BOLD}codegraph-workspace — remote Docker deploy${RST}"
info "Indexes on the server; you query it from here over SSH."; hr

# --- ssh target (key auth; offer to install the public key if it isn't set up) ---
ssh_key_ok() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$1" 'true' 2>/dev/null; }
while true; do
  ask_required SSH "SSH target for the server (e.g. user@host or an ssh alias)"
  info "Checking SSH connectivity (key auth)..."
  if ssh_key_ok "$SSH"; then ok "SSH key auth OK"; break; fi
  warn "Could not log in to '$SSH' with key auth."
  if command -v ssh-copy-id >/dev/null 2>&1 \
     && confirm_yes "Install your public key on the server now? (ssh-copy-id; asks for the account password once)"; then
    if ! ls "$HOME"/.ssh/id_*.pub >/dev/null 2>&1; then
      info "No SSH key found in ~/.ssh — generating one (ed25519)."
      ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ed25519" || warn "key generation failed"
    fi
    if ssh-copy-id "$SSH" && ssh_key_ok "$SSH"; then
      ok "public key installed — key auth OK"; break
    fi
    warn "Key installation failed (or the key needs an agent/passphrase)."
  fi
  confirm "Try a different target?" || die "Aborted."
done

# --- docker on remote ---
info "Checking Docker on the server..."
if ssh "$SSH" 'command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1'; then
  ok "Docker + compose present on server"
else
  die "The server needs Docker Engine with the compose plugin. Install Docker there first."
fi

remote_port_in_use() { ssh "$SSH" "bash -lc '(exec 3<>/dev/tcp/127.0.0.1/$1) >/dev/null 2>&1'" >/dev/null 2>&1; }
pick_free_remote_port() {
  local __var="$1" __prompt="$2" __def="$3" __p
  while true; do
    ask __p "$__prompt" "$__def"
    valid_port "$__p" || { warn "Port must be 1..65535."; continue; }
    if remote_port_in_use "$__p"; then warn "Port $__p is in use ON THE SERVER."; __def=$((__p + 1)); continue; fi
    printf -v "$__var" '%s' "$__p"; break
  done
}

# --- project + repos (paths are on the SERVER) ---
while true; do ask PROJECT "Deployment name (container/project slug)" "cgw-remote"; valid_slug "$PROJECT" && break; warn "Invalid slug."; done

REPOS_JSON=""; MOUNTS=""
info "${BOLD}Add the repositories to index.${RST} Paths are on the SERVER."
while true; do
  while true; do ask_required RNAME "  Repo name (slug)"; valid_slug "$RNAME" && break; warn "Invalid slug."; done
  while true; do
    ask_required RPATH "  Absolute server path to '$RNAME'"
    if ssh "$SSH" "test -d '$RPATH'"; then break; fi
    warn "Not a directory on the server: $RPATH"
  done
  ask RSCOPE "  Subtrees to index (comma-separated, '.' = whole repo)" "."
  SCOPE_JSON="$(csv_to_json_array "$RSCOPE")"
  REPOS_JSON="${REPOS_JSON}{\"name\":\"$RNAME\",\"path\":\"/repos/$RNAME\",\"scope\":$SCOPE_JSON},"
  MOUNTS="${MOUNTS}      - \"$RPATH:/repos/$RNAME:ro\"${NL}"
  ok "added $RNAME ($RPATH)"
  confirm_yes "Add another repo?" || break
done
REPOS_JSON="[${REPOS_JSON%,}]"

# --- ports: one on the server (container publish), one local for the SSH tunnel ---
pick_free_remote_port REMOTE_PORT "Server port to bind on the server's localhost" "8765"
pick_free_port LOCAL_PORT "Local port for the SSH tunnel (on this laptop)" "$REMOTE_PORT"

# --- auth (recommended for remote) ---
TOKEN="$(gen_token)"; ok "generated bearer token"

ask REMOTE_DIR "Directory to deploy into on the server" "~/codegraph-workspace/$PROJECT"
REMOTE_DIR="${REMOTE_DIR/#\~/\$HOME}"   # expand ~ on the remote side

# --- stage generated files locally ---
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/deploy"
printf '{\n  "viewsDir": "/data/views",\n  "repos": %s\n}\n' "$REPOS_JSON" > "$STAGE/deploy/workspace.json"
cat > "$STAGE/deploy/.env" <<EOF
COMPOSE_PROJECT_NAME=$PROJECT
HOST_PORT=$REMOTE_PORT
CGW_TOKEN=$TOKEN
CGW_INDEX_ON_START=0
EOF
cp "$HERE/cgw.sh" "$STAGE/deploy/cgw" && chmod +x "$STAGE/deploy/cgw"

cat > "$STAGE/deploy/docker-compose.yml" <<EOF
services:
  gateway:
    build:
      context: REMOTE_DIR_PLACEHOLDER/source
      args:
        CODEGRAPH_VERSION: latest
    image: codegraph-workspace:remote
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
info "  server:      $SSH"
info "  deploy dir:  $REMOTE_DIR"
info "  server port: 127.0.0.1:$REMOTE_PORT (server-local only)"
info "  local port:  127.0.0.1:$LOCAL_PORT (via SSH tunnel)"
hr
confirm_yes "Copy the project to the server, build, and start it now?" || { info "Aborted before deploy."; exit 0; }

# Resolve the remote dir and substitute the absolute build-context path.
REMOTE_ABS="$(ssh "$SSH" "mkdir -p '$REMOTE_DIR/source' '$REMOTE_DIR/deploy' && cd '$REMOTE_DIR' && pwd -P")"
sed "s#REMOTE_DIR_PLACEHOLDER#$REMOTE_ABS#" "$STAGE/deploy/docker-compose.yml" > "$STAGE/deploy/docker-compose.yml.tmp"
mv "$STAGE/deploy/docker-compose.yml.tmp" "$STAGE/deploy/docker-compose.yml"

info "Copying source to the server..."
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude deploy --exclude .git \
  --exclude views --exclude 'workspace.json' --exclude '.claude' \
  "$ROOT/" "$SSH:$REMOTE_ABS/source/"
rsync -az "$STAGE/deploy/" "$SSH:$REMOTE_ABS/deploy/"

info "Building and starting on the server (first build downloads CodeGraph)..."
ssh "$SSH" "cd '$REMOTE_ABS/deploy' && docker compose up -d --build"
ok "container is up on the server"

info "Indexing on the server (large repos can take a while)..."
ssh "$SSH" "cd '$REMOTE_ABS/deploy' && docker compose exec -T gateway node /app/dist/cli.js index" || warn "indexing reported an error; check 'docker compose logs'"
ssh "$SSH" "cd '$REMOTE_ABS/deploy' && docker compose exec -T gateway node /app/dist/cli.js status" || true

hr
ok "${BOLD}Deployed.${RST} Open the SSH tunnel, then point your client at it."
info ""
info "${BOLD}1) Tunnel${RST} (keep running, or add -f to background it):"
info "   ssh -N -L $LOCAL_PORT:127.0.0.1:$REMOTE_PORT $SSH"
if confirm_yes "Start the tunnel in the background now?"; then
  ssh -f -N -L "$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" "$SSH" && ok "tunnel listening on 127.0.0.1:$LOCAL_PORT"
fi
info ""
info "${BOLD}2) Claude Code${RST} (~/.claude.json):"
printf '  "mcpServers": {\n    "workspace": {\n      "type": "http",\n      "url": "http://127.0.0.1:%s/mcp",\n      "headers": { "Authorization": "Bearer %s" }\n    }\n  }\n' "$LOCAL_PORT" "$TOKEN"
info ""
info "${BOLD}Alternative — no tunnel, any MCP client${RST} (stdio over SSH):"
info "  command: ssh"
info "  args:    [\"$SSH\", \"docker\", \"exec\", \"-i\", \"$PROJECT\", \"codegraph-workspace\", \"serve\", \"--stdio\"]"
info ""
# Local wrapper: run day-2 commands from this laptop, forwarded over SSH.
mkdir -p "$ROOT/deploy/$PROJECT"
cat > "$ROOT/deploy/$PROJECT/cgw" <<WRAP
#!/usr/bin/env bash
# Day-2 helper for the '$PROJECT' remote deployment — forwards to ./cgw on the
# server. NOTE: paths given to add-repo are paths ON THE SERVER.
exec ssh $SSH "cd '$REMOTE_ABS/deploy' && ./cgw \$(printf '%q ' "\$@")"
WRAP
chmod +x "$ROOT/deploy/$PROJECT/cgw"
info ""
info "${BOLD}Day-2 ops${RST} — from this laptop (forwarded over SSH):"
info "  deploy/$PROJECT/cgw sync                          # refresh after pulls / branch switches"
info "  deploy/$PROJECT/cgw status | logs -f | down"
info "  deploy/$PROJECT/cgw add-repo <name> <server-path> [subtree...]"
info "  deploy/$PROJECT/cgw remove-repo <name>"
info "  (or on the server: cd '$REMOTE_ABS/deploy' && ./cgw …)"
