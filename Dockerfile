
FROM node:20-alpine

WORKDIR /app

# Installa OpenSSL, necessario per Prisma
RUN apk add --no-cache openssl

# Installa le dipendenze
COPY package*.json ./
RUN npm ci

# Copia il progetto
COPY . .

# Genera Prisma Client
RUN npx prisma generate

# Compila Next.js
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
