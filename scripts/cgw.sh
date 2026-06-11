#!/usr/bin/env bash
# Day-2 helper for a codegraph-workspace Docker deployment. The deploy scripts
# copy this file into deploy/<name>/cgw next to docker-compose.yml; it always
# operates on its own folder, so it can be run from anywhere. Self-contained on
# purpose (no lib.sh): the deploy folder may be rsynced to a server on its own.
# shellcheck disable=SC1007,SC2088,SC2015  # CDPATH= cd, quoted-~ match, and a&&b||usage are intentional
set -euo pipefail
HERE="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$HERE"

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
ok()  { printf '✓ %s\n' "$*"; }

if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else die "docker compose (v2) or docker-compose is required"; fi

usage() {
  cat <<'EOF'
Usage: ./cgw <command> [args]

  status [--freshness]              per-repo index stats
  sync                              refresh the index (after pulls / branch switches)
  index [-f]                        full (re-)index
  add-repo <name> <path> [subtree...]
                                    mount + register + index a new repo
                                    (path is on the machine running the container;
                                     no subtree = index the whole repo)
  remove-repo <name> [--keep-view]  unregister a repo, drop its mount + index data
  logs [-f]                         container logs
  up | down | restart               manage the container
EOF
}

cli() { $COMPOSE exec -T gateway codegraph-workspace "$@"; }
ensure_up() { $COMPOSE up -d >/dev/null 2>&1 || die "could not start the container (try: ./cgw logs)"; }

valid_slug() { case "$1" in ''|*[!A-Za-z0-9._-]*) return 1;; *) return 0;; esac; }
registered() { grep -Eq "\"name\":[[:space:]]?\"$1\"" workspace.json; }

# Rewrite workspace.json through a node one-liner executed in the container
# (stdin -> stdout), so the host needs nothing but Docker. Refuses to install
# an empty/garbled result.
edit_registry() {
  local script="$1"; shift
  local tmp="workspace.json.tmp.$$"
  if ! $COMPOSE exec -T gateway node -e "$script" "$@" <workspace.json >"$tmp" || ! [ -s "$tmp" ]; then
    rm -f "$tmp"
    die "failed to update workspace.json (is the container running?)"
  fi
  mv "$tmp" workspace.json
}

ADD_SCRIPT='const a=process.argv.slice(1);const name=a[0];const scope=a.slice(1);let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);j.repos=(j.repos||[]).concat([{name:name,path:"/repos/"+name,scope:scope}]);process.stdout.write(JSON.stringify(j,null,2)+"\n");});'
DEL_SCRIPT='const name=process.argv[1];let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);j.repos=(j.repos||[]).filter(r=>r.name!==name);process.stdout.write(JSON.stringify(j,null,2)+"\n");});'

cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  status|sync|index)
    ensure_up
    cli "$cmd" "$@"
    ;;

  logs)    $COMPOSE logs "$@" gateway ;;
  up)      $COMPOSE up -d ;;
  down)    $COMPOSE down ;;
  restart) $COMPOSE restart ;;

  add-repo)
    name="${1:-}"; rpath="${2:-}"
    [ -n "$name" ] && [ -n "$rpath" ] || { usage; exit 1; }
    shift 2
    [ $# -gt 0 ] || set -- "."          # default scope: whole repo
    for s in "$@"; do
      case "$s" in /*|..|../*|*/..|*/../*) die "unsafe scope entry: $s";; esac
    done
    valid_slug "$name" || die "invalid repo name (use A-Z a-z 0-9 . _ -): $name"
    case "$rpath" in "~"|"~/"*) rpath="${HOME}${rpath#\~}";; esac
    [ -d "$rpath" ] || die "not a directory: $rpath"
    rpath="$(CDPATH= cd -- "$rpath" && pwd -P)"
    registered "$name" && die "repo '$name' is already registered"
    grep -Fq ":/repos/$name:ro\"" docker-compose.yml && die "mount /repos/$name already exists in docker-compose.yml"

    ensure_up
    edit_registry "$ADD_SCRIPT" "$name" "$@"
    awk -v m="      - \"$rpath:/repos/$name:ro\"" \
      '{print; if (!done && index($0, "cgw_views:/data/views")) { print m; done=1 }}' \
      docker-compose.yml >docker-compose.yml.tmp
    mv docker-compose.yml.tmp docker-compose.yml
    $COMPOSE up -d                       # recreate with the new mount
    cli index -r "$name"
    ok "$name added and indexed"
    ;;

  remove-repo)
    name="${1:-}"
    [ -n "$name" ] || { usage; exit 1; }
    keep=0; [ "${2:-}" = "--keep-view" ] && keep=1
    registered "$name" || die "repo '$name' is not registered"
    [ "$(grep -c '"name"' workspace.json)" -gt 1 ] || die "refusing to remove the last repo"

    ensure_up
    edit_registry "$DEL_SCRIPT" "$name"
    if [ "$keep" = "0" ]; then
      $COMPOSE exec -T gateway rm -rf "/data/views/$name"
      ok "deleted index data /data/views/$name"
    fi
    grep -Fv ":/repos/$name:ro\"" docker-compose.yml >docker-compose.yml.tmp
    mv docker-compose.yml.tmp docker-compose.yml
    $COMPOSE up -d                       # recreate without the mount
    ok "$name removed"
    ;;

  ''|-h|--help|help) usage ;;
  *) usage; die "unknown command: $cmd" ;;
esac
