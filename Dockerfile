# Etapa 1: instalar dependencias.
# better-sqlite3 se compila en C++, así que acá necesitamos python, make y g++.
FROM node:24-slim AS dependencias

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Etapa 2: imagen final, sin las herramientas de compilación (más liviana).
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencias /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

CMD ["node", "src/index.js"]
