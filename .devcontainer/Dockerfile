FROM mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm

# sqlite3 CLI for inspecting logs (see README)
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends sqlite3 \
    && apt-get clean -y && rm -rf /var/lib/apt/lists/*
