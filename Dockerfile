FROM node:20-buster

WORKDIR /usr/local/visa-appointment

# Install chromium dependencies
RUN apt-get update && apt-get -y install chromium
RUN npx playwright install chromium

COPY ./ .

RUN npm install
RUN npm run build

ENTRYPOINT ["node", "build/visaAppointment.js", "-h"]
