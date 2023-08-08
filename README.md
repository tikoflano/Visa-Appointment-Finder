# Visa Appointment Finder

## Notifications

### WhatsApp

In order to get notifications via Whatsapp you will need to create a [Twilio](https://www.twilio.com/try-twilio) account and then set upt the [Whatsapp sandbox](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn).

### Gmail

You will need to set up an App Password.

- Go to https://myaccount.google.com/
- Enable 2 factor authentication
- Inside 2FA page go to App Passwords
- Create a new password for the email app using "other" device.
- Set this password in the .env file

## Running Locally

- `nvm install`

- `npm install`
- `npm run build`
- `node build/visaAppointment.js`

## Using Docker Compose

- `cp .env.dist .env`
- `nano .env`
- `docker compose run --rm visa-appointment`
