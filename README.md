# Visa Appointment Finder

This project was created to help getting a Visa appointment in the Chilean consulate rescheduled to the desired date.

## Getting started

- `cp .env.dist .env`
- `nano .env` and set at least the `VISA_*` variables.

To set the `GMAIL_*` env variables, you will need to set up an **App Password**.

- Go to https://myaccount.google.com/signinoptions/two-step-verification
- Enable 2 factor authentication
- Inside 2FA page go to App Passwords
- Create a new password for the email app using "other" device.
- Set this password in the .env file

## Run the script

### Locally

- `nvm install` (ignore if you have Node v20 installed)
- `npm install`
- `npm run build`
- `node build/visaAppointment.js`

### Using Docker

- `./run.sh`

#### Updating using Docker

- `git pull`
- `docker build -t visa .`

### Passing flags

However you execute the script, you can pass extra flags. Eg: `node build/visaAppointment.js --help` or `./run.sh --help`.
By default it runs with the `-h` (headless mode) flag when running using Docker.

## View logs

You can view the latest log entries with:

`sqlite3 db.sqlite "SELECT * FROM log ORDER BY id DESC LIMIT 10;"`

## Running multiple instances

The `./run.sh` can accept a **FIRST** argument like `--env env.something` that will be used, otherwise it will use `.env`.
This way you can schedule multiple instances to be running, each one of them with its own credentials and visa process.
