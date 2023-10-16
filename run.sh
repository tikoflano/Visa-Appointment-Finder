#!/usr/bin/env bash

BASE_DIR=$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)

if [[ "$(docker images -q visa 2> /dev/null)" == "" ]]; then
 docker build -t visa "$BASE_DIR"
fi

touch "$BASE_DIR/db.sqlite"
exec docker run --rm --env-file "$BASE_DIR/.env" -v "$BASE_DIR/db.sqlite:/usr/local/visa-appointment/db.sqlite" -e TZ=$(cat /etc/timezone) visa $@