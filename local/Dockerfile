FROM node:22-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js sync-schwab.js ./

EXPOSE 8080

CMD ["node", "server.js"]
