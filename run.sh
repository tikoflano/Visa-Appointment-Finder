#!/usr/bin/env bash


BASE_DIR=$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)
ENV_FILE_NAME=".env"

if [ "$1" == "--env" ];then
    shift
    ENV_FILE_NAME=$1
    shift
fi

ENV_FILE="$BASE_DIR/$ENV_FILE_NAME"

if [ ! -f "$ENV_FILE" ];then
    echo "Env file not found: $ENV_FILE"
    exit 1
fi

if [[ "$(docker images -q visa 2> /dev/null)" == "" ]]; then
 docker build -t visa "$BASE_DIR"
fi

touch "$BASE_DIR/db.sqlite"
exec docker run --rm --env-file "$ENV_FILE" -v "$BASE_DIR/db.sqlite:/usr/local/visa-appointment/db.sqlite" -e TZ=$(cat /etc/timezone) visa $@