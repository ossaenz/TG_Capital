FROM node:22-alpine

RUN apk add --no-cache openssl

WORKDIR /app

# Install dependencies
COPY local/package.json local/package-lock.json ./
RUN npm ci --omit=dev

# Copy server
COPY local/server.js local/sync-schwab.js ./

# Clone the webapp (read-only snapshot — originals are never touched)
COPY index.html advanced-wash-sales.html auth-redirect.html faveIcon.png ./webapp/
COPY js/   ./webapp/js/
COPY css/  ./webapp/css/
COPY logos/ ./webapp/logos/

EXPOSE 8080

CMD ["node", "server.js"]
