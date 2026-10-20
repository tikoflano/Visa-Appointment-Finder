#!/usr/bin/env bash
set -euo pipefail

BASE_DIR=$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)
SECRETS_DIR="$BASE_DIR/secrets"
KEY_FILE="$SECRETS_DIR/master.key"
DB_FILE="$BASE_DIR/db.sqlite"
IMAGE=visa
CONTAINER_NAME=visa-ui
CONTAINER_HOST=/host
PORT="${PORT:-3000}"
HOST_BIND="${HOST_BIND:-127.0.0.1}"
HASH_LABEL=visa.source_hash
IMAGE_REBUILT=0

usage() {
  cat <<'EOF'
Usage: ./run.sh [options]
       ./run.sh <command>

Start (default):
  ./run.sh                 Start visa-ui detached (rebuild if source changed)
  --rebuild                Force-rebuild the image
  --foreground             Run attached to this terminal
  --restart                Recreate the container even if it is already running

Commands:
  restart                  Same as --restart
  stop                     Stop and remove visa-ui
  logs                     Follow container logs
  dump                     Print decrypted settings and profiles (host Node)
  set-password             Set the admin UI password (host Node)
  generate-key             Show/create secrets/master.key
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

source_hash() {
  (
    cd "$BASE_DIR"
    {
      printf 'v1\n'
      for f in Dockerfile .dockerignore package.json package-lock.json tsconfig.json; do
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

print_status() {
  echo "Management UI: http://127.0.0.1:$PORT"
  echo "Container $CONTAINER_NAME keeps running after this terminal closes."
  echo "Logs:  ./run.sh logs"
  echo "Stop:  ./run.sh stop"
}

# Bind the project directory so SQLite WAL/SHM files sit next to db.sqlite
# on the host. Mounting only the .sqlite file hides writes from the UI.
docker_base=(
  -v "$BASE_DIR:$CONTAINER_HOST"
  -e "VISA_MASTER_KEY_FILE=$CONTAINER_HOST/secrets/master.key"
  -e "DB_PATH=$CONTAINER_HOST/db.sqlite"
  -e "TZ=$(cat /etc/timezone 2>/dev/null || echo UTC)"
  -e HOST=0.0.0.0
  -e PORT=3000
  -e "COOKIE_SECURE=${COOKIE_SECURE:-}"
  --shm-size=1g
  -p "$HOST_BIND:$PORT:3000"
)

ensure_key
touch "$DB_FILE"

if [ "${1:-}" = "generate-key" ]; then
  echo "Master key is at $KEY_FILE"
  exit 0
fi

if [ "${1:-}" = "set-password" ] || [ "${1:-}" = "dump" ]; then
  if [ ! -f "$BASE_DIR/build/server/cli.js" ]; then
    echo "build/server/cli.js is missing. Run: npm run build"
    exit 1
  fi
  export VISA_MASTER_KEY_FILE="$KEY_FILE"
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
  exit 0
fi

if [ "${1:-}" = "logs" ]; then
  exec docker logs -f "$CONTAINER_NAME"
fi

foreground=0
rebuild_flag=""
do_restart=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) rebuild_flag=--rebuild; shift ;;
    --foreground) foreground=1; shift ;;
    --restart | restart) do_restart=1; shift ;;
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
