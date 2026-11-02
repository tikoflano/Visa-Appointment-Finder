FROM node:23-bookworm

WORKDIR /usr/local/visa-appointment

# Reap orphaned Chromium processes when bots exit uncleanly. Node alone as
# PID 1 does not wait() children, so zombies accumulate until launch fails.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

# package.json / lockfile change far less often than app source. Keep npm and
# Playwright Chromium in their own layers so src/public edits reuse this cache.
COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY tsconfig.json vite.config.mjs ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build

EXPOSE 3000
ENV HOST=0.0.0.0
ENV PORT=3000
ENTRYPOINT ["tini", "--", "node", "build/server/index.js"]
