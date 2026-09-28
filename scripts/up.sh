#!/usr/bin/env bash
# Start all four services (redis / api / worker / frontend) with one command.
#
# Default mode: Docker-only, no Node/npm required on the host. Compose builds
# the frontend image itself (multi-stage: Node build stage → nginx runtime,
# see frontend/Dockerfile) on first run — this makes the first `up.sh` slower
# than subsequent ones.
#
# Known failure mode: pulling the node:24.20.0-alpine base image can hit TLS
# handshake timeouts against Docker Hub. If the build fails for that reason,
# re-run with --host-build (builds the frontend bundle on the host instead,
# needs Node).
#
# --dev:         restore the old bind-mounted fast path (host `npm run
#                build` picked up on refresh, no image rebuild); needs Node.
# --host-build:  build the frontend bundle on the host, build a Node-free
#                nginx-only frontend image, then `docker cp` the host-built
#                bundle into the running container; needs Node. Escape hatch
#                for the pull failure above — never touches the Node image.
#
# Any other arguments are passed through to `docker compose up`.

set -euo pipefail
cd "$(dirname "$0")/.."

mode=default
extra_args=()
for arg in "$@"; do
  case "$arg" in
    --dev) mode=dev ;;
    --host-build) mode=host-build ;;
    *) extra_args+=("$arg") ;;
  esac
done

require_node() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "✗ $1 requires Node/npm on the host, but npm was not found." >&2
    echo "  The default mode (no flag) does not need Node — run: bash scripts/up.sh" >&2
    exit 1
  fi
}

build_frontend_bundle_on_host() {
  echo "→ Building frontend bundle on host…"
  (
    cd frontend
    if [ ! -d node_modules ]; then
      npm install --no-audit --no-fund
    fi
    npm run build
  )
}

compose_files=(-f docker-compose.yml)
case "$mode" in
  dev)
    require_node "--dev"
    build_frontend_bundle_on_host
    compose_files+=(-f docker-compose.dev.yml)
    ;;
  host-build)
    require_node "--host-build"
    build_frontend_bundle_on_host
    echo "→ Building a Node-free frontend image (nginx only, no dist baked in)…"
    # Build via a throwaway override that only changes the build target, so
    # Compose computes and tags the image under its own naming scheme (the
    # same tag `up -d` below will look for) instead of us having to guess it.
    # frontend/.dockerignore excludes dist/ from the build context on
    # purpose, so this target never bakes in a stale bundle — the host-built
    # one is `docker cp`'d into the running container below instead.
    host_build_overlay=$(mktemp -t excelTemplateParser-hostbuild.XXXXXX.yml)
    trap 'rm -f "$host_build_overlay"' EXIT
    cat > "$host_build_overlay" <<'EOF'
services:
  frontend:
    build:
      target: runtime-dev
EOF
    docker compose "${compose_files[@]}" -f "$host_build_overlay" build frontend
    rm -f "$host_build_overlay"
    trap - EXIT
    ;;
esac

echo "→ docker compose ${compose_files[*]} up -d ${extra_args[*]:-}"
if ! docker compose "${compose_files[@]}" up -d "${extra_args[@]}"; then
  echo >&2
  echo "✗ docker compose up failed." >&2
  if [ "$mode" = default ]; then
    echo "  If this is a node:24.20.0-alpine pull failure (TLS handshake timeout" >&2
    echo "  against Docker Hub is a known issue here), retry with:" >&2
    echo "    bash scripts/up.sh --host-build" >&2
  fi
  exit 1
fi

if [ "$mode" = host-build ]; then
  echo "→ Copying host-built dist/ into the running frontend container…"
  frontend_cid=$(docker compose "${compose_files[@]}" ps -q frontend)
  docker cp frontend/dist/. "$frontend_cid":/usr/share/nginx/html/
fi

echo "→ Waiting for services to become healthy…"
timeout_s=120
elapsed=0
interval=3
services=$(docker compose "${compose_files[@]}" ps --services)
while true; do
  unhealthy=()
  for svc in $services; do
    cid=$(docker compose "${compose_files[@]}" ps -q "$svc")
    if [ -z "$cid" ]; then
      unhealthy+=("$svc (not running)")
      continue
    fi
    run_status=$(docker inspect --format '{{.State.Status}}' "$cid")
    health_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$cid")
    if [ "$run_status" != "running" ]; then
      unhealthy+=("$svc ($run_status)")
    elif [ "$health_status" = "unhealthy" ]; then
      unhealthy+=("$svc (unhealthy)")
    elif [ "$health_status" = "starting" ]; then
      unhealthy+=("$svc (starting)")
    fi
  done
  if [ "${#unhealthy[@]}" -eq 0 ]; then
    break
  fi
  if [ "$elapsed" -ge "$timeout_s" ]; then
    echo "✗ Timed out after ${timeout_s}s waiting for: ${unhealthy[*]}" >&2
    echo "  See logs with: docker compose ${compose_files[*]} logs <service>" >&2
    exit 1
  fi
  sleep "$interval"
  elapsed=$((elapsed + interval))
done

docker compose "${compose_files[@]}" ps

echo
echo "✓ 全部服務 healthy"
echo "→ 開啟 http://localhost:5173"
