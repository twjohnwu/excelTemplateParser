#!/usr/bin/env bash
# Start all four services (redis / api / worker / frontend) with one command.
#
# Builds the frontend bundle locally first (npm), then `docker compose up -d`
# stages the static dist into a slim nginx image. This avoids pulling a Node
# base image from Docker Hub (the registry sometimes throttles us with TLS
# handshake timeouts on `node:20-alpine`).

set -euo pipefail
cd "$(dirname "$0")/.."

needs_build=0
if [ ! -d frontend/dist ]; then
  needs_build=1
elif [ -n "$(find frontend/src frontend/index.html -newer frontend/dist 2>/dev/null || true)" ]; then
  needs_build=1
fi

if [ "$needs_build" = "1" ]; then
  echo "→ Building frontend…"
  (
    cd frontend
    if [ ! -d node_modules ]; then
      npm install --no-audit --no-fund
    fi
    npm run build
  )
fi

echo "→ docker compose up -d $*"
docker compose up -d "$@"
docker compose ps

echo
echo "✓ 全部服務 running"
echo "→ 開啟 http://localhost:5173"
