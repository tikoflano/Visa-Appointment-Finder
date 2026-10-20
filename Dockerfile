FROM node:23-bookworm

WORKDIR /usr/local/visa-appointment

# Install chromium dependencies
RUN apt-get update && apt-get -y install chromium

# This needs to be after the COPY command because it needes the package*.json files to install the correct chromium version
COPY ./package*.json .
COPY ./ .
RUN npm install
RUN npm run build

RUN npx playwright install --with-deps chromium

EXPOSE 3000
ENV HOST=0.0.0.0
ENV PORT=3000
ENTRYPOINT ["node", "build/server/index.js"]
