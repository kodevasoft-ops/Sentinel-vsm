FROM node:20-slim

# better-sqlite3 y node-onvif compilan módulos nativos
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/server.js"]
