#!/usr/bin/env bash
set -euo pipefail

BASE_DIR=$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)
SECRETS_DIR="$BASE_DIR/secrets"
KEY_FILE="$SECRETS_DIR/master.key"
OPENWA_KEY_FILE="$SECRETS_DIR/openwa.api-key"
DB_FILE="$BASE_DIR/db.sqlite"
IMAGE=visa
CONTAINER_NAME=visa-ui
DEV_CONTAINER=visa-dev
OPENWA_CONTAINER=openwa
OPENWA_COMPOSE="$BASE_DIR/compose.openwa.yml"
NETWORK=visa
CONTAINER_HOST=/host
PORT="${PORT:-3000}"
HOST_BIND="${HOST_BIND:-127.0.0.1}"
HASH_LABEL=visa.source_hash
IMAGE_REBUILT=0
OPENWA="${OPENWA:-1}"

usage() {
  cat <<'EOF'
Usage: ./run.sh [options]
       ./run.sh <command>

Start (default):
  ./run.sh                 Start visa-ui detached (rebuild if source changed)
  ./run.sh run             Same as ./run.sh
  --rebuild                Force-rebuild the image
  --foreground             Run attached to this terminal

Commands:
  run                      Same as the default start
  dev                      Vite HMR UI in Docker on the visa network (http://openwa:2785)
  restart                  Recreate visa-ui even if it is already running
  stop                     Stop and remove visa-ui (OpenWA is left running)
  stop-openwa              Stop the OpenWA sidecar
  logs                     Follow visa-ui logs
  logs-openwa              Follow OpenWA logs
  dump                     Print decrypted settings and profiles (host Node)
  set-password             Set the admin UI password (host Node)
  generate-key             Show/create secrets/master.key and secrets/openwa.api-key
  -h, --help               Show this help

./run.sh --env is gone. The old per-account cron workflow is not supported.
EOF
}

if [ "${1:-}" = "--env" ]; then
  echo "./run.sh --env is gone. Start the UI with ./run.sh"
  exit 1
fi

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

ensure_key() {
  mkdir -p "$SECRETS_DIR"
  if [ ! -f "$KEY_FILE" ]; then
    openssl rand -base64 32 > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "Generated master key at $KEY_FILE"
    echo "Back this file up. If it is lost, stored passwords cannot be decrypted."
  fi
  chmod 600 "$KEY_FILE"
}

ensure_openwa_key() {
  mkdir -p "$SECRETS_DIR"
  if [ ! -f "$OPENWA_KEY_FILE" ]; then
    openssl rand -base64 32 > "$OPENWA_KEY_FILE"
    chmod 600 "$OPENWA_KEY_FILE"
    echo "Generated OpenWA API key at $OPENWA_KEY_FILE"
  fi
  chmod 600 "$OPENWA_KEY_FILE"
  API_MASTER_KEY=$(tr -d '[:space:]' < "$OPENWA_KEY_FILE")
  if [ "${#API_MASTER_KEY}" -lt 32 ]; then
    echo "OpenWA API key in $OPENWA_KEY_FILE must be at least 32 characters"
    exit 1
  fi
  export API_MASTER_KEY
}

source_hash() {
  (
    cd "$BASE_DIR"
    {
      printf 'v2\n'
      for f in Dockerfile .dockerignore package.json package-lock.json tsconfig.json vite.config.mjs; do
        if [ -f "$f" ]; then
          sha256sum "$f"
        fi
      done
      find src public -type f -print0 | sort -z | xargs -0 sha256sum
    } | sha256sum | awk '{print $1}'
  )
}

build_image() {
  local hash="$1"
  docker build --label "$HASH_LABEL=$hash" -t "$IMAGE" "$BASE_DIR"
}

ensure_image() {
  local force="${1:-}"
  local hash
  hash=$(source_hash)
  local exists
  exists=$(docker images -q "$IMAGE" 2> /dev/null || true)
  local image_hash=""
  if [ -n "$exists" ]; then
    image_hash=$(docker inspect -f "{{index .Config.Labels \"$HASH_LABEL\"}}" "$IMAGE" 2>/dev/null || true)
  fi
  if [ "$force" = "--rebuild" ] || [ -z "$exists" ] || [ "$image_hash" != "$hash" ]; then
    if [ -n "$exists" ] && [ "$image_hash" != "$hash" ]; then
      echo "Source changed; rebuilding $IMAGE image"
    fi
    build_image "$hash"
    IMAGE_REBUILT=1
  fi
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" = "true" ]
}

openwa_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$OPENWA_CONTAINER" 2>/dev/null || echo false)" = "true" ]
}

compose() {
  ensure_openwa_key
  docker compose -f "$OPENWA_COMPOSE" "$@"
}

ensure_openwa() {
  if [ "$OPENWA" != "1" ]; then
    return
  fi
  ensure_openwa_key
  compose up -d
}

print_status() {
  echo "Management UI: http://127.0.0.1:$PORT"
  echo "Container $CONTAINER_NAME keeps running after this terminal closes."
  echo "Logs:  ./run.sh logs"
  echo "Stop:  ./run.sh stop"
  if [ "$OPENWA" = "1" ]; then
    echo "OpenWA hostname: openwa (not published on the host)"
    echo "From visa-ui / visa-dev use Settings URL http://openwa:2785"
    echo "OpenWA API key: $OPENWA_KEY_FILE (shared with visa-ui)"
    echo "OpenWA logs: ./run.sh logs-openwa"
    echo "Stop OpenWA: ./run.sh stop-openwa"
  fi
}

# Bind the project directory so SQLite WAL/SHM files sit next to db.sqlite
# on the host. Mounting only the .sqlite file hides writes from the UI.
docker_base=(
  -v "$BASE_DIR:$CONTAINER_HOST"
  -e "VISA_MASTER_KEY_FILE=$CONTAINER_HOST/secrets/master.key"
  -e "OPENWA_API_KEY_FILE=$CONTAINER_HOST/secrets/openwa.api-key"
  -e "OPENWA_BASE_URL=http://openwa:2785"
  -e "DB_PATH=$CONTAINER_HOST/db.sqlite"
  -e "TZ=$(cat /etc/timezone 2>/dev/null || echo UTC)"
  -e HOST=0.0.0.0
  -e PORT=3000
  -e "COOKIE_SECURE=${COOKIE_SECURE:-}"
  --shm-size=1g
  -p "$HOST_BIND:$PORT:3000"
)
if [ "$OPENWA" = "1" ]; then
  docker_base+=(--network "$NETWORK")
fi

ensure_key
ensure_openwa_key
touch "$DB_FILE"

if [ "${1:-}" = "generate-key" ]; then
  echo "Master key is at $KEY_FILE"
  echo "OpenWA API key is at $OPENWA_KEY_FILE"
  exit 0
fi

if [ "${1:-}" = "set-password" ] || [ "${1:-}" = "dump" ]; then
  if [ ! -f "$BASE_DIR/build/server/cli.js" ]; then
    echo "build/server/cli.js is missing. Run: npm run build"
    exit 1
  fi
  export VISA_MASTER_KEY_FILE="$KEY_FILE"
  export OPENWA_API_KEY_FILE="$OPENWA_KEY_FILE"
  export DB_PATH="$DB_FILE"
  cd "$BASE_DIR"
  exec node build/server/cli.js "$1"
fi

if [ "${1:-}" = "stop" ]; then
  if container_running; then
    docker stop "$CONTAINER_NAME" >/dev/null
    echo "Stopped $CONTAINER_NAME"
  else
    echo "$CONTAINER_NAME is not running"
  fi
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if openwa_running; then
    echo "OpenWA is still running (WhatsApp session). Stop it with: ./run.sh stop-openwa"
  fi
  exit 0
fi

if [ "${1:-}" = "stop-openwa" ]; then
  if openwa_running || docker inspect "$OPENWA_CONTAINER" >/dev/null 2>&1; then
    compose stop
    echo "Stopped $OPENWA_CONTAINER"
  else
    echo "$OPENWA_CONTAINER is not running"
  fi
  exit 0
fi

if [ "${1:-}" = "logs" ]; then
  exec docker logs -f "$CONTAINER_NAME"
fi

if [ "${1:-}" = "logs-openwa" ]; then
  exec docker logs -f "$OPENWA_CONTAINER"
fi

if [ "${1:-}" = "dev" ]; then
  api_port="${API_PORT:-3456}"
  vite_port="${VITE_DEV_PORT:-5173}"
  if [ -z "$(docker images -q "$IMAGE" 2>/dev/null || true)" ]; then
    echo "Building $IMAGE image for dockerized dev"
    build_image "$(source_hash)"
  fi
  ensure_openwa
  if [ "$(docker inspect -f '{{.State.Running}}' "$DEV_CONTAINER" 2>/dev/null || echo false)" = "true" ]; then
    docker rm -f "$DEV_CONTAINER" >/dev/null
  fi
  echo "Dev UI (HMR): http://127.0.0.1:$vite_port"
  echo "Open that URL — not :$api_port or :3000. Production visa-ui on :3000 is left running."
  if [ "$OPENWA" = "1" ]; then
    echo "OpenWA is http://openwa:2785 inside the visa network (not published on the host)."
  fi
  dev_args=(
    --rm --name "$DEV_CONTAINER" --entrypoint bash
    -v "$BASE_DIR:$CONTAINER_HOST"
    -e "VISA_MASTER_KEY_FILE=$CONTAINER_HOST/secrets/master.key"
    -e "OPENWA_API_KEY_FILE=$CONTAINER_HOST/secrets/openwa.api-key"
    -e "DB_PATH=$CONTAINER_HOST/db.sqlite"
    -e "TZ=$(cat /etc/timezone 2>/dev/null || echo UTC)"
    -e HOST=127.0.0.1
    -e "PORT=$api_port"
    -e VISA_DEV=1
    -e "PUBLIC_DIR=$CONTAINER_HOST/public"
    -e "VITE_API_PORT=$api_port"
    -e "VITE_DEV_PORT=$vite_port"
    -e VITE_LISTEN_HOST=0.0.0.0
    -e VITE_HMR_HOST=127.0.0.1
    --shm-size=1g
    -p "$HOST_BIND:$vite_port:$vite_port"
  )
  if [ "$OPENWA" = "1" ]; then
    dev_args+=(--network "$NETWORK" -e OPENWA_BASE_URL=http://openwa:2785)
  fi
  exec docker run "${dev_args[@]}" "$IMAGE" "$CONTAINER_HOST/scripts/dev.sh"
fi

foreground=0
rebuild_flag=""
do_restart=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) rebuild_flag=--rebuild; shift ;;
    --foreground) foreground=1; shift ;;
    --restart | restart) do_restart=1; shift ;;
    run) shift ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

ensure_image "$rebuild_flag"
ensure_openwa

if [ "$foreground" = 1 ]; then
  if container_running; then
    echo "Stopping detached $CONTAINER_NAME to run in the foreground"
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
  print_status
  exec docker run --rm --name "$CONTAINER_NAME" "${docker_base[@]}" "$IMAGE"
fi

if container_running && [ "$IMAGE_REBUILT" = 0 ] && [ "$do_restart" = 0 ]; then
  echo "$CONTAINER_NAME is already running"
  print_status
  exit 0
fi

if container_running; then
  if [ "$IMAGE_REBUILT" = 1 ]; then
    echo "Replacing $CONTAINER_NAME with the new image"
  else
    echo "Restarting $CONTAINER_NAME"
  fi
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
  "${docker_base[@]}" "$IMAGE" >/dev/null
print_status
