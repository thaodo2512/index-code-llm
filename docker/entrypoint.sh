#!/bin/sh
# Container entrypoint. Optionally build views + index before serving (handy for
# small local workspaces); for large trees, index out-of-band instead and leave
# CGW_INDEX_ON_START unset.
set -e

if [ "$1" = "serve" ] && [ "${CGW_INDEX_ON_START:-0}" = "1" ]; then
  echo "codegraph-workspace: building views and indexing before serve..."
  node /app/dist/cli.js build-views || echo "build-views failed (continuing)"
  node /app/dist/cli.js index || echo "index failed (continuing)"
fi

exec node /app/dist/cli.js "$@"
