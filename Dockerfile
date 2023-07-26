FROM node:20-alpine

WORKDIR /usr/local/visaAppointment

COPY ./ .

RUN npm install
RUN npx playwright install chromium
RUN npm run build

ENTRYPOINT ["node"]
CMD ["build/visaAppointment.js"]
