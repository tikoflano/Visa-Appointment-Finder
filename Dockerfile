FROM node:20-buster

WORKDIR /usr/local/visa-appointment

# Install chromium dependencies
RUN apt-get update && apt-get -y install chromium

COPY ./ .

# This needs to be after the COPY command because it needes the package*.json files to install the correct chromium version
RUN npx playwright install chromium
RUN npm install
RUN npm run build

ENTRYPOINT ["node", "build/visaAppointment.js", "-h"]
