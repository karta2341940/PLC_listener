FROM node:lts-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY monitor.js monitor-worker.js ./

CMD ["node", "monitor.js"]
