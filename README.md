# Visa Appointment Finder

Helps reschedule a US visa appointment at the Chilean consulate to an earlier date.

One long-running process serves a local admin UI, stores every account in SQLite, and launches Playwright checks as child processes. There is no per-account container and no cron job. WhatsApp is a separate OpenWA sidecar on the same Docker network — not inlined in Playwright, and not Meta Cloud API.

## How it works

```
./run.sh
    └── Docker network visa   (user-defined; not internal — OpenWA must reach WhatsApp)
            ├── openwa          compose.openwa.yml, hostname openwa
            │     ├── HTTP API on :2785 (not published on the host)
            │     ├── whatsapp-web.js (headless Chromium)
            │     ├── volume openwa-data  (linked WhatsApp session)
            │     └── API_MASTER_KEY from secrets/openwa.api-key
            └── visa-ui         restart unless-stopped
                  env OPENWA_BASE_URL=http://openwa:2785
                  env OPENWA_API_KEY_FILE=/host/secrets/openwa.api-key
                  └── node build/server/index.js     UI + scheduler + notifier
                          ├── HTTP on port 3000
                          ├── SQLite (db.sqlite)
                          ├── spawn node build/index.js   one Playwright check per due profile
                          └── Notifier → Gmail and/or OpenWA send-text
```

`./run.sh dev` uses the same `visa` network and OpenWA hostname. The UI is `visa-dev` (Vite on :5173, API on loopback inside that container). Port 2785 stays unpublished so the host never talks to OpenWA.

1. `./run.sh` starts a **detached** container named `visa-ui`. Closing the terminal does not stop it. Docker restarts it after a reboot unless you `./run.sh stop`.
2. The management server listens on http://127.0.0.1:3000 (password-protected).
3. About every 15 seconds the scheduler looks at **enabled** profiles.
4. When a profile is due (the global check interval, default 5 minutes), or you click **Run now**, it starts `node build/index.js` **inside that same container**.
5. That child logs into ais.usvisa-info.com, reads the booked date, searches for matching dates, optionally reschedules if the profile has that action, prints one `VISA_RESULT` JSON line on stdout, then exits. It does not send mail. Step-by-step debug messages are off unless Settings **Capture bot debug output** (or `--debug`) is on. The scheduler parses the JSON, stores it, and asks the notifier to send mail.
6. At most **Max concurrent runs** (default 2) children run at once. Extra due profiles wait in a FIFO queue, **one slot per profile** (already running or queued profiles are not enqueued again). A run that exceeds **Run timeout** is killed. The notifier sends appointment emails, heartbeats, and failure alarms from the server process — never from the Playwright child. Every send (and failed send) is stored in the notification log.

A profile is due from the **start** of its last run, not the finish. A check that lasts longer than the interval will not pile up extra queue entries, but the next run starts as soon as it is idle and the interval since that start has elapsed.

If a profile stays **running** or **queued** longer than **Check every**, the UI shows a queue-health warning and turns that profile’s running/queued badge orange.

The child does not read env files. The scheduler decrypts the visa password and injects `VISA_*` into that process. Gmail credentials stay in the server; the master key is not passed to children.

**AIS** is the US visa site the bot logs into: [ais.usvisa-info.com](https://ais.usvisa-info.com) (Chile NIV).

## Data on disk

| Path | Role |
| --- | --- |
| `db.sqlite` | Profiles, settings, run history, appointment logs |
| `db.sqlite-wal`, `db.sqlite-shm` | SQLite WAL sidecars (same database; needed because the UI and bot share the file). Do not delete them while the UI is running. |
| `secrets/master.key` | 32-byte base64 AES key. **Never commit this.** If it is lost, stored passwords cannot be decrypted. |
| `secrets/openwa.api-key` | Shared OpenWA admin key (≥32 characters). `./run.sh` writes it and passes the same value into OpenWA as `API_MASTER_KEY` and into visa-ui / visa-dev as `OPENWA_API_KEY_FILE`. **Never commit this.** |
| Docker volume `openwa-data` | OpenWA’s session store. Survives `./run.sh stop` and `./run.sh stop-openwa`. Wiping the volume unlinks WhatsApp; click **Link WhatsApp** again. |

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

The first run creates `secrets/master.key` if it is missing, builds the `visa` image, starts a detached container (`visa-ui`), and starts the OpenWA sidecar on the `visa` Docker network (see WhatsApp below). Open http://127.0.0.1:3000 and create an admin password. You can close the terminal; the UI and scheduled checks keep running. Later starts rebuild the image only when source files changed (see [When the Docker image is rebuilt](#when-the-docker-image-is-rebuilt)). If the image did not change and the container is already up, `./run.sh` prints the URL and exits.

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
| `./run.sh` or `./run.sh run` | Start `visa-ui` in the background. Rebuilds the image if source changed. If the container is already running and the image did not change, prints the URL and exits. |
| `./run.sh restart` | Recreate `visa-ui` even if it is already running. Rebuilds the image only if source changed. |
| `./run.sh --rebuild` | Force-rebuild the `visa` image, replace the running container, keep it detached. |
| `./run.sh --foreground` | Run attached to this terminal (`docker run --rm`). Closing the terminal stops the UI and the bots. Stops a detached `visa-ui` first if one is running. |
| `./run.sh --rebuild --foreground` | Force-rebuild, then run attached. Flag order does not matter. |
| `./run.sh dev` | Vite HMR UI at http://127.0.0.1:5173 in a `visa-dev` container on the `visa` network. Open **5173**, not the production UI on :3000. The API stays on loopback inside that container (Vite proxies `/api`). OpenWA is `http://openwa:2785` and is not published on the host. Skips login and does not start the scheduler or notifier. TypeScript changes restart the API process only. `npm run dev` is the same. |
| `./run.sh logs` | Follow `visa-ui` logs (`docker logs -f`). Ctrl+C only leaves the log stream; the container keeps running. |
| `./run.sh logs-openwa` | Follow the OpenWA sidecar logs. |
| `./run.sh stop` | Stop and remove `visa-ui`. Scheduled checks stop too. Leaves OpenWA running so the WhatsApp session stays linked. |
| `./run.sh stop-openwa` | Stop the OpenWA sidecar (session data stays on the `openwa-data` volume). |
| `./run.sh dump` | Print JSON of settings and decrypted profile passwords. Runs on the host with Node (needs `build/server/cli.js`, i.e. `npm run build`). Does not use Docker. |
| `./run.sh set-password` | Prompt for a new admin UI password. Same host Node path as `dump`. |
| `./run.sh generate-key` | Show or create `secrets/master.key` and `secrets/openwa.api-key`. |
| `./run.sh --help` | Print the same command list. |

`./run.sh --env` is gone. The old per-account cron workflow is not supported.

Environment variables `run.sh` honors when starting the container:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST_BIND` | `127.0.0.1` | Address published on the host (`0.0.0.0` to expose on the LAN) |
| `PORT` | `3000` | Host port mapped to production `visa-ui`’s 3000 |
| `COOKIE_SECURE` | unset | Set `true` if you terminate TLS in front of the UI |
| `OPENWA` | `1` | Set `0` to start `visa-ui` without the OpenWA sidecar or the `visa` network |

Examples:

```sh
./run.sh
./run.sh run
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

`docker build` still reuses layers. `npm ci` and Playwright Chromium only rerun when `package.json` / `package-lock.json` (or the Dockerfile) change. Edits under `src/` or `public/` reuse those layers and only copy sources and `npm run build` again. The old `apt-get install chromium` step is gone: Playwright downloads its own browser (`npx playwright install --with-deps chromium`).

## Using the UI

The table lists every profile: enabled switch, name, **current appointment**, **date window**, notify/reschedule badges, last **result**, last run time, **next run**, and icon actions (run/stop, runs, edit, delete). Rows are ordered by next run, soonest first; disabled profiles have no next run and sort last.

- **New profile** — visa account email/password, process ID, date window, notify and/or reschedule. Toolbar buttons are icons (new profile, all runs, calendar, notifications, settings, sign out).
- **Enabled** — when on, that profile is checked on the global interval. Leave new profiles off until you have reviewed them. Enable is refused if the date window overlaps another enabled profile (notify included — two people should not hunt the same days). An empty latest date needs a stored booked appointment from a prior run, or set a latest date.
- **Date window** — if latest is empty, the end of the window is the current booked date (dashed link, tooltip). That date can change after a check or reschedule.
- **Run now / Stop** — start or cancel a check immediately.
- **Next run** — last run **start** plus **Check every**. **due** means that time has already passed (or the profile has never run). Disabled profiles show —. `./run.sh dev` still shows this time but does not start scheduled checks.
- **Result** — **none available** is a slate chip (checked, nothing matched), distinct from gray **never run**. **available** is clickable and lists matching dates. **error** / **failed** / **timeout** open a dialog with the error text (same details as expanding that run).
- **Runs** (per profile) — history for that profile. Opens on the **last 24 hours**. Filter by from/to datetime and **notified**; sort newest or oldest first. A line above the list shows first and last notification in that range. A green/red bar is the mix of succeeded vs errored checks, with percentages. Click a row to expand booked appointment, dates, notified, rescheduled, and error text (the outcome badge is already on the row). The list is **not paginated**: 100 runs, or 500 when a filter is on (API cap 500). Older rows past that cap are omitted; SQLite still prunes runs after 14 days.
- **All runs** — toolbar clock. Same list, mix bar, and filters for every profile together, plus a **Profile** column and a profile dropdown. Use this for an admin view of execution and overall success vs failure rate.
- **Calendar** — toolbar calendar. A monthly grid of **enabled** profiles and the days they search. Inclusive latest dates fill those days; an empty latest date fills every day **strictly before** the stored booked appointment. That booked day is shown as a dashed chip and is not part of the search window. Profiles with no latest date and no booked appointment appear in the legend as **no window yet**. Previous / Next / Today move the month. Overlap is refused when enabling, so two enabled profiles should not share a day.
- **Notifications** — admin log of every appointment, heartbeat, failure alarm, or Settings test the notifier sent or failed to send, on **email** or **WhatsApp**. Opens on the **last 24 hours**. Filter by from/to, kind, status, and channel. Click a row for recipients and subject.
- **Settings** — two tabs. **Notifications** is Gmail, admin emails, **Link WhatsApp** (creates the session and shows a QR), and admin WhatsApp numbers, plus **Test email** / **Test WhatsApp**. OpenWA’s URL and API key come from the host (`http://openwa:2785` and `secrets/openwa.api-key`), not from Settings. **Scheduler** is check interval (default 5 minutes), heartbeat, max concurrent runs, run timeout, failure alarm (default 3 consecutive errors), and bot debug. Save writes both tabs.

**Notify** (orange badge) alerts the profile’s email and/or WhatsApp destinations when a matching date exists. At least one destination is required if notify is on. The same dates are not sent again on that channel until the date list changes. **Admin notification emails** get a BCC; **admin WhatsApp numbers** get a copy of appointment alerts. Profile recipients do not see admin email addresses. The Playwright child only reports dates; the server notifier sends after the check exits.

If every enabled channel fails, the AIS result is still stored and `notified` stays false. The error is on the run and as a **failed** row in **Notifications**. If email fails but WhatsApp sends (or the reverse), `notified` is true. Automatic **heartbeat** and **failure alarm** send failures are in that same log; **Send now** for heartbeat also shows the error on the Settings form. **Test email** and **Test WhatsApp** send a labeled `[TEST]` message to the admin destinations and appear in that log as kind **test**. Heartbeat and failure alarms can go to email, WhatsApp, or both.

**Reschedule** (green badge) books the first matching date without asking.

**Heartbeat** is a Settings toggle. The notifier emails the admin notification addresses at most once per heartbeat interval (default 1440 minutes), even if no profile ran or every run failed. The email lists enabled profiles and whether at least one of the last 5 runs succeeded; if none did, the subject flags that an admin needs to check. Settings shows when the last heartbeat was sent and has **Send now** to force one immediately. `./run.sh dev` turns the scheduler and notifier off, so automatic heartbeats, failure alarms, and scheduled checks do not fire there.

**Failure alarm** emails those same admin addresses when one profile records that many errors in a row (default 3). Timeouts, interruptions, bot errors, and a failed appointment email count; a later successful check resets the streak. The email is sent once per streak, when the count first hits the threshold.

**Bot debug** is off by default. A check only prints `VISA_RESULT` JSON (stdout) plus errors. Turn on **Capture bot debug output** in Settings when you are investigating a failure: the next scheduled or **Run now** checks pass `--debug`, keep step-by-step bot messages (login, home page, Playwright, …) on that run, and show them under the expanded result in **Runs**. Leave it off afterward. For a bot started by hand, `node build/index.js --debug` does the same for that process only. Pass `--reschedule` only when the server (or you) wants that process to book the first match.

## WhatsApp architecture

WhatsApp is an unofficial [OpenWA](https://github.com/rmyndharis/OpenWA) HTTP gateway in its own container (`compose.openwa.yml`), not a process inside Playwright and not Meta Cloud API. The visa server is only a client: create/start/QR/status plus `POST /api/sessions/{id}/messages/send-text`. Gmail stays the email path and a fallback when WhatsApp is not linked.

**Network.** `visa-ui`, `visa-dev`, and `openwa` share a user-defined Docker network named `visa`. The hostname is **`openwa`**. The network must not be `internal: true` — OpenWA has to reach WhatsApp on the internet. Port 2785 is not published on the host. Scan the QR from **Settings → Link WhatsApp**; do not open an OpenWA dashboard on the host.

**Host config vs Settings.** The gateway URL and API key are not user settings and are not stored in SQLite. `OPENWA_BASE_URL` defaults to `http://openwa:2785`. The API key is `secrets/openwa.api-key` (OpenWA `API_MASTER_KEY`). Startup deletes leftover `openwa_base_url` / `openwa_api_key` rows. Settings keeps the session UUID (read-only, hidden until **Link WhatsApp** writes it) and admin WhatsApp numbers. `whatsappGatewayReady` is derived from “URL parses and the key file is readable,” not a live health check.

**Session.** OpenWA’s session **name** is `visa`; the **id** is a UUID. **Link WhatsApp** reuses that name (or the stored id). If the session is already `ready`, a second click does not destroy it or show a new QR. `./run.sh stop` leaves OpenWA running so the link survives a visa-ui recreate. `./run.sh stop-openwa` stops the sidecar; session files stay on `openwa-data` until the volume is removed.

**Sends.** Appointment WhatsApp alerts go to unique(profile numbers + admin numbers) and are debounced per profile and channel on the sorted date list. Heartbeats and failure alarms can be WhatsApp-only. A 409 / “session is not connected” from OpenWA is retryable — WhatsApp Web can still be injecting while status reads `ready`. The home banner only means “no session id or the host key/URL is missing,” not “OpenWA is down” or “the session was destroyed.” Settings refreshes status when you open it.

The sidecar pins OpenWA’s **whatsapp-web.js** engine (headless Chromium, lower ban fingerprint than Baileys). Use a **dedicated** number you can afford to lose.

A `visa-ui` container started before this sidecar will not be on the `visa` network until `./run.sh restart`.

1. `./run.sh` (pulls `ghcr.io/rmyndharis/openwa` the first time, writes `secrets/openwa.api-key`)
2. In **Settings → Notifications**, click **Link WhatsApp** and scan the QR with a dedicated number (WhatsApp → Linked devices → Link a device)

Phone numbers are digits with country code (punctuation is stripped) or a group id (`…@g.us`). Same format on profiles and admin numbers.

`OPENWA=0 ./run.sh` starts only `visa-ui`.

To send mail you need a Gmail **App Password**:

- https://myaccount.google.com/signinoptions/two-step-verification
- Enable 2FA, then App Passwords → “other” device
- Put the user and app password in **Settings**

## Date range

- **Earliest date**: appointments on or after this date. Empty means no lower bound.
- **Latest date**: appointments on or before this date. Empty means **strictly before** the account’s currently booked appointment on AIS. If AIS has no booked appointment, the run fails unless you set a date. Each successful login stores that booked date on the profile and refreshes it after a reschedule.

A filled-in latest date is inclusive. An empty latest date is exclusive of the booked appointment, so you do not match the slot you already have. Overlap checks use the stored booked date for empty latest windows.

## What is stored in SQLite

**profile** — one row per visa account: name, email, encrypted password, process ID, notify emails, WhatsApp destinations, min/max dates, last-seen booked appointment, actions (`notify`, `reschedule`), enabled flag.

**setting** — Gmail user, encrypted Gmail app password, admin notification emails, OpenWA session id, admin WhatsApp numbers, check interval, heartbeat enabled/interval, concurrency, run timeout, failure alarm threshold, bot debug flag, admin password hash, key-check ciphertext.

**run** — each scheduler/manual execution (status, structured `VISA_RESULT` JSON, timestamps, and debug output only if that was on). Old rows are pruned after 14 days.

**notification** — each appointment, heartbeat, failure-alarm, or Settings test send on email or WhatsApp (recipients, subject, summary, status, channel).

`HOST_BIND` / `PORT` / `COOKIE_SECURE` for `./run.sh` are listed under [`run.sh` commands](#runsh-commands). The Node process inside the container also understands:

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `VISA_MASTER_KEY_FILE` | `secrets/master.key` | 32-byte base64 master key |
| `OPENWA_API_KEY_FILE` | `secrets/openwa.api-key` | Shared OpenWA admin key (`API_MASTER_KEY` in the sidecar). Must be at least 32 characters |
| `OPENWA_BASE_URL` | `http://openwa:2785` | OpenWA gateway URL (not stored in Settings) |
| `DB_PATH` | `./db.sqlite` | SQLite database |
| `PUBLIC_DIR` | `build/ui` | Vite production build of the admin UI. `./run.sh dev` still points this at `public/` for the API process; the browser should use Vite on :5173 |
| `VISA_DEV` | unset | Set `1` for `./run.sh dev`: skip login, do not start the scheduler or notifier. Refused unless `HOST` is localhost |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Address the Node server binds |
| `PORT` | `3000` | Listen port inside the process (Docker / `npm start`) |
| `API_PORT` | `3456` | `./run.sh dev` API port that Vite proxies to |
| `VITE_DEV_PORT` | `5173` | Host port published from the `visa-dev` Vite UI (open this in the browser) |
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
| `npm run test:openwa` | Typecheck and run the OpenWA notifier tests against a mock gateway |
