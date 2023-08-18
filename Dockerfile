FROM node:20-buster

WORKDIR /usr/local/visa-appointment

# Install chromium dependencies
RUN apt-get update && apt-get -y install chromium

# This needs to be after the COPY command because it needes the package*.json files to install the correct chromium version
COPY ./package*.json .
RUN npx playwright install chromium

COPY ./ .
RUN npm install
RUN npm run build

ENTRYPOINT ["node", "build/visaAppointment.js", "-h"]
