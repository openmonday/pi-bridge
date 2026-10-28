#!/bin/sh
# Run pi with this checkout's extension, without changing pi's settings.
# Usage: ./scripts/dev.sh [pi arguments...]
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ ! -d "$ROOT/node_modules" ]; then
  echo "Installing dependencies in $ROOT" >&2
  (cd "$ROOT" && npm install)
fi

exec pi -e "$ROOT/src/index.ts" "$@"
