FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

# Primero solo las dependencias, así Docker las cachea mientras no cambie package.json.
# (Ninguna dependencia se compila, así que no hacen falta herramientas extra.)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

CMD ["node", "src/index.js"]
