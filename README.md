# Visa Appointment Finder

## Mail Notification

You will need to set up an App Password.

- Go to https://myaccount.google.com/signinoptions/two-step-verification
- Enable 2 factor authentication
- Inside 2FA page go to App Passwords
- Create a new password for the email app using "other" device.
- Set this password in the .env file

## Running Locally

- `nvm install`
- `npm install`
- `npm run build`
- `node build/visaAppointment.js`

## Using Docker

- `cp .env.dist .env`
- `nano .env`
- `docker build -t visa .`
- `docker run --rm --env-file .env visa`

You can pass extra flags, Eg: `docker run --rm --env-file .env visa --help`.

**NOTE:** when calling the docker command from a different folder (like when running a cron job)
you need to set the full path for the .env file.
