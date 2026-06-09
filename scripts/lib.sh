#!/usr/bin/env bash
# Shared helpers for the deploy scripts: colored output, validated interactive
# prompts (adduser-style), and port checks. Sourced, not executed.
# shellcheck disable=SC2034,SC2088,SC1007  # palette used by callers; intentional ~ and CDPATH= idioms

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=; DIM=; RED=; GRN=; YLW=; CYN=; RST=
fi

info() { printf '%s\n' "$*"; }
hr()   { printf '%s\n' "${DIM}────────────────────────────────────────────────────────${RST}"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$RST" "$*" >&2; }
err()  { printf '%s✗%s %s\n' "$RED" "$RST" "$*" >&2; }
die()  { err "$*"; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Required command not found on PATH: $1"; }

# ask VAR "prompt" "default"
ask() {
  local __var="$1" __prompt="$2" __def="${3:-}" __ans
  if [ -n "$__def" ]; then printf '%s%s%s [%s]: ' "$CYN" "$__prompt" "$RST" "$__def"
  else printf '%s%s%s: ' "$CYN" "$__prompt" "$RST"; fi
  IFS= read -r __ans || true
  [ -z "$__ans" ] && __ans="$__def"
  printf -v "$__var" '%s' "$__ans"
}

# ask_required VAR "prompt"
ask_required() {
  local __var="$1" __prompt="$2"
  while true; do
    ask "$__var" "$__prompt" ""
    [ -n "${!__var}" ] && break
    warn "This value is required."
  done
}

# confirm "prompt"          -> default no
confirm() {
  local __ans; printf '%s%s%s [y/N]: ' "$CYN" "$1" "$RST"
  IFS= read -r __ans || true
  case "$__ans" in [yY]|[yY][eE][sS]) return 0;; *) return 1;; esac
}

# confirm_yes "prompt"      -> default yes
confirm_yes() {
  local __ans; printf '%s%s%s [Y/n]: ' "$CYN" "$1" "$RST"
  IFS= read -r __ans || true
  case "$__ans" in [nN]|[nN][oO]) return 1;; *) return 0;; esac
}

# expand a leading ~ to $HOME
expand_path() { case "$1" in "~"|"~/"*) printf '%s' "${HOME}${1#\~}";; *) printf '%s' "$1";; esac; }

# port_in_use PORT [host]   -> 0 (true) if a listener is on PORT
port_in_use() {
  local port="$1" host="${2:-127.0.0.1}"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP@"$host":"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  # fallback: attempt a connection
  (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1 && { exec 3>&- 3<&- 2>/dev/null; return 0; }
  return 1
}

# valid_port PORT -> 0 if a number in 1..65535
valid_port() { case "$1" in ''|*[!0-9]*) return 1;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# pick_free_port VAR "prompt" DEFAULT [host]
# Re-prompts until a valid, free port is chosen; suggests the next port on conflict.
pick_free_port() {
  local __var="$1" __prompt="$2" __def="$3" __host="${4:-127.0.0.1}" __p
  while true; do
    ask __p "$__prompt" "$__def"
    if ! valid_port "$__p"; then warn "Port must be a number in 1..65535."; continue; fi
    if port_in_use "$__p" "$__host"; then
      warn "Port $__p is already in use on $__host."
      __def=$((__p + 1)); valid_port "$__def" || __def=18765
      continue
    fi
    printf -v "$__var" '%s' "$__p"; break
  done
}

# csv_to_json_array "a, b ,c" -> ["a","b","c"]
csv_to_json_array() {
  local csv="$1" out="" item IFS=','
  for item in $csv; do
    item="$(printf '%s' "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -z "$item" ] && continue
    out="$out\"$item\","
  done
  printf '[%s]' "${out%,}"
}

# safe slug check (repo/container names)
valid_slug() { case "$1" in ''|*[!A-Za-z0-9._-]*) return 1;; *) return 0;; esac; }

gen_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24
  else head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# resolve the project root (dir containing this scripts/ folder)
project_root() { CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P; }

# choose `docker compose` vs legacy `docker-compose`
compose_cmd() {
  if docker compose version >/dev/null 2>&1; then echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"
  else die "docker compose (v2) or docker-compose is required."; fi
}
