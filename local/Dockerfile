FROM node:22-alpine

# openssl for self-signed cert; python3/make/g++ to compile better-sqlite3 native module
RUN apk add --no-cache openssl python3 make g++

WORKDIR /app

# Install dependencies (including native better-sqlite3 compilation)
COPY local/package.json local/package-lock.json ./
RUN npm ci --omit=dev

# Copy server files
COPY local/server.js local/sync-schwab.js local/local-enhance.js local/local-dashboard.html local/rag.js ./

# Clone the webapp (read-only snapshot — originals are never touched)
COPY index.html advanced-wash-sales.html auth-redirect.html faveIcon.png ./webapp/
COPY js/   ./webapp/js/
COPY css/  ./webapp/css/
COPY logos/ ./webapp/logos/

EXPOSE 8080

CMD ["node", "server.js"]
