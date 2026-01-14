# Dockerfile (FULL)
FROM node:20-alpine

WORKDIR /app

# npm butuh git kalau ada dependency dari github
RUN apk add --no-cache git

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
CMD ["node", "index.js"]
