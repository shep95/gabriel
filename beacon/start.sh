#!/bin/sh
# starts the beacon from a downloaded copy. double-click on linux, or: sh start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed. get it from https://nodejs.org (the LTS button), then run this again."
  read -r _; exit 1
fi
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund
exec node server.mjs "$@"
