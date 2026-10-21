#!/usr/bin/env bash
# Runs inside the visa image. API stays on container loopback; Vite is published
# to the host. OpenWA is reached as http://openwa:2785 on the visa network.
set -euo pipefail

APP="${APP_DIR:-/usr/local/visa-appointment}"
ROOT="${PROJECT_DIR:-/host}"
api_port="${PORT:-3456}"
vite_port="${VITE_DEV_PORT:-5173}"
export PATH="$APP/node_modules/.bin:$PATH"
export VITE_API_PORT="$api_port"
export VITE_DEV_PORT="$vite_port"
export VITE_LISTEN_HOST="${VITE_LISTEN_HOST:-0.0.0.0}"
export VITE_HMR_HOST="${VITE_HMR_HOST:-127.0.0.1}"
cd "$ROOT"

tsc
echo "Dev UI (HMR): http://127.0.0.1:$vite_port"
echo "API:          127.0.0.1:$api_port inside this container (proxied by Vite)"
echo "OpenWA:       http://openwa:2785 on the visa network"
echo "Login skipped. Scheduled checks and automatic heartbeats off. Run now still notifies."

tsc --watch --preserveWatchOutput --pretty false &
tsc_pid=$!
node --watch --require "$APP/scripts/polyfill-crypto.cjs" "$ROOT/build/server/index.js" &
node_pid=$!
trap 'kill "$tsc_pid" "$node_pid" 2>/dev/null || true' EXIT INT TERM

for i in $(seq 1 80); do
  if node -e "require('http').get('http://127.0.0.1:${api_port}/api/session',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 80 ]; then
    echo "API did not start on port $api_port"
    exit 1
  fi
  sleep 0.1
done

env -u PORT node --require "$APP/scripts/polyfill-crypto.cjs" \
  "$APP/node_modules/vite/bin/vite.js" \
  --config "$ROOT/vite.config.mjs" \
  --port "$vite_port" --host "$VITE_LISTEN_HOST" --clearScreen false
