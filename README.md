# Visa Appointment Finder

In order to get notifications via Whatsapp you will need to create a [Twilio](https://www.twilio.com/try-twilio) account and then set upt the [Whatsapp sandbox](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn).

## Running Locally

- `nvm install`

- `npm install`
- `npm run build`
- `node build/visaAppointment.js`

## Using Docker Compose

- `cp .env.dist .env`
- `nano .env`
- `docker compose run --rm visa-appointment`
