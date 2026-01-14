# Dockerfile — FIX spawn git ENOENT + run index.js
FROM node:20-alpine

WORKDIR /app

# wajib: git (karena ada dependency github:... di package.json)
RUN apk add --no-cache git

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# optional kalau kamu pakai volume /data:
# ENV DATA_DIR=/data

CMD ["node", "index.js"]
