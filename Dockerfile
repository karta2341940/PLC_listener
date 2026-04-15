FROM node:lts-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY client.js \
     client-worker.js \
     client-udp.js \
     client-udp-worker.js \
     ./

# TCP client by default; override with:
#   docker run -it plc-client node client-udp.js
CMD ["node", "client.js"]
