# Visa Appointment Finder

Helps reschedule a US visa appointment at the Chilean consulate to an earlier date.

One long-running process serves a local admin UI, stores every account in SQLite, and launches Playwright checks as child processes. There is no per-account container and no cron job.

## How it works

```
./run.sh
    └── Docker container visa-ui (restart unless-stopped)
            └── node build/server/index.js     UI + scheduler
                    ├── HTTP on port 3000
                    ├── SQLite (db.sqlite)
                    └── spawn node build/index.js   one Playwright check per due profile
```

1. `./run.sh` starts a **detached** container named `visa-ui`. Closing the terminal does not stop it. Docker restarts it after a reboot unless you `./run.sh stop`.
2. The management server listens on http://127.0.0.1:3000 (password-protected).
3. About every 15 seconds the scheduler looks at **enabled** profiles.
4. When a profile is due (the global check interval, default 5 minutes), or you click **Run now**, it starts `node build/index.js` **inside that same container**.
5. That child logs into ais.usvisa-info.com, searches for dates, optionally emails and/or reschedules, writes to the `log` table, then exits.
6. At most **Max concurrent runs** (default 2) children run at once. Extra due profiles wait in a queue. A run that exceeds **Run timeout** is killed.

The child does not read env files. The scheduler decrypts the visa password and Gmail app password, then injects `VISA_*` / `GMAIL_*` / `EMAIL_*` / `HEARTBEAT_*` into that process. The master key is not passed to children.

## Data on disk

| Path | Role |
| --- | --- |
| `db.sqlite` | Profiles, settings, run history, appointment logs |
| `db.sqlite-wal`, `db.sqlite-shm` | SQLite WAL sidecars (same database; needed because the UI and bot share the file). Do not delete them while the UI is running. |
| `secrets/master.key` | 32-byte base64 AES key. **Never commit this.** If it is lost, stored passwords cannot be decrypted. |

SQLite is opened in WAL mode so the server and several Playwright children can write concurrently. Back up all three `db.sqlite*` files together if you copy the database while the UI is running.

Docker bind-mounts the project directory so those WAL files are visible inside the container. Mounting only `db.sqlite` would hide imports and UI writes from each other.

## Secrets

Visa account passwords and the Gmail app password are encrypted with **AES-256-GCM** before they are written to SQLite. Each value is bound to a context string (for example `profile:3:visa_password`), so a ciphertext copied into another row will not decrypt.

The UI never sends stored passwords back to the browser. Leave a password field blank to keep the current one.

The admin login password is **hashed with scrypt**. It cannot be recovered — only replaced (`./run.sh set-password` or the first-run setup screen).

To print settings and decrypted passwords (needs the master key and `npm run build`):

```sh
./run.sh dump
```

## Getting started

### Docker (typical)

```sh
./run.sh
```

The first run creates `secrets/master.key` if it is missing, builds the `visa` image, and starts a detached container (`visa-ui`). Open http://127.0.0.1:3000 and create an admin password. You can close the terminal; the UI and scheduled checks keep running. Later starts rebuild the image only when source files changed (see [When the Docker image is rebuilt](#when-the-docker-image-is-rebuilt)). If the image did not change and the container is already up, `./run.sh` prints the URL and exits.

`./run.sh dump` and `./run.sh set-password` run on the host with Node; they do not use Docker.

The UI is published on localhost only. To reach it from another machine:

```sh
HOST_BIND=0.0.0.0 ./run.sh
```

If you terminate TLS in front of it, set `COOKIE_SECURE=true`.

### Locally (without Docker)

```sh
nvm install   # ignore if you have Node v20+
npm install
npx playwright install --with-deps chromium
npm run build
npm run cli -- generate-key
npm start
```

Then open http://127.0.0.1:3000.

## `run.sh` commands

The container is named `visa-ui`. Detached mode sets Docker’s restart policy to `unless-stopped`, so the container comes back after a reboot until you `./run.sh stop`. That policy is not a `run.sh` flag; use `./run.sh restart` to recreate a running container now.

Commands (`dev`, `restart`, `stop`, `logs`, …) select a mode. Flags (`--rebuild`, `--foreground`) only modify the default Docker start.

| Command | What it does |
| --- | --- |
| `./run.sh` | Start `visa-ui` in the background. Rebuilds the image if source changed. If the container is already running and the image did not change, prints the URL and exits. |
| `./run.sh restart` | Recreate `visa-ui` even if it is already running. Rebuilds the image only if source changed. |
| `./run.sh --rebuild` | Force-rebuild the `visa` image, replace the running container, keep it detached. |
| `./run.sh --foreground` | Run attached to this terminal (`docker run --rm`). Closing the terminal stops the UI and the bots. Stops a detached `visa-ui` first if one is running. |
| `./run.sh --rebuild --foreground` | Force-rebuild, then run attached. Flag order does not matter. |
| `./run.sh dev` | Vite HMR UI at http://127.0.0.1:5173, API on :3456. Open **5173**, not the production UI on :3000. CSS and JS update in the browser without a refresh. Skips login and does not start the scheduler, so it will not double-run bots next to `visa-ui`. TypeScript changes restart the API process only. `npm run dev` is the same. |
| `./run.sh logs` | Follow `visa-ui` logs (`docker logs -f`). Ctrl+C only leaves the log stream; the container keeps running. |
| `./run.sh stop` | Stop and remove `visa-ui`. Scheduled checks stop too. |
| `./run.sh dump` | Print JSON of settings and decrypted profile passwords. Runs on the host with Node (needs `build/server/cli.js`, i.e. `npm run build`). Does not use Docker. |
| `./run.sh set-password` | Prompt for a new admin UI password. Same host Node path as `dump`. |
| `./run.sh generate-key` | Print the path of `secrets/master.key`. Creates the file if it does not exist. |
| `./run.sh --help` | Print the same command list. |

`./run.sh --env` is gone. The old per-account cron workflow is not supported.

Environment variables `run.sh` honors when starting the container:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST_BIND` | `127.0.0.1` | Address published on the host (`0.0.0.0` to expose on the LAN) |
| `PORT` | `3000` | Host port mapped to the container’s 3000 |
| `COOKIE_SECURE` | unset | Set `true` if you terminate TLS in front of the UI |

Examples:

```sh
./run.sh
./run.sh restart
./run.sh dev
./run.sh logs
HOST_BIND=0.0.0.0 PORT=8080 ./run.sh
COOKIE_SECURE=true HOST_BIND=0.0.0.0 ./run.sh
./run.sh stop
```

## When the Docker image is rebuilt

`./run.sh` hashes the files that make up the image and stores that hash as the Docker label `visa.source_hash`. On the next start it hashes the same files again and rebuilds only if the value does not match (or if there is no `visa` image yet).

Included in the hash:

- `Dockerfile`
- `.dockerignore`
- `package.json`, `package-lock.json`
- `tsconfig.json`, `vite.config.mjs`
- everything under `src/` and `public/`

Not included: `README.md`, `db.sqlite`, `secrets/`, and other host-only files. Changing the README does not rebuild.

`--rebuild` ignores the hash and always builds. The first start after this hashing was added will rebuild once, because older images have no `visa.source_hash` label.

## Using the UI

- **New profile** — visa account email/password, process ID, date window, notify and/or reschedule, heartbeat.
- **Enabled** — when on, that profile is checked on the global interval. Leave new profiles off until you have reviewed them.
- **Run now / Stop** — start or cancel a check immediately.
- **Logs** — appointment messages (`log` table) and captured stdout/stderr of each run.
- **Settings** — Gmail sender, admin notification emails, check interval (default 5 minutes), heartbeat interval, max concurrent runs, run timeout.

**Notify** emails the profile’s recipients when a matching date exists. **Admin notification emails** (`email_admin_destination` in Settings, comma separated) get a BCC; profile recipients do not see those addresses. A profile can leave notify emails empty to notify only the admin.

**Reschedule** books the first matching date without asking.

**Heartbeat** emails the admin notification addresses on a successful run, at most once per heartbeat interval (default 1440 minutes).

To send mail you need a Gmail **App Password**:

- https://myaccount.google.com/signinoptions/two-step-verification
- Enable 2FA, then App Passwords → “other” device
- Put the user and app password in **Settings**

## Date range

- **Earliest date**: appointments on or after this date.
- **Latest date**: appointments on or before this date. If omitted, only dates **strictly before** the account’s current appointment are considered.

Both bounds are inclusive.

## What is stored in SQLite

**profile** — one row per visa account: name, email, encrypted password, process ID, notify addresses, min/max dates, actions (`notify`, `reschedule`), heartbeat flag, enabled flag.

**setting** — Gmail user, encrypted Gmail app password, admin notification emails, check interval, heartbeat interval, concurrency, run timeout, admin password hash, key-check ciphertext.

**run** — each scheduler/manual execution (status, output, timestamps). Old rows are pruned after 14 days.

**log** — messages from a check (`Process started`, `No appointment available`, …), keyed by visa process ID.

Inspect logs from the UI, or:

```sh
sqlite3 db.sqlite "SELECT * FROM log ORDER BY id DESC LIMIT 10;"
```

`HOST_BIND` / `PORT` / `COOKIE_SECURE` for `./run.sh` are listed under [`run.sh` commands](#runsh-commands). The Node process inside the container also understands:

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `VISA_MASTER_KEY_FILE` | `secrets/master.key` | 32-byte base64 master key |
| `DB_PATH` | `./db.sqlite` | SQLite database |
| `PUBLIC_DIR` | `build/ui` | Vite production build of the admin UI. `./run.sh dev` still points this at `public/` for the API process; the browser should use Vite on :5173 |
| `VISA_DEV` | unset | Set `1` for `./run.sh dev`: skip login, do not start the scheduler. Refused unless `HOST` is localhost |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Address the Node server binds |
| `PORT` | `3000` | Listen port inside the process (Docker / `npm start`) |
| `API_PORT` | `3456` | `./run.sh dev` API port that Vite proxies to |
| `VITE_DEV_PORT` | `5173` | `./run.sh dev` Vite UI port (open this in the browser) |
| `HOST_BIND` | `127.0.0.1` | Address Docker publishes on the host |
| `COOKIE_SECURE` | unset | Set `true` behind HTTPS |

## Local npm scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `build/` and bundle the UI into `build/ui` |
| `npm start` | Run the management server (needs key + DB) |
| `npm run dev` | Same as `./run.sh dev` |
| `npm run cli -- dump` | Same as `./run.sh dump` |
| `npm run cli -- set-password` | Same as `./run.sh set-password` |
| `npm run cli -- generate-key` | Create `secrets/master.key` if it does not exist |
