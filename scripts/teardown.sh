#!/usr/bin/env bash
# Completely remove a codegraph-workspace deployment: container, index volume,
# built image, and the generated deploy/<name>/ folder — so a deployment that
# went wrong can be wiped and redone from scratch.
#
#   - local_deploy / server_deploy: run this on the machine running the container.
#   - remote_deploy: run this on the LAPTOP and point it at deploy/<name>/ (the
#     SSH wrapper); the teardown is forwarded to the server, then the server-side
#     source+deploy dirs and the laptop wrapper are removed too.
#
# Falls back to removing the container/volume directly when `compose down`
# fails, so it also cleans up half-broken deployments.
# shellcheck disable=SC1007,SC2029  # CDPATH= cd is intentional; remote $vars expand client-side by design
set -euo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

ROOT="$(project_root)"

usage() {
  cat <<EOF
Usage: scripts/teardown.sh [deployment]

  deployment   a deploy folder path, or a name under $ROOT/deploy/
               (listed and prompted for if omitted)

Removes the container, the cgw_views index volume, the built image, and the
deploy folder. For a remote deployment (SSH wrapper) the server side is wiped
too. Your source repositories are never touched.
EOF
}
case "${1:-}" in -h|--help|help) usage; exit 0;; esac

hr; info "${BOLD}codegraph-workspace — deployment teardown${RST}"
info "Removes container + index volume + image + generated files. Repos are never touched."; hr

# --- pick the deployment ---
DIR="${1:-}"
if [ -z "$DIR" ]; then
  if [ -d "$ROOT/deploy" ]; then
    info "Deployments under $ROOT/deploy:"
    for d in "$ROOT"/deploy/*/; do
      [ -d "$d" ] || continue
      if [ -f "$d/docker-compose.yml" ]; then kind="runs here"
      elif [ -f "$d/cgw" ] && grep -q '^exec ssh ' "$d/cgw"; then kind="remote over SSH"
      else kind="unrecognized"; fi
      info "  $(basename "$d")  ${DIM}($kind)${RST}"
    done
  fi
  ask_required DIR "Deployment to tear down (name above, or a path)"
fi
DIR="$(expand_path "$DIR")"
[ -d "$DIR" ] || { [ -d "$ROOT/deploy/$DIR" ] && DIR="$ROOT/deploy/$DIR"; }
[ -d "$DIR" ] || die "No such deployment folder: $DIR"
DIR="$(CDPATH= cd -- "$DIR" && pwd -P)"

# ---------- mode A: the container runs on this machine ----------
if [ -f "$DIR/docker-compose.yml" ]; then
  need_cmd docker
  COMPOSE="$(compose_cmd)"
  PROJECT="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$DIR/.env" 2>/dev/null | head -1 || true)"
  [ -n "$PROJECT" ] || PROJECT="$(basename "$DIR")"
  IMAGE="$(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' "$DIR/docker-compose.yml" | head -1)"

  info "About to remove:"
  info "  container:  $PROJECT"
  info "  volume:     ${PROJECT}_cgw_views (the index data)"
  info "  image:      ${IMAGE:-<none found in compose file>}"
  info "  folder:     $DIR (config + .env with the bearer token)"
  confirm "Tear it all down?" || die "Aborted — nothing was removed."

  ( cd "$DIR" && $COMPOSE down --volumes --remove-orphans ) \
    || warn "compose down failed — removing the pieces directly"
  # Direct removal covers half-broken deployments; both are no-ops when
  # compose down already did the job.
  docker rm -f "$PROJECT" >/dev/null 2>&1 || true
  docker volume rm "${PROJECT}_cgw_views" >/dev/null 2>&1 || true
  ok "container + volume removed"

  if [ -n "$IMAGE" ]; then
    if docker rmi "$IMAGE" >/dev/null 2>&1; then ok "image $IMAGE removed"
    else warn "image $IMAGE not removed (already gone, or in use by another deployment)"; fi
  fi

  rm -rf "$DIR"
  ok "deleted $DIR"
  info "Re-deploy any time with scripts/local_deploy.sh or scripts/server_deploy.sh."
  exit 0
fi

# ---------- mode B: laptop-side wrapper for a remote deployment ----------
if [ -f "$DIR/cgw" ] && grep -q '^exec ssh ' "$DIR/cgw"; then
  need_cmd ssh
  SSH="$(sed -n 's/^exec ssh \([^ ]*\) .*/\1/p' "$DIR/cgw" | head -1)"
  RROOT="$(sed -n "s#^exec ssh [^ ]* \"cd '\([^']*\)/deploy'.*#\1#p" "$DIR/cgw" | head -1)"
  { [ -n "$SSH" ] && [ -n "$RROOT" ]; } || die "Could not parse the SSH wrapper at $DIR/cgw."

  PROJECT="$(ssh "$SSH" "sed -n 's/^COMPOSE_PROJECT_NAME=//p' '$RROOT/deploy/.env' 2>/dev/null" | head -1 || true)"
  [ -n "$PROJECT" ] || PROJECT="$(basename "$DIR")"
  IMAGE="$(ssh "$SSH" "sed -n 's/^[[:space:]]*image:[[:space:]]*//p' '$RROOT/deploy/docker-compose.yml' 2>/dev/null" | head -1 || true)"
  [ -n "$IMAGE" ] || IMAGE="codegraph-workspace:remote"

  info "About to remove ON ${BOLD}$SSH${RST}:"
  info "  container:  $PROJECT"
  info "  volume:     ${PROJECT}_cgw_views (the index data)"
  info "  image:      $IMAGE"
  info "  folder:     $RROOT (rsynced source + deploy config/.env)"
  info "and on this laptop:"
  info "  folder:     $DIR (the SSH wrapper)"
  confirm "Tear it all down?" || die "Aborted — nothing was removed."

  ssh "$SSH" "cd '$RROOT/deploy' && docker compose down --volumes --remove-orphans" \
    || warn "compose down failed on the server — removing the pieces directly"
  ssh "$SSH" "docker rm -f '$PROJECT' >/dev/null 2>&1; docker volume rm '${PROJECT}_cgw_views' >/dev/null 2>&1; true"
  ok "container + volume removed on $SSH"
  if ssh "$SSH" "docker rmi '$IMAGE' >/dev/null 2>&1"; then ok "image $IMAGE removed on $SSH"
  else warn "image $IMAGE not removed (already gone, or in use by another deployment)"; fi
  ssh "$SSH" "rm -rf '$RROOT'"
  ok "deleted $RROOT on $SSH"

  rm -rf "$DIR"
  ok "deleted $DIR"
  info "Re-deploy any time with scripts/remote_deploy.sh."
  exit 0
fi

die "Unrecognized deployment folder: $DIR (no docker-compose.yml and no SSH-wrapper cgw)."
