# Visa Appointment Finder

This project was created to help getting a Visa appointment in the Chilean consulate rescheduled to the desired date.

## Getting started

Configuration is split in two files:

- `.env.shared`: values common to every instance (Gmail sender, admin and heartbeat settings).
- `.env` (or `.env.<name>` per instance): the visa account and who gets notified.

Values in the instance file override the ones in `.env.shared`.

- `cp .env_shared_example .env.shared` and set the `GMAIL_*`, `EMAIL_ADMIN_DESTINATION` and `HEARTBEAT_*` variables.
- `cp .env_example .env` and set the `VISA_*` variables and `EMAIL_DESTINATION`.

`EMAIL_ADMIN_DESTINATION` receives a BCC of every appointment notification, so instance owners don't see it. `EMAIL_DESTINATION` can be left empty to notify only the admin.

Don't use quotes or inline comments (`KEY=value # comment`) in these files: Docker treats them as part of the value.

To set the `GMAIL_*` env variables, you will need to set up an **App Password**.

- Go to https://myaccount.google.com/signinoptions/two-step-verification
- Enable 2 factor authentication
- Inside 2FA page go to App Passwords
- Create a new password for the email app using "other" device.
- Set this password in the `.env.shared` file

## Run the script

### Locally

- `nvm install` (ignore if you have Node v20 installed)
- `npm install`
- `npm run build`
- `node build/index.js`

### Using Docker

- `./run.sh`

The first run builds the `visa` image. After that, `run.sh` reuses the existing image and **never rebuilds it**, so code changes are ignored until you rebuild.

#### Updating using Docker

Run this after a `git pull` or any change to the code:

- `docker build -t visa .`

### Passing flags

However you execute the script, you can pass extra flags. Eg: `node build/index.js --help` or `./run.sh --help`.
By default it runs with the `-h` (headless mode) flag when running using Docker.

### Date range

- `--minDate=MM/DD/YYYY`: only consider appointments **on or after** this date.
- `--maxDate=MM/DD/YYYY`: only consider appointments **on or before** this date. If omitted, only appointments **strictly before** your current appointment are considered.

Both dates are inclusive. Eg: `./run.sh --minDate=11/16/2026 --maxDate=11/30/2026` matches appointments from November 16 through November 30.

## View logs

You can view the latest log entries with:

`sqlite3 db.sqlite "SELECT * FROM log ORDER BY id DESC LIMIT 10;"`

## Running multiple instances

The `./run.sh` can accept a **FIRST** argument like `--env .env.something` that will be used, otherwise it will use `.env`. Any other flags go after it, eg: `./run.sh --env .env.something --minDate=11/16/2026`.
This way you can schedule multiple instances to be running, each one of them with its own credentials and visa process.
All instances also load `.env.shared`, so shared settings only need to be changed in one place.
